import initSqlJs from "sql.js"
import { readFileSync } from "node:fs"

const SQL = await initSqlJs()
const db = new SQL.Database(readFileSync("C:/Users/Faye Wang/.local/share/opencode/opencode.db"))

// Check a few sessions: compare part.time_created vs getLastTextPart result
const sessionIds = ["ses_177fefb07ffeSt1c2pZ3b8joA7", "ses_177b74243ffeJFdFP7TXvlMjR5"]

for (const sid of sessionIds) {
  console.log(`\n=== ${sid} ===`)
  const r = db.exec(`SELECT id, json_extract(data,'$.type'), json_extract(data,'$.state.status'), time_created, time_updated FROM part WHERE session_id='${sid}' ORDER BY time_created DESC LIMIT 3`)
  if (r[0]) {
    console.log("part_id\ttype\tstatus\tcreated\tupdated")
    for (const [pid, type, status, tc, tu] of r[0].values) {
      console.log(`${pid}\t${type}\t${status}\t${new Date(tc).toISOString()}\t${new Date(tu).toISOString()}`)
    }
  }

  // Also check the assistant text query
  const r2 = db.exec(`
    SELECT json_extract(p.data,'$.text') AS text, p.time_created
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id='${sid}' AND json_extract(p.data,'$.type')='text' AND json_extract(m.data,'$.role')='assistant'
    ORDER BY p.time_created DESC LIMIT 1
  `)
  if (r2[0]?.values[0]) {
    const [text, tc] = r2[0].values[0]
    console.log(`lastAssistantText time=${tc} (${new Date(tc).toISOString()}) len=${(text||'').length}`)
  }
}