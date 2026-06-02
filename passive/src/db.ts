import initSqlJs, { type Database, type QueryExecResult } from "sql.js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")

let _db: Database | null = null
let _ready = false

async function getDb(): Promise<Database> {
  if (_db && _ready) return _db
  const SQL = await initSqlJs()
  const fileBuffer = existsSync(DB_PATH) ? readFileSync(DB_PATH) : undefined
  _db = new SQL.Database(fileBuffer)
  _ready = true
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
  _ready = false
}

export interface Session {
  id: string
  title: string | null
  time_created: number
  time_updated: number
  time_archived: number | null
}

export interface PartRow {
  id: string
  session_id: string
  type: string
  state_status: string | null
  time_created: number
  time_updated: number
}

function rowsToObjects(result: QueryExecResult): Record<string, unknown>[] {
  const cols = result.columns
  return result.values.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
    return obj
  })
}

export async function getActiveSessions(): Promise<Session[]> {
  const db = await getDb()
  const results = db.exec(`
    SELECT id, title, time_created, time_updated, time_archived
    FROM session
    WHERE time_archived IS NULL OR time_archived = 0
    ORDER BY time_updated DESC
  `)
  if (!results.length) return []
  return rowsToObjects(results[0]) as unknown as Session[]
}

export async function getRecentlyArchivedSessions(graceMs: number): Promise<Session[]> {
  const db = await getDb()
  const cutoff = Date.now() - graceMs
  const results = db.exec(`
    SELECT id, title, time_created, time_updated, time_archived
    FROM session
    WHERE time_archived > ${cutoff}
    ORDER BY time_archived DESC
  `)
  if (!results.length) return []
  return rowsToObjects(results[0]) as unknown as Session[]
}

export interface TextPart {
  text: string
  time_created: number
}

export async function getLastTextPart(sessionId: string): Promise<TextPart | null> {
  const db = await getDb()
  const results = db.exec(`
    SELECT
      json_extract(data, '$.text') AS text,
      time_created
    FROM part
    WHERE session_id = '${sessionId.replace(/'/g, "''")}'
      AND json_extract(data, '$.type') = 'text'
    ORDER BY time_created DESC
    LIMIT 1
  `)
  if (!results.length || !results[0].values.length) return null
  const [text, time_created] = results[0].values[0] as [string | null, number]
  if (!text) return null
  return { text, time_created }
}

export async function getSessionParts(sessionId: string): Promise<PartRow[]> {
  const db = await getDb()
  const results = db.exec(`
    SELECT
      id,
      session_id,
      json_extract(data, '$.type') AS type,
      json_extract(data, '$.state.status') AS state_status,
      time_created,
      time_updated
    FROM part
    WHERE session_id = '${sessionId.replace(/'/g, "''")}'
    ORDER BY time_created ASC
  `)
  if (!results.length) return []
  return rowsToObjects(results[0]) as unknown as PartRow[]
}

export async function getLatestPart(sessionId: string): Promise<PartRow | null> {
  const parts = await getSessionParts(sessionId)
  return parts.length > 0 ? parts[parts.length - 1] : null
}

export async function refreshDb(): Promise<void> {
  closeDb()
  _ready = false
  await getDb()
}