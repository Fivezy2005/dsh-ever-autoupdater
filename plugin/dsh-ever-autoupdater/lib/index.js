/**
 * dsh-ever-autoupdater — check for plugin updates in this profile and apply them.
 *
 * Detection reuses the market's own `checkUpdates()` (dshmarket/lib/updates.js) so the
 * list of updates is exactly the one the market UI shows. When that module is not
 * installed, a built-in npm-registry check takes over (npm packages only).
 *
 * Before an update is planned it is checked against the running host (the market's own
 * compatibility functions): a version that declares itself incompatible is not
 * installed; npm sources fall back to the newest compatible version instead.
 *
 * Applying goes through the host's in-process `pluginManager` — the same official
 * operation the desktop client uses — so the profile manifest, the bundle bookkeeping
 * (`dsh.profile.bundles`) and the HMR reload all happen in one step. When the host has
 * no plugin manager (a plain CLI host, for instance), the same official operation is
 * invoked headlessly instead; the new code is then live after a restart.
 *
 * The plugin never updates itself: removing it would unload the code performing the
 * update.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { registerRoutes } from './api.js'
import { SCHEDULE_MODES, readSettings, readSkipped, storeDir, writeJson } from './store.js'

export const name = 'dsh-ever-autoupdater'

const SELF = 'dsh-ever-autoupdater'
const MARKET = 'dshmarket'
/** `setTimeout` cannot wait longer than this (≈ 24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647

export const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Run one check shortly after the host boots. */
  checkOnStart: true,
  /** Delay of the boot check, in milliseconds — the host is still warming up before it. */
  startupDelayMs: 45_000,
  /** `interval` (every `intervalHours`), `daily` (at `dailyTime` in `timeZone`) or `startup-only`. */
  scheduleMode: 'interval',
  /** Periodic re-check, in hours. 0 disables the timer in `interval` mode. */
  intervalHours: 3,
  /** `HH:MM`, used by the `daily` mode. */
  dailyTime: '03:30',
  /** IANA time zone the `daily` time is read in. Empty = the machine's local zone. */
  timeZone: '',
  /** Each scheduled trigger waits a random 0..jitterMinutes extra. 0 = no jitter. */
  jitterMinutes: 5,
  /** Apply the updates that were found. When false the plugin only reports. */
  autoApply: true,
  /** Upper bound of packages updated in one run. */
  maxUpdatesPerRun: 3,
  /** Install prerelease versions too. */
  allowPrerelease: false,
  /** Packages that are never touched. */
  skipPackages: [SELF],
  /** Explicit path to dshmarket's `lib/updates.js`. Empty = look it up in the profile. */
  marketModule: '',
  /** Registry used for version lookups. */
  registry: 'https://registry.npmjs.org',
}

const MODES = SCHEDULE_MODES

/** The effective configuration: defaults, overridden by `config`, with bad values replaced. */
export function resolveConfig(config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  if (!MODES.includes(cfg.scheduleMode)) cfg.scheduleMode = DEFAULTS.scheduleMode
  if (!Number.isFinite(cfg.intervalHours) || cfg.intervalHours < 0) cfg.intervalHours = DEFAULTS.intervalHours
  if (!Number.isFinite(cfg.jitterMinutes) || cfg.jitterMinutes < 0) cfg.jitterMinutes = DEFAULTS.jitterMinutes
  if (!Number.isFinite(cfg.startupDelayMs) || cfg.startupDelayMs < 0) cfg.startupDelayMs = DEFAULTS.startupDelayMs
  if (!Number.isFinite(cfg.maxUpdatesPerRun) || cfg.maxUpdatesPerRun < 0) cfg.maxUpdatesPerRun = DEFAULTS.maxUpdatesPerRun
  if (typeof cfg.dailyTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.dailyTime)) cfg.dailyTime = DEFAULTS.dailyTime
  if (typeof cfg.timeZone !== 'string' || !validZone(cfg.timeZone)) cfg.timeZone = ''
  cfg.skipPackages = [...new Set([...(Array.isArray(cfg.skipPackages) ? cfg.skipPackages : []), SELF])]
  return cfg
}

