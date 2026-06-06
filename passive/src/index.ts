import { loadConfig, DB_PATH, CHAT_ID, WATCH_DEBOUNCE_MS, FALLBACK_CHECK_MS } from "./config.js"
import {
  getActiveSessions,
  getRecentlyArchivedSessions,
  getLatestAssistantPart,
  getAssistantTextSince,
  getLatestPartTime,
  getLatestStepFinishStopTime,
  getSessionArchiveTime,
  closeDb,
  refreshDb,
} from "./db.js"
import { sendNotify } from "./notify.js"
import {
  loadNotifiedState,
  saveNotifiedState,
  recordPush,
  markSeen,
  clearArchiveTracking,
  getEntry,
  type SessionTrackEntry,
} from "./notify-state.js"
import { info, error, debug, logPoll, setVerbose } from "./logger.js"
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs"
import { PKG_FILE, LOCK_FILE } from "./paths.js"
import { FileWatcher } from "./watcher.js"
import { createHash } from "node:crypto"

const ARCHIVE_GRACE_MS = 5 * 60 * 1000

const DRY_RUN = process.argv.includes("--dry-run")
const ONE_SHOT = process.argv.includes("--once")
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v")
const RESET = process.argv.includes("--reset-state")

// Always use THIS process start time for the '"'"'session predates daemon'"'"' check.
const DAEMON_STARTED_AT = Date.now()
let HAS_PRIMED_CURRENT_PROCESS = false

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

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12)
}

function hasRuntimeDoneEvidence(entry: SessionTrackEntry | null | undefined): boolean {
  if (!entry) return false
  const seenAfterStart = (entry.lastSeenTime ?? 0) > DAEMON_STARTED_AT
  const hasAssistantText = (entry.lastSeenText ?? "").trim().length > 0
  return seenAfterStart && hasAssistantText
}

