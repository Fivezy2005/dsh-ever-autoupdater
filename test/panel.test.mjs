// Run: node --test test/
// Settings panel back end: settings store, skipped versions, manual runs, local routes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { apply, armScheduler, buildPlan, effectiveConfig, resolveConfig, run, runningAgentIds } from '../plugin/dsh-autoupdater/lib/index.js'
import { SETTING_KEYS, readSettings, readSkipped, saveSettings, validateSettings } from '../plugin/dsh-autoupdater/lib/store.js'
import { buildOverview, handleAction, isLoopback, registerRoutes, saveSettingsRequest } from '../plugin/dsh-autoupdater/lib/api.js'

const log = { info() {}, warn() {}, error() {} }

function makeState(dependencies = {}, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'panel-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies }))
  return { home, profileDir, profileName: 'desktop', manager: undefined, hostCtx: { get: () => undefined }, running: false, baseConfig: {}, nextAt: null, ...extra }
}

function fakeManager(names) {
  const calls = []
  const table = new Map(names.map((name) => [name, { name, version: '1.0.0', enabled: true, removable: true }]))
  return {
    calls,
    table,
    listBundles: async () => [...table.values()],
    setBundleEnabled: async (name, enabled) => { calls.push(['enable', name, enabled]); table.get(name).enabled = enabled; return { application: 'applied' } },
    removeBundle: async (name) => { calls.push(['remove', name]); table.delete(name); return { application: 'applied' } },
    installBundle: async (spec, options) => {
      calls.push(['install', spec])
      const at = spec.lastIndexOf('@')
      table.set(spec.slice(0, at), { name: spec.slice(0, at), version: spec.slice(at + 1), enabled: options.enabled, removable: true })
      return { application: 'applied' }
    },
  }
}

const fakeCompat = () => ({
  available: true,
  hostVersion: '0.2.2-rc.1',
  hostPackages: new Set(),
  manifestFacts: () => ({}),
  deriveHostCompatibility: () => ({ status: 'unknown', requirement: null }),
  findCompatibleVersion: async () => null,
})
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
const npmRow = (name, latest) => ({ name, kind: 'npm', current: '1.0.0', version: '1.0.0', latest, updateAvailable: true })

function marketStub(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'market-'))
  const file = join(dir, 'updates.js')
  writeFileSync(file, `export async function checkUpdates() { return ${JSON.stringify(rows)} }\n`)
  return file
}

