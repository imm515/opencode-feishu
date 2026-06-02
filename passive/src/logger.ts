import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const LOG_DIR = join(os.homedir(), "Program Files Dev", "opencode-feishu", "logs")
const MAX_SIZE = 5 * 1024 * 1024
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
      if (!f.match(/^\d{4}-\d{2}-\d{2}\.log$/)) continue
      const age = now - statSync(join(LOG_DIR, f)).mtimeMs
      if (age > MAX_AGE_MS) unlinkSync(join(LOG_DIR, f))
    }
  } catch { /* skip */ }
}

function rotate() {
  const p = logPath()
  if (!existsSync(p)) return
  try {
    if (statSync(p).size > MAX_SIZE) {
      writeFileSync(join(LOG_DIR, `rotate-${Date.now()}.log`), readFileSync(p))
      writeFileSync(p, "")
    }
  } catch { /* skip */ }
}

function doLog(level: string, tag: string, msg: string, extra?: Record<string, unknown>) {
  ensureLogDir()
  prune()
  rotate()
  const ts = new Date().toISOString()
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
  const line = `[${ts}] [${level}] [${tag}] ${msg}${extraStr}\n`
  process.stderr.write(line)
  try { appendFileSync(logPath(), line) } catch { /* skip */ }
}

export const info = (msg: string, extra?: Record<string, unknown>) => doLog("INFO", "passive", msg, extra)
export const warn = (msg: string, extra?: Record<string, unknown>) => doLog("WARN", "passive", msg, extra)
export const error = (msg: string, extra?: Record<string, unknown>) => doLog("ERROR", "passive", msg, extra)

export function logPoll(sessions: number, transitions: number, details?: string) {
  const d = new Date().toISOString()
  const extraStr = details ? ` detail="${details}"` : ""
  const line = `[${d}] [INFO] [passive] poll: sessions=${sessions} transitions=${transitions}${extraStr}\n`
  process.stderr.write(line)
  ensureLogDir()
  try { appendFileSync(logPath(), line) } catch { /* skip */ }
}

export { LOG_DIR }