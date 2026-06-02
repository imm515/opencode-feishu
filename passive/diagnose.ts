import initSqlJs from "sql.js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")

function partToState(t: string, s: string | null) {
  if (t === "text") return "waiting"
  if (t === "tool" && s === "running") return "working"
  if (t === "tool" && (s === "completed" || s === "error")) return "waiting"
  if (t === "reasoning") return "working"
  return "unknown"
}

function findRealPart(parts: Array<{type: string; status: string | null}>) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "step-start" || p.type === "step-finish") continue
    return partToState(p.type, p.status)
  }
  return "unknown"
}

function detectState(parts: Array<{type: string; status: string | null}>) {
  if (!parts.length) return "unknown"
  const last = parts[parts.length - 1]
  const t = last.type
  if (t === "step-finish") return findRealPart(parts.slice(0, -1))
  if (t === "step-start") return findRealPart(parts.slice(0, -1))
  return partToState(t, last.status)
}

async function main() {
  const SQL = await initSqlJs()
  const fileBuffer = existsSync(DB_PATH) ? readFileSync(DB_PATH) : undefined
  const db = new SQL.Database(fileBuffer)

  function rows(sql: string) {
    const r = db.exec(sql)
    if (!r.length) return []
    const cols = r[0].columns
    return r[0].values.map(row => {
      const obj: Record<string, unknown> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return obj
    })
  }

  const sessions = rows(`
    SELECT id, title, time_updated
    FROM session
    WHERE time_archived IS NULL OR time_archived = 0
    ORDER BY time_updated DESC
    LIMIT 10
  `) as Array<{id: string; title: string; time_updated: number}>

  const now = Date.now()
  console.log(`\n=== DIAGNOSIS ${new Date().toISOString()} ===`)
  console.log(`Poll interval: 20s | Target chat: oc_82bb66a73329cf403644debd24c86ec5\n`)

  for (const s of sessions) {
    const parts = rows(`
      SELECT
        id,
        json_extract(data, '$.type') AS type,
        json_extract(data, '$.state.status') AS status,
        time_created, time_updated
      FROM part
      WHERE session_id = '${s.id.replace(/'/g, "''")}'
      ORDER BY time_created ASC
    `) as Array<{id: string; type: string; status: string | null; time_created: number; time_updated: number}>

    const state = detectState(parts)
    const lastUpdate = parts.length > 0 ? parts[parts.length - 1].time_updated : s.time_updated
    const age = now - lastUpdate

    console.log(`[${s.id}]`)
    console.log(`  title: ${s.title ?? "(null)"}`)
    console.log(`  updated: ${new Date(s.time_updated).toISOString()} (${Math.round(age/1000)}s ago)`)
    console.log(`  parts: ${parts.length} total`)
    if (parts.length > 0) {
      const recent = parts.slice(-5)
      console.log(`  last 5 parts (newest last):`)
      for (const p of recent) {
        console.log(`    ${new Date(p.time_created).toISOString().slice(11,19)} type=${p.type} status=${p.status ?? "null"}`)
      }
    }
    console.log(`  -> state: ${state}`)
    console.log("")
  }

  db.close()
}

main().catch(console.error)
