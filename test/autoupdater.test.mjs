// Run: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULTS, resolveConfig, nextRun, jitterMs, createScheduler, buildPlan, applyUpdate, run,
  compareVersions, classifyJump, describeProcessFailure, describeFailure, pinSpec, runningAgentIds,
} from '../plugin/dsh-ever-autoupdater/lib/index.js'

const log = { info() {}, warn() {}, error() {} }
const iso = (date) => (date === null ? null : date.toISOString())

// ------------------------------------------------------------------ config / schedule

test('defaults: interval, 3h, jitter 5, no cooldown key, self always skipped', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.scheduleMode, 'interval')
  assert.equal(cfg.intervalHours, 3)
  assert.equal(cfg.jitterMinutes, 5)
  assert.equal(cfg.checkOnStart, true)
  assert.ok(!('cooldownHours' in cfg))
  assert.deepEqual(resolveConfig({ skipPackages: ['x'] }).skipPackages.sort(), ['dsh-ever-autoupdater', 'x'])
  assert.equal(resolveConfig({ scheduleMode: 'bogus', dailyTime: '25:99', timeZone: 'Nope/Zone' }).scheduleMode, 'interval')
  assert.equal(resolveConfig({ dailyTime: '25:99' }).dailyTime, DEFAULTS.dailyTime)
  assert.equal(resolveConfig({ timeZone: 'Nope/Zone' }).timeZone, '')
})

test('nextRun: interval / startup-only / zero hours', () => {
  const now = new Date('2026-11-10T12:00:00Z')
  assert.equal(iso(nextRun(resolveConfig({ scheduleMode: 'interval', intervalHours: 3 }), now)), '2026-11-10T15:00:00.000Z')
  assert.equal(nextRun(resolveConfig({ scheduleMode: 'interval', intervalHours: 0 }), now), null)
  assert.equal(nextRun(resolveConfig({ scheduleMode: 'startup-only' }), now), null)
})

test('nextRun daily: read in the configured zone, not the local one', () => {
  const cfg = (extra) => resolveConfig({ scheduleMode: 'daily', dailyTime: '09:30', ...extra })
  // 12:00Z = 07:00 in New York (EST) → 09:30 today is still ahead = 14:30Z
  assert.equal(iso(nextRun(cfg({ timeZone: 'America/New_York' }), new Date('2026-11-10T12:00:00Z'))), '2026-11-10T14:30:00.000Z')
  // 15:00Z = 10:00 in New York → today has passed → tomorrow
  assert.equal(iso(nextRun(cfg({ timeZone: 'America/New_York' }), new Date('2026-11-10T15:00:00Z'))), '2026-11-11T14:30:00.000Z')
  assert.equal(iso(nextRun(cfg({ timeZone: 'Asia/Shanghai' }), new Date('2026-11-10T12:00:00Z'))), '2026-11-11T01:30:00.000Z')
  assert.equal(iso(nextRun(cfg({ timeZone: 'UTC' }), new Date('2026-11-10T09:30:00Z'))), '2026-11-11T09:30:00.000Z') // strictly after now
})

test('nextRun daily across DST: stays on the wall-clock time', () => {
  const cfg = resolveConfig({ scheduleMode: 'daily', dailyTime: '09:30', timeZone: 'America/New_York' })
  // DST ends 2026-11-01: Oct 31 is EDT (UTC-4), Nov 1 is EST (UTC-5)
  assert.equal(iso(nextRun(cfg, new Date('2026-10-31T15:00:00Z'))), '2026-11-01T14:30:00.000Z')
  assert.equal(iso(nextRun(cfg, new Date('2026-10-30T15:00:00Z'))), '2026-10-31T13:30:00.000Z')
})

test('nextRun daily: a time that does not exist (DST gap) moves to the next day', () => {
  const cfg = resolveConfig({ scheduleMode: 'daily', dailyTime: '02:30', timeZone: 'America/New_York' })
  // 2026-03-08 02:30 does not exist in New York
  assert.equal(iso(nextRun(cfg, new Date('2026-03-07T12:00:00Z'))), '2026-03-09T06:30:00.000Z')
})

