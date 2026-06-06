import { loadConfig, DB_PATH, CHAT_ID, WATCH_DEBOUNCE_MS, FALLBACK_CHECK_MS, COMPLETE_GRACE_MS } from "./config.js"
import {
  getActiveSessions,
  getRecentlyArchivedSessions,
  getLatestAssistantPart,
  getAssistantTextSince,
  getLatestPartTime,
  getLatestPartMeta,
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

const DRY_RUN = process.argv.includes("--dry-run")
const ONE_SHOT = process.argv.includes("--once")
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v")
const RESET = process.argv.includes("--reset-state")
const DEBUG_MODE = COMPLETE_GRACE_MS < 300_000 || VERBOSE || DRY_RUN || ONE_SHOT
const STARTUP_CATCHUP_WINDOW_MS = Math.max(COMPLETE_GRACE_MS * 4, 10 * 60 * 1000)

const DAEMON_STARTED_AT = Date.now()
let HAS_PRIMED_CURRENT_PROCESS = false
let pendingWakeTimer: ReturnType<typeof setTimeout> | null = null
let lastTriggerMeta: { source: string; event: string; filename: string | null; changed: boolean; observedAt: number } | null = null

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

function getPendingDoneTime(entry: SessionTrackEntry | null | undefined): number {
  return entry?.pendingDoneAt ?? 0
}

function getLastDoneStopTime(entry: SessionTrackEntry | null | undefined): number {
  return entry?.lastDoneStopTime ?? 0
}

function getPendingReason(entry: SessionTrackEntry | null | undefined): string {
  return entry?.lastPendingReason ?? "unknown"
}

function wasDoneAlreadyPushed(
  sessionId: string,
  eventTime: number,
  stopTime: number,
): SessionTrackEntry | null {
  const freshState = loadNotifiedState()
  const freshEntry = getEntry(freshState, sessionId)
  if (!freshEntry) return null

  const pushedAt = freshEntry.lastPushedAt ?? 0
  const donePartTime = freshEntry.lastDonePartTime ?? 0
  const doneStopTime = freshEntry.lastDoneStopTime ?? 0
  if (pushedAt > 0 && donePartTime >= eventTime && doneStopTime >= stopTime) {
    return freshEntry
  }
  return null
}

function schedulePendingWake(
  state: ReturnType<typeof loadNotifiedState>,
  onWake?: () => void,
): void {
  if (pendingWakeTimer) {
    clearTimeout(pendingWakeTimer)
    pendingWakeTimer = null
  }

  if (!onWake) return

  let nextWakeAt = 0
  for (const [sessionId, entry] of Object.entries(state)) {
    if (sessionId.startsWith("_")) continue
    const pendingDoneAt = getPendingDoneTime(entry as SessionTrackEntry | null)
    if (!pendingDoneAt) continue
    const dueAt = pendingDoneAt + COMPLETE_GRACE_MS
    if (!nextWakeAt || dueAt < nextWakeAt) nextWakeAt = dueAt
  }

  if (!nextWakeAt) return

  const delay = Math.max(0, nextWakeAt - Date.now())
  debug("[pending:wake:schedule] dueAt=" + nextWakeAt + " delayMs=" + delay)
  pendingWakeTimer = setTimeout(() => {
    pendingWakeTimer = null
    onWake()
  }, delay)
}

async function poll(onPendingWake?: () => void): Promise<void> {
  await refreshDb()
  const config = loadConfig()
  const state = loadNotifiedState()

  const isStartup = !HAS_PRIMED_CURRENT_PROCESS
  const stateStatus = isStartup ? "startup" : "running"

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
  const archivedSessions = await getRecentlyArchivedSessions(COMPLETE_GRACE_MS)
  const activeSet = new Set(activeSessions.map((s) => s.id))

  if (!isStartup) {
    for (const [sessionId, entry] of Object.entries(state)) {
      if (sessionId.startsWith("_")) continue
      const e = entry as SessionTrackEntry | undefined
      if (e?.pendingDoneAt && activeSet.has(sessionId)) {
        const latestPartTime = await getLatestPartTime(sessionId)
        const latestStopTime = await getLatestStepFinishStopTime(sessionId)
        if (latestPartTime > (e.pendingDoneAt ?? 0) || latestStopTime > (e.pendingDoneAt ?? 0)) {
          debug("[done:cancel:reactivated] " + sessionId.slice(0, 18) + " session resumed after pending done")
          clearArchiveTracking(state, sessionId, latestPartTime, e.lastSeenText || "")
        }
      }
    }
  }

  const sessions = [...activeSessions, ...archivedSessions]

  if (sessions.length === 0) {
    if (!DRY_RUN && isStartup) saveNotifiedState(state)
    HAS_PRIMED_CURRENT_PROCESS = true
    schedulePendingWake(state, onPendingWake)
    logPoll(0, 0, undefined, 0)
    return
  }

  if (isStartup) {
    for (const session of activeSessions) {
      const latestPartTime = await getLatestPartTime(session.id)
      const latestStopTime = await getLatestStepFinishStopTime(session.id)
      const latest = await getLatestAssistantPart(session.id)
      const prev = getEntry(state, session.id)
      const lastDoneStopTime = getLastDoneStopTime(prev)
      const noPostStopParts = latestPartTime <= latestStopTime
      const stopNeedsCatchup = latestStopTime > lastDoneStopTime
      const stopIsRecent = latestStopTime > 0 && (Date.now() - latestStopTime) <= STARTUP_CATCHUP_WINDOW_MS
      state[session.id] = {
        lastSeenTime: Math.max(prev?.lastSeenTime ?? 0, latestPartTime),
        lastSeenText: prev?.lastSeenText ?? "",
        lastSeenArchiveTime: 0,
        lastSeenStopTime: Math.max(prev?.lastSeenStopTime ?? 0, latestStopTime),
        lastPushedAt: prev?.lastPushedAt ?? 0,
        lastDonePartTime: prev?.lastDonePartTime,
        lastDoneStopTime: prev?.lastDoneStopTime,
      }
      if (latest?.text?.trim() && stopNeedsCatchup && stopIsRecent && noPostStopParts) {
        const joined = await getAssistantTextSince(session.id, lastDoneStopTime > 0 ? lastDoneStopTime : 0)
        const catchupText = joined.text.trim() || latest.text.trim()
        markSeen(state, session.id, joined.latestTime || latest.time_created, catchupText, 0, latestStopTime)
        const entry = getEntry(state, session.id)
        if (entry) {
          ;(entry as SessionTrackEntry).pendingDoneAt = latestStopTime
          ;(entry as SessionTrackEntry).lastPendingReason = "startup-catchup"
        }
        debug(
          "[startup:catchup-pending] "
          + shortTitle(session.title, session.id)
          + " stopTime=" + latestStopTime
          + " recentWindowMs=" + STARTUP_CATCHUP_WINDOW_MS
          + " textLen=" + catchupText.length
        )
      }
    }

    for (const session of archivedSessions) {
      const latestPartTime = await getLatestPartTime(session.id)
      const latestStopTime = await getLatestStepFinishStopTime(session.id)
      const prev = getEntry(state, session.id)
      state[session.id] = {
        lastSeenTime: Math.max(prev?.lastSeenTime ?? 0, latestPartTime),
        lastSeenText: prev?.lastSeenText ?? "",
        lastSeenArchiveTime: session.time_archived ?? 0,
        lastSeenStopTime: Math.max(prev?.lastSeenStopTime ?? 0, latestStopTime),
        lastPushedAt: prev?.lastPushedAt ?? 0,
        lastDonePartTime: prev?.lastDonePartTime,
        lastDoneStopTime: prev?.lastDoneStopTime,
      }
    }

    if (!state._schemaVersion || state._schemaVersion < 6) state._schemaVersion = 6
    state._daemonStartedAt = DAEMON_STARTED_AT
    if (!DRY_RUN) saveNotifiedState(state)
    HAS_PRIMED_CURRENT_PROCESS = true
    schedulePendingWake(state, onPendingWake)
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
    const prevStopTime = prev?.lastSeenStopTime ?? 0

    if (isArchived) {
      if (archiveTime > prevArchiveTime) {
        const freshState = loadNotifiedState()
        const freshEntry = getEntry(freshState, session.id)
        if (freshEntry && freshEntry.lastSeenArchiveTime >= archiveTime) {
          debug("[arch:skip:dedup] " + title + " another instance already handled archiveTime=" + archiveTime)
          markSeen(state, session.id, freshEntry.lastSeenTime, freshEntry.lastSeenText, archiveTime, freshEntry.lastSeenStopTime)
          continue
        }

        const latestStopTime = await getLatestStepFinishStopTime(session.id)
        const daemonSeenLive = hasRuntimeDoneEvidence(prev)
        if (!daemonSeenLive && latestStopTime <= DAEMON_STARTED_AT) {
          debug("[arch:skip:no-runtime-evidence] " + title + " archiveTime=" + archiveTime + " stopTime=" + latestStopTime)
          markSeen(state, session.id, prev?.lastSeenTime ?? archiveTime, prev?.lastSeenText ?? "", archiveTime, latestStopTime)
          continue
        }

        debug("[arch:pending] " + title + " archiveTime=" + archiveTime + " — waiting " + COMPLETE_GRACE_MS + "ms before sending done")
        markSeen(state, session.id, prev?.lastSeenTime ?? archiveTime, prev?.lastSeenText ?? "", archiveTime, latestStopTime)
        const entry = getEntry(state, session.id)
        if (entry) {
          ;(entry as SessionTrackEntry).pendingDoneAt = archiveTime
          ;(entry as SessionTrackEntry).lastPendingReason = "archive"
        }
        continue
      }

      const entry = prev as SessionTrackEntry | null
      const pendingDoneTime = getPendingDoneTime(entry)
      if (!pendingDoneTime) {
        debug("[arch:skip] " + title + " archiveTime=" + archiveTime + " <= prevArchiveTime=" + prevArchiveTime + " no pendingDoneAt")
        continue
      }

      const elapsed = Date.now() - pendingDoneTime
      if (elapsed < COMPLETE_GRACE_MS) {
        const remaining = COMPLETE_GRACE_MS - elapsed
        debug("[arch:wait] " + title + " pendingDoneAt=" + pendingDoneTime + " elapsed=" + elapsed + "ms remaining=" + remaining + "ms — still waiting")
        continue
      }

      const archiveTimeNow = await getSessionArchiveTime(session.id)
      const stillArchived = !!(archiveTimeNow && archiveTimeNow > 0)
      if (!stillArchived || archiveTimeNow !== archiveTime) {
        debug("[arch:skip:archive-mismatch] " + title + " expectedArchiveTime=" + archiveTime + " archiveTimeNow=" + (archiveTimeNow ?? 0))
        clearArchiveTracking(state, session.id, entry?.lastSeenTime, entry?.lastSeenText || "")
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
        )
        continue
      }

      debug("[arch:fire:done] " + title + " elapsed=" + elapsed + "ms latestPartTime=" + latestPartTime + " latestStopTime=" + latestStopTime)
      try {
        const latest = await getLatestAssistantPart(session.id)
        const latestText = latest?.text ?? ""
        const dedupEntry = wasDoneAlreadyPushed(
          session.id,
          latest?.time_created ?? archiveTime,
          latestStopTime,
        )
        if (dedupEntry) {
          debug("[arch:skip:already-pushed] " + title + " latestTime=" + (latest?.time_created ?? archiveTime) + " stopTime=" + latestStopTime)
          recordPush(
            state,
            session.id,
            dedupEntry.lastSeenText || latestText,
            Math.max(dedupEntry.lastSeenTime ?? 0, latest?.time_created ?? archiveTime),
            Math.max(dedupEntry.lastSeenArchiveTime ?? 0, archiveTime),
            Math.max(dedupEntry.lastSeenStopTime ?? 0, latestStopTime),
          )
          continue
        }
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
        recordPush(state, session.id, latestText, latest?.time_created ?? archiveTime, archiveTime, latestStopTime)
        pushes++
        detailLines.push("done: " + title)
      } catch (err) {
        error("done push failed: " + session.id, { e: err instanceof Error ? err.message : String(err) })
      }
      continue
    }

    const latest = await getLatestAssistantPart(session.id)
    const latestPartTime = await getLatestPartTime(session.id)
    const latestStopTime = await getLatestStepFinishStopTime(session.id)

    if (!latest) {
      debug("[active:skip] " + title + " no assistant text part found")
      markSeen(state, session.id, latestPartTime, "", 0, latestStopTime)
      clearArchiveTracking(state, session.id, latestPartTime, "")
      continue
    }

    const latestTime = latest.time_created
    if (latestTime <= DAEMON_STARTED_AT) {
      debug("[active:skip:old] " + title + " latestTime=" + latestTime + " daemonStart=" + DAEMON_STARTED_AT)
      markSeen(state, session.id, latestTime, "", 0, latestStopTime)
      clearArchiveTracking(state, session.id, latestTime, "")
      continue
    }

    const hasNew = latestTime > prevTime
    debug("[active:check] " + title + " latestTime=" + latestTime + " hasNew=" + hasNew + " latestPart=" + latestPartTime + " latestStopTime=" + latestStopTime)

    if (hasNew && latest.text.trim()) {
      const freshState = loadNotifiedState()
      const freshEntry = getEntry(freshState, session.id)
      if (freshEntry && freshEntry.lastSeenTime >= latestTime) {
        debug("[active:skip:dedup] " + title + " another instance already handled latestTime=" + latestTime)
        markSeen(state, session.id, latestTime, "", 0, latestStopTime)
        continue
      }

      const joined = await getAssistantTextSince(session.id, prevTime)
      const replyText = joined.text.trim() || latest.text.trim()
      const replyTime = joined.latestTime
      debug("[active:assemble] " + title + " chunks=" + joined.chunkCount + " len=" + replyText.length + " replyTime=" + replyTime)
      markSeen(state, session.id, replyTime, replyText, 0, latestStopTime)
      const lastDoneStopTime = getLastDoneStopTime(prev)
      const stopAdvancedNow = latestStopTime > Math.max(prevStopTime, lastDoneStopTime)
      const stopObservedDuringRuntimeNow = latestStopTime > DAEMON_STARTED_AT
      const noPostStopPartsNow = latestPartTime <= latestStopTime
      if (stopAdvancedNow && stopObservedDuringRuntimeNow && noPostStopPartsNow) {
        debug("[active:pending:same-poll] " + title + " stopTime=" + latestStopTime + " replyTime=" + replyTime + " — waiting " + COMPLETE_GRACE_MS + "ms before sending done")
        const entry = getEntry(state, session.id)
        if (entry) {
          ;(entry as SessionTrackEntry).pendingDoneAt = latestStopTime
          ;(entry as SessionTrackEntry).lastPendingReason = "same-poll-stop"
        }
      } else {
        debug(
          "[active:no-done-evidence] "
          + title
          + " replyTime=" + replyTime
          + " stopAdvanced=" + stopAdvancedNow
          + " stopObservedDuringRuntime=" + stopObservedDuringRuntimeNow
          + " noPostStopParts=" + noPostStopPartsNow
          + " latestPartTime=" + latestPartTime
          + " latestStopTime=" + latestStopTime
        )
        clearArchiveTracking(state, session.id, replyTime, replyText)
      }
      debug("[active:skip:reply_push_disabled] " + title)
      continue
    }

    if (hasNew) {
      debug("[active:skip:empty] " + title + " latestTime=" + latestTime + " text is empty")
      markSeen(state, session.id, latestTime, "", 0, latestStopTime)
      clearArchiveTracking(state, session.id, latestTime, "")
      continue
    }

    markSeen(state, session.id, latestTime, prev?.lastSeenText ?? "", 0, latestStopTime)

    const pendingDoneTime = getPendingDoneTime(prev)
    const lastDoneStopTime = getLastDoneStopTime(prev)
    const stopAdvanced = latestStopTime > Math.max(prevStopTime, lastDoneStopTime)
    const stopNeedsPush = latestStopTime > lastDoneStopTime
    const stopObservedDuringRuntime = latestStopTime > DAEMON_STARTED_AT
    const noPostStopParts = latestPartTime <= latestStopTime

    if (pendingDoneTime > 0) {
      const elapsed = Date.now() - pendingDoneTime
      const pendingReason = getPendingReason(prev)
      const latestMeta = await getLatestPartMeta(session.id)
      if (!noPostStopParts) {
        const resumeAfterStopMs = latestPartTime - pendingDoneTime
        debug(
          "[active:cancel:post-stop-output] "
          + title
          + " pendingReason=" + pendingReason
          + " quietForMs=" + elapsed
          + " resumeAfterStopMs=" + resumeAfterStopMs
          + " latestPartTime=" + latestPartTime
          + " latestStopTime=" + latestStopTime
          + " resumedType=" + (latestMeta?.type ?? "")
          + " resumedReason=" + (latestMeta?.reason ?? "")
          + " resumedTool=" + (latestMeta?.tool ?? "")
        )
        clearArchiveTracking(state, session.id, latestPartTime, prev?.lastSeenText ?? "")
        continue
      }

      if (elapsed < COMPLETE_GRACE_MS) {
        const remaining = COMPLETE_GRACE_MS - elapsed
        debug(
          "[active:wait] "
          + title
          + " pendingReason=" + pendingReason
          + " pendingDoneAt=" + pendingDoneTime
          + " elapsed=" + elapsed + "ms remaining=" + remaining + "ms"
        )
        continue
      }

      debug(
        "[active:fire:done] "
        + title
        + " pendingReason=" + pendingReason
        + " quietForMs=" + elapsed
        + " latestStopTime=" + latestStopTime
        + " stopObservedDelayMs=" + Math.max(0, pendingDoneTime - latestStopTime)
        + " triggerSource=" + (lastTriggerMeta?.source ?? "startup")
        + " triggerEvent=" + (lastTriggerMeta?.event ?? "")
        + " triggerChanged=" + String(lastTriggerMeta?.changed ?? false)
        + " triggerObservedDelayMs=" + (lastTriggerMeta ? Math.max(0, lastTriggerMeta.observedAt - latestStopTime) : 0)
      )
      try {
        const dedupEntry = wasDoneAlreadyPushed(
          session.id,
          latest.time_created,
          latestStopTime,
        )
        if (dedupEntry) {
          debug("[active:skip:already-pushed] " + title + " latestTime=" + latest.time_created + " stopTime=" + latestStopTime)
          recordPush(
            state,
            session.id,
            dedupEntry.lastSeenText || latest.text,
            Math.max(dedupEntry.lastSeenTime ?? 0, latest.time_created),
            Math.max(dedupEntry.lastSeenArchiveTime ?? 0, 0),
            Math.max(dedupEntry.lastSeenStopTime ?? 0, latestStopTime),
          )
          continue
        }
        if (!DRY_RUN) {
          await sendNotify({
            appId: config.appId,
            appSecret: config.appSecret,
            sessionId: session.id,
            sessionTitle: session.title,
            kind: "done",
            text: latest.text || null,
            archiveTime: null,
            textTime: latest.time_created ?? null,
          })
        }
        recordPush(state, session.id, latest.text, latest.time_created, 0, latestStopTime)
        pushes++
        detailLines.push("done: " + title)
      } catch (err) {
        error("done push failed: " + session.id, { e: err instanceof Error ? err.message : String(err) })
      }
      continue
    }

    if (stopNeedsPush && stopObservedDuringRuntime && noPostStopParts && hasRuntimeDoneEvidence(prev)) {
      debug("[active:pending] " + title + " stopTime=" + latestStopTime + " — waiting " + COMPLETE_GRACE_MS + "ms before sending done")
      const entry = getEntry(state, session.id)
      if (entry) {
        ;(entry as SessionTrackEntry).pendingDoneAt = latestStopTime
        ;(entry as SessionTrackEntry).lastPendingReason = "separate-stop"
      }
      continue
    }

    debug(
      "[active:no-done-transition] "
      + title
      + " latestTime=" + latestTime
      + " stopAdvanced=" + stopAdvanced
      + " stopNeedsPush=" + stopNeedsPush
      + " stopObservedDuringRuntime=" + stopObservedDuringRuntime
      + " noPostStopParts=" + noPostStopParts
      + " hasRuntimeDoneEvidence=" + hasRuntimeDoneEvidence(prev)
      + " latestPartTime=" + latestPartTime
      + " latestStopTime=" + latestStopTime
    )
    clearArchiveTracking(state, session.id, latestTime, prev?.lastSeenText ?? "")
  }

  if (!state._schemaVersion || state._schemaVersion < 6) state._schemaVersion = 6
  state._daemonStartedAt = DAEMON_STARTED_AT
  if (!DRY_RUN) saveNotifiedState(state)
  HAS_PRIMED_CURRENT_PROCESS = true
  schedulePendingWake(state, onPendingWake)
  logPoll(sessions.length, pushes, detailLines.join("; ") || undefined, pushes)
  info("[cycle] pushes=" + pushes + " sessions=" + sessions.length + " status=" + stateStatus)
}

