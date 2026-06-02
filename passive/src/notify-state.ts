import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { existsSync as pathExists } from "node:fs"
import type { AiState } from "./state-machine.js"

const STATE_DIR = join(process.cwd(), "logs")
const STATE_FILE = join(STATE_DIR, "notify-state.json")
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface NotifiedEntry {
  state: AiState
  notifiedAt: number
  transition: string | null
}

export type NotifiedMap = Record<string, NotifiedEntry> & { _primed?: boolean }

function ensureDir(): void {
  if (!pathExists(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
}

export function loadNotifiedState(): NotifiedMap {
  if (!existsSync(STATE_FILE)) return {}
  try {
    const raw = readFileSync(STATE_FILE, "utf-8")
    const parsed = JSON.parse(raw) as NotifiedMap
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function saveNotifiedState(map: NotifiedMap): void {
  ensureDir()
  pruneOldEntries(map)
  const tmp = STATE_FILE + ".tmp"
  try {
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8")
    renameSync(tmp, STATE_FILE)
  } catch {
    /* skip */
  }
}

function pruneOldEntries(map: NotifiedMap): void {
  const cutoff = Date.now() - MAX_AGE_MS
  for (const key of Object.keys(map)) {
    if (map[key].notifiedAt < cutoff) delete map[key]
  }
}

export function recordNotified(
  map: NotifiedMap,
  sessionId: string,
  state: AiState,
  transition: string | null,
): void {
  map[sessionId] = { state, notifiedAt: Date.now(), transition }
  saveNotifiedState(map)
}

export function getNotified(map: NotifiedMap, sessionId: string): NotifiedEntry | null {
  return map[sessionId] ?? null
}