test('jitter: 0 means none, otherwise within 0..max', () => {
  assert.equal(jitterMs({ jitterMinutes: 0 }), 0)
  assert.equal(jitterMs({ jitterMinutes: 5 }, () => 0), 0)
  assert.equal(jitterMs({ jitterMinutes: 5 }, () => 0.5), 150_000)
  assert.ok(jitterMs({ jitterMinutes: 5 }, () => 0.999999) < 300_000)
})

function fakeClock(start) {
  let current = new Date(start).getTime()
  const queue = []
  return {
    now: () => new Date(current),
    timers: {
      set(fn, ms) { const item = { fn, at: current + ms, ms }; queue.push(item); return item },
      clear(item) { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1) },
    },
    queue,
    /** Advance to the earliest timer and fire it. */
    step() {
      queue.sort((a, b) => a.at - b.at)
      const item = queue.shift()
      current = Math.max(current, item.at)
      item.fn()
      return item
    },
  }
}

test('scheduler: startup trigger, then scheduled triggers re-arm themselves (no setInterval)', () => {
  const clock = fakeClock('2026-11-10T12:00:00Z')
  const fired = []
  const scheduler = createScheduler({
    cfg: resolveConfig({ intervalHours: 3, jitterMinutes: 0, startupDelayMs: 1000 }),
    trigger: (reason) => fired.push(reason),
    now: clock.now, timers: clock.timers, random: () => 0,
  })
  scheduler.start()
  clock.step(); clock.step(); clock.step()
  assert.deepEqual(fired, ['startup', 'scheduled', 'scheduled'])
  assert.equal(clock.queue.length, 1, 'exactly one next trigger is armed')
  scheduler.stop()
  assert.equal(clock.queue.length, 0)
  const source = readFileSync(new URL('../plugin/dsh-ever-autoupdater/lib/index.js', import.meta.url), 'utf8')
  assert.ok(!/\bsetInterval\b/.test(source), 'no setInterval in the plugin')
})

test('scheduler: checkOnStart false and intervalHours 0 arm nothing', () => {
  const clock = fakeClock('2026-11-10T12:00:00Z')
  createScheduler({ cfg: resolveConfig({ checkOnStart: false, intervalHours: 0 }), trigger() {}, now: clock.now, timers: clock.timers }).start()
  assert.equal(clock.queue.length, 0)
})

test('scheduler: a wait longer than a timer can hold is taken in steps and still fires', () => {
  const clock = fakeClock('2026-11-10T12:00:00Z')
  const fired = []
  createScheduler({
    cfg: resolveConfig({ checkOnStart: false, intervalHours: 1000, jitterMinutes: 0 }),
    trigger: (reason) => fired.push(reason), now: clock.now, timers: clock.timers, random: () => 0,
  }).start()
  const first = clock.step()
  assert.equal(first.ms, 2_147_483_647)
  assert.deepEqual(fired, [])
  clock.step()
  assert.deepEqual(fired, ['scheduled'])
})

// ------------------------------------------------------------------ versions