export function apply(ctx, config) {
  const base = config ?? {}
  const cfg = resolveConfig(base)
  const log = ctx.logger('dsh-ever-autoupdater')
  if (cfg.enabled === false) {
    log.info('automatic updates are disabled by configuration')
    return
  }
  const holder = { state: null }
  const api = { run, effectiveConfig, rearm: armScheduler, runningAgentIds, log }
  // The plugin manager lives in the host scope, one level above the profile entries.
  ctx.inject(['loader'], (hostCtx) => {
    void start(hostCtx, base, log)
      .then((state) => {
        holder.state = state ?? null
      })
      .catch((error) => {
        log.error(`could not start: ${describe(error)}`)
      })
  })
  // The settings panel talks to these routes (loopback only).
  ctx.inject(['webServer'], (c) => {
    try {
      const dispose = registerRoutes(c.get('webServer'), holder, api)
      c.effect(() => () => dispose(), 'dsh-ever-autoupdater.routes')
    } catch (error) {
      log.warn(`the settings panel routes could not be registered: ${describe(error)}`)
    }
  })
}

/** The configuration in force: shipped defaults, then the file the panel saves to. */
export function effectiveConfig(state) {
  return resolveConfig({ ...state.baseConfig, ...readSettings(state.home) })
}

/** (Re)create the scheduler from the current settings; the boot check only runs on the first arming. */
export function armScheduler(state, log, { startup = false } = {}) {
  state.scheduler?.stop()
  state.nextAt = null
  const cfg = effectiveConfig(state)
  const scheduler = createScheduler({
    cfg: startup ? cfg : { ...cfg, checkOnStart: false },
    trigger: (reason) => {
      void run(state, effectiveConfig(state), log, reason).catch((error) => log.error(`check failed: ${describe(error)}`))
    },
    onArm: (at) => {
      state.nextAt = at.toISOString()
      log.info(`next check at ${state.nextAt}`)
    },
  })
  state.scheduler = scheduler
  scheduler.start()
  return cfg
}

async function start(hostCtx, baseConfig, log) {
  const manager = hostCtx.get('pluginManager')
  const profile = manager?.profile ?? hostCtx.get('profileContext')
  const profileDir = profile?.dir
  if (typeof profileDir !== 'string' || profileDir === '') {
    log.warn('the profile directory is unknown — automatic updates are off')
    return null
  }
  const state = {
    hostCtx,
    manager,
    baseConfig,
    profileDir,
    profileName: typeof profile?.name === 'string' ? profile.name : 'desktop',
    home: dirname(dirname(profileDir)),
    running: false,
    scheduler: undefined,
    nextAt: null,
  }

  hostCtx.effect(() => () => state.scheduler?.stop(), 'dsh-ever-autoupdater.schedule')
  const cfg = armScheduler(state, log, { startup: true })
  log.info(`armed for profile "${state.profileName}" (${state.profileDir}), mode ${cfg.scheduleMode}`)
  return state
}

// ------------------------------------------------------------------ scheduling

/** Wall-clock parts of an instant in a time zone ('' = local), as a UTC-based millisecond count. */
const formatters = new Map()
function wallMs(ms, timeZone) {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone === '' ? undefined : timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  const parts = {}
  for (const part of formatter.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) parts[part.type] = Number(part.value)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second)
}

function validZone(timeZone) {
  if (timeZone === '') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * The instant at which the wall clock of `timeZone` reads y-m-d h:m, or null when that
 * time does not exist there (a daylight-saving gap). Each guess is checked by formatting
 * it back, so a result is always a time the zone really shows.
 */
function zonedInstant(y, m, d, hour, minute, timeZone) {
  const naive = Date.UTC(y, m - 1, d, hour, minute)
  const first = naive - (wallMs(naive, timeZone) - naive)
  const second = naive - (wallMs(first, timeZone) - first)
  return wallMs(second, timeZone) === naive ? second : null
}

/** The next occurrence of `HH:MM` in `timeZone` strictly after `now`. */
function nextDaily(dailyTime, timeZone, now) {
  const [hour, minute] = dailyTime.split(':').map(Number)
  const today = new Date(wallMs(now.getTime(), timeZone))
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset))
    const instant = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timeZone)
    // A day on which the time does not exist (a DST gap) is skipped; the next one is used.
    if (instant !== null && instant > now.getTime()) return new Date(instant)
  }
  return null
}

/** When the next scheduled check is due (before jitter), or null when none is. */
export function nextRun(cfg, now = new Date()) {
  if (cfg.scheduleMode === 'startup-only') return null
  if (cfg.scheduleMode === 'daily') return nextDaily(cfg.dailyTime, cfg.timeZone, now)
  if (!(cfg.intervalHours > 0)) return null
  return new Date(now.getTime() + cfg.intervalHours * 3600_000)
}

/** A random delay between 0 and `jitterMinutes`, in milliseconds. */
export function jitterMs(cfg, random = Math.random) {
  if (!(cfg.jitterMinutes > 0)) return 0
  return Math.floor(random() * cfg.jitterMinutes * 60_000)
}

