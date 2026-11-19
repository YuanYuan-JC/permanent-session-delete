/**
 * Host half of the permanent-delete bundle.
 *
 * Removes one conversation for good: it deletes every generation of the
 * session-owned log directory, drops the projection-cache checkpoint, and, when
 * the conversation spawned sub-agent sessions, removes those child logs too.
 *
 * @module dsh-permanent-session-delete
 */

import { readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

export const name = 'permanent-session-delete'

/** Services required before this plugin activates. */
export const inject = ['connection', 'sessions', 'sessionPersistence']

/** Exact Fetch route the browser half calls. */
export const ROUTE = '/api/session.permanentDelete'

/** Canonical generation filenames plus the retained pre-release names. */
const SESSION_FILE = /^session(\.[A-Za-z0-9]+)?\.jsonl(\.zstd)?$/

/** Kernel writer lock file inside the session-owned directory. */
const LOCK_FILE = 'session.lock'

/** Session ids are opaque; reject separators before any path work. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

/**
 * A deletion outcome; `status` is the HTTP status, `error` a stable code the
 * browser half localizes, and `descendants` how many child sessions went with it.
 * @param {number} status - HTTP status.
 * @param {string} [error] - stable error code.
 * @param {number} [descendants] - child sessions removed.
 * @returns {{ status: number, error?: string, descendants?: number }} outcome.
 */
function outcome(status, error, descendants) {
  const result = { status }
  if (error !== undefined) result.error = error
  if (descendants !== undefined) result.descendants = descendants
  return result
}

/**
 * Answer one raw JSON result.
 * @param {number} status - HTTP status code.
 * @param {Record<string, unknown>} body - JSON body.
 * @returns {Response} buffered JSON response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Read one session-owned directory and verify it holds only session artifacts.
 * @param {string} directory - absolute session-owned directory.
 * @returns {Promise<string[] | undefined>} accepted entries, or undefined when
 * the layout is not recognized.
 */
async function inspectDirectory(directory) {
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    return undefined
  }
  if (entries.length === 0) return undefined
  for (const entry of entries) {
    if (entry === LOCK_FILE) continue
    if (SESSION_FILE.test(entry)) continue
    return undefined
  }
  return entries
}

/**
 * Every stored sub-agent session below one conversation, transitively.
 *
 * Only `origin: 'subagent'` links count: an ordinary fork or an adopted seed is
 * an independent conversation even when its header names a parent.
 * @param {readonly { header?: { id?: string, origin?: string, parentSession?: string } }[]} snapshots
 * stored-session snapshots.
 * @param {string} rootId - the conversation being deleted.
 * @returns {string[]} descendant session ids, parents before children.
 */
function subagentDescendants(snapshots, rootId) {
  const children = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header?.origin !== 'subagent' || typeof header.parentSession !== 'string') continue
    if (typeof header.id !== 'string') continue
    const bucket = children.get(header.parentSession)
    if (bucket === undefined) children.set(header.parentSession, [header.id])
    else bucket.push(header.id)
  }
  const ordered = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      ordered.push(child)
      queue.push(child)
    }
  }
  return ordered
}

/**
 * Locate one stored session's artifact and verify its layout.
 * @param {{ stat: (id: string) => Promise<unknown> }} persistence - session storage.
 * @param {string} sessionId - stored session identity.
 * @returns {Promise<{ id: string, error?: string, directory?: string, entries?: string[] }>} plan.
 */
async function planTarget(persistence, sessionId) {
  let snapshot
  try {
    snapshot = await persistence.stat(sessionId)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined || snapshot === null) return { id: sessionId, error: 'not-found' }
  const location = snapshot.location
  const filePath = location !== undefined && location !== null && typeof location.path === 'string'
    ? location.path
    : undefined
  if (filePath === undefined) return { id: sessionId }
  if (!path.isAbsolute(filePath)) return { id: sessionId, error: 'unexpected-layout' }
  const directory = path.dirname(filePath)
  if (path.dirname(directory) === directory) return { id: sessionId, error: 'unexpected-layout' }
  const entries = await inspectDirectory(directory)
  if (entries === undefined) return { id: sessionId, error: 'unexpected-layout' }
  return { id: sessionId, directory, entries }
}

/**
 * Permanently delete one stored conversation and its sub-agent sessions.
 *
 * A materialized Session owns exactly one directory; retained format
 * generations and the writer lock live in it, so the whole directory goes.
 * A created-but-never-appended Session has no artifact and only loses its
 * records.
 *
 * The running app keeps an opened conversation's Agent in memory and no public
 * API disposes it, so deleting a live Session would leave a restorable ghost.
 * The same applies to a sub-agent session that is still loaded. Either case is
 * refused instead of half-deleted; the conversation becomes deletable after the
 * app restarts and its row stays cold.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - stored Session identity.
 * @returns {Promise<{ status: number, error?: string, descendants?: number }>} outcome.
 */
