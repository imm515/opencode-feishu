import { info, error } from "./logger.js"
import { sendInteractiveCard } from "./sender.js"
import { buildCardFromDSL, type CardArgs } from "./card-dsl.js"
import type { AiState } from "./state-machine.js"
import { CHAT_ID } from "./config.js"

type StateTransition = "working→waiting" | "waiting→working" | "any→done"

export interface NotifyParams {
  appId: string
  appSecret: string
  sessionId: string
  sessionTitle: string | null
  state: AiState
  transition: StateTransition
}

export async function sendNotify(params: NotifyParams): Promise<void> {
  const { appId, appSecret, sessionId, sessionTitle, state, transition } = params

  const emoji = state === "working" ? "🔄" : state === "waiting" ? "❓" : state === "done" ? "✅" : "❔"
  let title = ""
  let body = ""
  let template: CardArgs["template"] = "blue"

  const shortTitle = sessionTitle
    ? (sessionTitle.length > 40 ? sessionTitle.slice(0, 40) + "…" : sessionTitle)
    : sessionId

  switch (transition) {
    case "working→waiting":
      title = `${emoji} OpenCode 需要你处理`
      template = "blue"
      body = `**会话**: ${shortTitle}\n\nAI 已完成当前回复，等待你的下一步指示。`
      break
    case "waiting→working":
      title = `${emoji} OpenCode 正在继续`
      template = "green"
      body = `**会话**: ${shortTitle}\n\nAI 已收到你的输入，正在处理中...`
      break
    case "any→done":
      title = `${emoji} OpenCode 任务完成`
      template = "green"
      body = `**会话**: ${shortTitle}\n\n任务已全部完成。`
      break
  }

  info(`Sending notification: ${transition} for session ${sessionId}`, {
    title,
    template,
    chatId: CHAT_ID,
    sessionTitle: shortTitle,
  })

  const card = buildCardFromDSL({
    title,
    template,
    sections: [
      { type: "markdown", content: body },
    ],
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