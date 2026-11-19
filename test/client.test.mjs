import assert from 'node:assert/strict'
import test from 'node:test'

let loadCount = 0

/**
 * A tiny React stand-in that renders one component with hooks, so the dialog can
 * be exercised without react-dom.
 * @returns {object} fake React module plus a render controller.
 */
function createFakeReact() {
  const render = {
    hooks: [],
    hookIndex: 0,
    effects: [],
    scheduled: undefined,
    component: undefined,
    props: undefined,
    tree: undefined,
    render() {
      render.hookIndex = 0
      render.effects = []
      render.tree = render.component(render.props)
      const next = []
      for (const effect of render.effects) {
        const previous = render.hooks[`effect-${effect.index}`]
        const same = previous !== undefined && effect.deps !== undefined && previous.deps !== undefined
          && effect.deps.length === previous.deps.length
          && effect.deps.every((value, index) => Object.is(value, previous.deps[index]))
        if (same) {
          next.push(previous)
          continue
        }
        previous?.cleanup?.()
        const cleanup = effect.fn()
        const record = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        render.hooks[`effect-${effect.index}`] = record
        next.push(record)
      }
      // Drop effects that disappeared from this render.
      for (const key of Object.keys(render.hooks)) {
        if (key.startsWith('effect-') && !next.includes(render.hooks[key])) delete render.hooks[key]
      }
    },
    schedule() {
      render.render()
    },
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const node = { type, props: props ?? {}, children }
      if (node.props.ref !== undefined) node.props.ref.current = node
      node.focus = () => { globalThis.document.activeElement = node }
      node.querySelectorAll = () => []
      node.addEventListener = () => {}
      return node
    },
    useState(initial) {
      const index = render.hookIndex++
      if (!(index in render.hooks)) render.hooks[index] = initial
      return [render.hooks[index], value => {
        render.hooks[index] = typeof value === 'function' ? value(render.hooks[index]) : value
        render.render()
      }]
    },
    useRef(initial) {
      const index = render.hookIndex++
      if (!(index in render.hooks)) render.hooks[index] = { current: initial }
      return render.hooks[index]
    },
    useEffect(fn, deps) {
      render.effects.push({ index: render.hookIndex, fn, deps })
      render.hookIndex += 1
    },
  }

  return { React, render }
}

/**
 * Find the first rendered node matching a predicate.
 * @param {object} node - rendered tree.
 * @param {(node: object) => boolean} match - predicate.
 * @returns {object | undefined} match.
 */
function find(node, match) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (match(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, match)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Load client.js with a fake React and apply the plugin to a fake context.
 * @param {(specifier: string) => object} loadReact - react module supplier.
 * @returns {Promise<object>} registration capture and the required entries.
 */
async function loadClient(loadReact) {
  const registered = []
  const notices = []
  const calls = { order: [], refresh: 0 }
  const dicts = {}
  let module
  const reactModule = loadReact()

  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-permanent-session-delete')
        module = factory(specifier => {
          assert.equal(specifier, 'react')
          return reactModule
        })
      },
    },
  }
  globalThis.document = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  }

  loadCount += 1
  await import(`../client.js?v=${loadCount}`)

  const ctx = {
    effect: run => { run(); return () => {} },
    locale: {
      register: (namespace, tables) => { Object.assign(dicts, tables); return () => {} },
      bind: namespace => key => dicts.en?.[key] ?? key,
    },
    slots: {
      inject: (name, install) => {
        const result = install()
        const values = result !== null && typeof result === 'object' && Symbol.iterator in result
          ? [...result]
          : [result]
        for (const value of values) registered.push({ slot: name, value })
      },
      register: (options, component) => ({ options, component }),
    },
    contextMenus: {
      register: input => { registered.push({ contribution: input }); return () => {} },
      notify: (text, success) => {
        calls.order.push('notify')
        notices.push({ text, success })
      },
    },
    get: name => {
      if (name === 'sessions') {
        return { async refresh() { calls.order.push('refresh'); calls.refresh += 1 } }
      }
          return undefined
    },
  }

  assert.deepEqual(module.inject, ['contextMenus', 'locale', 'slots'])
  module.apply(ctx)

  return { module, ctx, registered, notices, calls, dicts }
}

test('registers the icon, the confirm dialog, and the header row', async () => {
  const { React } = createFakeReact()
  const { registered } = await loadClient(() => React)

  const icon = registered.find(entry => entry.slot === 'contextMenu.icon')
  assert.equal(icon.value.options.key, 'permanent-session-delete.trash')

  const overlay = registered.find(entry => entry.slot === 'shell.overlay')
  assert.equal(overlay.value.options.locale, 'permanent-session-delete')

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  assert.equal(menu.target, 'session')
  const action = menu.resolve({ sessionId: 'abc' })[0]
  assert.equal(action.label, 'Delete permanently')
  assert.equal(action.separatorBefore, true)
  assert.equal(action.afterContent, true, 'the row renders after the built-in Session actions')
  assert.equal(action.danger, undefined, 'the row must not be styled as a danger action')
  assert.equal(typeof action.run, 'function')
})

