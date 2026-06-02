import { loadConfig, POLL_INTERVAL_MS, CHAT_ID } from "./config.js"
import { getActiveSessions, getSessionParts, closeDb, refreshDb } from "./db.js"
import type { SessionState } from "./state-machine.js"
import { detectAiStateFromParts, formatStateEmoji } from "./state-machine.js"
import { sendNotify } from "./notify.js"
import { TtlMap } from "./utils.js"
import { info, warn, error, logPoll } from "./logger.js"

const sessionStates = new TtlMap<SessionState>(60 * 60 * 1000)

async function poll(): Promise<void> {
  await refreshDb()
  const config = loadConfig()
  const sessions = await getActiveSessions()

  if (sessions.length === 0) return

  let notified = 0
  let detailLines: string[] = []

  for (const session of sessions) {
    const parts = await getSessionParts(session.id)
    const state = detectAiStateFromParts(parts)
    const lastPart = parts.length > 0 ? parts[parts.length - 1] : null
    const lastTime = lastPart?.time_updated ?? session.time_updated
    const existing = sessionStates.get(session.id)

    if (state === "waiting") {
      if (!existing?.notifiedWaiting) {
        await sendNotify({
          appId: config.appId,
          appSecret: config.appSecret,
          sessionId: session.id,
          sessionTitle: session.title,
          state,
          transition: "working→waiting",
        })
        notified++
        const shortTitle = session.title
          ? (session.title.length > 40 ? session.title.slice(0, 40) + "…" : session.title)
          : session.id
        detailLines.push(`${shortTitle}: ❓ notified`)
        sessionStates.set(session.id, {
          sessionId: session.id,
          title: session.title,
          aiState: state,
          lastPartTime: lastTime,
          notifiedWaiting: true,
        })
      } else {
        sessionStates.set(session.id, {
          sessionId: session.id,
          title: session.title,
          aiState: state,
          lastPartTime: lastTime,
          notifiedWaiting: true,
        })
      }
    } else if (state === "working") {
      sessionStates.set(session.id, {
        sessionId: session.id,
        title: session.title,
        aiState: state,
        lastPartTime: lastTime,
        notifiedWaiting: false,
      })
    } else {
      sessionStates.set(session.id, {
        sessionId: session.id,
        title: session.title,
        aiState: state,
        lastPartTime: lastTime,
        notifiedWaiting: existing?.notifiedWaiting ?? false,
      })
    }
  }

  logPoll(sessions.length, notified, detailLines.length ? detailLines.join("; ") : undefined)
}

async function main(): Promise<void> {
  info("Starting opencode-feishu passive monitor (level-triggered)", {
    pollIntervalMs: POLL_INTERVAL_MS,
    chatId: CHAT_ID,
  })

  await refreshDb()
  info("DB opened", { dbPath: "C:\\Users\\Faye Wang\\.local\\share\\opencode\\opencode.db" })

  const interval = setInterval(async () => {
    try {
      await poll()
    } catch (err) {
      error(`Poll error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, POLL_INTERVAL_MS)

  process.on("SIGINT", () => {
    info("Shutting down...")
    clearInterval(interval)
    closeDb()
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    info("Shutting down...")
    clearInterval(interval)
    closeDb()
    process.exit(0)
  })

  await poll()
}

main().catch((err) => {
  error(`Fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
