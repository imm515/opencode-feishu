import { loadConfig, POLL_INTERVAL_MS, CHAT_ID } from "./config.js"
import {
  getActiveSessions,
  getRecentlyArchivedSessions,
  getLatestAssistantPart,
  getLatestPartTime,
  closeDb,
  refreshDb,
} from "./db.js"
import { sendNotify } from "./notify.js"
import {
  loadNotifiedState,
  saveNotifiedState,
  recordPush,
  markSeen,
  getEntry,
} from "./notify-state.js"
import { info, error, debug, logPoll, setVerbose } from "./logger.js"
import { readFileSync } from "node:fs"
import { PKG_FILE } from "./paths.js"

const ARCHIVE_GRACE_MS = 5 * 60 * 1000

const DRY_RUN = process.argv.includes("--dry-run")
const ONE_SHOT = process.argv.includes("--once")
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v")
const RESET = process.argv.includes("--reset-state")

// Always use THIS process start time for the 'session predates daemon' check.
const DAEMON_STARTED_AT = Date.now()

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_FILE, "utf-8")) as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "?"
  }
}

function shortTitle(title: string | null | undefined, id: string): string {
  if (!title) return id
  return title.length > 40 ? title.slice(0, 40) + "..." : title
}

async function poll(): Promise<void> {
  await refreshDb()
  const config = loadConfig()
  const state = loadNotifiedState()

  // isStartup = true on first poll of this process when state has no _schemaVersion.
  const isStartup = !state._schemaVersion
  const stateStatus = isStartup ? "startup" : "running"

  const activeSessions = await getActiveSessions()
  const archivedSessions = await getRecentlyArchivedSessions(ARCHIVE_GRACE_MS)
  const sessions = [...activeSessions, ...archivedSessions]

  if (sessions.length === 0) {
    logPoll(0, 0, undefined, 0)
    return
  }

  let pushes = 0
  const detailLines: string[] = []

  for (const session of sessions) {
    const isArchived = !!(session.time_archived && session.time_archived > 0)
    const archiveTime = session.time_archived ?? 0
    const title = shortTitle(session.title, session.id)
    const prev = getEntry(state, session.id)
    const prevTime = prev?.lastSeenTime ?? 0
    const prevArchiveTime = prev?.lastSeenArchiveTime ?? 0

    if (isArchived) {
      // --- archived session ---
      if (archiveTime > prevArchiveTime) {
        if (isStartup) {
          const latestPartTime = await getLatestPartTime(session.id)
          debug("[arch:prime] " + title + " archiveTime=" + archiveTime + " latestPartTime=" + latestPartTime)
          markSeen(state, session.id, latestPartTime, "", archiveTime)
        } else {
          try {
            const latest = await getLatestAssistantPart(session.id)
            const latestText = latest?.text ?? ""
            debug("[arch:push] " + title + " archiveTime=" + archiveTime + " textTime=" + (latest?.time_created ?? null) + " textLen=" + latestText.length)
            if (!DRY_RUN) {
              await sendNotify({
                appId: config.appId,
                appSecret: config.appSecret,
                sessionId: session.id,
                sessionTitle: session.title,
                kind: "done",
                text: latestText || null,
                archiveTime,
                textTime: latest?.time_created ?? null,
              })
            }
            const partTimeForState = latest?.time_created ?? archiveTime
            recordPush(state, session.id, latestText, partTimeForState, archiveTime)
            pushes++
            detailLines.push("done: " + title)
          } catch (err) {
            error("done push failed: " + session.id, { e: err instanceof Error ? err.message : String(err) })
          }
        }
      } else {
        debug("[arch:skip] " + title + " archiveTime=" + archiveTime + " <= prevArchiveTime=" + prevArchiveTime)
      }
    } else {
      // --- active session ---
      if (isStartup) {
        const letP = await getLatestPartTime(session.id)
        debug("[active:prime] " + title + " latestPartTime=" + letP)
        markSeen(state, session.id, letP, "", 0)
        continue
      }

      const latest = await getLatestAssistantPart(session.id)

      if (!latest) {
        debug("[active:skip] " + title + " no assistant text part found")
        const partTime = await getLatestPartTime(session.id)
        if (prev) markSeen(state, session.id, partTime, "", 0)
        else markSeen(state, session.id, partTime, "", 0)
        continue
      }

      const latestTime = latest.time_created

      // Skip parts that existed before this daemon process started.
      if (latestTime <= DAEMON_STARTED_AT) {
        debug("[active:skip:old] " + title + " latestTime=" + latestTime + " daemonStart=" + DAEMON_STARTED_AT)
        markSeen(state, session.id, latestTime, "", 0)
        continue
      }

      const hasNew = latestTime > prevTime
      debug("[active:check] " + title + " prevTime=" + prevTime + " latestTime=" + latestTime + " hasNew=" + hasNew)

      if (!hasNew) {
        debug("[active:skip:synced] " + title + " latestTime=" + latestTime + " <= prev.lastSeenTime=" + prevTime)
        markSeen(state, session.id, latestTime, "", 0)
        continue
      }

      if (!latest.text.trim()) {
        debug("[active:skip:empty] " + title + " latestTime=" + latestTime + " text is empty")
        markSeen(state, session.id, latestTime, "", 0)
        continue
      }

      // === PUSH ===
      try {
        debug("[active:PUSH] " + title + " partTime=" + latestTime + " textLen=" + latest.text.length)
        if (!DRY_RUN) {
          await sendNotify({
            appId: config.appId,
            appSecret: config.appSecret,
            sessionId: session.id,
            sessionTitle: session.title,
            kind: "reply",
            text: latest.text,
            textTime: latestTime,
          })
        }
        recordPush(state, session.id, latest.text, latestTime, 0)
        pushes++
        detailLines.push("reply: " + title)
      } catch (err) {
        error("reply push failed: " + session.id, { e: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  if (!state._schemaVersion) state._schemaVersion = 3
  if (!DRY_RUN) saveNotifiedState(state)
  logPoll(sessions.length, pushes, detailLines.join("; ") || undefined, pushes)
  info("[cycle] pushes=" + pushes + " sessions=" + sessions.length + " status=" + stateStatus)
}

async function main(): Promise<void> {
  const version = readVersion()
  setVerbose(VERBOSE)
  info("opencode-feishu passive monitor v" + version + " starting", {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    pollIntervalMs: POLL_INTERVAL_MS,
    chatId: CHAT_ID,
    archiveGraceMs: ARCHIVE_GRACE_MS,
    dryRun: DRY_RUN,
    oneShot: ONE_SHOT,
    verbose: VERBOSE,
    reset: RESET,
    daemonStartedAt: DAEMON_STARTED_AT,
  })

  if (RESET) {
    try {
      const { unlinkSync } = await import("node:fs")
      const { STATE_FILE } = await import("./paths.js")
      unlinkSync(STATE_FILE)
      info("[reset] state file deleted")
    } catch {/* skip */ }
  }

  try {
    await refreshDb()
    info("DB opened")
  } catch (err) {
    error("DB open failed", { e: err instanceof Error ? err.message : String(err) })
    process.exit(2)
  }

  const interval = setInterval(async () => {
    try { await poll() }
    catch (err) { error("Poll error", { e: err instanceof Error ? err.message : String(err) }) }
  }, POLL_INTERVAL_MS)

  const shutdown = (sig: string) => {
    info("Received " + sig + ", shutting down")
    clearInterval(interval)
    closeDb()
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM" , () => shutdown("SIGTERM"))
  process.on("uncaughtException", (err) => error("uncaught", { e: err.message, s: err.stack }))
  process.on("unhandledRejection", (r) => error("unhandled", { r: String(r) }))

  await poll()
  if (ONE_SHOT) { info("--once, exiting"); process.exit(0) }
  info("Daemon running, polling every " + POLL_INTERVAL_MS + "ms")
}

main().catch((err) => { error("Fatal", { e: err.message }); process.exit(1) })
// MARKER
