import { loadConfig, POLL_INTERVAL_MS, CHAT_ID } from "./config.js"
import {
  getActiveSessions,
  getRecentlyArchivedSessions,
  getSessionParts,
  getLastTextPart,
  closeDb,
  refreshDb,
} from "./db.js"
import {
  detectSessionState,
  detectTransition,
  type AiState,
  type Transition,
} from "./state-machine.js"
import { sendNotify } from "./notify.js"
import { loadNotifiedState, saveNotifiedState, recordNotified, getNotified } from "./notify-state.js"
import { info, error, logPoll } from "./logger.js"

const ARCHIVE_GRACE_MS = 60 * 1000
const RECENTLY_SEEN_TTL_MS = 30 * 60 * 1000

const DRY_RUN = process.argv.includes("--dry-run")
const ONE_SHOT = process.argv.includes("--once")

async function poll(): Promise<void> {
  await refreshDb()
  const config = loadConfig()
  const notifiedMap = loadNotifiedState()
  const isPrimed = notifiedMap._primed === true

  const activeSessions = await getActiveSessions()
  const archivedSessions = await getRecentlyArchivedSessions(ARCHIVE_GRACE_MS)
  const sessions = [...activeSessions, ...archivedSessions]

  if (sessions.length === 0) {
    logPoll(0, 0)
    return
  }

  let notifiedCount = 0
  const detailLines: string[] = []

  for (const session of sessions) {
    const isArchived = !!(session.time_archived && session.time_archived > 0)
    const parts = await getSessionParts(session.id)
    const currentState: AiState = detectSessionState(parts, isArchived)
    const previous = getNotified(notifiedMap, session.id)
    const transition: Transition = detectTransition(previous?.state ?? null, currentState)

    if (!isPrimed) {
      notifiedMap[session.id] = {
        state: currentState,
        notifiedAt: Date.now(),
        transition: null,
      }
      const shortTitle = session.title
        ? (session.title.length > 40 ? session.title.slice(0, 40) + "…" : session.title)
        : session.id
      detailLines.push(`[prime] ${shortTitle}: ${currentState}`)
      continue
    }

    if (transition && (currentState === "waiting" || currentState === "done")) {
      const resultText = currentState === "done"
        ? (await getLastTextPart(session.id))?.text ?? null
        : null

      const shortTitle = session.title
        ? (session.title.length > 40 ? session.title.slice(0, 40) + "…" : session.title)
        : session.id
      const label = currentState === "done" ? "✅" : "❓"

      const action = DRY_RUN ? "[dry-run] would notify" : "notify"
      info(`${action}: ${transition} for session ${session.id}`, {
        title: `${label} OpenCode ${currentState === "done" ? "任务完成" : "需要你处理"}`,
        sessionTitle: shortTitle,
        hasResult: !!resultText,
        dryRun: DRY_RUN,
      })
      if (DRY_RUN) {
        notifiedCount++
        detailLines.push(`${shortTitle}: ${label} (${previous?.state ?? "?"}→${currentState}) [dry-run]`)
        continue
      }

      try {
        await sendNotify({
          appId: config.appId,
          appSecret: config.appSecret,
          sessionId: session.id,
          sessionTitle: session.title,
          state: currentState,
          transition,
          resultText,
        })
        recordNotified(notifiedMap, session.id, currentState, transition)
        notifiedCount++
        detailLines.push(`${shortTitle}: ${label} (${previous?.state ?? "?"}→${currentState})`)
      } catch (err) {
        error(`Notification failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      notifiedMap[session.id] = {
        state: currentState,
        notifiedAt: previous?.notifiedAt ?? Date.now(),
        transition: previous?.transition ?? null,
      }
    }
  }

  if (!isPrimed) {
    notifiedMap._primed = true
    info(`Primed ${sessions.length} sessions (no notifications on first boot)`)
  }

  if (!DRY_RUN) saveNotifiedState(notifiedMap)
  logPoll(sessions.length, notifiedCount, detailLines.length ? detailLines.join("; ") : undefined)
}

async function main(): Promise<void> {
  info("Starting opencode-feishu passive monitor (edge-triggered)", {
    pollIntervalMs: POLL_INTERVAL_MS,
    chatId: CHAT_ID,
    archiveGraceMs: ARCHIVE_GRACE_MS,
    dryRun: DRY_RUN,
    oneShot: ONE_SHOT,
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

  if (ONE_SHOT) {
    info("--once specified, exiting after first poll")
    process.exit(0)
  }
}

main().catch((err) => {
  error(`Fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
