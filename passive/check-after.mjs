import initSqlJs from "sql.js"
import { readFileSync } from "node:fs"
import os from "node:os"

const SQL = await initSqlJs()
const db = new SQL.Database(readFileSync(`${os.homedir()}/.local/share/opencode/opencode.db`))

// Check: is there any session with assistant text part created AFTER 1780410364211 (current daemonStart)?
const daemonStart = 1780410364211
const r = db.exec(`
  SELECT s.id, s.title, s.time_archived,
    (SELECT MAX(p.time_created) FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = s.id AND json_extract(p.data,'$.type')='text'
     AND json_extract(m.data,'$.role')='assistant') AS max_text_time
  FROM session s
  WHERE (s.time_archived IS NULL OR s.time_archived = 0)
  ORDER BY max_text_time DESC
`)
console.log(`Sessions with assistant text created AFTER daemonStart (${daemonStart}):`)
console.log(`(These would be pushed on next cycle)\n`)
console.log("sid\ttitle\tarchived\tmax_text_time")
for (const [sid, title, archived, maxText] of r[0]?.values ?? []) {
  if (maxText && Number(maxText) > daemonStart) {
    console.log(`${String(sid).slice(0,12)}\t${title}\t${archived}\t${maxText} (${new Date(Number(maxText)).toISOString()})`)
  }
}
console.log("\n--- All active sessions (top 5 by text time) ---")
for (const [sid, title, archived, maxText] of (r[0]?.values ?? []).slice(0, 5)) {
  const ageSec = Math.round((daemonStart - Number(maxText)) / 1000)
  console.log(`${String(sid).slice(0,12)}\tmax_text=${maxText} age=${ageSec}s\ttitle=${title}`)
}

// Also check pending archived sessions
const r2 = db.exec(`
  SELECT s.id, s.title, s.time_archived
  FROM session s
  WHERE s.time_archived > ${daemonStart - 300000}
  ORDER BY s.time_archived DESC
`)
console.log(`\n--- Recently archived (within 5min of daemon) ---`)
for (const [sid, title, ta] of r2[0]?.values ?? []) {
  console.log(`${String(sid).slice(0,12)}\tarchived=${ta}\ttitle=${title}`)
}