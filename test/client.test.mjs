// Run: node --test test/
// Browser half: the loader contract (what the host needs from client.js), without a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('../plugin/dsh-autoupdater/lib/client.js', import.meta.url)), 'utf8')

function load() {
  const loaded = []
  const sandbox = { window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } } }
  vm.runInNewContext(source, sandbox)
  return loaded
}

test('client: registers one module with the right id and a factory', () => {
  const loaded = load()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-autoupdater')
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
  assert.equal(meta.id, 'dsh-autoupdater')
  assert.equal(typeof meta.order, 'number')
  assert.equal(typeof meta.label(), 'string')
  assert.notEqual(meta.label(), '')
  assert.equal(typeof component, 'function')
  dispose()
  assert.deepEqual(unregistered, ['dsh-autoupdater'])
})

test('client: network text is rendered as text only (no innerHTML / eval)', () => {
  assert.ok(!/\binnerHTML\b/.test(source))
  assert.ok(!/\beval\s*\(/.test(source))
  assert.ok(!/new Function\b/.test(source))
})

test('client: only the three local routes are called, by relative path', () => {
  const calls = [...source.matchAll(/(?:getJson|postJson)\('([^']+)'/g)].map((m) => m[1])
  assert.deepEqual([...new Set(calls)].sort(), ['action', 'overview', 'settings'])
  assert.ok(source.includes("const API = 'api/dsh-autoupdater/'"))
})
