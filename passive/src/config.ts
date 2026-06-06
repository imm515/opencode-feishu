import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { STANDALONE_CONFIG } from "./paths.js"

const FeishuConfigSchema = {
  appId: (v: unknown) => typeof v === "string" && v.length > 0,
  appSecret: (v: unknown) => typeof v === "string" && v.length > 0,
} as const

export type ResolvedConfig = { appId: string; appSecret: string }

/**
 * Load feishu config from passive/feishu.json (standalone, independent of plugin).
 * Optional configPath override for testing.
 */
export function loadConfig(configPath?: string): ResolvedConfig {
  const path = configPath ?? STANDALONE_CONFIG
  if (!existsSync(path)) {
    throw new Error(
      `Missing feishu config: ${path}\n` +
      `Create passive/feishu.json with {"appId":"cli_xxx","appSecret":"xxx"}`
    )
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  if (!FeishuConfigSchema.appId(raw.appId) || !FeishuConfigSchema.appSecret(raw.appSecret)) {
    throw new Error("Invalid feishu config: appId/appSecret required")
  }
  return { appId: raw.appId, appSecret: raw.appSecret }
}

export const DB_PATH = join(os.homedir(), ".local", "share", "opencode", "opencode.db")
export const PROXY = process.env.FEISHU_PROXY ?? "http://127.0.0.1:10809"
export const CHAT_ID = "oc_82bb66a73329cf403644debd24c86ec5"

function envInt(key: string, fallback: number): number {
  return process.env[key] ? Math.max(1000, parseInt(process.env[key]!, 10) || fallback) : fallback
}

function cliInt(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return Math.max(1000, parseInt(process.argv[idx + 1], 10) || fallback)
  }
  return fallback
}

export const POLL_INTERVAL_MS = cliInt("--poll-ms", envInt("FEISHU_POLL_MS", 20_000))
export const WATCH_DEBOUNCE_MS = cliInt("--debounce-ms", envInt("FEISHU_DEBOUNCE_MS", 2_000))
export const FALLBACK_CHECK_MS = cliInt("--fallback-ms", envInt("FEISHU_FALLBACK_MS", 120_000))
export const COMPLETE_GRACE_MS = cliInt("--complete-grace-ms", envInt("FEISHU_COMPLETE_GRACE_MS", 300_000))
