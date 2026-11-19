import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { permanentDeleteSession } from '../index.js'

const SESSION_ID = 'ece3142b-987a-44df-a9c7-1dc0c1709f56'

/**
 * Build a fake Host context over one temp directory per session.
 * @param {{ sessions?: { id: string, files?: string[], live?: boolean, origin?: string, parentSession?: string, location?: boolean }[], failUnlinkFor?: string }} options - fixture.
 * @returns {Promise<{ ctx: object, calls: object, dirOf: (id: string) => string }>} fixture.
 */
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'permanent-delete-'))
  const specs = options.sessions ?? [{ id: SESSION_ID }]
  const sessions = new Map()
  for (const spec of specs) {
    const directory = path.join(root, 'project', spec.id)
    await mkdir(directory, { recursive: true })
    for (const name of spec.files ?? ['session.lock', 'session.v4.jsonl.zstd']) {
      await writeFile(path.join(directory, name), 'x')
    }
    sessions.set(spec.id, { ...spec, directory })
  }

  const calls = { unarchived: [], unpinned: [], cached: [] }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionPersistence') {
        return {
          async stat(id) {
            const spec = sessions.get(id)
            if (spec === undefined) return undefined
            if (spec.location === false) return { header: { id } }
            return { location: { kind: 'jsonl', path: path.join(spec.directory, 'session.v4.jsonl.zstd') } }
          },
          async list() {
            return [...sessions.values()].map(spec => ({
              header: { id: spec.id, origin: spec.origin, parentSession: spec.parentSession },
            }))
          },
        }
      }
      if (name === 'agents') {
        return { get: id => (sessions.get(id)?.live === true ? { id } : undefined) }
      }
      if (name === 'workspaceRegistry') {
        return {
          async unarchiveSession(id) { calls.unarchived.push(id) },
          async unpinSession(id) { calls.unpinned.push(id) },
        }
      }
      if (name === 'storageDomain') {
        return {
          get: domain => (domain === 'session_projcache'
            ? { table: () => ({ async delete(id) { calls.cached.push(id); return true } }) }
            : undefined),
        }
      }
      return undefined
    },
  }
  return { ctx, calls, dirOf: id => sessions.get(id).directory, root }
}

test('removes a cold conversation and its follow-up records', async () => {
  const { ctx, calls, dirOf } = await fixture()
  const result = await permanentDeleteSession(ctx, SESSION_ID)
  assert.equal(result.status, 200)
  assert.equal(result.descendants, 0)
  await assert.rejects(readdir(dirOf(SESSION_ID)))
  assert.deepEqual(calls.unarchived, [SESSION_ID])
  assert.deepEqual(calls.unpinned, [SESSION_ID])
  assert.deepEqual(calls.cached, [SESSION_ID])
})

test('cascades into sub-agent sessions and their descendants', async () => {
  const { ctx, calls, dirOf } = await fixture({
    sessions: [
      { id: 'root' },
      { id: 'child', origin: 'subagent', parentSession: 'root' },
      { id: 'grandchild', origin: 'subagent', parentSession: 'child' },
    ],
  })
  const result = await permanentDeleteSession(ctx, 'root')
  assert.equal(result.status, 200)
  assert.equal(result.descendants, 2)
  for (const id of ['root', 'child', 'grandchild']) await assert.rejects(readdir(dirOf(id)))
  assert.deepEqual(calls.cached.sort(), ['child', 'grandchild', 'root'])
})

test('does not follow a non-subagent parent link', async () => {
  const { ctx, dirOf } = await fixture({
    sessions: [
      { id: 'root' },
      { id: 'fork', parentSession: 'root' },
    ],
  })
  const result = await permanentDeleteSession(ctx, 'root')
  assert.equal(result.status, 200)
  assert.equal(result.descendants, 0)
  assert.equal((await readdir(dirOf('fork'))).length, 2)
})

test('refuses while a sub-agent session is still loaded', async () => {
  const { ctx, dirOf } = await fixture({
    sessions: [
      { id: 'root' },
      { id: 'child', origin: 'subagent', parentSession: 'root', live: true },
    ],
  })
  const result = await permanentDeleteSession(ctx, 'root')
  assert.equal(result.status, 409)
  assert.equal(result.error, 'descendant-live')
  assert.equal((await readdir(dirOf('root'))).length, 2)
  assert.equal((await readdir(dirOf('child'))).length, 2)
})

