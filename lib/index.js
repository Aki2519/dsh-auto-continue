/**
 * dsh-auto-continue host half: on every host boot, scan persisted sessions,
 * find the most recent one whose last turn did not complete (a crash-orphaned
 * open turn, or a turn/end reason in `continueOn`), resume it through
 * `ctx.agents.resume()` with the session's own last-known model config, and
 * inject a "continue" user message so the agent picks the task back up. The
 * resumed rows are served to the web client through /api/auto-continue/status
 * so the UI can surface a visible notice.
 *
 * Zero runtime dependencies on purpose: node builtins plus the injected
 * `agents` service and the optional `sessionPersistence` / `agentDefaultModel`
 * / `webServer` services only, so the package installs as a plain file: bundle.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { repairSessionFile } from './repair.js'

export const name = 'dsh-auto-continue'
export const inject = ['agents']

/** Fallback prompt when the patch config carries none. */
const DEFAULT_PROMPT = '系统刚刚重启。请从上次中断的地方继续完成任务，并在完成后简要汇报。'
/** Fallback reasons treated as "did not finish". */
const DEFAULT_CONTINUE_ON = ['interrupted', 'error', 'max-tokens', 'aborted']

/** The last boot's resumed rows, for the web client status endpoint. */
let bootResumed = []

/**
 * Walk the session event log and report the last turn's state.
 * @param events - raw session events (inspection, before crash-repair).
 * @returns the open turn start (if any) and the last turn/end event.
 */
function lastTurn(events) {
  let open = null
  let end = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = event
      end = null
    } else if (event.type === 'turn/end') {
      end = event
      open = null
    }
  }
  return { open, end }
}

/**
 * Decide whether a session deserves a resume.
 * @param events - raw session events.
 * @param continueOn - turn/end reasons treated as unfinished.
 * @returns true when the session's last turn was interrupted or unfinished.
 */
export function shouldContinue(events, continueOn) {
  const { open, end } = lastTurn(events)
  // An open turn with no closer is a crash scene: the persistence backend
  // would close it as `interrupted` on load, and `inspect` predates repair.
  if (open !== null) return true
  if (end === null) return false
  return continueOn.includes(end.data?.reason?.kind)
}

/**
 * The last request/header's call configuration, so a resumed session keeps
 * the provider/model it ran under instead of following the current default.
 * @param events - raw session events.
 * @returns the call config of the newest request/header, or undefined.
 */
export function lastRequestConfig(events) {
  let config
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const header = event.data?.header
    if (header?.config) config = header.config
  }
  return config
}

/**
 * The preset a session last recorded, mirroring `resolveSessionPreset`: the
 * newest `agent-preset/selected` event wins, else the creation header value.
 * @param events - raw session events.
 * @param header - the session's creation header.
 * @returns the preset id, or undefined when the session never recorded one.
 */
export function lastPreset(events, header) {
  let selected
  for (const event of events) {
    if (event.type !== 'agent-preset/selected') continue
    if (typeof event.data?.agentPreset === 'string') selected = event.data.agentPreset
  }
  return selected ?? header?.agentPreset
}

/**
 * The agent setup for a resumed session: mount the preset it recorded so its
 * history's tool calls stay playable, exactly like the host API proxy does.
 * Without an agentPresets service the session resumes with the host
 * composition and no preset mount.
 * @param ctx - host cordis context.
 * @param presetId - the session's recorded preset id, or undefined.
 * @returns the setup callback, or undefined when no roster is configured.
 */
async function composeSetup(ctx, presetId) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return undefined
  const resolvedId = (await presets.resolve(presetId)).id
  return async (agentCtx) => {
    await presets.mount(agentCtx, resolvedId)
  }
}

/** Build the injected "continue" message. */
export function continueMessage(prompt) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: name },
  }
}

/**
 * The registry-global archived-session set, read from the workspace domain
 * state (`$DSH_HOME/storages/workspace.json`). Archived sessions are never
 * resumed: the user put them away on purpose.
 * @returns the archived session id set (empty when the file is unreadable).
 */
export function readArchivedSessions() {
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const file = join(home, 'storages', 'workspace.json')
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    const ids = state?.global?.archivedSessionIds ?? state?.archivedSessionIds
    return Array.isArray(ids) ? new Set(ids) : new Set()
  } catch {
    return new Set()
  }
}

/**
 * Poll the global service store for a service, tolerating a slow app boot.
 * @param ctx - host cordis context.
 * @param service - service name to look up.
 * @param tries - number of 2s polls before giving up.
 * @returns the service instance, or undefined when it never arrived.
 */
