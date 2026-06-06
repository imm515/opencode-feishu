import { DatabaseSync } from "node:sqlite"
import { statSync } from "node:fs"
import { join } from "path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")

let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH)
    // WAL mode: reader never blocks, never needs close/reopen
    _db.exec("PRAGMA journal_mode=WAL")
  }
  return _db
}

export function closeDb(): void {
  try { _db?.close() } catch {}
  _db = null
}

/** Return DB file mtime (ms) for change detection. */
export function getDbMtime(): number {
  try {
    return statSync(DB_PATH).mtimeMs
  } catch {
    return 0
  }
}

export interface Session {
  id: string
  title: string | null
  time_created: number
  time_updated: number
  time_archived: number | null
}

export async function getActiveSessions(): Promise<Session[]> {
  const db = getDb()
  const stmt = db.prepare("SELECT id, title, time_created, time_updated, time_archived FROM session WHERE time_archived IS NULL OR time_archived = 0 ORDER BY time_updated DESC")
  return stmt.all() as unknown as Session[]
}

export async function getRecentlyArchivedSessions(graceMs: number): Promise<Session[]> {
  const db = getDb()
  const cutoff = Date.now() - graceMs
  const stmt = db.prepare("SELECT id, title, time_created, time_updated, time_archived FROM session WHERE time_archived > ? ORDER BY time_archived DESC")
  return stmt.all(cutoff) as unknown as Session[]
}

export async function getSessionArchiveTime(sessionId: string): Promise<number | null> {
  const db = getDb()
  const stmt = db.prepare("SELECT time_archived FROM session WHERE id = ? LIMIT 1")
  const row = stmt.get(sessionId) as { time_archived: number | null } | undefined
  return row?.time_archived ?? null
}

export interface LatestPartInfo {
  text: string
  time_created: number
  time_updated: number
  type: string
}

export interface PartChunk {
  text: string
  time_created: number
}

export interface LatestPartMeta {
  time_created: number
  time_updated: number
  type: string | null
  reason: string | null
  tool: string | null
}

export async function getLatestPartTime(sessionId: string): Promise<number> {
  const db = getDb()
  const stmt = db.prepare("SELECT MAX(time_created) AS max_time FROM part WHERE session_id = ?")
  const row = stmt.get(sessionId) as { max_time: number | null } | undefined
  return row?.max_time ?? 0
}

export async function getLatestStepFinishStopTime(sessionId: string): Promise<number> {
  const db = getDb()
  const stmt = db.prepare(
    "SELECT MAX(time_created) AS max_time FROM part " +
    "WHERE session_id = ? AND json_extract(data, '$.type') = 'step-finish' " +
    "AND json_extract(data, '$.reason') = 'stop'"
  )
  const row = stmt.get(sessionId) as { max_time: number | null } | undefined
  return row?.max_time ?? 0
}

export async function getLatestPartMeta(sessionId: string): Promise<LatestPartMeta | null> {
  const db = getDb()
  const stmt = db.prepare(
    "SELECT p.time_created, p.time_updated, " +
    "json_extract(p.data, '$.type') AS type, " +
    "json_extract(p.data, '$.reason') AS reason, " +
    "json_extract(p.data, '$.tool') AS tool " +
    "FROM part AS p WHERE p.session_id = ? " +
    "ORDER BY p.time_created DESC LIMIT 1"
  )
  const row = stmt.get(sessionId) as LatestPartMeta | undefined
  return row ?? null
}

export async function getLatestAssistantPart(sessionId: string): Promise<LatestPartInfo | null> {
  const db = getDb()
  const stmt = db.prepare(
    "SELECT json_extract(p.data, '$.text') AS text, p.time_created, p.time_updated, json_extract(p.data, '$.type') AS type " +
    "FROM part AS p JOIN message AS m ON m.id = p.message_id " +
    "WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'text' AND json_extract(m.data, '$.role') = 'assistant' " +
    "ORDER BY p.time_created DESC LIMIT 1"
  )
  const row = stmt.get(sessionId) as LatestPartInfo | undefined
  if (!row || !row.text) return null
  return row
}

/**
 * Concatenate all assistant text parts after `sinceTime` in order.
 * Returns joined text + the latest part's time_created.
 * Used to assemble a full streamed reply across multiple part chunks.
 */
export async function getAssistantTextSince(
  sessionId: string,
  sinceTime: number,
): Promise<{ text: string; latestTime: number; chunkCount: number }> {
  const db = getDb()
  const stmt = db.prepare(
    "SELECT json_extract(p.data, '$.text') AS text, p.time_created " +
    "FROM part AS p JOIN message AS m ON m.id = p.message_id " +
    "WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'text' " +
    "AND json_extract(m.data, '$.role') = 'assistant' " +
    "AND p.time_created > ? " +
    "ORDER BY p.time_created ASC"
  )
  const rows = stmt.all(sessionId, sinceTime) as { text: string | null; time_created: number }[]
  let joined = ""
  let latest = sinceTime
  for (const r of rows) {
    if (r.text) joined += r.text
    if (r.time_created > latest) latest = r.time_created
  }
  return { text: joined, latestTime: latest, chunkCount: rows.length }
}

/** Ensure DB is open. In WAL mode reads see latest committed data automatically. */
export async function refreshDb(): Promise<void> {
  // Runtime evidence showed long-lived reads can drift from the current session table
  // view, causing passive to act on stale archive state. Reopen on each refresh so
  // every poll observes a fresh snapshot from disk.
  closeDb()
  getDb()
}
