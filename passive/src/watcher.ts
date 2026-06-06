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
  private walFile: string
  private debounceMs: number
  private fallbackMs: number
  private lastSignature: string

  constructor(
    dbPath: string,
    onChange: ChangeCallback,
    debounceMs: number = 2000,
    fallbackMs: number = 120_000,
  ) {
    this.dbDir = dirname(dbPath)
    this.dbFile = dbPath
    this.dbPrefix = basename(dbPath)
    this.walFile = dbPath + "-wal"
    this.onChange = onChange
    this.debounceMs = debounceMs
    this.fallbackMs = fallbackMs
    this.lastSignature = this.readSignature()
  }

  private readStat(path: string): { mtimeMs: number; size: number } {
    try {
      const stat = statSync(path)
      return { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return { mtimeMs: 0, size: 0 }
    }
  }

  private readSignature(): string {
    const db = this.readStat(this.dbFile)
    const wal = this.readStat(this.walFile)
    return `${db.mtimeMs}:${db.size}|${wal.mtimeMs}:${wal.size}`
  }

  private relevantFile(name: string | null): boolean {
    if (!name) return true
    return name === this.dbPrefix || name === this.dbPrefix + "-wal" || name === this.dbPrefix + "-shm"
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
      const signature = this.readSignature()
      if (signature !== this.lastSignature) {
        this.lastSignature = signature
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
