import initSqlJs from "sql.js"
import { readFileSync } from "node:fs"
import os from "node:os"

const SQL = await initSqlJs()
const db = new SQL.Database(readFileSync(`${os.homedir()}/.local/share/opencode/opencode.db`))

// For each session in state file, check: is there any assistant text part with time_created > lastSeenTime?
const state = JSON.parse(readFileSync("D:/Program Files Dev/opencode-feishu/passive/logs/notify-state.json", "utf-8"))
const sids = Object.keys(state).filter(k => !k.startsWith("_"))
console.log(`State has ${sids.length} sessions\n`)

let newlyUpdated = 0
for (const sid of sids) {
  const e = state[sid]
  const storedTime = e.lastSeenTime

  // Find sessions with newer assistant text parts
  const r = db.exec(`
    SELECT json_extract(p.data,'$.text') AS text, p.time_created
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id='${sid}'
      AND json_extract(p.data,'$.type')='text'
      AND json_extract(m.data,'$.role')='assistant'
      AND p.time_created > ${storedTime}
    ORDER BY p.time_created DESC LIMIT 1
  `)
  if (r[0]?.values[0]) {
    newlyUpdated++
    const [text, tc] = r[0].values[0]
    const ageMin = Math.round((Number(tc) - storedTime) / 60000)
    console.log(`NEW: ${sid.slice(0,12)} stored=${storedTime} db=${tc} age=${ageMin}min`)
    console.log(`  text: ${(text||'').replace(/\s+/g,' ').trim().slice(0,80)}`)
  }
}

console.log(`\nTotal sessions with DB text newer than stored: ${newlyUpdated}`)

// Also: sessions with NO stored entry but HAVE assistant text (would push all on startup)
const stateMap = new Set(sids)
const r2 = db.exec(`
  SELECT s.id, s.title, json_extract(p.data,'$.text') AS text, p.time_created
  FROM session s
  JOIN part p ON p.session_id = s.id
  JOIN message m ON m.id = p.message_id
  WHERE (s.time_archived IS NULL OR s.time_archived = 0)
    AND json_extract(p.data,'$.type')='text'
    AND json_extract(m.data,'$.role')='assistant'
  ORDER BY p.time_created DESC
`)
let noState = 0
for (const [sid, title, text, tc] of r2[0]?.values ?? []) {
  if (!stateMap.has(String(sid))) {
    noState++
    console.log(`NO_STATE: ${String(sid).slice(0,12)} title=${title} text_len=${(text||'').length} time=${tc}`)
  }
}
console.log(`\nSessions with assistant text but NO state entry: ${noState}`)