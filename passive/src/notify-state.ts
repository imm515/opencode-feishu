import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs"
import { LOG_DIR, STATE_FILE } from "./paths.js"

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionTrackEntry {
  lastSeenTime: number
  lastSeenText: string
  lastSeenArchiveTime: number
  lastPushedAt: number
  lastDoneTime: number
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

export function loadNotifiedState(): NotifiedMap {
  if (!existsSync(STATE_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as NotifiedMap
    if (isLegacy(raw)) return {}
    if (raw && typeof raw === "object") return raw
    return {}
  } catch {
    return {}
  }
}

export function saveNotifiedState(map: NotifiedMap): void {
  ensureDir()
  pruneOldEntries(map)
  map._schemaVersion = SCHEMA_VERSION
  const tmp = STATE_FILE + ".tmp"
  try {
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8")
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
    lastDoneTime: cur?.lastDoneTime ?? 0,
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
    lastDoneTime: cur?.lastDoneTime ?? 0,
  }
}

export function getEntry(map: NotifiedMap, sessionId: string): SessionTrackEntry | null {
  return map[sessionId] ?? null
}

export function recordDone(
  map: NotifiedMap,
  sessionId: string,
  doneTime: number,
): void {
  const prev = map[sessionId]
  map[sessionId] = {
    lastSeenTime: prev?.lastSeenTime ?? 0,
    lastSeenText: prev?.lastSeenText ?? "",
    lastSeenArchiveTime: prev?.lastSeenArchiveTime ?? 0,
    lastPushedAt: prev?.lastPushedAt ?? Date.now(),
    lastDoneTime: doneTime,
  }
}