const rowsOf = (...names) => Object.fromEntries(names.map((name) => [name, { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.0.1', updateAvailable: true }]))
const deps = (extra = {}) => ({ compat: fakeCompat(), fetchImpl: okFetch, ...extra })

// ------------------------------------------------------------------ settings store

test('settings: only known keys with valid values are accepted', () => {
  assert.deepEqual(validateSettings({ autoApply: true, intervalHours: 6 }), { ok: true, value: { autoApply: true, intervalHours: 6 } })
  assert.equal(validateSettings({ bogus: 1 }).ok, false)
  assert.match(validateSettings({ bogus: 1 }).error, /unknown setting "bogus"/)
  assert.match(validateSettings({ intervalHours: -1 }).error, /intervalHours/)
  assert.match(validateSettings({ intervalHours: '3' }).error, /intervalHours/)
  assert.match(validateSettings({ scheduleMode: 'hourly' }).error, /scheduleMode/)
  assert.match(validateSettings({ dailyTime: '25:00' }).error, /dailyTime/)
  assert.match(validateSettings({ maxUpdatesPerRun: 1.5 }).error, /maxUpdatesPerRun/)
  assert.match(validateSettings({ skipPackages: ['ok', ''] }).error, /skipPackages/)
  assert.equal(validateSettings([]).ok, false)
  assert.equal(validateSettings(null).ok, false)
  assert.deepEqual(validateSettings({ skipPackages: [' a '] }).value.skipPackages, ['a'])
  assert.ok(SETTING_KEYS.includes('autoApply') && !SETTING_KEYS.includes('registry') && !SETTING_KEYS.includes('marketModule'))
})

test('settings: saved values persist, merge, and bad entries on disk are dropped', () => {
  const state = makeState()
  assert.deepEqual(readSettings(state.home), {})
  saveSettings(state.home, { autoApply: true })
  saveSettings(state.home, { intervalHours: 6 })
  assert.deepEqual(readSettings(state.home), { autoApply: true, intervalHours: 6 })
  writeFileSync(join(state.home, 'autoupdater', 'settings.json'), JSON.stringify({ autoApply: 'yes', intervalHours: 2, extra: 1 }))
  assert.deepEqual(readSettings(state.home), { intervalHours: 2 })
  writeFileSync(join(state.home, 'autoupdater', 'settings.json'), 'not json')
  assert.deepEqual(readSettings(state.home), {})
})

test('effectiveConfig: shipped defaults, then saved settings; the updater itself stays in skipPackages', () => {
  const state = makeState({}, { baseConfig: { autoApply: false, intervalHours: 4, registry: 'https://example.test' } })
  assert.equal(effectiveConfig(state).autoApply, false)
  saveSettings(state.home, { autoApply: true, skipPackages: ['x'] })
  const cfg = effectiveConfig(state)
  assert.equal(cfg.autoApply, true)
  assert.equal(cfg.intervalHours, 4)
  assert.equal(cfg.registry, 'https://example.test')
  assert.deepEqual([...cfg.skipPackages].sort(), ['dsh-autoupdater', 'x'])
})

test('armScheduler: re-arming uses the saved interval and does not queue a boot check', () => {
  const state = makeState({}, { baseConfig: { intervalHours: 1, jitterMinutes: 0, startupDelayMs: 10 } })
  try {
    armScheduler(state, log)
    const first = Date.parse(state.nextAt)
    saveSettings(state.home, { intervalHours: 5 })
    armScheduler(state, log)
    const second = Date.parse(state.nextAt)
    assert.ok(second - first > 3.5 * 3600_000 && second - first < 4.5 * 3600_000, 'interval moved from 1h to 5h')
    saveSettings(state.home, { scheduleMode: 'startup-only' })
    armScheduler(state, log)
    assert.equal(state.nextAt, null)
  } finally {
    state.scheduler?.stop()
  }
})

// ------------------------------------------------------------------ skipped versions

test('skip: a skipped target version is not offered again; a newer one is', async () => {
  const state = makeState({ p: '1.0.0' })
  state.manager = fakeManager(['p'])
  const cfg = resolveConfig({})
  assert.deepEqual((await handleAction(state, { action: 'skip', name: 'p', version: '1.0.1' }, {})).body, { ok: true })
  assert.deepEqual(readSkipped(state.home), { p: '1.0.1' })

  const same = await buildPlan({ rows: [npmRow('p', '1.0.1')] }, state, cfg, deps({ log }))
  assert.equal(same.plan.length, 0)
  assert.match(same.skipped[0].reason, /you skipped 1\.0\.1/)
  assert.equal(same.skipped[0].userSkipped, true)

  const newer = await buildPlan({ rows: [npmRow('p', '1.0.2')] }, state, cfg, deps({ log }))
  assert.equal(newer.plan.length, 1)
  assert.equal(newer.plan[0].version, '1.0.2')

  await handleAction(state, { action: 'unskip', name: 'p' }, {})
  assert.deepEqual(readSkipped(state.home), {})
  const back = await buildPlan({ rows: [npmRow('p', '1.0.1')] }, state, cfg, deps({ log }))
  assert.equal(back.plan.length, 1)
})

test('skip: bad requests are refused', async () => {
  const state = makeState()
  assert.equal((await handleAction(state, { action: 'skip', name: '', version: '1' }, {})).status, 400)
  assert.equal((await handleAction(state, { action: 'skip', name: 'p' }, {})).status, 400)
  assert.equal((await handleAction(state, { action: 'nope' }, {})).status, 400)
  assert.equal((await handleAction(state, null, {})).status, 400)
})

// ------------------------------------------------------------------ manual runs

function manualSetup({ busy = false, autoApply = false, names = ['a', 'b', 'c'] } = {}) {
  const state = makeState(Object.fromEntries(names.map((n) => [n, '1.0.0'])))
  state.manager = fakeManager(names)
  if (busy) state.hostCtx = { get: () => ({ list: () => [{ id: 'session-1', status: 'running' }] }) }
  const cfg = resolveConfig({ marketModule: marketStub(rowsOf(...names)), autoApply, maxUpdatesPerRun: 1 })
  return { state, cfg }
}

test('manual check: reports and applies nothing, even when idle and autoApply is on', async () => {
  const { state, cfg } = manualSetup({ autoApply: true })
  const report = await run(state, cfg, log, 'manual', deps({ manual: {} }))
  assert.equal(report.reason, 'manual')
  assert.equal(report.updates.length, 3)
  assert.equal(report.applied.length, 0)
  assert.ok(report.deferred.every((item) => item.reason === 'check only'))
  assert.equal(state.manager.calls.length, 0)
})

test('manual update, idle: ignores autoApply=false and the per-run limit', async () => {
  const { state, cfg } = manualSetup({ autoApply: false })
  const report = await run(state, cfg, log, 'manual', deps({ manual: { apply: true } }))
  assert.equal(report.applied.length, 3)
  assert.equal(report.deferred.length, 0)
  assert.equal(state.manager.table.get('a').version, '1.0.1')
})

test('manual update, agents running, no confirmation: nothing changes and the caller is asked', async () => {
  const { state, cfg } = manualSetup({ busy: true })
  const report = await run(state, cfg, log, 'manual', deps({ manual: { apply: true, names: ['a', 'b'] } }))
  assert.equal(report.needsConfirmation, true)
  assert.deepEqual(report.runningAgents, ['session-1'])
  assert.deepEqual(report.updates.map((u) => u.name), ['a', 'b'])
  assert.equal(report.applied.length, 0)
  assert.equal(state.manager.calls.length, 0)
  assert.equal(state.running, false, 'the running flag is released')
})

test('manual update, agents running, confirmed: only the chosen packages are updated', async () => {
  const { state, cfg } = manualSetup({ busy: true })
  const report = await run(state, cfg, log, 'manual', deps({ manual: { apply: true, confirmed: true, names: ['b'] } }))
  assert.equal(report.needsConfirmation, undefined)
  assert.deepEqual(report.applied.map((item) => item.name), ['b'])
  assert.equal(state.manager.table.get('b').version, '1.0.1')
  assert.equal(state.manager.table.get('a').version, '1.0.0')
})

test('scheduled run is unchanged: agents running → deferred, never asks', async () => {
  const { state, cfg } = manualSetup({ busy: true, autoApply: true })
  const report = await run(state, cfg, log, 'scheduled', deps())
  assert.equal(report.applied.length, 0)
  assert.equal(report.needsConfirmation, undefined)
  assert.ok(report.deferred.every((item) => /agents running/.test(item.reason)))
})

// ------------------------------------------------------------------ actions through the API layer

function apiFor(state, overrides = {}) {
  return {
    run: (s, cfg, l, reason, extra) => run(s, cfg, l, reason, { ...deps(), ...extra }),
    effectiveConfig,
    rearm: overrides.rearm ?? (() => {}),
    runningAgentIds,
    log,
  }
}

test('action update: asks for confirmation, then applies when confirmed', async () => {
  const { state } = manualSetup({ busy: true, names: ['a'] })
  state.baseConfig = { marketModule: marketStub(rowsOf('a')) }
  const api = apiFor(state)
  const asked = await handleAction(state, { action: 'update', names: ['a'] }, api)
  assert.equal(asked.status, 200)
  assert.equal(asked.body.needsConfirmation, true)
  assert.deepEqual(asked.body.runningAgents, ['session-1'])
  assert.equal(state.manager.calls.length, 0)

  const done = await handleAction(state, { action: 'update', names: ['a'], confirmed: true }, api)
  assert.equal(done.body.report.applied.length, 1)
  assert.equal(JSON.parse(readFileSync(join(state.home, 'autoupdater', 'last-run.json'), 'utf8')).reason, 'manual')
})

test('action: a run already in progress → 409, bad names → 400', async () => {
  const { state } = manualSetup({ names: ['a'] })
  state.baseConfig = { marketModule: marketStub(rowsOf('a')) }
  const api = apiFor(state)
  assert.equal((await handleAction(state, { action: 'update', names: 'a' }, api)).status, 400)
  state.running = true
  const busy = await handleAction(state, { action: 'check' }, api)
  assert.equal(busy.status, 409)
  assert.match(busy.body.error, /already running/)
})

test('action clearFailed: one package or all', async () => {
  const state = makeState()
  const file = join(state.home, 'autoupdater', 'failed-versions.json')
  mkdirSync(join(state.home, 'autoupdater'), { recursive: true })
  writeFileSync(file, JSON.stringify({ a: { target: '1' }, b: { target: '2' } }))
  await handleAction(state, { action: 'clearFailed', name: 'a' }, {})
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['b'])
  await handleAction(state, { action: 'clearFailed' }, {})
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  assert.equal((await handleAction(state, { action: 'clearFailed', name: 5 }, {})).status, 400)
})

test('settings request: invalid → 400 and nothing written; valid → saved and re-armed', () => {
  const state = makeState()
  let rearmed = 0
  const api = apiFor(state, { rearm: () => { rearmed++ } })
  const bad = saveSettingsRequest(state, { intervalHours: -5 }, api)
  assert.equal(bad.status, 400)
  assert.equal(existsSync(join(state.home, 'autoupdater', 'settings.json')), false)
  assert.equal(rearmed, 0)
  const good = saveSettingsRequest(state, { autoApply: true, intervalHours: 6 }, api)
  assert.equal(good.status, 200)
  assert.equal(good.body.settings.intervalHours, 6)
  assert.deepEqual(readSettings(state.home), { autoApply: true, intervalHours: 6 })
  assert.equal(rearmed, 1)
  const noSelf = saveSettingsRequest(state, { skipPackages: ['x'] }, api)
  assert.ok(noSelf.body.settings.skipPackages.includes('dsh-autoupdater'))
})

test('overview: pending excludes applied and user-skipped; carries settings, agents and history', async () => {
  const state = makeState()
  mkdirSync(join(state.home, 'autoupdater'), { recursive: true })
  writeFileSync(join(state.home, 'autoupdater', 'last-run.json'), JSON.stringify({
    host: { version: '0.2.2-rc.1', checked: true },
    updates: [{ name: 'a', to: '1.1.0' }, { name: 'b', to: '2.0.0' }, { name: 'c', to: '3.0.0' }],
    applied: [{ name: 'a', to: '1.1.0' }],
    failed: [],
  }))
  writeFileSync(join(state.home, 'autoupdater', 'skipped-versions.json'), JSON.stringify({ b: '2.0.0' }))
  state.nextAt = '2026-11-10T18:00:00.000Z'
  state.hostCtx = { get: () => ({ list: () => [{ id: 's1', status: 'running' }] }) }
  const overview = buildOverview(state, apiFor(state))
  assert.deepEqual(overview.pending.map((item) => item.name), ['c'])
  assert.deepEqual(overview.runningAgents, ['s1'])
  assert.equal(overview.nextCheckAt, '2026-11-10T18:00:00.000Z')
  assert.equal(overview.settings.intervalHours, 3)
  assert.equal(overview.host.version, '0.2.2-rc.1')
  assert.deepEqual(overview.skippedVersions, { b: '2.0.0' })
  // Without any report the overview is still well-formed.
  const empty = buildOverview(makeState(), apiFor(state))
  assert.deepEqual(empty.pending, [])
  assert.equal(empty.lastRun, null)
})

// ------------------------------------------------------------------ routes

function fakeWebServer() {
  const routes = new Map()
  const removed = []
  return {
    routes,
    removed,
    register: (spec) => {
      routes.set(spec.path, spec.handler)
      return () => removed.push(spec.path)
    },
  }
}

function request(method, address, body) {
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress: address }
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
    req.emit('end')
  })
  return req
}

