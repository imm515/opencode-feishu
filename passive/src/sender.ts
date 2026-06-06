export interface FeishuSendResult {
  ok: boolean
  messageId?: string
  error?: string
}

const BLOCKED_REPLY_CARD_TITLES = [
  "💬 OpenCode 新回复",
]

let _token: string | null = null
let _tokenExpire = 0

async function getToken(appId: string, appSecret: string): Promise<string> {
  if (_token && Date.now() < _tokenExpire - 60_000) return _token
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    const json = await res.json() as { tenant_access_token?: string; code?: number; msg?: string }
    const token = json?.tenant_access_token
    if (!token) throw new Error(`No token: code=${json?.code} msg=${json?.msg}`)
    _token = token
    _tokenExpire = Date.now() + 2 * 60 * 60 * 1000
    return token
  } catch (err) {
    throw new Error(`Token fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function sendRaw(
  appId: string,
  appSecret: string,
  chatId: string,
  msgType: "text" | "interactive",
  content: string,
): Promise<FeishuSendResult> {
  const token = await getToken(appId, appSecret)
  const url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
      signal: AbortSignal.timeout(10_000),
    })
    const json = await res.json() as { code?: number; msg?: string; data?: { message_id?: string } }
    if (json.code !== 0) return { ok: false, error: `code=${json.code} msg=${json.msg}` }
    return { ok: true, messageId: json.data?.message_id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function sendTextMessage(
  appId: string,
  appSecret: string,
  chatId: string,
  text: string,
): Promise<FeishuSendResult> {
  return sendRaw(appId, appSecret, chatId, "text", JSON.stringify({ text }))
}

export async function sendInteractiveCard(
  appId: string,
  appSecret: string,
  chatId: string,
  card: object,
): Promise<FeishuSendResult> {
  const content = JSON.stringify(card)
  if (BLOCKED_REPLY_CARD_TITLES.some((title) => content.includes(title))) {
    return { ok: false, error: "blocked reply card payload in passive sender" }
  }
  return sendRaw(appId, appSecret, chatId, "interactive", content)
}