async function poll(): Promise<void> {
  await refreshDb()
  const config = loadConfig()
  const state = loadNotifiedState()

  // Prime against the current daemon process once, regardless of whether a prior
  // state file exists. Without this, a restart can treat long-archived sessions
  // as freshly completed and bulk-send backlog done cards.
  const isStartup = !HAS_PRIMED_CURRENT_PROCESS
  const stateStatus = isStartup ? "startup" : "running"

  // Process-local priming must not inherit pending done timers from older daemon
  // windows. Otherwise a restart can replay historical @all completions even when
  // the current process never observed those sessions go live.
  if (isStartup) {
    for (const [sessionId, entry] of Object.entries(state)) {
      if (sessionId.startsWith("_")) continue
      const e = entry as SessionTrackEntry | undefined
      if (!e) continue
      if (e.pendingDoneAt || e.lastSeenArchiveTime > 0) {
        debug(
          "[startup:clear-archive-tracking] "
          + sessionId.slice(0, 18)
          + " pendingDoneAt=" + (e.pendingDoneAt ?? 0)
          + " lastSeenArchiveTime=" + (e.lastSeenArchiveTime ?? 0)
        )
        clearArchiveTracking(state, sessionId, e.lastSeenTime, e.lastSeenText || "")
      }
    }
  }

  const activeSessions = await getActiveSessions()
  const archivedSessions = await getRecentlyArchivedSessions(ARCHIVE_GRACE_MS)

  // Build a Set of currently active/archived session IDs for cancel-check below.
  const activeSet = new Set(activeSessions.map((s) => s.id))

  // --- STEP 1: Cancel pending done if session has reactivated ---
  // If an entry has pendingDoneAt but the session is now active (not archived),
  // the user sent a new message — cancel the pending done.
  if (!isStartup) {
    for (const [sessionId, entry] of Object.entries(state)) {
      if (sessionId.startsWith("_")) continue
      const e = entry as SessionTrackEntry | undefined
      if (e?.pendingDoneAt && activeSet.has(sessionId)) {
        debug("[arch:cancel:reactivated] " + sessionId.slice(0, 18) + " session is active again, cancelling pending done")
        clearArchiveTracking(state, sessionId, e.lastSeenTime, e.lastSeenText || "")
      }
    }
  }

  const sessions = [...activeSessions, ...archivedSessions]

  if (sessions.length === 0) {
    if (!DRY_RUN && isStartup) saveNotifiedState(state)
    HAS_PRIMED_CURRENT_PROCESS = true
    logPoll(0, 0, undefined, 0)
    return
  }

  if (isStartup) {
    // Startup priming is a snapshot step, not normal transition processing.
    // Rebuild active-session tracking from the live DB view so old archive markers
    // cannot leak forward into the current daemon window.
    for (const session of activeSessions) {
      const latestPartTime = await getLatestPartTime(session.id)
      const prev = getEntry(state, session.id)
      state[session.id] = {
        lastSeenTime: Math.max(prev?.lastSeenTime ?? 0, latestPartTime),
        lastSeenText: "",
        lastSeenArchiveTime: 0,
        lastPushedAt: prev?.lastPushedAt ?? 0,
      }
    }

    // Archived sessions seen during startup are only primed as already-known archive
    // snapshots. They must not become pending done transitions in this daemon window.
    for (const session of archivedSessions) {
      const latestPartTime = await getLatestPartTime(session.id)
      const prev = getEntry(state, session.id)
      state[session.id] = {
        lastSeenTime: Math.max(prev?.lastSeenTime ?? 0, latestPartTime),
        lastSeenText: "",
        lastSeenArchiveTime: session.time_archived ?? 0,
        lastPushedAt: prev?.lastPushedAt ?? 0,
      }
    }

    if (!state._schemaVersion || state._schemaVersion < 4) state._schemaVersion = 4
    state._daemonStartedAt = DAEMON_STARTED_AT
    if (!DRY_RUN) saveNotifiedState(state)
    HAS_PRIMED_CURRENT_PROCESS = true
    logPoll(sessions.length, 0, undefined, 0)
    info("[cycle] pushes=0 sessions=" + sessions.length + " status=" + stateStatus)
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
          // === DEDUP: re-read state to check if another instance already handled this archive ===
                  const freshState = loadNotifiedState()
                  const freshEntry = getEntry(freshState, session.id)
                  if (freshEntry && freshEntry.lastSeenArchiveTime >= archiveTime) {
                        debug("[arch:skip:dedup] " + title + " another instance already handled archiveTime=" + archiveTime)
                        markSeen(state, session.id, freshEntry.lastSeenTime, "", archiveTime)
                        continue
                  }
                  if ((prev?.lastPushedAt ?? 0) > 0 && (prev?.lastSeenArchiveTime ?? 0) >= archiveTime) {
                        debug("[arch:skip:already-pushed] " + title + " archiveTime=" + archiveTime + " prevArchiveTime=" + (prev?.lastSeenArchiveTime ?? 0) + " lastPushedAt=" + (prev?.lastPushedAt ?? 0))
                        markSeen(state, session.id, prev?.lastSeenTime ?? archiveTime, prev?.lastSeenText ?? "", archiveTime)
                        continue
                  }

          // Record pendingDoneAt — done card is deferred until ARCHIVE_GRACE_MS expires.
          // If the session reactivates before then, the cancel-check above clears pendingDoneAt.
          const daemonSeenLive = hasRuntimeDoneEvidence(prev)
          if (!daemonSeenLive) {
            debug(
              "[arch:skip:no-runtime-evidence] "
              + title
              + " archiveTime=" + archiveTime
              + " prevSeen=" + (prev?.lastSeenTime ?? 0)
              + " textLen=" + ((prev?.lastSeenText ?? "").trim().length)
              + " daemonStart=" + DAEMON_STARTED_AT
            )
            markSeen(state, session.id, prev?.lastSeenTime ?? archiveTime, prev?.lastSeenText ?? "", archiveTime)
            continue
          }

          debug("[arch:pending] " + title + " archiveTime=" + archiveTime + " — waiting " + ARCHIVE_GRACE_MS + "ms before sending done")
          const prevTimeVal = prev?.lastSeenTime ?? 0
          const prevTextVal = prev?.lastSeenText ?? ""
          markSeen(state, session.id, prevTimeVal, prevTextVal, archiveTime)
          // Set pendingDoneAt on the entry just written
          const entry = getEntry(state, session.id)
          if (entry) (entry as SessionTrackEntry).pendingDoneAt = archiveTime
        }
      } else {
        // Session is still archived — check if the pending done timer has expired.
        const entry = prev as SessionTrackEntry | null
        if (entry?.pendingDoneAt) {
          const elapsed = Date.now() - entry.pendingDoneAt
          if (elapsed >= ARCHIVE_GRACE_MS) {
            const archiveTimeNow = await getSessionArchiveTime(session.id)
            const stillArchived = !!(archiveTimeNow && archiveTimeNow > 0)
            if (!stillArchived || archiveTimeNow !== archiveTime) {
              debug(
                "[arch:skip:archive-mismatch] "
                + title
                + " expectedArchiveTime=" + archiveTime
                + " archiveTimeNow=" + (archiveTimeNow ?? 0)
              )
              clearArchiveTracking(state, session.id, entry.lastSeenTime, entry.lastSeenText || "")
              continue
            }
            const latestPartTime = await getLatestPartTime(session.id)
            const latestStopTime = await getLatestStepFinishStopTime(session.id)
            const hasStopEvidence = latestStopTime > 0
            const stopCoversArchive = latestStopTime >= archiveTime
            const noPostArchiveParts = latestPartTime <= archiveTime

            if (!hasStopEvidence || !stopCoversArchive || !noPostArchiveParts) {
              debug(
                "[arch:skip:not-final] "
                + title
                + " latestPartTime=" + latestPartTime
                + " latestStopTime=" + latestStopTime
                + " archiveTime=" + archiveTime
                + " hasStopEvidence=" + hasStopEvidence
                + " stopCoversArchive=" + stopCoversArchive
                + " noPostArchiveParts=" + noPostArchiveParts
              )
              continue
            }

            // Timer expired and archive still looks final — send the done card.
            debug(
              "[arch:fire:done] "
              + title
              + " elapsed=" + elapsed + "ms >= " + ARCHIVE_GRACE_MS + "ms"
              + " latestPartTime=" + latestPartTime
              + " latestStopTime=" + latestStopTime
            )
            try {
              const latest = await getLatestAssistantPart(session.id)
              const latestText = latest?.text ?? ""
              debug("[arch:done] " + title + " textLen=" + latestText.length)
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
          } else {
            debug("[arch:wait] " + title + " pendingDoneAt=" + entry.pendingDoneAt + " elapsed=" + elapsed + "ms — still waiting")
          }
        } else {
          debug("[arch:skip] " + title + " archiveTime=" + archiveTime + " <= prevArchiveTime=" + prevArchiveTime + " no pendingDoneAt")
        }
      }
    } else {
      // --- active session ---
      if (isStartup) {
        const letP = await getLatestPartTime(session.id)
        debug("[active:prime] " + title + " latestPartTime=" + letP)
        markSeen(state, session.id, letP, "", 0)
        clearArchiveTracking(state, session.id, letP, "")
        continue
      }

      const latest = await getLatestAssistantPart(session.id)

      if (!latest) {
        debug("[active:skip] " + title + " no assistant text part found")
        const partTime = await getLatestPartTime(session.id)
        markSeen(state, session.id, partTime, "", 0)
        clearArchiveTracking(state, session.id, partTime, "")
        continue
      }

      const latestTime = latest.time_created

      // Skip parts that existed before this daemon process started.
      if (latestTime <= DAEMON_STARTED_AT) {
        debug("[active:skip:old] " + title + " latestTime=" + latestTime + " daemonStart=" + DAEMON_STARTED_AT)
        markSeen(state, session.id, latestTime, "", 0)
        clearArchiveTracking(state, session.id, latestTime, "")
        continue
      }

      const hasNew = latestTime > prevTime
      const ctxLatest = await getLatestPartTime(session.id)
      debug("[active:check] " + title + " latestTime=" + latestTime + " hasNew=" + hasNew + " latestPart=" + ctxLatest)

      if (hasNew && latest.text.trim()) {
        // === DEDUP: re-read state to check if another instance already pushed ===
        const freshState = loadNotifiedState()
        const freshEntry = getEntry(freshState, session.id)
        if (freshEntry && freshEntry.lastSeenTime >= latestTime) {
          debug("[active:skip:dedup] " + title + " another instance already pushed latestTime=" + latestTime)
          markSeen(state, session.id, latestTime, "", 0)
          continue
        }

        // Passive mode tracks new text for done detection only.
        // No intermediate reply card is pushed.
        const joined = await getAssistantTextSince(session.id, prevTime)
        const replyText = joined.text.trim() || latest.text.trim()
        const replyTime = joined.latestTime
        debug("[active:assemble] " + title + " chunks=" + joined.chunkCount + " len=" + replyText.length + " replyTime=" + replyTime)
        markSeen(state, session.id, replyTime, replyText, 0)
        clearArchiveTracking(state, session.id, replyTime, replyText)
        debug("[active:skip:reply_push_disabled] " + title)
      } else if (hasNew) {
        debug("[active:skip:empty] " + title + " latestTime=" + latestTime + " text is empty")
        markSeen(state, session.id, latestTime, "", 0)
        clearArchiveTracking(state, session.id, latestTime, "")
      } else {
        markSeen(state, session.id, latestTime, "", 0)
        clearArchiveTracking(state, session.id, latestTime, "")
      }
    }
  }

  if (!state._schemaVersion || state._schemaVersion < 4) state._schemaVersion = 4
  state._daemonStartedAt = DAEMON_STARTED_AT
  if (!DRY_RUN) saveNotifiedState(state)
  HAS_PRIMED_CURRENT_PROCESS = true
  logPoll(sessions.length, pushes, detailLines.join("; ") || undefined, pushes)
  info("[cycle] pushes=" + pushes + " sessions=" + sessions.length + " status=" + stateStatus)
}

