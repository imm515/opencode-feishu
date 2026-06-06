import { loadConfig, DB_PATH, CHAT_ID, WATCH_DEBOUNCE_MS, FALLBACK_CHECK_MS } from "./config.js"
import {
  getActiveSessions,
  getRecentlyArchivedSessions,
  getLatestAssistantPart,
  getAssistantTextSince,
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
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs"
import { PKG_FILE } from "./paths.js"
import { FileWatcher } from "./watcher.js"

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
          // === DEDUP: re-read state to check if another instance already pushed archive ===
          const freshState = loadNotifiedState()
          const freshEntry = getEntry(freshState, session.id)
          if (freshEntry && freshEntry.lastSeenArchiveTime >= archiveTime) {
            debug("[arch:skip:dedup] " + title + " another instance already pushed archiveTime=" + archiveTime)
            markSeen(state, session.id, freshEntry.lastSeenTime, "", archiveTime)
            continue
          }

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
        markSeen(state, session.id, partTime, "", 0)
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
      const ctxLatest = await getLatestPartTime(session.id)
      debug("[active:check] " + title + " latestTime=" + latestTime + " hasNew=" + hasNew + " latestPart=" + ctxLatest)

      let latestText = ""

      if (hasNew && latest.text.trim()) {
        // === DEDUP: re-read state to check if another instance already pushed ===
        const freshState = loadNotifiedState()
        const freshEntry = getEntry(freshState, session.id)
        if (freshEntry && freshEntry.lastSeenTime >= latestTime) {
          debug("[active:skip:dedup] " + title + " another instance already pushed latestTime=" + latestTime)
          markSeen(state, session.id, latestTime, "", 0)
          continue
        }

        // === ASSEMBLE FULL STREAMED REPLY ===
        // AI streams text in multiple part chunks. We must concatenate all
        // assistant text parts since the last push to capture the full reply
        // (not just the last streaming chunk).
        const joined = await getAssistantTextSince(session.id, prevTime)
        const replyText = joined.text.trim() || latest.text.trim()
        const replyTime = joined.latestTime
        debug("[active:assemble] " + title + " chunks=" + joined.chunkCount + " len=" + replyText.length + " replyTime=" + replyTime)

        // Passive mode now tracks new assistant text only for done detection/state.
        // No intermediate reply card is pushed.
        latestText = replyText
        markSeen(state, session.id, replyTime, replyText, 0)
        debug("[active:skip:reply_push_disabled] " + title + " latestPart=" + ctxLatest)
      } else if (hasNew) {
        debug("[active:skip:empty] " + title + " latestTime=" + latestTime + " text is empty")
        markSeen(state, session.id, latestTime, "", 0)
      }

      if (!hasNew) {
        markSeen(state, session.id, latestTime, "", 0)
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
    watchDebounceMs: WATCH_DEBOUNCE_MS,
    fallbackCheckMs: FALLBACK_CHECK_MS,
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

  // Single-instance lock via exclusive file create (OS-atomic on Windows)
  const lockFile = ".passive.lock"
  function acquireLock(): boolean {
    try {
      const fd = openSync(lockFile, "wx")
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      return false
    }
  }
  if (!acquireLock()) {
    try {
      const existingPid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10)
      if (!isNaN(existingPid)) {
        try { process.kill(existingPid, 0); info("Another daemon (PID " + existingPid + ") is running, exiting"); process.exit(0) }
        catch { /* stale lock */ }
      }
    } catch { /* skip */ }
    unlinkSync(lockFile)
    if (!acquireLock()) { error("Cannot acquire lock even after removing stale file"); process.exit(3) }
  }
  info("Lock acquired, PID " + process.pid)

  // Event-driven watcher (Layer 1+2) + fallback timer (Layer 3)
  let pollInFlight = false
  const watcher = new FileWatcher(DB_PATH, async () => {
    if (pollInFlight) return
    pollInFlight = true
    try { await poll() }
    catch (err) { error("Poll error", { e: err instanceof Error ? err.message : String(err) }) }
    finally { pollInFlight = false }
  }, WATCH_DEBOUNCE_MS, FALLBACK_CHECK_MS)
  watcher.start()

  const shutdown = (sig: string) => {
    info("Received " + sig + ", shutting down")
    watcher.stop()
    closeDb()
    try {
      const currentPid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10)
      if (currentPid === process.pid) {
        unlinkSync(lockFile)
        info("Lock released")
      }
    } catch {}
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM" , () => shutdown("SIGTERM"))
  process.on("uncaughtException", (err) => error("uncaught", { e: err.message, s: err.stack }))
  process.on("unhandledRejection", (r) => error("unhandled", { r: String(r) }))

  // Initial poll on startup
  await poll()
  if (ONE_SHOT) {
    info("--once, exiting")
    watcher.stop()
    try {
      const currentPid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10)
      if (currentPid === process.pid) unlinkSync(lockFile)
    } catch {}
    process.exit(0)
  }
  info("Daemon running, watching " + DB_PATH + " (debounce=" + WATCH_DEBOUNCE_MS + "ms, fallback=" + FALLBACK_CHECK_MS + "ms)")
}

main().catch((err) => { error("Fatal", { e: err.message }); process.exit(1) })
// MARKER
