import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs"
import { join } from "node:path"
import { LOG_DIR } from "./paths.js"

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
}

function logFile() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.log`
}

function logPath() { return join(LOG_DIR, logFile()) }

function prune() {
  ensureLogDir()
  const now = Date.now()
  try {
    for (const f of readdirSync(LOG_DIR)) {
      const isDailyLog = /^\d{4}-\d{2}-\d{2}\.log$/.test(f)
      const isRotateLog = f.startsWith("rotate-")
      if (!isDailyLog && !isRotateLog) continue
      const age = now - statSync(join(LOG_DIR, f)).mtimeMs
      if (age > MAX_AGE_MS) unlinkSync(join(LOG_DIR, f))
    }
  } catch { /* skip */ }
}

function toLocalIso(d: Date): string {
  const off = 8 * 60
  const local = new Date(d.getTime() + off * 60_000)
  const y = local.getUTCFullYear()
  const m = String(local.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(local.getUTCDate()).padStart(2, "0")
  const hh = String(local.getUTCHours()).padStart(2, "0")
  const mm = String(local.getUTCMinutes()).padStart(2, "0")
  const ss = String(local.getUTCSeconds()).padStart(2, "0")
  const ms = String(local.getUTCMilliseconds()).padStart(3, "0")
  return `${y}-${m}-${dd}T${hh}:${mm}:${ss}.${ms}+08:00`
}

function doLog(level: string, tag: string, msg: string, extra?: Record<string, unknown>) {
  if (level === "DEBUG" && !verboseFlag) return
  ensureLogDir()
  const ts = toLocalIso(new Date())
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
  const line = `[${ts}] [${level}] [${tag}] [pid=${process.pid}] ${msg}${extraStr}\n`
  process.stderr.write(line)
  try { appendFileSync(logPath(), line) } catch { /* skip */ }
}

export const info = (msg: string, extra?: Record<string, unknown>) => doLog("INFO", "passive", msg, extra)
export const warn = (msg: string, extra?: Record<string, unknown>) => doLog("WARN", "passive", msg, extra)
export const error = (msg: string, extra?: Record<string, unknown>) => doLog("ERROR", "passive", msg, extra)
export const debug = (msg: string, extra?: Record<string, unknown>) => doLog("DEBUG", "passive", msg, extra)

let verboseFlag = false
export function setVerbose(on: boolean): void { verboseFlag = on }

let _lastPrune = 0

export function logPoll(sessions: number, transitions: number, details?: string, stateChanges = 0) {
  const now = Date.now()
  if (now - _lastPrune > 60_000) {
    prune()
    _lastPrune = now
  }
  const d = toLocalIso(new Date())
  const extraStr = details ? ` detail="${details}"` : ""
  const stateStr = stateChanges > 0 ? ` stateChanges=${stateChanges}` : ""
  const line = `[${d}] [INFO] [passive] [pid=${process.pid}] poll: sessions=${sessions} transitions=${transitions}${stateStr}${extraStr}\n`
  process.stderr.write(line)
  ensureLogDir()
  try { appendFileSync(logPath(), line) } catch { /* skip */ }
}

export { LOG_DIR }
