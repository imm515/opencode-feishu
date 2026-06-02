import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { info, error } from "./logger.js"
import { sendInteractiveCard } from "./sender.js"
import { buildCardFromDSL, type CardArgs, type CardTemplate } from "./card-dsl.js"
import { CHAT_ID } from "./config.js"
import { truncateMarkdown } from "./markdown.js"
import { LOG_DIR } from "./paths.js"

const THREAD_TEMPLATES: { template: CardTemplate }[] = [
  { template: "blue" },
  { template: "green" },
  { template: "orange" },
  { template: "grey" },
  { template: "purple" },
  { template: "red" },
]

const COLOR_FILE = LOG_DIR + "/session-colors.json"
const COLOR_MAX_AGE = 7 * 24 * 60 * 60 * 1000

interface ColorStore {
  [sessionId: string]: { template: CardTemplate; updatedAt: number }
}

let _colorStore: ColorStore | null = null

function loadColorStore(): ColorStore {
  if (_colorStore) return _colorStore
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  try {
    const raw = JSON.parse(readFileSync(COLOR_FILE, "utf-8")) as ColorStore
    _colorStore = raw
  } catch {
    _colorStore = {}
  }
  return _colorStore
}

function saveColorStore(): void {
  if (!_colorStore) return
  const now = Date.now()
  for (const k of Object.keys(_colorStore)) {
    if (now - (_colorStore[k]?.updatedAt ?? 0) > COLOR_MAX_AGE) {
      delete _colorStore[k]
    }
  }
  try {
    writeFileSync(COLOR_FILE, JSON.stringify(_colorStore, null, 2), "utf-8")
  } catch { /* skip */ }
}

function hashSession(sessionId: string): number {
  let hash = 0
  for (const ch of sessionId) {
    hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0
  }
  return hash
}

function pickTemplate(sessionId: string): CardTemplate {
  return THREAD_TEMPLATES[hashSession(sessionId) % THREAD_TEMPLATES.length].template
}

export function threadTemplate(sessionId: string): CardTemplate {
  const store = loadColorStore()
  const existing = store[sessionId]
  if (existing) return existing.template
  const t = pickTemplate(sessionId)
  store[sessionId] = { template: t, updatedAt: Date.now() }
  saveColorStore()
  info("[color] assign " + t + " to " + sessionId.slice(0, 18))
  return t
}

export type PushKind = "reply" | "done"

export interface NotifyParams {
  appId: string
  appSecret: string
  sessionId: string
  sessionTitle: string | null
  kind: PushKind
  text: string | null
  archiveTime?: number | null
  textTime?: number | null
}

function shortTitle(title: string | null | undefined, id: string): string {
  if (!title) return id
  return title.length > 40 ? title.slice(0, 40) + "…" : title
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return ""
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`
}

export async function sendNotify(params: NotifyParams): Promise<void> {
  const { appId, appSecret, sessionId, sessionTitle, kind, text, archiveTime, textTime } = params

  const t = shortTitle(sessionTitle, sessionId)
  const sections: CardArgs["sections"] = []
  let title = ""
  const template = threadTemplate(sessionId)

  if (kind === "done") {
    title = `✅ OpenCode 任务完成`
    sections.push({ type: "markdown", content: `**会话**: ${t}` })
    if (text && text.trim()) {
      sections.push({ type: "divider" })
      sections.push({ type: "markdown", content: truncateMarkdown(text) })
    } else {
      sections.push({ type: "markdown", content: `\n任务已结束（无文本输出）。` })
    }
    sections.push({
      type: "note",
      content: `结束时间: ${fmtTime(archiveTime)}  |  session: ${sessionId.slice(0, 12)}…`,
    })
    sections.push({ type: "markdown", content: "<at id=all></at>" })
  } else {
    title = `💬 OpenCode 新回复`
    sections.push({ type: "markdown", content: `**会话**: ${t}` })
    if (text && text.trim()) {
      sections.push({ type: "divider" })
      sections.push({ type: "markdown", content: truncateMarkdown(text) })
    } else {
      sections.push({ type: "markdown", content: `\nAI 已产生新内容（无文本）。` })
    }
    sections.push({
      type: "note",
      content: `回复时间: ${fmtTime(textTime)}  |  session: ${sessionId.slice(0, 12)}…`,
    })
  }

  info(`[push] kind=${kind} session=${sessionId.slice(0, 12)} text_len=${text?.length ?? 0}`, {
    title,
    template,
    chatId: CHAT_ID,
    sessionTitle: t,
  })

  const card = buildCardFromDSL({ title, template, sections })
  const result = await sendInteractiveCard(appId, appSecret, CHAT_ID, card)
  if (result.ok) {
    info(`[push] sent message_id=${result.messageId} kind=${kind} session=${sessionId.slice(0, 12)}`)
  } else {
    error(`[push] failed: ${result.error}`, { kind, sessionId, chatId: CHAT_ID })
  }
}
