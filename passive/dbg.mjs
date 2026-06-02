import initSqlJs from 'sql.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'os'

const DB_PATH = join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')

const SQL = await initSqlJs()
const raw = readFileSync(DB_PATH)
const db = new SQL.Database(raw)

console.log('=== Session count ===')
const sc = db.exec('SELECT COUNT(*) FROM session')
console.log(sc[0].values)

console.log('\n=== Active sessions (sample) ===')
const active = db.exec(SELECT id, title, time_created, time_updated, time_archived FROM session WHERE time_archived IS NULL OR time_archived = 0 ORDER BY time_updated DESC LIMIT 3)
if (active.length) {
  console.log('cols:', active[0].columns)
  active[0].values.forEach(r => console.log(r))
}

console.log('\n=== Part count ===')
const pc = db.exec('SELECT COUNT(*) FROM part')
console.log(pc[0].values)

console.log('\n=== Message count ===')
const mc = db.exec('SELECT COUNT(*) FROM message')
console.log(mc[0].values)

console.log('\n=== Recent parts (sample) ===')
const rp = db.exec(
  SELECT p.id, p.session_id, json_extract(p.data,'$.type') as ptype, p.time_created, p.time_updated,
         json_extract(m.data,'$.role') as role, json_extract(p.data,'$.text') as text
  FROM part p JOIN message m ON m.id = p.message_id
  ORDER BY p.time_updated DESC LIMIT 5
)
if (rp.length) {
  console.log('cols:', rp[0].columns)
  rp[0].values.forEach(r => console.log(JSON.stringify({id:r[0],sid:r[1],type:r[2],tc:r[3],tu:r[4],role:r[5],text:(r[6]||'').slice(0,30)})))
}

// pick first active session and inspect
const oneId = db.exec(SELECT id FROM session WHERE (time_archived IS NULL OR time_archived = 0) ORDER BY time_updated DESC LIMIT 1)
if (oneId.length && oneId[0].values.length) {
  const sid = oneId[0].values[0][0]
  console.log('\n=== Parts for session:', sid.slice(0,20), '===')
  const parts = db.exec(
    SELECT p.id, json_extract(p.data,'$.type') as type, p.time_created, p.time_updated,
           json_extract(m.data,'$.role') as role, json_extract(p.data,'$.text') as text
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ''
    ORDER BY p.time_created ASC
  )
  if (parts.length) {
    console.log('count:', parts[0].values.length)
    parts[0].values.forEach(r => console.log(JSON.stringify({type:r[1],tc:r[2],tu:r[3],role:r[4],text:(r[5]||'').slice(0,40)})))
  }
  
  // check the query used in getLatestAssistantPart
  console.log('\n=== getLatestAssistantPart query result ===')
  const q = db.exec(
    SELECT json_extract(p.data,'$.text') AS text, p.time_created, p.time_updated,
           json_extract(p.data,'$.type') AS type
    FROM part AS p JOIN message AS m ON m.id = p.message_id
    WHERE p.session_id = ''
      AND json_extract(p.data,'$.type') = 'text'
      AND json_extract(m.data,'$.role') = 'assistant'
    ORDER BY p.time_created DESC LIMIT 1
  )
  if (q.length && q[0].values.length) {
    const [text,tc,tu,type] = q[0].values[0]
    console.log('text_len:', (text||'').length, 'tc:', tc, 'tu:', tu, 'type:', type)
    console.log('text_preview:', (text||'').slice(0,50))
  } else {
    console.log('NO RESULT')
  }
}

db.close()