async function waitFor(ctx, service, tries) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = ctx.get(service)
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return undefined
}

/**
 * Cross-process resume mutex. Two dsh instances sharing one $DSH_HOME must
 * never resume the same session concurrently: both would replay the same
 * event seqs into one log, corrupting it. The lock is an atomically-created
 * directory holding the owner pid; a stale lock (owner dead) is reclaimed.
 * @returns a release function, or undefined when another instance holds it.
 */
function acquireResumeLock() {
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const lockDir = join(home, '.auto-continue.lock')
  const pidFile = join(lockDir, 'pid')
  const release = () => {
    try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  const tryCreate = () => {
    try {
      mkdirSync(lockDir)
      writeFileSync(pidFile, String(process.pid), 'utf8')
      return true
    } catch {
      return false
    }
  }
  if (tryCreate()) {
    process.once('exit', release)
    return release
  }
  // Lock exists: reclaim when its owner pid is gone.
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    if (Number.isFinite(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0)
      } catch {
        release()
        if (tryCreate()) {
          process.once('exit', release)
          return release
        }
      }
    }
  } catch {
    release()
    if (tryCreate()) {
      process.once('exit', release)
      return release
    }
  }
  return undefined
}

/**
 * Plugin entry: kick off the scan on host boot, never block apply().
 * @param ctx - host cordis context.
 * @param config - patch-layer configuration.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  void run(ctx, config).catch((error) => {
    writeLog(config, `ERROR ${String(error?.message ?? error)}`)
  })
}

/**
 * Append one line to the plugin's disk log (`$DSH_HOME/auto-continue.log`),
 * mirroring the same line to ctx.logger when a console exporter is installed.
 * The web profile ships no logger plugin, so the file is the observable
 * surface; a bad log destination never fails the scan.
 * @param config - patch-layer configuration (may carry a logFile override).
 * @param line - message body without the timestamp prefix.
 */
function writeLog(config, line) {
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const file = typeof config.logFile === 'string' && config.logFile.length > 0
    ? config.logFile
    : join(home, 'auto-continue.log')
  const stamp = new Date().toISOString()
  try {
    appendFileSync(file, `${stamp} ${line}\n`, 'utf8')
  } catch {
    /* best-effort observability only */
  }
}

/**
 * The scan: wait for the loader tree, list persisted sessions newest-first,
 * resume the first unfinished candidate, inject the continue message.
 * @param ctx - host cordis context.
 * @param config - resolved patch-layer configuration.
 */
async function run(ctx, config) {
  const loader = ctx.get('loader')
  if (loader !== undefined) await loader.await()

  // Never scan while another dsh instance already owns the resume lock:
  // two drivers on one session log corrupt it (duplicate seqs).
  const release = acquireResumeLock()
  if (release === undefined) {
    writeLog(config, 'SKIP another instance holds the resume lock')
    return
  }
  try {
    await bootRepair(ctx, config)
    await scan(ctx, config)
  } finally {
    release()
  }
}

/**
 * Recursively list session artifacts under a persistence root.
 * @param root - the JSONL persistence root (`$DSH_HOME/sessions`).
 * @param depth - recursion guard (workspace nesting is shallow).
 * @returns artifact paths.
 */
function listSessionFiles(root, depth = 0) {
  if (depth > 3) return []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...listSessionFiles(path, depth + 1))
    else if (entry.name === 'session.jsonl.zstd') out.push(path)
  }
  return out
}

/**
 * Boot-time healing: fix session logs corrupted by concurrent writers
 * (duplicate/overlapping records) before the resume scan runs, so repaired
 * sessions load cleanly. Runs under the same cross-process lock as the scan.
 * @param ctx - host cordis context.
 * @param config - resolved patch-layer configuration.
 */
