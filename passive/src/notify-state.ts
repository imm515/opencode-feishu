import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmSync } from "node:fs"
import { LOG_DIR, STATE_FILE } from "./paths.js"

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionTrackEntry {
  lastSeenTime: number
  lastSeenText: string
  lastSeenArchiveTime: number
  lastPushedAt: number
  /** When this session first archived — gates the done card by ARCHIVE_GRACE_MS.
   *  Cleared when the session reactivates, or after the done card is sent.
   */
  pendingDoneAt?: number
}

interface LegacySessionTrackEntry extends SessionTrackEntry {
  lastDoneTime?: number
  pendingDoneTime?: number
}

export type NotifiedMap = Record<string, SessionTrackEntry> & {
  _schemaVersion?: number
  _daemonStartedAt?: number
}

const SCHEMA_VERSION = 3

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
}

function isLegacy(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false
  const obj = raw as Record<string, unknown>
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && "state" in (v as object)) return true
  }
  return false
}

function sanitizeEntry(raw: unknown): SessionTrackEntry | null {
  if (!raw || typeof raw !== "object") return null
  const entry = raw as LegacySessionTrackEntry
  const lastSeenTime = Number(entry.lastSeenTime ?? 0) || 0
  const lastSeenText = typeof entry.lastSeenText === "string" ? entry.lastSeenText : ""
  const lastSeenArchiveTime = Math.max(
    Number(entry.lastSeenArchiveTime ?? 0) || 0,
    Number(entry.lastDoneTime ?? 0) || 0,
  )
  const lastPushedAt = Number(entry.lastPushedAt ?? 0) || 0
  const pendingDoneAt = Number((raw as any).pendingDoneAt ?? 0) || undefined
  return {
    lastSeenTime,
    lastSeenText,
    lastSeenArchiveTime,
    lastPushedAt,
    ...(pendingDoneAt ? { pendingDoneAt } : {}),
  }
}

export function loadNotifiedState(): NotifiedMap {
  if (!existsSync(STATE_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as NotifiedMap
    if (isLegacy(raw)) return {}
    if (raw && typeof raw === "object") {
      const normalized: NotifiedMap = {}
      if (typeof raw._schemaVersion === "number") normalized._schemaVersion = raw._schemaVersion
      if (typeof raw._daemonStartedAt === "number") normalized._daemonStartedAt = raw._daemonStartedAt
      for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith("_")) continue
        const entry = sanitizeEntry(value)
        if (entry) normalized[key] = entry
      }
      return normalized
    }
    return {}
  } catch {
    return {}
  }
}

export function saveNotifiedState(map: NotifiedMap): void {
  ensureDir()
  pruneOldEntries(map)
  const normalized: NotifiedMap = {}
  if (typeof map._daemonStartedAt === "number") normalized._daemonStartedAt = map._daemonStartedAt
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith("_")) continue
    const entry = sanitizeEntry(value)
    if (entry) normalized[key] = entry
  }
  normalized._schemaVersion = SCHEMA_VERSION
  const tmp = STATE_FILE + ".tmp"
  try {
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf-8")
    // Windows renameSync cannot replace an existing file atomically like POSIX.
    rmSync(STATE_FILE, { force: true })
    renameSync(tmp, STATE_FILE)
  } catch { /* skip */ }
}

function pruneOldEntries(map: NotifiedMap): void {
  const cutoff = Date.now() - MAX_AGE_MS
  for (const key of Object.keys(map)) {
    if (key.startsWith("_")) continue
    const e = map[key]
    if (!e || e.lastPushedAt < cutoff) delete map[key]
  }
}

export function recordPush(
  map: NotifiedMap,
  sessionId: string,
  text: string,
  partTime: number,
  archiveTime: number,
): void {
  const cur = map[sessionId]
  map[sessionId] = {
    lastSeenTime: partTime,
    lastSeenText: text,
    lastSeenArchiveTime: archiveTime,
    lastPushedAt: Date.now(),
    // pendingDoneAt intentionally cleared here — done card was sent
  }
}

export function markSeen(
  map: NotifiedMap,
  sessionId: string,
  partTime: number,
  text: string,
  archiveTime: number,
): void {
  const cur = map[sessionId]
  map[sessionId] = {
    lastSeenTime: partTime > (cur?.lastSeenTime ?? 0) ? partTime : (cur?.lastSeenTime ?? 0),
    lastSeenText: text,
    lastSeenArchiveTime: archiveTime || (cur?.lastSeenArchiveTime ?? 0),
    pendingDoneAt: cur?.pendingDoneAt,
    lastPushedAt: cur?.lastPushedAt ?? Date.now(),
  }
}

export function getEntry(map: NotifiedMap, sessionId: string): SessionTrackEntry | null {
  return map[sessionId] ?? null
}