test('compareVersions: semver order incl. prereleases; classifyJump', () => {
  assert.equal(compareVersions('0.83.1', '0.83.0'), 1)
  assert.equal(compareVersions('2.6.0', '2.10.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(classifyJump('1.2.3', '1.2.4'), 0)
  assert.equal(classifyJump('1.2.3', '1.3.0'), 1)
  assert.equal(classifyJump('1.2.3', '2.0.0'), 2)
})

test('describeProcessFailure: stdout is used when stderr is empty (was "exit code 1")', () => {
  assert.equal(describeProcessFailure({ status: 1, stderr: '', stdout: 'line1\nERR_PNPM_X something broke\n' }), 'line1 ERR_PNPM_X something broke')
  assert.equal(describeProcessFailure({ status: 1, stderr: 'boom', stdout: 'ignored' }), 'boom')
  assert.equal(describeProcessFailure({ status: 7, stderr: '', stdout: '' }), 'exit code 7')
  assert.equal(describeFailure({ error: { code: 'operation-error', diagnostic: 'detail' } }), 'operation-error: detail')
})

test('pinSpec keeps path:/semver: and swaps the commit', () => {
  assert.equal(pinSpec('github:o/r', 'a'.repeat(40)), `github:o/r#${'a'.repeat(40)}`)
  assert.equal(pinSpec('github:o/r#path:sub&semver:^1', 'b'.repeat(40)), `github:o/r#${'b'.repeat(40)}&path:sub&semver:^1`)
})

test('runningAgentIds: only status running', () => {
  const host = { get: () => ({ list: () => [{ id: 'a', status: 'running' }, { id: 'b', status: 'idle' }] }) }
  assert.deepEqual(runningAgentIds(host), ['a'])
  assert.deepEqual(runningAgentIds({ get: () => undefined }), [])
})

// ------------------------------------------------------------------ planning

function makeProfile(dependencies) {
  const home = mkdtempSync(join(tmpdir(), 'autoupd-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies }))
  return { home, profileDir, profileName: 'desktop', manager: undefined, hostCtx: { get: () => undefined }, running: false }
}

const HOST = '0.2.2-rc.1'
/** Fake of the market's host info: only the version is read; it no longer screens versions. */
const fakeCompat = () => ({ available: true, hostVersion: HOST })
function fakeFetch(manifests) {
  return async (url) => {
    for (const [key, value] of Object.entries(manifests)) {
      if (String(url).includes(key)) {
        if (value === 404) return { ok: false, status: 404 }
        if (value === 500) return { ok: false, status: 500 }
        if (value === 'throw') throw new Error('network down')
        return { ok: true, status: 200, json: async () => value }
      }
    }
    return { ok: false, status: 404 }
  }
}
const row = (name, current, latest, extra = {}) => ({ name, kind: 'npm', current, version: current, latest, updateAvailable: true, ...extra })
const cfgDefault = resolveConfig({})

test('plan (npm): the latest version is installed even when it declares a newer host', async () => {
  const state = makeProfile({ a: '1.0.0', b: '1.0.0', c: '1.0.0' })
  const detected = { rows: [row('a', '1.0.0', '1.0.1'), row('b', '1.0.0', '1.0.1'), row('c', '1.0.0', '2.0.0')] }
  const fetchImpl = fakeFetch({
    '/a/1.0.1': { engines: { dsh: 'ok' } },
    '/b/1.0.1': {},
    '/c/2.0.0': { engines: { dsh: '>=9.0.0' } },
  })
  const { plan, skipped, host } = await buildPlan(detected, state, cfgDefault, { compat: fakeCompat(), fetchImpl, log })
  const byName = Object.fromEntries(plan.map((entry) => [entry.name, entry]))
  assert.equal(byName.a.target, 'a@1.0.1')
  assert.equal(byName.b.target, 'b@1.0.1')
  // No fallback to an older "compatible" version and no note: the market's latest is the target.
  assert.equal(byName.c.target, 'c@2.0.0')
  assert.equal(byName.c.version, '2.0.0')
  assert.equal(byName.c.note, undefined)
  assert.equal(byName.c.compat, undefined)
  assert.equal(skipped.length, 0)
  assert.equal(host.version, HOST)
})

test('plan (npm): a version missing on the registry is skipped without an install target', async () => {
  const state = makeProfile({ a: '1.0.0', b: '1.0.0' })
  const fetchImpl = fakeFetch({ '/a/1.0.1': 404, '/b/1.0.1': 'throw' })
  const { plan, skipped } = await buildPlan({ rows: [row('a', '1.0.0', '1.0.1'), row('b', '1.0.0', '1.0.1')] }, state, cfgDefault, { compat: fakeCompat(), fetchImpl, log })
  assert.equal(plan.length, 0)
  assert.match(skipped.find((item) => item.name === 'a').reason, /does not exist on the registry/)
  assert.match(skipped.find((item) => item.name === 'b').reason, /could not confirm/)
})

test('plan (git): the target commit is installed without reading its manifest', async () => {
  const sha = (char) => char.repeat(40)
  const state = makeProfile({ g1: 'github:o/g1', g2: 'github:o/g2#path:sub' })
  const git = (name, latest) => ({ name, kind: 'github', current: sha('0'), latest, updateAvailable: true })
  const urls = []
  const fetchImpl = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ engines: { dsh: '>=9.0.0' } }) } }
  const { plan, skipped } = await buildPlan({ rows: [git('g1', sha('1')), git('g2', sha('2'))] }, state, cfgDefault, { compat: fakeCompat(), fetchImpl, log })
  assert.deepEqual(plan.map((entry) => entry.name).sort(), ['g1', 'g2'])
  assert.equal(skipped.length, 0, 'a declaration of a newer host does not skip the commit')
  assert.deepEqual(urls, [], 'the target commit manifest is not read any more')
  assert.equal(plan.find((entry) => entry.name === 'g1').floating, true)
})