test('clicking the row only opens the confirmation, it does not delete', async () => {
  const { React } = createFakeReact()
  const { registered, notices } = await loadClient(() => React)

  let requested = 0
  globalThis.fetch = async () => {
    requested += 1
    return { ok: true, json: async () => ({ ok: true }) }
  }

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  await menu.resolve({ sessionId: 'abc' })[0].run()
  assert.equal(requested, 0)
  assert.equal(notices.length, 0)
})

test('confirming deletes, closes, refreshes, and toasts', async () => {
  const fake = createFakeReact()
  const { registered, notices, calls } = await loadClient(() => fake.React)

  const overlay = registered.find(entry => entry.slot === 'shell.overlay')
  const Dialog = overlay.value.component
  fake.render.component = Dialog
  fake.render.props = { t: key => key }
  fake.render.render()

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  menu.resolve({ sessionId: 'abc' })[0].run()   // opens the dialog and re-renders
  assert.ok(find(fake.render.tree, node => node.props?.role === 'dialog') !== undefined)

  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, json: async () => ({ ok: true }) }
  }

  const confirm = find(fake.render.tree, node => node.props?.className === 'pd-button pd-primary')
  await confirm.props.onClick()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'api/session.permanentDelete')
  assert.equal(requests[0].init.body, JSON.stringify({ sessionId: 'abc' }))
  assert.deepEqual(calls.order, ['refresh', 'notify'])
  assert.deepEqual(notices.at(-1), { text: 'Conversation permanently deleted.', success: true })
  assert.equal(find(fake.render.tree, node => node.props?.role === 'dialog'), undefined)
})

test('cancelling closes without a request', async () => {
  const fake = createFakeReact()
  const { registered } = await loadClient(() => fake.React)

  const overlay = registered.find(entry => entry.slot === 'shell.overlay')
  fake.render.component = overlay.value.component
  fake.render.props = { t: key => key }
  fake.render.render()

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  menu.resolve({ sessionId: 'abc' })[0].run()

  let requested = 0
  globalThis.fetch = async () => { requested += 1; return { ok: true } }

  const cancel = find(fake.render.tree, node => node.props?.className === 'pd-button')
  cancel.props.onClick()
  assert.equal(requested, 0)
  assert.equal(find(fake.render.tree, node => node.props?.role === 'dialog'), undefined)
})

test('a refused deletion keeps the dialog open with a localized error', async () => {
  const fake = createFakeReact()
  const { registered } = await loadClient(() => fake.React)

  const overlay = registered.find(entry => entry.slot === 'shell.overlay')
  fake.render.component = overlay.value.component
  fake.render.props = { t: key => key }
  fake.render.render()

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  menu.resolve({ sessionId: 'abc' })[0].run()

  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'running' }),
  })

  const confirm = find(fake.render.tree, node => node.props?.className === 'pd-button pd-primary')
  await confirm.props.onClick()

  const dialog = find(fake.render.tree, node => node.props?.role === 'dialog')
  assert.ok(dialog !== undefined, 'the dialog stays open after a refusal')
  assert.ok(find(fake.render.tree, node => node.props?.role === 'alert') !== undefined)
})

test('reports how many sub-agent sessions went with the conversation', async () => {
  const fake = createFakeReact()
  const { registered, notices } = await loadClient(() => fake.React)

  const overlay = registered.find(entry => entry.slot === 'shell.overlay')
  fake.render.component = overlay.value.component
  fake.render.props = { t: key => key }
  fake.render.render()

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  menu.resolve({ sessionId: 'abc' })[0].run()

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, descendants: 2 }) })
  const confirm = find(fake.render.tree, node => node.props?.className === 'pd-button pd-primary')
  await confirm.props.onClick()

  assert.deepEqual(notices.at(-1), {
    text: 'Conversation and {count} sub-agent session(s) permanently deleted.',
    success: true,
  })
})

test('reports a sub-agent still loaded in this run', async () => {
  const fake = createFakeReact()
  const { registered, notices } = await loadClient(() => fake.React)

  const overlay = registered.find(entry => entry.slot === 'shell.overlay')
  fake.render.component = overlay.value.component
  fake.render.props = { t: key => key }
  fake.render.render()

  const menu = registered.find(entry => entry.contribution !== undefined).contribution
  menu.resolve({ sessionId: 'abc' })[0].run()

  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'descendant-live' }),
  })
  const confirm = find(fake.render.tree, node => node.props?.className === 'pd-button pd-primary')
  await confirm.props.onClick()

  const dialog = find(fake.render.tree, node => node.props?.role === 'dialog')
  assert.ok(dialog !== undefined, 'the dialog stays open')
  assert.deepEqual(notices, [])
})
