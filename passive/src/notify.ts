import { info, error } from "./logger.js"
import { sendInteractiveCard } from "./sender.js"
import { buildCardFromDSL, type CardArgs } from "./card-dsl.js"
import type { AiState } from "./state-machine.js"
import { CHAT_ID } from "./config.js"
import { truncateMarkdown } from "./markdown.js"

type StateTransition = "any→waiting" | "any→working" | "any→done"

export interface NotifyParams {
  appId: string
  appSecret: string
  sessionId: string
  sessionTitle: string | null
  state: AiState
  transition: StateTransition
  resultText?: string | null
}

export async function sendNotify(params: NotifyParams): Promise<void> {
  const { appId, appSecret, sessionId, sessionTitle, state, transition, resultText } = params

  const emoji = state === "working" ? "🔄" : state === "waiting" ? "❓" : state === "done" ? "✅" : "❔"
  let title = ""
  let body = ""
  let template: CardArgs["template"] = "blue"
  const sections: CardArgs["sections"] = []

  const shortTitle = sessionTitle
    ? (sessionTitle.length > 40 ? sessionTitle.slice(0, 40) + "…" : sessionTitle)
    : sessionId

  switch (transition) {
    case "any→waiting":
      title = `${emoji} OpenCode 需要你处理`
      template = "blue"
      body = `**会话**: ${shortTitle}\n\nAI 已完成当前回复，等待你的下一步指示。`
      sections.push({ type: "markdown", content: body })
      break
    case "any→working":
      title = `${emoji} OpenCode 正在继续`
      template = "green"
      body = `**会话**: ${shortTitle}\n\nAI 已收到你的输入，正在处理中...`
      sections.push({ type: "markdown", content: body })
      break
    case "any→done":
      title = `${emoji} OpenCode 任务完成`
      template = "green"
      sections.push({ type: "markdown", content: `**会话**: ${shortTitle}` })
      if (resultText && resultText.trim()) {
        sections.push({ type: "divider" })
        sections.push({ type: "markdown", content: truncateMarkdown(resultText) })
      } else {
        sections.push({ type: "markdown", content: `\n任务已全部完成（无文本输出）。` })
      }
      break
  }

  info(`Sending notification: ${transition} for session ${sessionId}`, {
    title,
    template,
    chatId: CHAT_ID,
    sessionTitle: shortTitle,
    hasResult: !!resultText,
  })

  const card = buildCardFromDSL({
    title,
    template,
    sections,
  })

  const result = await sendInteractiveCard(appId, appSecret, CHAT_ID, card)
  if (result.ok) {
    info(`Notification sent: ${transition} for ${sessionId}`, {
      messageId: result.messageId,
      chatId: CHAT_ID,
    })
  } else {
    error(`Notification failed: ${result.error}`, {
      transition,
      sessionId,
      chatId: CHAT_ID,
    })
  }
}
