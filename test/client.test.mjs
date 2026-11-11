// Run: node --test test/
// Browser half: the loader contract (what the host needs from client.js), without a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('../plugin/dsh-ever-autoupdater/lib/client.js', import.meta.url)), 'utf8')

function load() {
  const loaded = []
  const sandbox = { window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } } }
  vm.runInNewContext(source, sandbox)
  return loaded
}

test('client: registers one module with the right id and a factory', () => {
  const loaded = load()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-ever-autoupdater')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('client: the factory returns the exports (apply + inject) — returning nothing breaks the host', () => {
  const [spec] = load()
  const exports = spec.factory(() => ({}))
  assert.equal(typeof exports, 'object')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(JSON.stringify(exports.inject), '["slots"]') // the array comes from another realm
})

test('client: apply seats a settings.section slot once the settings page exists, and removes it', () => {
  const [spec] = load()
  const exports = spec.factory(() => ({}))
  const registered = []
  const unregistered = []
  let injectCallback
  exports.apply({
    slots: {
      inject: (name, callback) => { assert.equal(name, 'settings.section'); injectCallback = callback },
      register: (meta, component) => { registered.push({ meta, component }); return () => unregistered.push(meta.id) },
    },
  })
  assert.equal(registered.length, 0, 'nothing is registered before the page asks')
  const dispose = injectCallback()
  assert.equal(registered.length, 1)
  const { meta, component } = registered[0]
  assert.equal(meta.name, 'settings.section')
  assert.equal(meta.id, 'dsh-ever-autoupdater')
  assert.equal(typeof meta.order, 'number')
  assert.equal(typeof meta.label(), 'string')
  assert.notEqual(meta.label(), '')
  assert.equal(typeof component, 'function')
  dispose()
  assert.deepEqual(unregistered, ['dsh-ever-autoupdater'])
})

test('client: network text is rendered as text only (no innerHTML / eval)', () => {
  assert.ok(!/\binnerHTML\b/.test(source))
  assert.ok(!/\beval\s*\(/.test(source))
  assert.ok(!/new Function\b/.test(source))
})

test('client: only the three local routes are called, by relative path', () => {
  const calls = [...source.matchAll(/(?:getJson|postJson)\('([^']+)'/g)].map((m) => m[1])
  assert.deepEqual([...new Set(calls)].sort(), ['action', 'overview', 'settings'])
  assert.ok(source.includes("const API = 'api/dsh-ever-autoupdater/'"))
})

// ---- no flicker: a poll that finds nothing new must not touch the DOM -------------------------
function fakeDom() {
  const registry = new Map()
  const make = (tag) => {
    const node = {
      tag, children: [], className: '', hidden: false, attrs: {}, listeners: {}, replaced: 0, _text: '',
      appendChild(child) { child.parent = node; node.children.push(child); return child },
      replaceChildren(...kids) { node.replaced += 1; node.children = []; for (const k of kids) node.appendChild(k) },
      remove() { if (node.id) registry.delete(node.id) },
      setAttribute(k, v) { node.attrs[k] = v },
      addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn) },
      classList: { toggle() {} },
      get childNodes() { return node.children },
      set textContent(v) { node._text = v; node.children = [] },
      get textContent() { return node._text },
      style: {},
    }
    return node
  }
  const document = {
    documentElement: { lang: 'zh' },
    createElement: make,
    getElementById: (id) => registry.get(id) || null,
    head: { appendChild: (n) => { if (n.id) registry.set(n.id, n); return n } },
  }
  return { document, make }
}

const overview = () => ({
  host: { version: '0.2.2-rc.1' },
  lastRun: { at: '2026-11-10T00:00:00.000Z', applied: [], failed: [], rolledBack: [], deferred: [{ name: 'a', reason: 'agents running' }], skipped: [] },
  nextCheckAt: '2099-01-01T00:00:00.000Z',
  runningAgents: [], running: false,
  pending: [{ name: 'a', from: '1.0.0', to: '1.1.0' }],
  settings: { autoApply: false, allowPrerelease: false, scheduleMode: 'interval', intervalHours: 3, dailyTime: '03:30', maxUpdatesPerRun: 3, skipPackages: ['dsh-ever-autoupdater'] },
  failedVersions: {}, skippedVersions: {},
})

async function mounted(data) {
  const { document, make } = fakeDom()
  const timers = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { sandbox.spec = spec } }, confirm: () => true },
    document,
    fetch: async () => ({ ok: true, json: async () => data.current }),
    AbortSignal,
    setInterval: (fn) => { timers.push(fn); return timers.length },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
  }
  vm.runInNewContext(source, sandbox)
  const exports = sandbox.spec.factory((name) => (name === 'react' ? { createElement: (tag, props) => props } : {}))
  let component
  exports.apply({ slots: { inject: (_n, cb) => cb(), register: (_m, c) => { component = c; return () => {} } } })
  const props = component()
  const host = make('div')
  props.ref(host)
  await new Promise((r) => setImmediate(r))
  const root = host.children[0]
  return { root, poll: timers[0], host, props }
}

test('client: a poll with unchanged data rebuilds nothing (no flicker)', async () => {
  const data = { current: overview() }
  const { root, poll } = await mounted(data)
  const blocks = root.children.slice(2) // after header + notice bar
  assert.equal(blocks.length, 4)
  assert.ok(blocks.every((b) => b.replaced === 1), 'first load paints every block exactly once')
  for (let i = 0; i < 3; i++) { await poll(); await new Promise((r) => setImmediate(r)) }
  assert.ok(blocks.every((b) => b.replaced === 1), 'three polls with identical data: still once')
})

test('client: only the block whose data changed is repainted', async () => {
  const data = { current: overview() }
  const { root, poll } = await mounted(data)
  const [status, pending, settings, history] = root.children.slice(2)
  data.current = { ...overview(), pending: [] }
  await poll(); await new Promise((r) => setImmediate(r))
  assert.equal(pending.replaced, 2, 'pending list changed → repainted')
  assert.equal(status.replaced, 1)
  assert.equal(settings.replaced, 1)
  assert.equal(history.replaced, 1)
})

test('client: the settings form is not replaced while it has focus', async () => {
  const data = { current: overview() }
  const { root, poll } = await mounted(data)
  const settings = root.children[4]
  settings.listeners.focusin[0]()
  data.current = { ...overview(), settings: { ...overview().settings, intervalHours: 6 } }
  await poll(); await new Promise((r) => setImmediate(r))
  assert.equal(settings.replaced, 1, 'user is typing → untouched')
  settings.listeners.focusout[0]()
  await poll(); await new Promise((r) => setImmediate(r))
  assert.equal(settings.replaced, 2, 'focus left → new value shown')
})