/**
 * One trigger, then re-arm: the next time is recomputed after every firing, so a daily
 * trigger does not drift across a daylight-saving change and a wait longer than a timer
 * can hold is simply taken in several steps.
 */
export function createScheduler({
  cfg,
  trigger,
  onArm = () => {},
  now = () => new Date(),
  timers = { set: setTimeout, clear: clearTimeout },
  random = Math.random,
}) {
  let stopped = false
  let startup
  let handle

  function waitUntil(target, fire) {
    const remaining = target - now().getTime()
    handle = timers.set(() => {
      if (stopped) return
      if (target - now().getTime() > 50) waitUntil(target, fire)
      else fire()
    }, Math.max(0, Math.min(remaining, MAX_TIMEOUT_MS)))
  }

  function arm() {
    if (stopped) return
    const base = nextRun(cfg, now())
    if (base === null) return
    const target = new Date(base.getTime() + jitterMs(cfg, random))
    onArm(target)
    waitUntil(target.getTime(), () => {
      // Re-armed first, so a run that is skipped or slow never moves the next trigger.
      arm()
      trigger('scheduled')
    })
  }

  return {
    start() {
      if (cfg.checkOnStart !== false) {
        startup = timers.set(() => {
          if (!stopped) trigger('startup')
        }, cfg.startupDelayMs)
      }
      arm()
    },
    stop() {
      stopped = true
      if (startup !== undefined) timers.clear(startup)
      if (handle !== undefined) timers.clear(handle)
    },
  }
}

// ------------------------------------------------------------------ one cycle

/** One check-and-apply cycle. */
export async function run(state, cfg, log, reason, deps = {}) {
  if (state.running) {
    log.info('a check is already running — skipping this one')
    return null
  }
  state.running = true
  const report = {
    at: new Date().toISOString(),
    reason,
    profile: state.profileName,
    profileDir: state.profileDir,
    source: null,
    manager: state.manager !== undefined,
    host: null,
    runningAgents: [],
    updates: [],
    applied: [],
    deferred: [],
    failed: [],
    skipped: [],
    rolledBack: [],
  }
  try {
    const detected = await detect(state, cfg, log)
    report.source = detected.source
    const planned = await buildPlan(detected, state, cfg, { ...deps, log })
    report.host = planned.host
    report.skipped = planned.skipped
    const plan = planned.plan
    report.updates = plan.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      from: entry.current ?? null,
      to: entry.version ?? entry.latest ?? null,
      target: entry.target,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    }))
    if (plan.length === 0) {
      log.info(report.skipped.length === 0 ? 'everything is up to date' : `nothing to install (${report.skipped.length} skipped)`)
      writeReport(state, report)
      return report
    }
    log.info(`${plan.length} update(s) available: ${plan.map((entry) => `${entry.name} → ${entry.version ?? entry.target}`).join(', ')}`)

    // A manual request (deps.manual) is the user's own command: it ignores autoApply and the
    // per-run limit, may be narrowed to `names`, and passes the running-agent guard only with `confirmed`.
    const manual = deps.manual
    const busy = runningAgentIds(state.hostCtx)
    report.runningAgents = busy
    if (manual?.apply !== true) {
      if (busy.length > 0) {
        report.deferred = plan.map((entry) => ({ name: entry.name, reason: `agents running: ${busy.join(', ')}` }))
        log.warn(`not applying: ${busy.length} agent(s) are running (${busy.join(', ')}) — will retry later`)
        writeReport(state, report)
        return report
      }
      if (manual !== undefined || cfg.autoApply === false) {
        report.deferred = plan.map((entry) => ({ name: entry.name, reason: manual !== undefined ? 'check only' : 'autoApply is disabled' }))
        log.info(manual !== undefined ? 'manual check — nothing applied' : 'autoApply is disabled — reporting only')
        writeReport(state, report)
        return report
      }
    }
    let chosen = plan
    if (manual?.apply === true) {
      if (Array.isArray(manual.names)) chosen = plan.filter((entry) => manual.names.includes(entry.name))
      if (busy.length > 0 && manual.confirmed !== true) {
        report.needsConfirmation = true
        report.updates = chosen.map((entry) => ({ name: entry.name, kind: entry.kind, from: entry.current ?? null, to: entry.version ?? entry.latest ?? null, target: entry.target }))
        log.info(`manual update needs confirmation: ${busy.length} agent(s) are running`)
        return report
      }
    }

    const limit = manual?.apply === true ? chosen.length : cfg.maxUpdatesPerRun > 0 ? cfg.maxUpdatesPerRun : plan.length
    for (const entry of chosen.slice(limit)) {
      report.deferred.push({ name: entry.name, reason: `beyond maxUpdatesPerRun (${limit}) — next run` })
    }
    const failedStore = readFailed(state)
    for (const entry of chosen.slice(0, limit)) {
      const outcome = await (deps.applyUpdate ?? applyUpdate)(state, entry, log)
      if (outcome.ok) {
        report.applied.push({
          name: entry.name,
          from: entry.current ?? null,
          to: entry.version ?? entry.target,
          target: entry.target,
          action: outcome.action,
          restartRequired: outcome.restartRequired === true,
        })
        delete failedStore[entry.name]
        log.info(`updated ${entry.name} → ${entry.version ?? entry.target} (${outcome.action})`)
      } else {
        report.failed.push({ name: entry.name, from: entry.current ?? null, to: entry.version ?? entry.target, target: entry.target, error: outcome.error })
        if (outcome.rollback !== undefined) {
          report.rolledBack.push({ name: entry.name, ...outcome.rollback })
        }
        if (outcome.blameTarget === true) {
          failedStore[entry.name] = { target: entry.version ?? entry.latest ?? entry.target, at: new Date().toISOString(), error: outcome.error }
        }
        log.warn(`could not update ${entry.name}: ${outcome.error}`)
      }
    }
    writeFailed(state, failedStore)
    writeReport(state, report)
    return report
  } finally {
    state.running = false
  }
}