async function main(): Promise<void> {
  const version = readVersion()
  setVerbose(VERBOSE)
  const runtimeSignature = {
    indexHash: hashText(poll.toString()),
    sendNotifyHash: hashText(sendNotify.toString()),
    daemonStartedAt: DAEMON_STARTED_AT,
  }
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
    runtimeSignature,
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
  function acquireLock(): boolean {
    try {
      const fd = openSync(LOCK_FILE, "wx")
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
      const existingPid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10)
      if (!isNaN(existingPid)) {
        try { process.kill(existingPid, 0); info("Another daemon (PID " + existingPid + ") is running, exiting"); process.exit(0) }
        catch { /* stale lock */ }
      }
    } catch { /* skip */ }
    unlinkSync(LOCK_FILE)
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
      const currentPid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10)
      if (currentPid === process.pid) {
        unlinkSync(LOCK_FILE)
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
      const currentPid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10)
      if (currentPid === process.pid) unlinkSync(LOCK_FILE)
    } catch {}
    process.exit(0)
  }
  info("Daemon running, watching " + DB_PATH + " (debounce=" + WATCH_DEBOUNCE_MS + "ms, fallback=" + FALLBACK_CHECK_MS + "ms)")
}

main().catch((err) => { error("Fatal", { e: err.message }); process.exit(1) })
// MARKER
