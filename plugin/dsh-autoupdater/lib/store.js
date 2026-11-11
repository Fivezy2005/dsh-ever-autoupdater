/**
 * Small files under `<DSH_HOME>/autoupdater/`: the user's settings, the versions the
 * user skipped, and the JSON helpers the updater shares. Nothing here touches the host.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SCHEDULE_MODES = ['interval', 'daily', 'startup-only']

export function storeDir(home) {
  return join(home, 'autoupdater')
}

export function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Atomic write: temporary file, then rename. */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/

/** The settings the panel may change, each with its validator (true = acceptable). */
const SETTING_RULES = {
  autoApply: (v) => typeof v === 'boolean',
  allowPrerelease: (v) => typeof v === 'boolean',
  scheduleMode: (v) => SCHEDULE_MODES.includes(v),
  intervalHours: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 720,
  dailyTime: (v) => typeof v === 'string' && HH_MM.test(v),
  maxUpdatesPerRun: (v) => Number.isInteger(v) && v >= 0 && v <= 50,
  skipPackages: (v) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 214),
}

export const SETTING_KEYS = Object.keys(SETTING_RULES)

/** `{ ok: true, value }` with only valid known keys, or `{ ok: false, error }` naming the first bad one. */
export function validateSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'settings must be an object' }
  const value = {}
  for (const [key, entry] of Object.entries(input)) {
    const rule = SETTING_RULES[key]
    if (rule === undefined) return { ok: false, error: `unknown setting "${key}"` }
    if (!rule(entry)) return { ok: false, error: `invalid value for "${key}"` }
    value[key] = key === 'skipPackages' ? entry.map((x) => x.trim()) : entry
  }
  return { ok: true, value }
}

/** The saved settings; keys that are unknown or no longer valid are dropped. */
export function readSettings(home) {
  const raw = readJson(join(storeDir(home), 'settings.json'), {})
  const value = {}
  for (const key of SETTING_KEYS) {
    if (key in raw && SETTING_RULES[key](raw[key])) value[key] = raw[key]
  }
  return value
}

/** Merge a validated partial change into the saved settings and return the result. */
export function saveSettings(home, change) {
  const merged = { ...readSettings(home), ...change }
  writeJson(join(storeDir(home), 'settings.json'), merged)
  return merged
}

/** `{ "<package>": "<version the user skipped>" }` */
export function readSkipped(home) {
  const raw = readJson(join(storeDir(home), 'skipped-versions.json'), {})
  const value = {}
  for (const [key, entry] of Object.entries(raw)) if (typeof entry === 'string') value[key] = entry
  return value
}

export function writeSkipped(home, store) {
  writeJson(join(storeDir(home), 'skipped-versions.json'), store)
}
