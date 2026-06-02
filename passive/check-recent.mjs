import initSqlJs from "sql.js"
import { readFileSync } from "node:fs"

const SQL = await initSqlJs()
const db = new SQL.Database(readFileSync("C:/Users/Faye Wang/.local/share/opencode/opencode.db"))

const sids = [
  "ses_17c28bd3f4feNqZJ2O8Rj1z9Lw",
  "ses_17e0f83cb7fej7M3Q6V7P6YdJk",
  "ses_17cdf0fa6ffe0S8qX3L5c9ZmJd",
  "ses_177fefb07ffeSt1c2pZ3b8joA7",
]

for (const sid of sids) {
  const r = db.exec(`
    SELECT json_extract(p.data,'$.text') AS text, p.time_created
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id='${sid}'
      AND json_extract(p.data,'$.type')='text'
      AND json_extract(m.data,'$.role')='assistant'
    ORDER BY p.time_created DESC LIMIT 1
  `)
  if (r[0]?.values[0]) {
    const [text, tc] = r[0].values[0]
    console.log(`${sid.slice(0,12)}: text_len=${(text||'').length} time=${tc} (${new Date(Number(tc)).toISOString()})`)
    console.log(`  preview: ${(text||'').replace(/\s+/g,' ').trim().slice(0,60)}`)
  } else {
    console.log(`${sid.slice(0,12)}: no assistant text`)
  }
}

// Check 窗口2 session
const r2 = db.exec(`
  SELECT json_extract(p.data,'$.text') AS text, p.time_created, p.time_updated
  FROM part p JOIN message m ON m.id = p.message_id
  WHERE p.session_id='ses_177fefb07ffeSt1c2pZ3b8joA7'
    AND json_extract(p.data,'$.type')='text'
    AND json_extract(m.data,'$.role')='assistant'
  ORDER BY p.time_created DESC LIMIT 1
`)
if (r2[0]?.values[0]) {
  const [text, tc, tu] = r2[0].values[0]
  console.log(`\n窗口2: text_len=${(text||'').length} created=${tc} updated=${tu}`)
}