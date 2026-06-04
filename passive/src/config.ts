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
export const POLL_INTERVAL_MS = 20_000