async function bootRepair(ctx, config) {
  if (config.repairOnBoot === false) return
  const root = join((process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh'), 'sessions')
  const minAgeMs = typeof config.repairMinAgeMs === 'number' && config.repairMinAgeMs > 0
    ? config.repairMinAgeMs
    : 60000
  const now = Date.now()
  let repaired = 0
  let gaps = 0
  let errors = 0
  for (const file of listSessionFiles(root)) {
    try {
      if (now - statSync(file).mtimeMs < minAgeMs) continue
    } catch {
      continue
    }
    try {
      const report = await repairSessionFile(file)
      if (report.status === 'repaired') {
        repaired += 1
        writeLog(config, `REPAIR ${file.split(/[\\/]sessions[\\/]/).pop()} fixes=${report.repairs.length} events=${report.events}`)
      } else if (report.status === 'gap') {
        gaps += 1
        writeLog(config, `REPAIR-GAP ${file.split(/[\\/]sessions[\\/]/).pop()} ${report.reason ?? ''}`)
      } else if (report.status === 'error') {
        errors += 1
        writeLog(config, `REPAIR-ERROR ${file.split(/[\\/]sessions[\\/]/).pop()} ${report.reason ?? ''}`)
      }
    } catch (error) {
      errors += 1
      writeLog(config, `REPAIR-ERROR ${file} ${String(error?.message ?? error)}`)
    }
  }
  if (repaired + gaps + errors > 0) {
    writeLog(config, `INFO repair done: ${repaired} fixed, ${gaps} gap(s) skipped, ${errors} error(s)`)
  }
}

/**
 * The scan: wait for the loader tree, list persisted sessions newest-first,
 * resume the first unfinished candidate, inject the continue message.
 * @param ctx - host cordis context.
 * @param config - resolved patch-layer configuration.
 */
async function scan(ctx, config) {
  // Services register as the app settles; retry briefly before going dormant
  // instead of giving up on a slow boot.
  const agents = await waitFor(ctx, 'agents', 15)
  const persistence = await waitFor(ctx, 'sessionPersistence', 15)
  if (agents === undefined || persistence === undefined) {
    writeLog(config, 'WARN agents or sessionPersistence unavailable; dormant')
    return
  }

  const continueOn = Array.isArray(config.continueOn) && config.continueOn.length > 0
    ? config.continueOn
    : DEFAULT_CONTINUE_ON
  const prompt = typeof config.prompt === 'string' && config.prompt.length > 0
    ? config.prompt
    : DEFAULT_PROMPT
  const skipSubagents = config.skipSubagents !== false
  const onlyMostRecent = config.onlyMostRecent !== false
  const archived = readArchivedSessions()
  let archivedSkipped = 0

  const headers = await persistence.list()
  const candidates = headers
    .filter((header) => {
      if (archived.has(header.id)) {
        archivedSkipped += 1
        return false
      }
      if (!skipSubagents) return true
      return header.origin !== 'subagent' && header.parentSession === undefined
    })
    .sort((left, right) => right.createdAt - left.createdAt)

  const resumed = []
  for (const header of candidates) {
    if (onlyMostRecent && resumed.length > 0) break
    let events = []
    try {
      const inspection = await persistence.inspect(header.id)
      events = inspection?.events ?? []
    } catch {
      continue
    }
    if (!shouldContinue(events, continueOn)) continue
    // Never adopt a session this process already runs: the API proxy may have
    // resumed it a moment ago, and two drivers on one log corrupt it.
    if (agents.get(header.id) !== undefined) continue
    try {
      const sessionConfig = lastRequestConfig(events)
      const defaultModel = ctx.get('agentDefaultModel')
      const selection = defaultModel?.currentSelection?.()
      // `forceModel` wins over everything: it pins every resumed session to
      // one model (e.g. a cheap one) regardless of what the session recorded.
      const forced = config.forceModel
      const agentOptions = forced?.provider && forced?.model
        ? { provider: forced.provider, model: forced.model }
        : (sessionConfig?.provider
            ? { provider: sessionConfig.provider, model: sessionConfig.model }
            : (selection !== undefined
                ? { provider: selection.provider, model: selection.model }
                : undefined))
      const setup = await composeSetup(ctx, lastPreset(events, header))
      const { agent } = await agents.resume({
        resumeSessionId: header.id,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(setup === undefined ? {} : { setup }),
      })
      agent.followup(continueMessage(prompt))
      resumed.push({
        sessionId: header.id,
        cwd: header.cwd ?? null,
        time: Date.now(),
      })
      writeLog(config, `RESUME ${header.id}`)
    } catch (error) {
      writeLog(config, `FAIL ${header.id} ${String(error?.message ?? error)}`)
    }
  }
  bootResumed = resumed
  if (resumed.length === 0 && archivedSkipped === 0) writeLog(config, 'SKIP no unfinished session to resume')
  if (archivedSkipped > 0) writeLog(config, `INFO ${archivedSkipped} archived session(s) skipped`)

  // Serve this boot's resumed rows to the web client so the UI can show a
  // visible notice. Registered after the loader settled, so webServer exists.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && resumed.length > 0) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/auto-continue/status',
      handler: (_req, res) => {
        const body = JSON.stringify({ resumed: bootResumed })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
      },
    }))
  }
}
