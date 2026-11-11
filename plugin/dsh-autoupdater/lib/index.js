/**
 * dsh-autoupdater — check for plugin updates in this profile and apply them.
 *
 * Detection reuses the market's own `checkUpdates()` (dshmarket/lib/updates.js) so the
 * list of updates is exactly the one the market UI shows. When that module is not
 * installed, a built-in npm-registry check takes over (npm packages only).
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const name = 'dsh-autoupdater'

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Run one check shortly after the host boots. */
  checkOnStart: true,
  /** Delay of the boot check, in milliseconds — the host is still warming up before it. */
  startupDelayMs: 45_000,
  /** Periodic re-check, in hours. 0 disables the timer. */
  intervalHours: 6,
  /** Apply the updates that were found. When false the plugin only reports. */
  autoApply: true,
  /** Upper bound of packages updated in one run. */
  maxUpdatesPerRun: 3,
  /** Packages that are never touched. */
  skipPackages: ['dsh-autoupdater'],
  /** Explicit path to dshmarket's `lib/updates.js`. Empty = look it up in the profile. */
  marketModule: '',
  /** Registry used by the built-in fallback check. */
  registry: 'https://registry.npmjs.org',
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const log = ctx.logger('dsh-autoupdater')
  if (cfg.enabled === false) {
    log.info('automatic updates are disabled by configuration')
    return
  }
  // The plugin manager lives in the host scope, one level above the profile entries.
  ctx.inject(['loader'], (hostCtx) => {
    void start(hostCtx, cfg, log).catch((error) => {
      log.error(`could not start: ${describe(error)}`)
    })
  })
}

async function start(hostCtx, cfg, log) {
  const manager = hostCtx.get('pluginManager')
  const profile = manager?.profile ?? hostCtx.get('profileContext')
  const profileDir = profile?.dir
  if (typeof profileDir !== 'string' || profileDir === '') {
    log.warn('the profile directory is unknown — automatic updates are off')
    return
  }
  const state = {
    hostCtx,
    manager,
    profileDir,
    profileName: typeof profile?.name === 'string' ? profile.name : 'desktop',
    home: dirname(dirname(profileDir)),
    running: false,
  }

  if (cfg.checkOnStart !== false) {
    const delay = Number.isFinite(cfg.startupDelayMs) ? Math.max(0, cfg.startupDelayMs) : DEFAULTS.startupDelayMs
    hostCtx.effect(() => {
      const timer = setTimeout(() => {
        void run(state, cfg, log, 'startup').catch((error) => log.error(`check failed: ${describe(error)}`))
      }, delay)
      return () => clearTimeout(timer)
    }, 'dsh-autoupdater.startup')
  }

  const hours = Number.isFinite(cfg.intervalHours) ? cfg.intervalHours : DEFAULTS.intervalHours
  if (hours > 0) {
    const period = hours * 3600_000
    hostCtx.effect(() => {
      const timer = setInterval(() => {
        void run(state, cfg, log, 'interval').catch((error) => log.error(`check failed: ${describe(error)}`))
      }, period)
      return () => clearInterval(timer)
    }, 'dsh-autoupdater.interval')
  }

  log.info(`armed for profile "${state.profileName}" (${state.profileDir})`)
}

/** One check-and-apply cycle. */
async function run(state, cfg, log, reason) {
  if (state.running) {
    log.info('a check is already running — skipping this one')
    return
  }
  state.running = true
  const report = {
    at: new Date().toISOString(),
    reason,
    profile: state.profileName,
    profileDir: state.profileDir,
    source: null,
    manager: state.manager !== undefined,
    runningAgents: [],
    updates: [],
    applied: [],
    deferred: [],
    failed: [],
  }
  try {
    const detected = await detect(state, cfg, log)
    report.source = detected.source
    const plan = buildPlan(detected, state, cfg)
    report.updates = plan.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      current: entry.current ?? null,
      latest: entry.latest ?? null,
      target: entry.target,
    }))
    if (plan.length === 0) {
      log.info('everything is up to date')
      writeReport(state, report)
      return
    }
    log.info(`${plan.length} update(s) available: ${plan.map((entry) => `${entry.name} → ${entry.latest ?? entry.target}`).join(', ')}`)

    const busy = runningAgentIds(state.hostCtx)
    report.runningAgents = busy
    if (busy.length > 0) {
      report.deferred = plan.map((entry) => ({ name: entry.name, reason: `agents running: ${busy.join(', ')}` }))
      log.warn(`not applying: ${busy.length} agent(s) are running (${busy.join(', ')}) — will retry later`)
      writeReport(state, report)
      return
    }
    if (cfg.autoApply === false) {
      report.deferred = plan.map((entry) => ({ name: entry.name, reason: 'autoApply is disabled' }))
      log.info('autoApply is disabled — reporting only')
      writeReport(state, report)
      return
    }

    const limit = Number.isFinite(cfg.maxUpdatesPerRun) && cfg.maxUpdatesPerRun > 0 ? cfg.maxUpdatesPerRun : plan.length
    for (const entry of plan.slice(0, limit)) {
      const outcome = await applyUpdate(state, entry, log)
      if (outcome.ok) {
        report.applied.push({
          name: entry.name,
          target: entry.target,
          action: outcome.action,
          restartRequired: outcome.restartRequired === true,
        })
        log.info(`updated ${entry.name} → ${entry.target} (${outcome.action})`)
      } else {
        report.failed.push({ name: entry.name, target: entry.target, error: outcome.error })
        log.warn(`could not update ${entry.name}: ${outcome.error}`)
      }
    }
    writeReport(state, report)
  } finally {
    state.running = false
  }
}