async function main(): Promise<void> {
  const version = readVersion()
  setVerbose(VERBOSE)
  const runtimeSignature = {
    indexHash: hashText(poll.toString()),
    notifyStateHash: hashText(saveNotifiedState.toString()),
    watcherHash: hashText(FileWatcher.toString()),
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
    archiveGraceMs: COMPLETE_GRACE_MS,
    debugMode: DEBUG_MODE,
    dryRun: DRY_RUN,
    oneShot: ONE_SHOT,
    verbose: VERBOSE,
    reset: RESET,
    daemonStartedAt: DAEMON_STARTED_AT,
    runtimeSignature,
  })

  if (RESET) {
    try {
      const { unlinkSync: fsUnlink } = await import("node:fs")
      const { STATE_FILE } = await import("./paths.js")
      fsUnlink(STATE_FILE)
      info("[reset] state file deleted")
    } catch {
      /* skip */
    }
  }

  try {
    await refreshDb()
    info("DB opened")
  } catch (err) {
    error("DB open failed", { e: err instanceof Error ? err.message : String(err) })
    process.exit(2)
  }

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
        try {
          process.kill(existingPid, 0)
          info("Another daemon (PID " + existingPid + ") is running, exiting")
          process.exit(0)
        } catch {
          /* stale lock */
        }
      }
    } catch {
      /* skip */
    }
    unlinkSync(LOCK_FILE)
    if (!acquireLock()) {
      error("Cannot acquire lock even after removing stale file")
      process.exit(3)
    }
  }
  info("Lock acquired, PID " + process.pid)

  let pollInFlight = false
  let pollQueued = false
  const triggerPoll = async () => {
    if (pollInFlight) {
      pollQueued = true
      return
    }
    pollInFlight = true
    try {
      await poll(() => { void triggerPoll() })
    } catch (err) {
      error("Poll error", { e: err instanceof Error ? err.message : String(err) })
    } finally {
      pollInFlight = false
      if (pollQueued) {
        pollQueued = false
        void triggerPoll()
      }
    }
  }
  const watcher = new FileWatcher(
    DB_PATH,
    async (trigger) => {
      lastTriggerMeta = {
        source: trigger.source,
        event: trigger.event,
        filename: trigger.filename,
        changed: trigger.changed,
        observedAt: Date.now(),
      }
      debug(
        "[watch] source=" + trigger.source
        + " event=" + trigger.event
        + " filename=" + (trigger.filename ?? "")
        + " changed=" + String(trigger.changed)
        + " signatureBefore=" + trigger.signatureBefore
        + " signatureAfter=" + trigger.signatureAfter
      )
      if (!trigger.changed) return
      void triggerPoll()
    },
    WATCH_DEBOUNCE_MS,
    FALLBACK_CHECK_MS,
  )
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
    } catch {
      /* skip */
    }
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("uncaughtException", (err) => error("uncaught", { e: err.message, s: err.stack }))
  process.on("unhandledRejection", (r) => error("unhandled", { r: String(r) }))

  await poll(() => { void triggerPoll() })
  if (ONE_SHOT) {
    info("--once, exiting")
    watcher.stop()
    try {
      const currentPid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10)
      if (currentPid === process.pid) unlinkSync(LOCK_FILE)
    } catch {
      /* skip */
    }
    process.exit(0)
  }
  info("Daemon running, watching " + DB_PATH + " (debounce=" + WATCH_DEBOUNCE_MS + "ms, fallback=" + FALLBACK_CHECK_MS + "ms)")
}

main().catch((err) => {
  error("Fatal", { e: err.message })
  process.exit(1)
})