test('plan: exclusions each carry a reason; prerelease off by default; order is patch → minor → major', async () => {
  const state = makeProfile({ dshmarket: '1.0.0', 'dsh-ever-autoupdater': '0.1.0', plain: '1.0.0', pre: '1.0.0', major: '1.0.0', minor: '1.0.0', patch: '1.0.0' })
  const detected = {
    rows: [
      row('dshmarket', '1.0.0', '1.1.0'), row('dsh-ever-autoupdater', '0.1.0', '0.2.0'), row('plain', '1.0.0', '1.1.0', { notAPlugin: true }),
      row('pre', '1.0.0', '1.1.0-rc.1'), row('major', '1.0.0', '2.0.0'), row('minor', '1.0.0', '1.1.0'), row('patch', '1.0.0', '1.0.1'),
    ],
  }
  const fetchImpl = fakeFetch({ '/pre/': {}, '/major/': {}, '/minor/': {}, '/patch/': {} })
  const { plan, skipped } = await buildPlan(detected, state, cfgDefault, { compat: fakeCompat(), fetchImpl, log })
  assert.deepEqual(plan.map((entry) => entry.name), ['patch', 'minor', 'major'])
  const reasons = Object.fromEntries(skipped.map((item) => [item.name, item.reason]))
  assert.match(reasons.dshmarket, /market cannot update itself/)
  assert.match(reasons['dsh-ever-autoupdater'], /cannot update itself/)
  assert.match(reasons.plain, /plain dependency/)
  assert.match(reasons.pre, /prerelease/)
  assert.ok(Object.values(reasons).every((reason) => reason !== ''))
})

test('plan: bundles the host marks not removable / unknown are skipped with a reason', async () => {
  const state = makeProfile({ locked: '1.0.0', other: '1.0.0' })
  state.manager = { listBundles: async () => [{ name: 'locked', removable: false, enabled: true, version: '1.0.0' }] }
  const fetchImpl = fakeFetch({ '/locked/': {}, '/other/': {} })
  const { plan, skipped } = await buildPlan({ rows: [row('locked', '1.0.0', '1.0.1'), row('other', '1.0.0', '1.0.1')] }, state, cfgDefault, { compat: fakeCompat(), fetchImpl, log })
  assert.equal(plan.length, 0)
  assert.match(skipped.find((item) => item.name === 'locked').reason, /not removable/)
  assert.match(skipped.find((item) => item.name === 'other').reason, /not a plugin bundle/)
})

// ------------------------------------------------------------------ applying

/** A fake plugin manager that keeps a small in-memory bundle table. */
function fakeManager({ bundle, installVersion, failInstallOnce = false, failRemove = false, failEnable = false }) {
  const calls = []
  const table = new Map(bundle === null ? [] : [[bundle.name, { ...bundle }]])
  let installs = 0
  return {
    calls,
    table,
    listBundles: async () => [...table.values()],
    setBundleEnabled: async (name, enabled) => {
      calls.push(['enable', name, enabled])
      if (failEnable) return { application: 'failed', error: { code: 'x' } }
      table.get(name).enabled = enabled
      return { application: 'applied' }
    },
    removeBundle: async (name) => {
      calls.push(['remove', name])
      if (failRemove) return { application: 'failed', error: { code: 'bundle-in-use' } }
      table.delete(name)
      return { application: 'applied' }
    },
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options])
      installs++
      if (failInstallOnce && installs === 1) return { application: 'failed', error: { code: 'operation-error', diagnostic: 'ERR_PNPM_BOOM' } }
      const name = spec.replace(/@[^@]*$/, '')
      const version = spec.endsWith(`@${entryOld}`) ? entryOld : installVersion ?? spec.split('@').pop()
      table.set(name, { name, version, enabled: options.enabled, removable: true })
      return { application: 'applied' }
    },
  }
}
const entryOld = '1.0.0'
const npmEntry = (extra = {}) => ({ name: 'p', kind: 'npm', current: '1.0.0', version: '1.1.0', target: 'p@1.1.0', ...extra })
const stateWith = (manager) => ({ manager, profileName: 'desktop', home: '.', profileDir: '.' })

