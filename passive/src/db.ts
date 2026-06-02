import { DatabaseSync } from "node:sqlite"
import { join } from "path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")

let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (_db) {
    // Re-read WAL by closing and re-opening each poll
    try { _db.close() } catch {}
  }
  _db = new DatabaseSync(DB_PATH)
  return _db
}

export function closeDb(): void {
  try { _db?.close() } catch {}
  _db = null
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

export interface LatestPartInfo {
  text: string
  time_created: number
  time_updated: number
  type: string
}

export async function getLatestPartTime(sessionId: string): Promise<number> {
  const db = getDb()
  const stmt = db.prepare("SELECT MAX(time_created) AS max_time FROM part WHERE session_id = ?")
  const row = stmt.get(sessionId) as { max_time: number | null } | undefined
  return row?.max_time ?? 0
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

export async function refreshDb(): Promise<void> {
  closeDb()
  getDb()
}