/**
 * The updates the market would show. The market's own module is preferred so both
 * agree on what "outdated" means; the built-in check is the fallback.
 */
async function detect(state, cfg, log) {
  const modulePath = cfg.marketModule || join(state.profileDir, 'node_modules', 'dshmarket', 'lib', 'updates.js')
  if (existsSync(modulePath)) {
    try {
      const mod = await import(pathToFileURL(modulePath).href)
      const checkUpdates = mod.checkUpdates ?? mod.default?.checkUpdates
      if (typeof checkUpdates === 'function') {
        const rows = await checkUpdates(state.profileName, true, state.profileDir)
        const list = Object.entries(rows ?? {}).map(([name, row]) => ({ name, ...row }))
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
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string') continue
    const installed = spec.replace(/^[\^~]/, '')
    if (!/^\d+\.\d+\.\d+/.test(installed)) continue
    try {
      const response = await fetch(`${cfg.registry}/${encodeURIComponent(name)}/latest`)
      if (!response.ok) continue
      const document = await response.json()
      const latest = document?.version
      if (typeof latest === 'string' && compareVersions(latest, installed) > 0) {
        rows.push({ name, kind: 'npm', current: installed, latest, updateAvailable: true })
      }
    } catch {
      // A registry that cannot be reached is not an update.
    }
  }
  return rows
}

/** Turn detected rows into concrete install targets. */
function buildPlan(detected, state, cfg) {
  const manifest = readManifest(state.profileDir)
  const skip = new Set(cfg.skipPackages ?? DEFAULTS.skipPackages)
  const plan = []
  for (const row of detected.rows) {
    if (row.updateAvailable !== true) continue
    if (skip.has(row.name)) continue
    const target = targetFor(row, manifest)
    if (target === null) continue
    plan.push({ ...row, target: target.target, kind: target.kind, external: target.external })
  }
  return plan
}

/**
 * The specifier to hand to the package manager.
 * npm packages are pinned to the exact version the market reported; git sources keep
 * their reference, minus a pinned commit — that pin is what would freeze the update.
 */
function targetFor(row, manifest) {
  const name = row.name
  if (row.kind === 'npm') {
    const latest = typeof row.latest === 'string' ? row.latest : ''
    if (latest === '') return null
    const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest) ? latest : 'latest'
    return {
      kind: 'npm',
      target: `${name}@${version}`,
      // The package manager installs an exact version; the headless route does the same.
      external: { action: 'add', target: `${name}@${version}` },
    }
  }
  if (row.kind === 'github' || row.kind === 'git') {
    const spec = manifest.dependencies?.[name]
    if (typeof spec !== 'string' || spec === '') return null
    const floating = !/#[0-9a-f]{40}$/i.test(spec)
    const rewritten = spec.replace(/#[0-9a-f]{40}$/i, '')
    return {
      kind: row.kind,
      target: rewritten,
      // A floating reference has to be re-resolved; `add` would answer "already up to
      // date", so the headless route asks for an `update` instead.
      external: floating
        ? { action: 'update', target: name }
        : { action: 'add', target: rewritten },
    }
  }
  return null
}

/**
 * Install the target through the host's manager. A package that is already a
 * dependency has to be removed first — the manager refuses to install over one.
 */
async function applyUpdate(state, entry, log) {
  const manager = state.manager
  if (!manager) {
    const outcome = headlessApply(state, entry)
    if (outcome.ok) log.info(`${entry.name} updated headlessly — a restart loads the new code`)
    return outcome
  }
  const options = { enabled: true, saveExact: entry.kind === 'npm' }

  let result = await manager.installBundle(entry.target, options)
  if (failed(result)) {
    const code = result.error?.code
    if (code !== 'already-installed') return { ok: false, error: describeFailure(result) }
    log.info(`${entry.name} is already installed — reinstalling it`)
    const removal = await manager.removeBundle(entry.name)
    if (failed(removal)) return { ok: false, error: `remove failed: ${describeFailure(removal)}` }
    result = await manager.installBundle(entry.target, options)
    if (failed(result)) return { ok: false, error: `install failed: ${describeFailure(result)}` }
    return { ok: true, action: 'reinstall' }
  }
  return { ok: true, action: 'install' }
}

function failed(result) {
  return result?.application === 'failed'
}

function describeFailure(result) {
  const code = result?.error?.code
  if (code === undefined) return 'unknown failure'
  if (code === 'operation-error') return result.error.diagnostic ?? code
  return code
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
  const args = [cli, state.profileName, entry.external.action, entry.external.target]
  const result = spawnSync(exe, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: state.home },
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (result.error) return { ok: false, error: describe(result.error) }
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail === '' ? `exit code ${result.status}` : detail }
  }
  return { ok: true, action: entry.external.action, restartRequired: true }
}

/** The agents that are currently running — updating under them is not safe. */
function runningAgentIds(hostCtx) {
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

function readManifest(profileDir) {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** The last run, for the user to read outside of the host's log. */
function writeReport(state, report) {
  const dir = join(state.home, 'autoupdater')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'last-run.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    // A report that cannot be written must not fail the cycle.
  }
}

function compareVersions(a, b) {
  const parse = (value) => String(value).split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function describe(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}