test('apply: sequence is disable → remove → install(enabled preserved) → verify', async () => {
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: true, removable: true } })
  const outcome = await applyUpdate(stateWith(manager), npmEntry(), log)
  assert.equal(outcome.ok, true)
  assert.deepEqual(manager.calls.map((call) => call[0]), ['enable', 'remove', 'install'])
  assert.deepEqual(manager.calls[2][2], { enabled: true, saveExact: true })
  assert.equal(manager.table.get('p').version, '1.1.0')
})

test('apply: a package that was disabled stays disabled', async () => {
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: false, removable: true } })
  const outcome = await applyUpdate(stateWith(manager), npmEntry(), log)
  assert.equal(outcome.ok, true)
  assert.deepEqual(manager.calls.map((call) => call[0]), ['remove', 'install'], 'no enable call for an already disabled package')
  assert.equal(manager.calls[1][2].enabled, false)
  assert.equal(manager.table.get('p').enabled, false)
})

test('apply: remove failure → no install, previous enabled state restored', async () => {
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: true, removable: true }, failRemove: true })
  const outcome = await applyUpdate(stateWith(manager), npmEntry(), log)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /remove failed: bundle-in-use/)
  assert.ok(!manager.calls.some((call) => call[0] === 'install'))
  assert.equal(manager.table.get('p').enabled, true)
})

test('apply: install failure → rolled back to the old version and old enabled state, real error text kept', async () => {
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: false, removable: true }, failInstallOnce: true })
  const outcome = await applyUpdate(stateWith(manager), npmEntry(), log)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /ERR_PNPM_BOOM/)
  assert.equal(outcome.rollback.ok, true)
  assert.equal(outcome.rollback.spec, 'p@1.0.0')
  assert.equal(outcome.blameTarget, true)
  assert.equal(manager.table.get('p').version, '1.0.0')
  assert.equal(manager.table.get('p').enabled, false)
})

test('apply: version that did not go up → failure + rollback', async () => {
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: true, removable: true }, installVersion: '1.1.0' })
  const original = manager.installBundle
  manager.installBundle = async (spec, options) => {
    const result = await original(spec, options)
    if (spec === 'p@1.1.0') manager.table.get('p').version = '1.0.0' // the manager "installed" something old
    return result
  }
  const outcome = await applyUpdate(stateWith(manager), npmEntry(), log)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /version after install is 1\.0\.0, expected 1\.1\.0/)
  assert.equal(outcome.rollback.ok, true)
})

test('apply: enabled state drifted after install → corrected, else failure', async () => {
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: false, removable: true } })
  const original = manager.installBundle
  manager.installBundle = async (spec, options) => {
    const result = await original(spec, { ...options, enabled: true }) // pretend the host ignored the option
    return result
  }
  const outcome = await applyUpdate(stateWith(manager), npmEntry(), log)
  assert.equal(outcome.ok, true)
  assert.equal(manager.table.get('p').enabled, false)
})

// ------------------------------------------------------------------ whole cycle

function marketStub(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'market-'))
  const file = join(dir, 'updates.js')
  writeFileSync(file, `export async function checkUpdates() { return ${JSON.stringify(rows)} }\n`)
  return file
}

