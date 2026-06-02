// Real-time session state monitor — for debugging "why no notification?"
// Polls opencode.db every 2s and prints state changes only (edge-triggered view).
// Pure read-only, never sends Feishu notifications.

import initSqlJs from "sql.js"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const POLL_MS = 2000

let lastState: Record<string, string> = {}

function partToState(type: string, status: string | null, role: string | null): string {
  if (type === "text") return role === "user" ? "working" : "waiting"
  if (type === "tool" && (status === "running" || status === "pending")) return "working"
  if (type === "tool" && (status === "completed" || status === "error")) return "waiting"
  if (type === "reasoning") return "working"
  if (type === "step-start" || type === "step-finish") return "skip"
  return "?"
}

async function snapshot(db: any): Promise<Record<string, { state: string; title: string; ts: number; type: string; status: string | null; role: string | null }>> {
  const r = db.exec(`
    SELECT s.id, s.title, COALESCE(s.time_archived, 0) AS archived,
      (SELECT json_extract(p.data, '$.type') FROM part p WHERE p.session_id = s.id ORDER BY p.time_created DESC LIMIT 1) AS t,
      (SELECT json_extract(p.data, '$.state.status') FROM part p WHERE p.session_id = s.id ORDER BY p.time_created DESC LIMIT 1) AS s,
      (SELECT json_extract(m.data, '$.role') FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = s.id ORDER BY p.time_created DESC LIMIT 1) AS r,
      (SELECT MAX(p.time_created) FROM part p WHERE p.session_id = s.id) AS last_pt
    FROM session s
    WHERE s.time_archived IS NULL OR s.time_archived = 0
  `)
  const out: Record<string, { state: string; title: string; ts: number; type: string; status: string | null; role: string | null }> = {}
  for (const row of r[0].values) {
    const [id, title, archived, t, s, r2, lastPt] = row
    if (archived > 0) { out[id] = { state: "done", title: title ?? id, ts: 0, type: "archived", status: null, role: null }; continue }
    if (!t) { out[id] = { state: "empty", title: title ?? id, ts: 0, type: "—", status: null, role: null }; continue }
    out[id] = { state: partToState(t, s, r2), title: title ?? id, ts: lastPt ?? 0, type: t, status: s, role: r2 }
  }
  return out
}

function short(s: string, n = 32) { return s.length > n ? s.slice(0, n) + "…" : s }

async function main() {
  const SQL = await initSqlJs()
  let db = new SQL.Database(readFileSync(DB_PATH))

  const reload = setInterval(() => {
    try { db.close(); db = new SQL.Database(readFileSync(DB_PATH)) }
    catch (e) { console.error("[reload] failed:", e) }
  }, 5000)

  console.log(`[monitor] polling ${DB_PATH} every ${POLL_MS}ms (Ctrl-C to stop)`)
  console.log(`[monitor] watching for state changes only (no changes = no output)`)
  console.log()

  let cycle = 0
  while (true) {
    cycle++
    try {
      const snap = await snapshot(db)
      if (cycle === 1) {
        for (const [id, s] of Object.entries(snap)) lastState[id] = s.state
        const counts: Record<string, number> = {}
        for (const s of Object.values(snap)) counts[s.state] = (counts[s.state] ?? 0) + 1
        console.log(`[prime] ${Object.keys(snap).length} sessions:`, counts)
      } else {
        for (const [id, s] of Object.entries(snap)) {
          const prev = lastState[id]
          if (prev !== s.state) {
            const t = new Date().toISOString().slice(11, 19)
            const arrow = prev ? `${prev}→${s.state}` : `?→${s.state}`
            const emoji = s.state === "working" ? "🔄" : s.state === "waiting" ? "❓" : s.state === "done" ? "✅" : "❔"
            console.log(`[${t}] ${emoji} ${arrow.padEnd(15)} ${short(s.title).padEnd(32)} (${s.type}${s.role ? "/" + s.role : ""}${s.status ? "/" + s.status : ""})`)
            lastState[id] = s.state
          }
        }
        for (const id of Object.keys(lastState)) {
          if (!(id in snap)) {
            console.log(`[${new Date().toISOString().slice(11, 19)}] ❌ ${short(lastState[id] + "→gone").padEnd(15)} ${id}`)
            delete lastState[id]
          }
        }
      }
    } catch (e) {
      console.error("[poll] error:", e instanceof Error ? e.message : e)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

process.on("SIGINT", () => { console.log("\n[monitor] stopped"); process.exit(0) })
main().catch(e => { console.error(e); process.exit(1) })