test('refuses the whole tree when one sub-agent layout is unknown', async () => {
  const { ctx, dirOf } = await fixture({
    sessions: [
      { id: 'root' },
      { id: 'child', origin: 'subagent', parentSession: 'root', files: ['session.v4.jsonl.zstd', 'notes.txt'] },
    ],
  })
  const result = await permanentDeleteSession(ctx, 'root')
  assert.equal(result.status, 409)
  assert.equal(result.error, 'unexpected-layout')
  assert.equal((await readdir(dirOf('root'))).length, 2)
  assert.equal((await readdir(dirOf('child'))).length, 2)
})

test('reports a missing conversation without touching anything', async () => {
  const { ctx, calls, dirOf } = await fixture()
  const result = await permanentDeleteSession(ctx, 'missing-id')
  assert.equal(result.status, 404)
  assert.equal(result.error, 'not-found')
  assert.deepEqual(calls.unarchived, [])
  assert.ok((await readdir(dirOf(SESSION_ID))).length > 0)
})

test('refuses a conversation that is still loaded in this app run', async () => {
  const { ctx, dirOf } = await fixture({ sessions: [{ id: SESSION_ID, live: true }] })
  const result = await permanentDeleteSession(ctx, SESSION_ID)
  assert.equal(result.status, 409)
  assert.equal(result.error, 'live')
  assert.ok((await readdir(dirOf(SESSION_ID))).length > 0)
})

test('deletes a blank conversation that has no artifact yet', async () => {
  const { ctx, calls } = await fixture({ sessions: [{ id: SESSION_ID, location: false }] })
  const result = await permanentDeleteSession(ctx, SESSION_ID)
  assert.equal(result.status, 200)
  assert.deepEqual(calls.cached, [SESSION_ID])
  assert.deepEqual(calls.unarchived, [SESSION_ID])
})

test('reports a filesystem failure after clearing marks', async () => {
  const { ctx, dirOf } = await fixture()
  await chmod(dirOf(SESSION_ID), 0o500)
  try {
    const result = await permanentDeleteSession(ctx, SESSION_ID)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'filesystem-failed')
  } finally {
    await chmod(dirOf(SESSION_ID), 0o700)
  }
})

test('keeps retained generation files and the lock together', async () => {
  const { ctx, dirOf, root } = await fixture({
    sessions: [{ id: SESSION_ID, files: ['session.lock', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'] }],
  })
  const result = await permanentDeleteSession(ctx, SESSION_ID)
  assert.equal(result.status, 200)
  await assert.rejects(readdir(dirOf(SESSION_ID)))
  await rm(root, { recursive: true, force: true })
})

test('prunes archive marks whose session no longer exists', async () => {
  const { pruneOrphanArchiveMarks } = await import('../index.js')
  const dropped = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          archivedSessionIds: ['gone-1', 'exists', 'broken', 'gone-2'],
          async unarchiveSession(id) { dropped.push(id) },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async stat(id) {
            if (id === 'broken') throw new Error('io failure')
            if (id === 'exists') return { header: { id } }
            return undefined
          },
        }
      }
      return undefined
    },
  }
  assert.equal(await pruneOrphanArchiveMarks(ctx), 2)
  assert.deepEqual(dropped, ['gone-1', 'gone-2'])
})

test('pruning is a no-op without a workspace registry', async () => {
  const { pruneOrphanArchiveMarks } = await import('../index.js')
  assert.equal(await pruneOrphanArchiveMarks({ get: () => undefined }), 0)
})

test('prunes projection rows whose session no longer exists', async () => {
  const { pruneOrphanProjectionRows } = await import('../index.js')
  const removed = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessionPersistence') {
        return { async list() { return [{ header: { id: 'alive-1' } }, { header: { id: 'alive-2' } }] } }
      }
      if (name === 'storageDomain') {
        return {
          get: domain => (domain === 'session_projcache'
            ? { table: () => ({
              * keys() { yield 'alive-1'; yield 'gone-1'; yield 'alive-2'; yield 'gone-2' },
              async deleteMany(keys) { removed.push(...keys); return keys.length },
            }) }
            : undefined),
        }
      }
      return undefined
    },
  }
  assert.equal(await pruneOrphanProjectionRows(ctx), 2)
  assert.deepEqual(removed, ['gone-1', 'gone-2'])
})

test('projection pruning is a no-op without the storage domain', async () => {
  const { pruneOrphanProjectionRows } = await import('../index.js')
  assert.equal(await pruneOrphanProjectionRows({ get: () => undefined }), 0)
})
