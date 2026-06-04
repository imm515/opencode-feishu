import { watch, type FSWatcher, statSync } from "node:fs"
import { dirname, basename } from "node:path"

export type ChangeCallback = () => void

export class FileWatcher {
  private watcher: FSWatcher | null = null
  private fallbackTimer: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private onChange: ChangeCallback
  private dbDir: string
  private dbFile: string
  private dbPrefix: string
  private debounceMs: number
  private fallbackMs: number
  private lastMtime: number

  constructor(
    dbPath: string,
    onChange: ChangeCallback,
    debounceMs: number = 2000,
    fallbackMs: number = 120_000,
  ) {
    this.dbDir = dirname(dbPath)
    this.dbFile = dbPath
    this.dbPrefix = basename(dbPath)
    this.onChange = onChange
    this.debounceMs = debounceMs
    this.fallbackMs = fallbackMs
    this.lastMtime = this.readMtime()
  }

  private readMtime(): number {
    try {
      return statSync(this.dbFile).mtimeMs
    } catch {
      return 0
    }
  }

  private relevantFile(name: string | null): boolean {
    if (!name) return true
    return name.startsWith(this.dbPrefix)
  }

  private onRawEvent(event: string, filename: string | null): void {
    if (!this.relevantFile(filename)) return

    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.fireIfChanged()
    }, this.debounceMs)
  }

  private fireIfChanged(): void {
    try {
      const s = statSync(this.dbFile, { throwIfNoEntry: false })
      if (!s) return
      const mtime = s.mtimeMs
      if (mtime > this.lastMtime) {
        this.lastMtime = mtime
        this.onChange()
      }
    } catch {
      // file gone — ignore
    }
  }

  start(): void {
    this.watcher = watch(this.dbDir, (event, filename) => this.onRawEvent(event, filename))
    this.fallbackTimer = setInterval(() => this.fireIfChanged(), this.fallbackMs)
  }

  stop(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null }
    if (this.watcher) { this.watcher.close(); this.watcher = null }
  }
}
