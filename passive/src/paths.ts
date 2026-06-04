import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const MODULE_DIR = dirname(__filename)

export const PASSIVE_DIR = join(MODULE_DIR, "..")
export const LOG_DIR = join(PASSIVE_DIR, "logs")
export const STATE_FILE = join(LOG_DIR, "notify-state.json")
export const PID_FILE = join(PASSIVE_DIR, ".passive.pid")
export const DIST_ENTRY = join(PASSIVE_DIR, "dist", "index.js")
export const PKG_FILE = join(PASSIVE_DIR, "package.json")

export const START_LOG = join(LOG_DIR, "passive.log")
export const ERR_LOG = join(LOG_DIR, "passive.err")

/** Standalone config path — independent of the opencode-feishu plugin */
export const STANDALONE_CONFIG = join(PASSIVE_DIR, "feishu.json")
