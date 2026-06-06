import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs"
import { LOG_DIR, STATE_FILE } from "./paths.js"

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionTrackEntry {
  lastSeenTime: number
  lastSeenText: string
  lastSeenArchiveTime: number
  lastPushedAt: number
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
  return {
    lastSeenTime,
    lastSeenText,
    lastSeenArchiveTime,
    lastPushedAt,
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
    lastPushedAt: cur?.lastPushedAt ?? Date.now(),
  }
}

export function getEntry(map: NotifiedMap, sessionId: string): SessionTrackEntry | null {
  return map[sessionId] ?? null
}