test('run: failure report has reasons + real error; failed version is not retried; a newer one is', async () => {
  const state = makeProfile({ p: '1.0.0' })
  const manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: true, removable: true }, failInstallOnce: true })
  state.manager = manager
  const cfg = resolveConfig({ marketModule: marketStub({ p: { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.1.0', updateAvailable: true } }) })
  const deps = { fetchImpl: fakeFetch({ '/p/1.1.0': {}, '/p/1.2.0': {} }) }

  const first = await run(state, cfg, log, 'test', deps)
  assert.equal(first.failed.length, 1)
  assert.match(first.failed[0].error, /ERR_PNPM_BOOM/)
  assert.equal(first.rolledBack.length, 1)
  assert.equal(first.rolledBack[0].ok, true)
  const written = JSON.parse(readFileSync(join(state.home, 'autoupdater', 'last-run.json'), 'utf8'))
  assert.equal(written.failed[0].name, 'p')
  assert.ok(existsSync(join(state.home, 'autoupdater', 'failed-versions.json')))

  const second = await run(state, cfg, log, 'test', deps)
  assert.equal(second.updates.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.match(second.skipped[0].reason, /failed before \(1\.1\.0\)/)

  const newerCfg = resolveConfig({ marketModule: marketStub({ p: { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } }) })
  const third = await run(state, newerCfg, log, 'test', deps)
  assert.equal(third.applied.length, 1)
  assert.equal(third.applied[0].to, '1.2.0')
  assert.ok(!('p' in JSON.parse(readFileSync(join(state.home, 'autoupdater', 'failed-versions.json'), 'utf8'))), 'success clears the memory')
})

test('run: idempotent — after a successful update the next run has no updates', async () => {
  const state = makeProfile({ p: '1.0.0' })
  state.manager = fakeManager({ bundle: { name: 'p', version: '1.0.0', enabled: true, removable: true } })
  const deps = { fetchImpl: fakeFetch({ '/p/1.1.0': {} }) }
  const available = { p: { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.1.0', updateAvailable: true } }
  const first = await run(state, resolveConfig({ marketModule: marketStub(available) }), log, 'test', deps)
  assert.equal(first.applied.length, 1)
  const upToDate = { p: { kind: 'npm', version: '1.1.0', current: '1.1.0', latest: null, updateAvailable: false } }
  const second = await run(state, resolveConfig({ marketModule: marketStub(upToDate) }), log, 'test', deps)
  assert.deepEqual(second.updates, [])
})

test('run: running agents → everything deferred with a reason; autoApply false → reported only; cap → deferred', async () => {
  const rows = {}
  const deps = { fetchImpl: fakeFetch({ '/a/1.0.1': {}, '/b/1.0.1': {}, '/c/1.0.1': {} }) }
  for (const name of ['a', 'b', 'c']) rows[name] = { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.0.1', updateAvailable: true }
  const mk = () => {
    const state = makeProfile({ a: '1.0.0', b: '1.0.0', c: '1.0.0' })
    state.manager = fakeManager({ bundle: null })
    for (const name of ['a', 'b', 'c']) state.manager.table.set(name, { name, version: '1.0.0', enabled: true, removable: true })
    return state
  }
  const marketModule = marketStub(rows)

  const busy = mk()
  busy.hostCtx = { get: () => ({ list: () => [{ id: 'x', status: 'running' }] }) }
  const r1 = await run(busy, resolveConfig({ marketModule }), log, 'test', deps)
  assert.equal(r1.applied.length, 0)
  assert.equal(r1.deferred.length, 3)
  assert.ok(r1.deferred.every((item) => /agents running/.test(item.reason)))
  assert.equal(busy.manager.calls.length, 0)

  const r2 = await run(mk(), resolveConfig({ marketModule, autoApply: false }), log, 'test', deps)
  assert.equal(r2.applied.length, 0)
  assert.ok(r2.deferred.every((item) => /autoApply is disabled/.test(item.reason)))

  const r3 = await run(mk(), resolveConfig({ marketModule, maxUpdatesPerRun: 2 }), log, 'test', deps)
  assert.equal(r3.applied.length, 2)
  assert.equal(r3.deferred.length, 1)
  assert.match(r3.deferred[0].reason, /maxUpdatesPerRun/)
})

test('run: re-entry guard skips a second concurrent run', async () => {
  const state = makeProfile({})
  state.running = true
  assert.equal(await run(state, resolveConfig({}), log, 'test'), null)
  assert.equal(state.running, true, 'the running run keeps its flag')
})

// ------------------------------------------------------------------ order: fetch before market functions

test('order: registry facts are read before the host version is resolved', async () => {
  // Importing the market module installs its own dispatcher and breaks `fetch` afterwards,
  // so every registry read has to happen first.
  const state = makeProfile({ p: '1.0.0', q: '1.0.0' })
  const events = []
  const compat = { available: true, get hostVersion() { events.push('host'); return HOST } }
  const fetchImpl = async (url) => { events.push('fetch'); return fakeFetch({ '/p/1.1.0': {}, '/q/1.1.0': {} })(url) }
  await buildPlan({ rows: [row('p', '1.0.0', '1.1.0'), row('q', '1.0.0', '1.1.0')] }, state, cfgDefault, { compat, fetchImpl, log })
  assert.deepEqual(events, ['fetch', 'fetch', 'host'])
})
