/**
 * The local HTTP face of the updater, for the settings panel. Three routes, loopback only:
 *
 *   GET  /api/dsh-ever-autoupdater/overview   status, pending updates, settings, last run
 *   POST /api/dsh-ever-autoupdater/settings   save a partial settings object
 *   POST /api/dsh-ever-autoupdater/action     check | update | skip | unskip | clearFailed
 *
 * The handlers are plain functions of (state, body, api) so tests call them without a server.
 */
import { join } from 'node:path'
import { readJson, readSettings, readSkipped, saveSettings, storeDir, validateSettings, writeJson, writeSkipped } from './store.js'

const BASE = '/api/dsh-ever-autoupdater'
const BODY_LIMIT = 64 * 1024

export function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function failedFile(state) {
  return join(storeDir(state.home), 'failed-versions.json')
}

function readFailedStore(state) {
  const raw = readJson(failedFile(state), {})
  return Array.isArray(raw) ? {} : raw
}

/** What the panel shows. Never throws; a missing file is an empty section. */
export function buildOverview(state, api) {
  const report = readJson(join(storeDir(state.home), 'last-run.json'), null)
  const skippedByUser = readSkipped(state.home)
  const applied = new Set((report?.applied ?? []).map((item) => item.name))
  const pending = (report?.updates ?? []).filter((item) => !applied.has(item.name) && skippedByUser[item.name] !== item.to)
  return {
    ok: true,
    profile: state.profileName,
    host: report?.host ?? null,
    running: state.running === true,
    nextCheckAt: state.nextAt ?? null,
    runningAgents: api.runningAgentIds(state.hostCtx),
    pending,
    settings: api.effectiveConfig(state),
    saved: readSettings(state.home),
    lastRun: report,
    failedVersions: readFailedStore(state),
    skippedVersions: skippedByUser,
  }
}

export function saveSettingsRequest(state, body, api) {
  const checked = validateSettings(body)
  if (!checked.ok) return { status: 400, body: { ok: false, error: checked.error } }
  saveSettings(state.home, checked.value)
  // Re-armed without a boot check: a changed interval must not trigger an extra run.
  api.rearm(state, api.log)
  return { status: 200, body: { ok: true, settings: api.effectiveConfig(state), nextCheckAt: state.nextAt ?? null } }
}

const NAME = /^[@A-Za-z0-9._~/-]{1,214}$/

export async function handleAction(state, body, api) {
  const action = body?.action
  if (action === 'check' || action === 'update') {
    const manual = action === 'check' ? {} : { apply: true, confirmed: body.confirmed === true }
    if (action === 'update' && body.names !== undefined) {
      if (!Array.isArray(body.names) || body.names.some((n) => typeof n !== 'string')) return { status: 400, body: { ok: false, error: 'names must be a list of package names' } }
      manual.names = body.names
    }
    const report = await api.run(state, api.effectiveConfig(state), api.log, 'manual', { manual })
    if (report === null) return { status: 409, body: { ok: false, error: 'a check is already running — try again in a moment' } }
    if (report.needsConfirmation === true) {
      return { status: 200, body: { ok: true, needsConfirmation: true, runningAgents: report.runningAgents, updates: report.updates } }
    }
    return { status: 200, body: { ok: true, report } }
  }
  if (action === 'skip') {
    if (typeof body.name !== 'string' || !NAME.test(body.name) || typeof body.version !== 'string' || body.version === '') {
      return { status: 400, body: { ok: false, error: 'skip needs a package name and a version' } }
    }
    const store = readSkipped(state.home)
    store[body.name] = body.version
    writeSkipped(state.home, store)
    return { status: 200, body: { ok: true } }
  }
  if (action === 'unskip') {
    const store = readSkipped(state.home)
    delete store[body.name]
    writeSkipped(state.home, store)
    return { status: 200, body: { ok: true } }
  }
  if (action === 'clearFailed') {
    const store = readFailedStore(state)
    if (body.name === undefined) {
      for (const key of Object.keys(store)) delete store[key]
    } else if (typeof body.name === 'string') {
      delete store[body.name]
    } else {
      return { status: 400, body: { ok: false, error: 'name must be a package name' } }
    }
    writeJson(failedFile(state), store)
    return { status: 200, body: { ok: true } }
  }
  return { status: 400, body: { ok: false, error: 'unknown action' } }
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

/** Wrap a handler: loopback check, method check, state check, JSON body, error → status. */
function route(holder, method, produce) {
  return async (req, res) => {
    try {
      if (!isLoopback(req)) return send(res, 403, { ok: false, error: 'forbidden: loopback only' })
      if ((req.method ?? 'GET') !== method) return send(res, 405, { ok: false, error: 'method not allowed' })
      const state = holder.state
      if (state === null) return send(res, 503, { ok: false, error: 'the updater has not finished starting' })
      let body = null
      if (method === 'POST') {
        let text
        try {
          text = await readBody(req)
        } catch (error) {
          return send(res, 413, { ok: false, error: error instanceof Error ? error.message : 'body could not be read' })
        }
        try {
          body = JSON.parse(text || '{}')
        } catch {
          return send(res, 400, { ok: false, error: 'the request body is not valid JSON' })
        }
      }
      const result = await produce(state, body)
      send(res, result.status, result.body)
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Register the routes on the host web server; returns a function that removes them. */
export function registerRoutes(webServer, holder, api) {
  if (typeof webServer?.register !== 'function') throw new Error('the host web server is not available')
  const disposers = [
    webServer.register({ kind: 'exact', path: `${BASE}/overview`, handler: route(holder, 'GET', async (state) => ({ status: 200, body: buildOverview(state, api) })) }),
    webServer.register({ kind: 'exact', path: `${BASE}/settings`, handler: route(holder, 'POST', async (state, body) => saveSettingsRequest(state, body, api)) }),
    webServer.register({ kind: 'exact', path: `${BASE}/action`, handler: route(holder, 'POST', (state, body) => handleAction(state, body, api)) }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already gone
      }
    }
  }
}
