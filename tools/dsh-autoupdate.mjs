#!/usr/bin/env node
/**
 * dsh-autoupdate — headless plugin updater for a DSH Next profile.
 *
 * Detection: dshmarket's own checkUpdates() (the same engine the Market UI uses).
 * Apply:     the official headless plugin operation (asar /lib/plugin-cli.js),
 *            which is exactly what `dsh plugin` runs — pnpm under the profile
 *            write lock, with bundle reconciliation and restore-on-rejection.
 *
 * No GUI, no browser session, no `dsh` executable on PATH.
 *
 * Usage:
 *   node dsh-autoupdate.mjs                       # report only (default)
 *   node dsh-autoupdate.mjs --apply               # report + apply
 *   node dsh-autoupdate.mjs --json                # machine-readable report
 *   node dsh-autoupdate.mjs --profile desktop --home C:/Users/fivez/.dsh
 *
 * Exit codes: 0 = nothing to do / applied cleanly, 1 = failure, 2 = nothing to do
 * but with detected updates in report mode (useful for cron: 0 = up to date).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {
    profile: 'desktop',
    home: process.env.DSH_HOME || 'C:/Users/fivez/.dsh',
    next: process.env.DSH_NEXT_EXE || 'D:/Apps/DSH Next/DSH NEXT.exe',
    asar: process.env.DSH_NEXT_ASAR || 'D:/Apps/DSH Next/resources/app.asar',
    apply: false,
    json: false,
    includePrerelease: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--json') out.json = true
    else if (a === '--include-prerelease') out.includePrerelease = true
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--home') out.home = argv[++i]
    else if (a === '--next') out.next = argv[++i]
    else if (a === '--asar') out.asar = argv[++i]
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
const profileDir = join(opts.home, 'profiles', opts.profile)

// ---------------------------------------------------------------- detection

/**
 * The market plugin owns the update engine. It lives in the desktop profile;
 * a different profile's packages are still checked through it, because the
 * engine only reads the profile directory it is pointed at.
 */
