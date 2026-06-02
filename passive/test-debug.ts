import initSqlJs, { type Database, type QueryExecResult } from "sql.js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const FEISHU_JSON = join(os.homedir(), ".config", "opencode", "plugins", "feishu.json")

async function main() {
  console.log("=== DB Check ===")
  console.log("DB path:", DB_PATH)
  console.log("DB exists:", existsSync(DB_PATH))

  const SQL = await initSqlJs()
  const fileBuffer = existsSync(DB_PATH) ? readFileSync(DB_PATH) : undefined
  const db = new SQL.Database(fileBuffer)

  console.log("\n=== Active Sessions ===")
  const results = db.exec(`
    SELECT id, title, time_created, time_updated, time_archived
    FROM session
    WHERE (time_archived IS NULL OR time_archived = 0)
    ORDER BY time_updated DESC
    LIMIT 10
  `)
  if (!results.length) {
    console.log("No sessions found")
  } else {
    console.log("Columns:", results[0].columns)
    for (const row of results[0].values) {
      console.log(JSON.stringify(row))
    }
  }

  console.log("\n=== Session Parts (first session only) ===")
  if (results.length) {
    const firstSessionId = results[0].values[0][0]
    console.log("Session:", firstSessionId)
    const parts = db.exec(`
      SELECT
        id,
        session_id,
        json_extract(data, '$.type') AS type,
        json_extract(data, '$.state.status') AS state_status,
        time_created,
        time_updated
      FROM part
      WHERE session_id = '${firstSessionId}'
      ORDER BY time_created DESC
      LIMIT 5
    `)
    if (!parts.length) {
      console.log("No parts")
    } else {
      console.log("Columns:", parts[0].columns)
      for (const row of parts[0].values) {
        console.log(JSON.stringify(row))
      }
    }
  }

  console.log("\n=== Feishu Config ===")
  console.log("Config path:", FEISHU_JSON)
  console.log("Config exists:", existsSync(FEISHU_JSON))
  if (existsSync(FEISHU_JSON)) {
    const raw = JSON.parse(readFileSync(FEISHU_JSON, "utf-8"))
    console.log("appId:", raw.appId)
    console.log("appSecret:", raw.appSecret ? "***" + raw.appSecret.slice(-4) : "MISSING")
  }

  console.log("\n=== Token Test ===")
  if (existsSync(FEISHU_JSON)) {
    const cfg = JSON.parse(readFileSync(FEISHU_JSON, "utf-8"))
    if (cfg.appId && cfg.appSecret) {
      try {
        const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
          signal: AbortSignal.timeout(15_000),
        })
        const json = await res.json() as { tenant_access_token?: string; code?: number; msg?: string }
        console.log("Token result:", json.code === 0 ? "OK" : "FAIL", json.msg)
        const token = json.tenant_access_token
        if (token) {
          console.log("Token prefix:", token.slice(0, 8) + "...")

          console.log("\n=== Send Test Card ===")
          const card = {
            schema: "2.0",
            config: { wide_screen_mode: true },
            header: {
              title: { tag: "plain_text", content: "被动模式测试卡片" },
              template: "blue",
            },
            body: {
              elements: [
                { tag: "markdown", content: "**测试消息**\n这是被动模式的测试卡片。" },
              ],
            },
          }
          const sendRes = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ receive_id: "oc_82bb66a73329cf403644debd24c86ec5", msg_type: "interactive", content: JSON.stringify(card) }),
            signal: AbortSignal.timeout(15_000),
          })
          const sendJson = await sendRes.json() as { code?: number; msg?: string; data?: { message_id?: string } }
          console.log("Card result:", sendJson.code === 0 ? "OK" : "FAIL", sendJson.msg)
          console.log("messageId:", sendJson.data?.message_id)
        }
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err))
      }
    }
  }

  db.close()
}

main().catch(console.error)