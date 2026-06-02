import type { PartRow } from "./db.js"

export type AiState = "working" | "waiting" | "done" | "unknown"

export interface SessionState {
  sessionId: string
  title: string | null
  aiState: AiState
  lastPartTime: number
  notifiedWaiting: boolean
}

function partToState(type: string, status: string | null): AiState {
  if (type === "text") return "waiting"
  if (type === "tool" && status === "running") return "working"
  if (type === "tool" && status === "pending") return "working"
  if (type === "tool" && (status === "completed" || status === "error")) return "waiting"
  if (type === "reasoning") return "working"
  return "unknown"
}

function findLastRealPart(parts: PartRow[]): PartRow | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "step-start" || p.type === "step-finish") continue
    return p
  }
  return null
}

export function detectAiStateFromParts(parts: PartRow[]): AiState {
  if (!parts.length) return "unknown"
  const last = parts[parts.length - 1]
  if (last.type === "step-start" || last.type === "step-finish") {
    const real = findLastRealPart(parts.slice(0, -1))
    return real ? partToState(real.type, real.state_status) : "unknown"
  }
  return partToState(last.type, last.state_status)
}

export function formatStateEmoji(state: AiState): string {
  switch (state) {
    case "working": return "🔄"
    case "waiting": return "❓"
    case "done": return "✅"
    default: return "❔"
  }
}