export async function permanentDeleteSession(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    return outcome(503, 'unavailable')
  }

  let snapshot
  try {
    snapshot = await persistence.stat(sessionId)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined || snapshot === null) return outcome(404, 'not-found')

  // An opened conversation lives in the Agent registry for the app's lifetime.
  // Its in-memory log would survive the file deletion and stay restorable, so
  // refuse rather than report a deletion that the sidebar still shows.
  if (ctx.get('agents')?.get?.(sessionId) !== undefined) return outcome(409, 'live')

  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return outcome(503, 'unavailable')
  }
  const descendants = subagentDescendants(Array.isArray(snapshots) ? snapshots : [], sessionId)

  // Preflight every target before touching anything, so a bad layout or a
  // running child leaves the whole tree intact.
  const plans = []
  for (const id of [sessionId, ...descendants]) {
    if (id !== sessionId && ctx.get('agents')?.get?.(id) !== undefined) {
      return outcome(409, 'descendant-live')
    }
    const plan = await planTarget(persistence, id)
    if (plan.error !== undefined) {
      if (plan.error === 'not-found' && id !== sessionId) continue
      return outcome(plan.error === 'not-found' ? 404 : 409, plan.error)
    }
    plans.push(plan)
  }

  // Clear archive and pin marks before the conversation disappears, so no stale
  // id keeps a hidden or pinned slot for a session that no longer exists.
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    try {
      await registry.unarchiveSession?.(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`permanent delete: clearing archive mark failed: ${String(error)}`)
    }
    try {
      await registry.unpinSession?.(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`permanent delete: clearing pin failed: ${String(error)}`)
    }
  }

  const domain = ctx.get('storageDomain')?.get?.('session_projcache')
  for (const plan of plans) {
    if (plan.directory !== undefined) {
      try {
        for (const entry of plan.entries) await unlink(path.join(plan.directory, entry))
        await rmdir(plan.directory)
      } catch (error) {
        ctx.logger?.warn?.(`permanent delete: removing ${plan.directory} failed: ${String(error)}`)
        return outcome(500, 'filesystem-failed')
      }
    }
    if (domain !== undefined) {
      try {
        await domain.table('sessions').delete(plan.id)
      } catch (error) {
        ctx.logger?.warn?.(`permanent delete: dropping projection cache failed: ${String(error)}`)
      }
    }
  }

  ctx.logger?.info?.(
    `permanent delete: removed session ${sessionId}` +
    (descendants.length > 0 ? ` with ${descendants.length} sub-agent session(s)` : ''),
  )
  return outcome(200, undefined, descendants.length)
}

/**
 * Drop archive marks whose Session no longer exists.
 *
 * Deletion removes a Session's files, and a restart rebuilds the Session list
 * from storage, but the workspace archive set keeps raw ids. Left alone they
 * are invisible dead entries; pruning them through the registry's own write path
 * keeps `workspace.json` honest without touching the file behind the app's back.
 * A `stat` failure other than absence is not treated as deletion.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<number>} number of marks dropped.
 */
export async function pruneOrphanArchiveMarks(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  if (registry === undefined || persistence === undefined) return 0
  let archived
  try {
    archived = [...registry.archivedSessionIds]
  } catch {
    return 0
  }
  let removed = 0
  for (const sessionId of archived) {
    let snapshot
    try {
      snapshot = await persistence.stat(sessionId)
    } catch {
      continue
    }
    if (snapshot !== undefined && snapshot !== null) continue
    try {
      await registry.unarchiveSession(sessionId)
      removed += 1
    } catch (error) {
      ctx.logger?.warn?.(`permanent delete: pruning archive mark ${sessionId} failed: ${String(error)}`)
    }
  }
  if (removed > 0) ctx.logger?.info?.(`permanent delete: dropped ${removed} archive mark(s) without a Session`)
  return removed
}

/**
 * Drop projection-cache rows whose Session no longer exists.
 *
 * A cache row is a derived checkpoint, never authoritative, so a row whose
 * Session is gone only wastes space. Deleting through the open storage domain
 * keeps the backend's in-memory table and its per-record files in agreement;
 * removing the files directly lets a later flush write them back.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<number>} number of rows dropped.
 */
export async function pruneOrphanProjectionRows(ctx) {
  const persistence = ctx.get('sessionPersistence')
  const table = ctx.get('storageDomain')?.get?.('session_projcache')?.table?.('sessions')
  if (persistence === undefined || typeof persistence.list !== 'function' || table === undefined) return 0
  let stored
  try {
    stored = await persistence.list()
  } catch {
    return 0
  }
  const alive = new Set()
  for (const snapshot of stored) {
    const id = snapshot?.header?.id
    if (typeof id === 'string') alive.add(id)
  }
  const orphans = []
  for (const key of table.keys()) {
    if (!alive.has(key)) orphans.push(key)
  }
  if (orphans.length === 0) return 0
  try {
    const removed = await table.deleteMany(orphans)
    ctx.logger?.info?.(`permanent delete: dropped ${removed} projection row(s) without a Session`)
    return removed
  } catch (error) {
    ctx.logger?.warn?.(`permanent delete: pruning projection rows failed: ${String(error)}`)
    return 0
  }
}

/**
 * Register the browser-callable route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 */
export function apply(ctx) {
  // Optional hygiene: the registry may be absent in non-web compositions.
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], scope => {
    void pruneOrphanArchiveMarks(scope).catch(() => {})
    void pruneOrphanProjectionRows(scope).catch(() => {})
  })

  ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body
      try {
        body = await request.json()
      } catch {
        body = undefined
      }
      const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
      if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
        return json(400, { error: 'invalid-session-id' })
      }
      const result = await permanentDeleteSession(ctx, sessionId)
      if (result.status !== 200) {
        return json(result.status, { error: result.error ?? 'failed', sessionId })
      }
      return json(200, { ok: true, sessionId, descendants: result.descendants ?? 0 })
    },
  })
}
