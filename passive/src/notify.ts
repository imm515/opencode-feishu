import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { info, error } from "./logger.js"
import { sendInteractiveCard } from "./sender.js"
import { buildCardFromDSL, type CardArgs, type CardTemplate } from "./card-dsl.js"
import { CHAT_ID } from "./config.js"
import { LOG_DIR } from "./paths.js"
import { truncateMarkdown } from "./markdown.js"

const THREAD_TEMPLATES: { template: CardTemplate }[] = [
  { template: "blue" },
  { template: "wathet" },
  { template: "turquoise" },
  { template: "green" },
  { template: "yellow" },
  { template: "orange" },
  { template: "red" },
  { template: "carmine" },
  { template: "violet" },
  { template: "purple" },
  { template: "indigo" },
  { template: "grey" },
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

export type PushKind = "done"  // Only done cards — passive bot sends no intermediate cards.

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
  if (!ms) return "—"
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

  // Runtime hard-stop: passive is done-only. If any stale or hidden path still
  // tries to send a reply card, drop it here instead of trusting compile-time types.
  if (kind !== "done") {
    error(`[push] blocked non-done kind=${String(kind)}`, {
      sessionId,
      chatId: CHAT_ID,
      archiveTime: archiveTime ?? null,
      textTime: textTime ?? null,
    })
    return
  }

  const t = shortTitle(sessionTitle, sessionId)
  const sections: CardArgs["sections"] = []
  const title = `✅ OpenCode 任务完成`
  const template = threadTemplate(sessionId)
  const cleanedText = text?.trim() ?? ""

  sections.push({ type: "markdown", content: "<at id=all></at>" })
  sections.push({ type: "markdown", content: `**会话**: ${t}` })
  if (cleanedText) {
    sections.push({ type: "divider" })
    sections.push({ type: "markdown", content: truncateMarkdown(cleanedText) })
  } else {
    sections.push({ type: "markdown", content: "_任务已完成，但没有捕获到可展示的最终文本输出。_" })
  }
  sections.push({ type: "divider" })
  sections.push({
    type: "note",
    content:
      `结束时间: ${fmtTime(archiveTime ?? textTime)}`
      + `  |  最后回复: ${fmtTime(textTime)}`
      + `  |  session: ${sessionId.slice(0, 12)}…`,
  })
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