function marketUpdatesEntry() {
  const candidates = [
    join(profileDir, 'node_modules', 'dshmarket', 'lib', 'updates.js'),
    join(opts.home, 'profiles', 'desktop', 'node_modules', 'dshmarket', 'lib', 'updates.js'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(
    `dshmarket not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
    `Install it into the profile first: pnpm add dshmarket --dir "${profileDir}"`,
  )
}

async function detect() {
  const entry = marketUpdatesEntry()
  const { checkUpdates } = await import(pathToFileURL(entry).href)
  const statuses = await checkUpdates(opts.profile, true, profileDir)
  return Object.entries(statuses).map(([name, s]) => ({ name, ...s }))
}

// ---------------------------------------------------------------- target building

const COMMIT_PIN = /^[0-9a-f]{40}$/i

/**
 * Mirror of dshmarket's githubUpdateTarget(): keep a branch/tag/semver
 * selector and a monorepo `#path:`, drop a pinned commit (it names the code
 * already on disk, so an update built from it can never move).
 */
function githubUpdateTarget(spec) {
  const at = spec.indexOf('#')
  if (at === -1) return spec
  const repo = spec.slice(0, at)
  let subpath = null
  let ref = null
  for (const selector of spec.slice(at + 1).split('&')) {
    if (!selector.startsWith('path:/')) {
      if (selector !== '' && !COMMIT_PIN.test(selector)) {
        if (ref !== null) return repo
        ref = selector
      }
      continue
    }
    const candidate = selector.slice('path:/'.length)
    const valid = /^[A-Za-z0-9_./-]+$/.test(candidate) &&
      !candidate.split('/').some((s) => s === '' || s === '.' || s === '..')
    if (subpath !== null || !valid) return repo
    subpath = candidate
  }
  const selectors = [...(ref === null ? [] : [ref]), ...(subpath === null ? [] : [`path:/${subpath}`])]
  return selectors.length === 0 ? repo : `${repo}#${selectors.join('&')}`
}

function profileManifest() {
  const file = join(profileDir, 'package.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function installedSpec(name) {
  const m = profileManifest()
  return m.dependencies?.[name] ?? m.devDependencies?.[name] ?? m.optionalDependencies?.[name] ?? null
}

/**
 * Turn one detected update into the exact command the official operation
 * takes. Returns null for rows that must not be touched.
 */
function planFor(row) {
  const spec = installedSpec(row.name)
  if (spec === null) {
    return { ...row, action: 'skip', reason: 'not a direct dependency of the profile' }
  }
  if (row.updateAvailable !== true) {
    // The engine's own verdict. A row can name a version on both sides (a
    // prerelease line the registry's `latest` does not name) and still mean
    // "nothing to do" — a downgrade is not an update.
    return { ...row, action: 'skip', reason: 'no update available' }
  }
  if (row.kind === 'linked' || row.kind === 'generation') {
    return { ...row, action: 'skip', reason: `${row.kind} install — updated in place, never upgraded` }
  }
  if (row.kind === 'npm') {
    if (typeof row.latest !== 'string') {
      return { ...row, action: 'skip', reason: 'no registry version to move to' }
    }
    if (/:|\//.test(spec) && !spec.startsWith('@')) {
      return { ...row, action: 'skip', reason: `spec "${spec}" is not a plain registry name` }
    }
    return { ...row, action: 'add', target: `${row.name}@${row.latest}`, spec }
  }
  if (row.kind === 'github') {
    if (row.unreleasedCommit) {
      return { ...row, action: 'skip', reason: 'newer commit is unreleased (no version bump upstream)' }
    }
    const target = githubUpdateTarget(spec)
    if (target === spec) {
      // A floating spec: `add` of an identical spec is a pnpm no-op, so the
      // re-resolve has to be asked for with `update` (dshmarket #786).
      return { ...row, action: 'update', target: row.name, spec }
    }
    return { ...row, action: 'add', target, spec }
  }
  return { ...row, action: 'skip', reason: `unsupported source kind "${row.kind}"` }
}

// ---------------------------------------------------------------- apply

function runHeadless(args) {
  // `lib/plugin-cli.js` lives INSIDE app.asar, so it is not visible to a plain
  // filesystem check — Electron resolves asar paths at runtime. Only the
  // archive itself and the executable can be probed here.
  const cli = join(opts.asar, 'lib', 'plugin-cli.js')
  if (!existsSync(opts.next) || !existsSync(opts.asar)) {
    throw new Error(`DSH Next not found:\n  exe: ${opts.next}\n  asar: ${opts.asar}`)
  }
  const r = spawnSync(opts.next, [cli, opts.profile, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: opts.home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

// ---------------------------------------------------------------- main

const t0 = Date.now()
try {
  const rows = await detect()
  const plans = rows.map(planFor)
  const updatable = plans.filter((p) => p.action !== 'skip')

  if (opts.json) {
    console.log(JSON.stringify({
      profile: opts.profile,
      elapsedMs: Date.now() - t0,
      total: rows.length,
      updatable: updatable.map((p) => ({
        name: p.name, kind: p.kind, current: p.current, latest: p.latest,
        action: p.action, target: p.target, spec: p.spec,
      })),
      skipped: plans.filter((p) => p.action === 'skip').map((p) => ({ name: p.name, reason: p.reason })),
      applied: [],
    }, null, 2))
  } else {
    console.log(`profile: ${opts.profile}  (${profileDir})`)
    console.log(`checked ${rows.length} packages in ${Date.now() - t0}ms`)
    if (updatable.length === 0) {
      console.log('everything is up to date.')
    } else {
      console.log(`\n${updatable.length} update(s) available:`)
      for (const p of updatable) {
        const from = p.current ?? p.version ?? '?'
        const to = p.kind === 'github' ? (p.latest ?? '?') : p.latest
        console.log(`  ${p.name}: ${from} -> ${to}   [${p.action} ${p.target}]`)
      }
    }
  }

  if (!opts.apply) {
    if (updatable.length > 0) process.exitCode = 2
    process.exit(process.exitCode ?? 0)
  }

  const applied = []
  for (const p of updatable) {
    if (!opts.json) console.log(`\napplying ${p.name} (${p.action} ${p.target}) ...`)
    const r = runHeadless([p.action, p.target])
    const ok = r.exitCode === 0
    applied.push({ name: p.name, action: p.action, target: p.target, exitCode: r.exitCode, ok })
    if (!opts.json) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join('\n')
      console.log(ok ? `  ok` : `  FAILED (exit ${r.exitCode})\n${tail}`)
    }
    if (!ok) {
      console.error(`\nstopping after failure on ${p.name}; the profile is unchanged for the rest.`)
      break
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ profile: opts.profile, applied }, null, 2))
  } else if (applied.some((a) => a.ok)) {
    console.log('\nDone. DSH Next must be restarted for the new plugin code to be loaded.')
  }
  process.exitCode = applied.every((a) => a.ok) ? 0 : 1
} catch (e) {
  console.error(`dsh-autoupdate failed: ${e?.message ?? e}`)
  if (process.env.DSH_AUTOUPDATE_DEBUG) console.error(e?.stack)
  process.exitCode = 1
}
