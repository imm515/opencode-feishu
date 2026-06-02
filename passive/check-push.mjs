import initSqlJs from "sql.js"
import { readFileSync } from "node:fs"

const SQL = await initSqlJs()
const db = new SQL.Database(readFileSync("C:/Users/Faye Wang/.local/share/opencode/opencode.db"))

// For each pushed session, check: does the DB have a newer assistant text part?
const state = JSON.parse(readFileSync("D:/Program Files Dev/opencode-feishu/passive/logs/notify-state.json", "utf-8"))
const sids = Object.keys(state).filter(k => !k.startsWith("_")).slice(0, 8)

for (const sid of sids) {
  const entry = state[sid]
  const dbR = db.exec(`
    SELECT json_extract(p.data,'$.text') AS text, p.time_created
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id='${sid}'
      AND json_extract(p.data,'$.type')='text'
      AND json_extract(m.data,'$.role')='assistant'
    ORDER BY p.time_created DESC LIMIT 2
  `)
  let dbText = null, dbTime = 0
  if (dbR[0]?.values[0]) {
    dbText = dbR[0].values[0][0]
    dbTime = Number(dbR[0].values[0][1])
  }
  const storedTime = entry.lastSeenTime
  const textLen = (dbText || '').length
  const isNewer = dbTime > storedTime
  const isEmpty = textLen === 0
  console.log(`${sid.slice(0,12)} stored_t=${storedTime} db_t=${dbTime} newer=${isNewer} empty=${isEmpty} db_len=${textLen} stored_len=${entry.lastSeenText.length}`)
  if (dbText) console.log(`  preview: ${dbText.replace(/\s+/g,' ').trim().slice(0,80)}`)
}