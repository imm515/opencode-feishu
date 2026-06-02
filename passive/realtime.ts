import initSqlJs from "sql.js"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")

async function main() {
  const SQL = await initSqlJs()
  const db = new SQL.Database(readFileSync(DB_PATH))

  function rows(sql: string): any[] {
    const r = db.exec(sql)
    if (!r.length) return []
    const cols: string[] = r[0].columns
    return r[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
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
  `)

  const now = Date.now()
  console.log(`\n=== REALTIME ${new Date().toISOString()} ===\n`)

  for (const s of sessions) {
    const parts = rows(`
      SELECT json_extract(data, '$.type') AS type,
             json_extract(data, '$.state.status') AS status,
             time_created, time_updated
      FROM part
      WHERE session_id = '${(s.id as string).replace(/'/g, "''")}'
      ORDER BY time_created ASC
    `)

    if (!parts.length) {
      console.log(`[${s.id}] "${s.title}" -> unknown (no parts)\n`)
      continue
    }

    const last = parts[parts.length - 1] as any
    const lastUpdate = (last.time_updated as number) || (s.time_updated as number)
    const age = Math.round((now - lastUpdate) / 1000)

    function partToState(t: string, st: string | null) {
      if (t === "text") return "waiting"
      if (t === "tool" && st === "running") return "working"
      if (t === "tool" && (st === "completed" || st === "error")) return "waiting"
      if (t === "reasoning") return "working"
      return null
    }

    function detectState(partsArr: any[]) {
      const last = partsArr[partsArr.length - 1]
      if (last.type === "step-finish" || last.type === "step-start") {
        for (let i = partsArr.length - 2; i >= 0; i--) {
          const p = partsArr[i]
          if (p.type !== "step-start" && p.type !== "step-finish") {
            return partToState(p.type, p.status) ?? "unknown"
          }
        }
        return "unknown"
      }
      return partToState(last.type, last.status) ?? "unknown"
    }

    const state = detectState(parts)
    const recent = parts.slice(-5)

    console.log(`[${s.id}]`)
    console.log(`  title: ${s.title}`)
    console.log(`  updated: ${new Date(s.time_updated).toISOString()} (${age}s ago)`)
    console.log(`  parts: ${parts.length} total`)
    console.log(`  last 5 parts (oldest→newest):`)
    for (const p of recent) {
      const pstate = partToState(p.type, p.status)
      console.log(`    ${new Date(p.time_created).toISOString().slice(11,19)}  ${p.type}  status=${p.status ?? "null"}  state=${pstate ?? "-"}`)
    }
    console.log(`  -> state: ${state}`)
    console.log("")
  }

  db.close()
}

main().catch(console.error)