// ------------------------------------------------------------------ detection

/**
 * The updates the market would show. The market's own module is preferred so both
 * agree on what "outdated" means; the built-in check is the fallback.
 */
async function detect(state, cfg, log) {
  const modulePath = cfg.marketModule || join(state.profileDir, 'node_modules', MARKET, 'lib', 'updates.js')
  if (existsSync(modulePath)) {
    try {
      const mod = await import(pathToFileURL(modulePath).href)
      const checkUpdates = mod.checkUpdates ?? mod.default?.checkUpdates
      if (typeof checkUpdates === 'function') {
        const rows = await checkUpdates(state.profileName, true, state.profileDir)
        const list = Object.entries(rows ?? {}).map(([rowName, row]) => ({ name: rowName, ...row }))
        return { source: 'dshmarket', rows: list }
      }
      log.warn('the market module exposes no checkUpdates() — using the built-in check')
    } catch (error) {
      log.warn(`the market module could not be used (${describe(error)}) — using the built-in check`)
    }
  }
  return { source: 'builtin', rows: await builtinDetect(state, cfg) }
}

/** npm-registry check for plain npm dependencies. */
async function builtinDetect(state, cfg) {
  const manifest = readManifest(state.profileDir)
  const rows = []
  for (const [dependency, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string') continue
    const installed = spec.replace(/^[\^~]/, '')
    if (!/^\d+\.\d+\.\d+/.test(installed)) continue
    try {
      const response = await fetch(`${cfg.registry}/${encodeURIComponent(dependency)}/latest`)
      if (!response.ok) continue
      const document = await response.json()
      const latest = document?.version
      if (typeof latest === 'string' && compareVersions(latest, installed) > 0) {
        rows.push({ name: dependency, kind: 'npm', current: installed, latest, updateAvailable: true })
      }
    } catch {
      // A registry that cannot be reached is not an update.
    }
  }
  return rows
}

// ------------------------------------------------------------------ planning

const SEMVER_EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA = /^[0-9a-f]{40}$/i

/**
 * Turn detected rows into install targets: filtered (with a recorded reason for every
 * row that is dropped), checked against the host, and ordered by risk.
 *
 * `deps.compat` and `deps.fetchImpl` are injection points for tests.
 */
export async function buildPlan(detected, state, cfg, deps = {}) {
  const manifest = readManifest(state.profileDir)
  const skip = new Set(cfg.skipPackages ?? DEFAULTS.skipPackages)
  const skipped = []
  const rejected = (row, reason, extra = {}) => skipped.push({ name: row.name, from: row.current ?? row.version ?? null, to: row.latest ?? null, reason, ...extra })

  const bundles = await listBundleMap(state.manager)
  const failedStore = readFailed(state)
  const userSkipped = readSkipped(state.home)
  const candidates = []
  for (const row of detected.rows) {
    if (row.updateAvailable !== true) continue
    if (row.name === SELF || skip.has(row.name)) {
      rejected(row, row.name === SELF ? 'the updater cannot update itself — removing it would unload the code doing the update' : 'listed in skipPackages')
      continue
    }
    if (row.name === MARKET) {
      rejected(row, 'the market cannot update itself — update it by hand with DSH closed')
      continue
    }
    if (row.notAPlugin === true) {
      rejected(row, 'a plain dependency, not a plugin — the market does not update those')
      continue
    }
    const bundle = bundles?.get(row.name)
    if (bundles !== null && bundle === undefined) {
      rejected(row, 'not a plugin bundle of this profile')
      continue
    }
    if (bundle !== undefined && bundle.removable === false) {
      rejected(row, 'the host marks this bundle as not removable')
      continue
    }
    const target = targetFor(row, manifest)
    if (target === null) {
      rejected(row, 'no install target could be derived')
      continue
    }
    candidates.push({ row, target })
  }

  // Everything the compatibility check needs is fetched here, with the native `fetch`.
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const facts = new Map()
  for (const { row, target } of candidates) {
    facts.set(row.name, target.kind === 'npm' ? await fetchNpmManifest(row, cfg, fetchImpl) : await fetchGitManifest(row, manifest, fetchImpl))
  }

  const compat = deps.compat ?? (await loadCompat(state, cfg, deps.log))
  const host = { version: compat.hostVersion ?? null, checked: compat.available }

  const plan = []
  for (const { row, target } of candidates) {
    const fetched = facts.get(row.name)
    const resolved = target.kind === 'npm'
      ? await resolveNpm(row, target, fetched, compat, cfg, fetchImpl)
      : resolveGit(row, target, fetched, compat)
    if (resolved.skip !== undefined) {
      rejected(row, resolved.skip)
      continue
    }
    const entry = { ...row, ...target, ...resolved.entry }
    if (entry.kind === 'npm' && entry.version.includes('-') && cfg.allowPrerelease !== true) {
      rejected(row, `${entry.version} is a prerelease — prereleases are not installed automatically`)
      continue
    }
    const wanted = entry.version ?? entry.latest
    if (userSkipped[row.name] !== undefined && userSkipped[row.name] === wanted) {
      rejected(row, `you skipped ${wanted} — a newer version will be offered again`, { userSkipped: true })
      continue
    }
    const failedBefore = failedStore[row.name]
    if (failedBefore !== undefined && alreadyFailed(entry, failedBefore)) {
      rejected(row, `failed before (${failedBefore.target}) and nothing newer has been published — not retried`)
      continue
    }
    entry.originalSpec = manifest.dependencies?.[row.name]
    plan.push(entry)
  }
  plan.sort(compareRisk)
  return { plan, skipped, host }
}

function alreadyFailed(entry, failedBefore) {
  if (entry.kind === 'npm') return compareVersions(entry.version, failedBefore.target) <= 0
  return entry.latest === failedBefore.target
}

/** Patch → minor → major; a source with no version to compare counts as a minor jump. */
export function classifyJump(from, to) {
  const left = parseSemver(from)
  const right = parseSemver(to)
  if (left === null || right === null) return 1
  if (left.main[0] !== right.main[0]) return 2
  if (left.main[1] !== right.main[1]) return 1
  return 0
}

function compareRisk(a, b) {
  const rank = classifyJump(a.current ?? a.version, a.version) - classifyJump(b.current ?? b.version, b.version)
  return rank !== 0 ? rank : a.name.localeCompare(b.name)
}

async function listBundleMap(manager) {
  if (manager === undefined || typeof manager.listBundles !== 'function') return null
  try {
    return new Map((await manager.listBundles()).map((bundle) => [bundle.name, bundle]))
  } catch {
    return null
  }
}

/**
 * The specifier to hand to the package manager.
 * npm packages are pinned to the exact version the market reported; git sources keep
 * their reference, minus a pinned commit — that pin is what would freeze the update.
 */
function targetFor(row, manifest) {
  const rowName = row.name
  if (row.kind === 'npm') {
    const latest = typeof row.latest === 'string' ? row.latest : ''
    if (!SEMVER_EXACT.test(latest)) return null
    return { kind: 'npm', target: `${rowName}@${latest}`, version: latest }
  }
  if (row.kind === 'github' || row.kind === 'git') {
    const spec = manifest.dependencies?.[rowName]
    if (typeof spec !== 'string' || spec === '') return null
    const floating = !/#[0-9a-f]{40}$/i.test(spec)
    return { kind: row.kind, target: spec.replace(/#[0-9a-f]{40}$/i, ''), floating }
  }
  return null
}

/** The `external` (headless) form of a target. */
function externalFor(entry) {
  if (entry.kind === 'npm') return { action: 'add', target: entry.target }
  // A floating reference has to be re-resolved; `add` would answer "already up to date".
  return entry.floating ? { action: 'update', target: entry.name } : { action: 'add', target: entry.target }
}

// ------------------------------------------------------------------ compatibility

/**
 * The market's own host-compatibility functions and the host version they judge against.
 * Without the market (or without a readable host version) every candidate counts as
 * "undeclared" — installable, because the host refuses a truly incompatible install by
 * itself and a failure is rolled back.
 */
async function loadCompat(state, cfg, log) {
  const none = { available: false, hostVersion: null, hostPackages: new Set() }
  const modulePath = cfg.marketModule || join(state.profileDir, 'node_modules', MARKET, 'lib', 'updates.js')
  const lib = dirname(modulePath)
  const files = {
    compatibility: join(lib, 'discovery-compatibility.js'),
    install: join(lib, 'dsh-install.js'),
    check: join(lib, 'check.js'),
  }
  if (!Object.values(files).every((file) => existsSync(file))) return none
  try {
    const compatibility = await import(pathToFileURL(files.compatibility).href)
    const install = await import(pathToFileURL(files.install).href)
    const check = await import(pathToFileURL(files.check).href)
    const info = install.dshHostInfo()
    return {
      available: true,
      hostVersion: info?.version ?? null,
      hostPackages: check.corePackageNames(info?.directory ?? null),
      manifestFacts: compatibility.manifestFacts,
      deriveHostCompatibility: compatibility.deriveHostCompatibility,
      findCompatibleVersion: compatibility.findCompatibleVersion,
    }
  } catch (error) {
    log?.warn(`the market compatibility check could not be loaded (${describe(error)}) — versions are not screened`)
    return none
  }
}

function verdictOf(compat, manifestJson) {
  if (compat.available !== true || manifestJson === null) return { status: 'unknown', requirement: null }
  const verdict = compat.deriveHostCompatibility(compat.manifestFacts(manifestJson), compat.hostVersion, compat.hostPackages)
  return { status: verdict.status, requirement: verdict.requirement ?? null }
}

async function fetchJsonOrNull(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', 'user-agent': 'dsh-ever-autoupdater' } })
    if (response.status === 404) return { missing: true }
    if (!response.ok) return { error: `HTTP ${response.status}` }
    return { json: await response.json() }
  } catch (error) {
    return { error: describe(error) }
  }
}

/** The manifest of the exact version the market named (`<registry>/<name>/<version>`). */
function fetchNpmManifest(row, cfg, fetchImpl) {
  return fetchJsonOrNull(`${cfg.registry}/${encodeURIComponent(row.name)}/${row.latest}`, fetchImpl)
}

async function resolveNpm(row, target, fetched, compat, cfg, fetchImpl) {
  const latest = target.version
  if (fetched.missing === true) return { skip: `version ${latest} does not exist on the registry` }
  if (fetched.error !== undefined) return { skip: `the registry could not confirm ${latest} (${fetched.error})` }
  const verdict = verdictOf(compat, fetched.json)
  if (verdict.status !== 'incompatible') {
    return { entry: { version: latest, compat: verdict.status, ...(verdict.status === 'unknown' && compat.available ? { note: 'no host compatibility declared — installing anyway' } : {}) } }
  }
  const alternative = await compat.findCompatibleVersion(
    row.name,
    compat.hostVersion,
    compat.hostPackages,
    cfg.registry,
    (url, init) => fetchImpl(url, init),
    typeof row.current === 'string' && SEMVER_EXACT.test(row.current) ? row.current : null,
  )
  if (alternative === null) {
    return { skip: `${latest} needs DSH ${verdict.requirement ?? '(unknown range)'}, this host is ${compat.hostVersion} — and no newer compatible version exists` }
  }
  return {
    entry: {
      version: alternative,
      target: `${row.name}@${alternative}`,
      compat: 'compatible',
      note: `latest ${latest} needs DSH ${verdict.requirement ?? '(unknown range)'} (host ${compat.hostVersion}) — using the newest compatible ${alternative}`,
    },
  }
}

/** `owner/repo` and the optional sub-path of a GitHub spec, or null. */
function githubParts(spec) {
  const match = /(?:^github:|github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[#&]|$)/.exec(spec)
  if (match === null) return null
  const sub = /(?:[#&])path:([^&]+)/.exec(spec)
  return { repo: match[1], path: sub === null ? '' : `${sub[1].replace(/^\/+|\/+$/g, '')}/` }
}

async function fetchGitManifest(row, manifest, fetchImpl) {
  const spec = manifest.dependencies?.[row.name]
  const parts = typeof spec === 'string' ? githubParts(spec) : null
  if (parts === null || typeof row.latest !== 'string' || !SHA.test(row.latest)) return { error: 'not a GitHub source with a known commit' }
  return fetchJsonOrNull(`https://raw.githubusercontent.com/${parts.repo}/${row.latest}/${parts.path}package.json`, fetchImpl)
}

function resolveGit(row, target, fetched, compat) {
  if (fetched.json === undefined) {
    return { entry: { compat: 'unknown', note: 'could not read the compatibility declaration of the target commit — installing anyway' } }
  }
  const verdict = verdictOf(compat, fetched.json)
  if (verdict.status === 'incompatible') {
    return { skip: `target commit needs DSH ${verdict.requirement ?? '(unknown range)'}, this host is ${compat.hostVersion} — history is not searched for an older version` }
  }
  return { entry: { compat: verdict.status } }
}

// ------------------------------------------------------------------ applying

/** A manager call that never throws: a failure becomes a `failed` result. */
async function call(fn) {
  try {
    return await fn()
  } catch (error) {
    return { application: 'failed', error: { code: 'exception', diagnostic: describe(error) } }
  }
}

function failed(result) {
  return result?.application === 'failed'
}

export function describeFailure(result) {
  const code = result?.error?.code
  if (code === undefined) return 'unknown failure'
  const diagnostic = result.error.diagnostic
  return typeof diagnostic === 'string' && diagnostic !== '' ? `${code}: ${diagnostic}` : code
}

/** `owner/repo#<sha>`-style spec with the commit replaced, for a rollback to the previous commit. */
export function pinSpec(spec, sha) {
  const [base, fragment] = spec.split('#')
  if (fragment === undefined) return `${base}#${sha}`
  const rest = fragment.split('&').filter((part) => /^(path|semver):/.test(part))
  return `${base}#${[sha, ...rest].join('&')}`
}

/**
 * Update one package through the host's manager:
 * record state → disable → remove → install → verify, and restore the old version when
 * the install or the verification fails. The manager refuses to install over an
 * existing dependency, so removing first is not optional.
 */
export async function applyUpdate(state, entry, log) {
  const manager = state.manager
  if (!manager) {
    const outcome = headlessApply(state, entry)
    if (outcome.ok) log.info(`${entry.name} updated headlessly — a restart loads the new code`)
    return outcome
  }

  const before = (await call(async () => (await manager.listBundles()).find((bundle) => bundle.name === entry.name)))
  if (before === undefined || failed(before)) {
    return { ok: false, error: before === undefined ? 'the package is not an installed bundle' : `could not read the current state: ${describeFailure(before)}` }
  }
  if (before.removable === false) return { ok: false, error: 'the host marks this bundle as not removable' }
  const wasEnabled = before.enabled === true
  const oldVersion = before.version ?? entry.current ?? null

  if (wasEnabled) {
    const disabled = await call(() => manager.setBundleEnabled(entry.name, false))
    if (failed(disabled)) return { ok: false, error: `disable failed: ${describeFailure(disabled)}` }
  }
  const removal = await call(() => manager.removeBundle(entry.name))
  if (failed(removal)) {
    if (wasEnabled) await call(() => manager.setBundleEnabled(entry.name, true))
    return { ok: false, error: `remove failed: ${describeFailure(removal)}` }
  }

  const options = { enabled: wasEnabled, saveExact: entry.kind === 'npm' }
  const installed = await call(() => manager.installBundle(entry.target, options))
  let problem = failed(installed) ? `install failed: ${describeFailure(installed)}` : null
  if (problem === null) problem = await verifyInstalled(manager, entry, { oldVersion, wasEnabled })
  if (problem === null) return { ok: true, action: 'reinstall' }

  const rollback = await restore(manager, entry, { oldVersion, wasEnabled })
  return { ok: false, error: problem, rollback, blameTarget: true }
}

/** After an install: did the right version arrive, with the state it had before? */
async function verifyInstalled(manager, entry, { oldVersion, wasEnabled }) {
  let bundle = await call(async () => (await manager.listBundles()).find((item) => item.name === entry.name))
  if (bundle === undefined || failed(bundle)) return 'installed, but the package is not listed afterwards'
  if (entry.kind === 'npm') {
    if (bundle.version !== entry.version) return `version after install is ${bundle.version ?? 'unknown'}, expected ${entry.version}`
    if (oldVersion !== null && compareVersions(bundle.version, oldVersion) <= 0) return `version after install (${bundle.version}) is not newer than before (${oldVersion})`
  } else if (oldVersion !== null && bundle.version !== undefined && compareVersions(bundle.version, oldVersion) < 0) {
    return `version after install (${bundle.version}) is older than before (${oldVersion})`
  }
  if ((bundle.enabled === true) !== wasEnabled) {
    const fixed = await call(() => manager.setBundleEnabled(entry.name, wasEnabled))
    bundle = await call(async () => (await manager.listBundles()).find((item) => item.name === entry.name))
    if (failed(fixed) || bundle === undefined || failed(bundle) || (bundle.enabled === true) !== wasEnabled) {
      return `enabled state after install is ${bundle?.enabled === true ? 'on' : 'off'}, it was ${wasEnabled ? 'on' : 'off'} before`
    }
  }
  return null
}

/** Put the previous version back, in its previous enabled state. */
async function restore(manager, entry, { oldVersion, wasEnabled }) {
  const spec = entry.kind === 'npm' && oldVersion !== null
    ? `${entry.name}@${oldVersion}`
    : typeof entry.originalSpec === 'string' && SHA.test(entry.current ?? '') ? pinSpec(entry.originalSpec, entry.current) : entry.originalSpec
  if (typeof spec !== 'string') return { attempted: false, ok: false, error: 'the previous version is not known' }
  // A half-installed package would block the reinstall; a package that is not there is fine.
  await call(() => manager.removeBundle(entry.name))
  const result = await call(() => manager.installBundle(spec, { enabled: wasEnabled, saveExact: entry.kind === 'npm' }))
  return failed(result)
    ? { attempted: true, ok: false, spec, error: describeFailure(result) }
    : { attempted: true, ok: true, spec }
}

/** What a failed child process said: stderr first, then stdout, then the exit code. */
export function describeProcessFailure(result) {
  const lastLines = (text) => String(text ?? '').trim().split('\n').slice(-3).join(' ').trim()
  const detail = lastLines(result.stderr) || lastLines(result.stdout)
  return detail === '' ? `exit code ${result.status}` : detail
}

/**
 * The headless route: the very same official operation the `dsh plugin` command
 * performs, but started as a child process. It is used when the host has no plugin
 * manager. The new code is live after a restart, because the running composition is
 * not recomposed.
 */
function headlessApply(state, entry) {
  const exe = process.execPath
  const cli = join(dirname(exe), 'resources', 'app.asar', 'lib', 'plugin-cli.js')
  if (!existsSync(exe) || !existsSync(dirname(cli))) {
    return { ok: false, error: 'the headless plugin command is not available in this installation' }
  }
  const external = externalFor(entry)
  const result = spawnSync(exe, [cli, state.profileName, external.action, external.target], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: state.home },
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (result.error) return { ok: false, error: describe(result.error) }
  if (result.status !== 0) return { ok: false, error: describeProcessFailure(result) }
  return { ok: true, action: external.action, restartRequired: true }
}

/** The agents that are currently running — updating under them is not safe. */
export function runningAgentIds(hostCtx) {
  const agents = hostCtx.get('agents')
  if (agents === undefined) return []
  let listed
  try {
    listed = agents.list()
  } catch {
    return []
  }
  if (!Array.isArray(listed)) return []
  const ids = []
  for (const agent of listed) {
    if (agent === null || typeof agent !== 'object' || agent.status !== 'running') continue
    const id = typeof agent.id === 'string' && agent.id !== '' ? agent.id : 'agent'
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

// ------------------------------------------------------------------ files

function readManifest(profileDir) {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

function reportDir(state) {
  return storeDir(state.home)
}

/** The last run, for the user to read outside of the host's log. */
function writeReport(state, report) {
  try {
    writeJson(join(reportDir(state), 'last-run.json'), report)
  } catch {
    // A report that cannot be written must not fail the cycle.
  }
}

/** `{ "<package>": { target, at, error } }` — versions that failed, so they are not retried. */
function readFailed(state) {
  try {
    const parsed = JSON.parse(readFileSync(join(reportDir(state), 'failed-versions.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeFailed(state, store) {
  try {
    writeJson(join(reportDir(state), 'failed-versions.json'), store)
  } catch {
    // Losing the memory only means one more retry.
  }
}

// ------------------------------------------------------------------ versions

function parseSemver(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  return {
    main: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Semver order, prereleases included: 1.0.0-rc.1 < 1.0.0. */
export function compareVersions(a, b) {
  const left = parseSemver(a) ?? { main: [0, 0, 0], pre: [] }
  const right = parseSemver(b) ?? { main: [0, 0, 0], pre: [] }
  for (let index = 0; index < 3; index++) {
    if (left.main[index] !== right.main[index]) return left.main[index] > right.main[index] ? 1 : -1
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (numeric) return Number(x) > Number(y) ? 1 : -1
    if (/^\d+$/.test(x)) return -1
    if (/^\d+$/.test(y)) return 1
    return x > y ? 1 : -1
  }
  return 0
}

function describe(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}