function response() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value }
  const done = new Promise((resolve) => { res.end = (text) => { res.body = text; resolve(res) } })
  res.done = done
  return res
}

async function call(server, path, method, address, body) {
  const res = response()
  server.routes.get(path)(request(method, address, body), res)
  await res.done
  return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body), headers: res.headers }
}

test('isLoopback: only the local addresses', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback({ socket: { remoteAddress: address } }), true)
  for (const address of ['192.168.1.5', '::ffff:10.0.0.1', '', undefined]) assert.equal(isLoopback({ socket: { remoteAddress: address } }), false)
  assert.equal(isLoopback({}), false)
})

test('routes: loopback only, method checked, JSON validated, state required', async () => {
  const state = makeState({ a: '1.0.0' })
  state.manager = fakeManager(['a'])
  const holder = { state }
  const server = fakeWebServer()
  const dispose = registerRoutes(server, holder, apiFor(state))
  assert.deepEqual([...server.routes.keys()].sort(), ['/api/dsh-autoupdater/action', '/api/dsh-autoupdater/overview', '/api/dsh-autoupdater/settings'])

  const overview = '/api/dsh-autoupdater/overview'
  const settings = '/api/dsh-autoupdater/settings'
  const action = '/api/dsh-autoupdater/action'

  const remote = await call(server, overview, 'GET', '192.168.1.5')
  assert.equal(remote.status, 403)
  assert.equal((await call(server, settings, 'POST', '10.0.0.2', { autoApply: true })).status, 403)
  assert.deepEqual(readSettings(state.home), {}, 'a refused request changes nothing')

  const ok = await call(server, overview, 'GET', '127.0.0.1')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.equal(ok.json.profile, 'desktop')

  assert.equal((await call(server, overview, 'POST', '127.0.0.1', {})).status, 405)
  assert.equal((await call(server, settings, 'GET', '127.0.0.1')).status, 405)
  assert.equal((await call(server, settings, 'POST', '127.0.0.1', '{not json')).status, 400)
  assert.equal((await call(server, settings, 'POST', '127.0.0.1', { nope: 1 })).status, 400)
  const saved = await call(server, settings, 'POST', '::1', { intervalHours: 8 })
  assert.equal(saved.status, 200)
  assert.deepEqual(readSettings(state.home), { intervalHours: 8 })
  assert.equal((await call(server, action, 'POST', '127.0.0.1', { action: 'skip', name: 'a', version: '1.0.1' })).status, 200)
  assert.deepEqual(readSkipped(state.home), { a: '1.0.1' })

  holder.state = null
  assert.equal((await call(server, overview, 'GET', '127.0.0.1')).status, 503)

  dispose()
  assert.equal(server.removed.length, 3)
})

