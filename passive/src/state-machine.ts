export type AiState = "working" | "waiting" | "done" | "unknown"

export function formatStateEmoji(state: AiState): string {
  switch (state) {
    case "working": return "🔄"
    case "waiting": return "❓"
    case "done": return "✅"
    default: return "❔"
  }
}