test('routes: an oversized body is refused', async () => {
  const state = makeState()
  const server = fakeWebServer()
  registerRoutes(server, { state }, apiFor(state))
  const res = response()
  server.routes.get('/api/dsh-autoupdater/settings')(request('POST', '127.0.0.1', 'x'.repeat(70 * 1024)), res)
  await res.done
  assert.equal(res.statusCode, 413)
  assert.match(res.body, /too large/)
  assert.deepEqual(readSettings(state.home), {})
})

// ------------------------------------------------------------------ plugin entry

test('apply: one plugin entry needs both the loader and the web server; routes go away with the host scope', async () => {
  const state = makeState()
  const injected = {}
  const effects = []
  const manager = { profile: { dir: state.profileDir, name: 'desktop' }, listBundles: async () => [] }
  const hostCtx = {
    get: (name) => (name === 'pluginManager' ? manager : undefined),
    effect: (fn) => effects.push(fn()),
  }
  const server = fakeWebServer()
  const webCtx = { get: (name) => (name === 'webServer' ? server : undefined), effect: (fn) => effects.push(fn()) }
  const ctx = { logger: () => log, inject: (names, callback) => { injected[names[0]] = callback } }

  apply(ctx, { checkOnStart: false, intervalHours: 0 })
  assert.deepEqual(Object.keys(injected).sort(), ['loader', 'webServer'])

  injected.webServer(webCtx)
  assert.equal(server.routes.size, 3)
  // Routes exist before the loader finished: they answer 503 rather than crash.
  assert.equal((await call(server, '/api/dsh-autoupdater/overview', 'GET', '127.0.0.1')).status, 503)

  injected.loader(hostCtx)
  for (let i = 0; i < 50 && (await call(server, '/api/dsh-autoupdater/overview', 'GET', '127.0.0.1')).status === 503; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const overview = await call(server, '/api/dsh-autoupdater/overview', 'GET', '127.0.0.1')
  assert.equal(overview.status, 200)
  assert.equal(overview.json.profile, 'desktop')

  for (const dispose of effects) dispose?.()
  assert.equal(server.removed.length, 3)
})

test('apply: disabled → no injection at all', () => {
  const injected = []
  apply({ logger: () => log, inject: (names) => injected.push(names) }, { enabled: false })
  assert.deepEqual(injected, [])
})
