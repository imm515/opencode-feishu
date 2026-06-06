import { watch, type FSWatcher, statSync, existsSync } from "node:fs"
import { dirname, basename } from "node:path"

export interface WatchTrigger {
  source: "dir" | "file" | "fallback"
  event: string
  filename: string | null
  signatureBefore: string
  signatureAfter: string
  changed: boolean
}

export type ChangeCallback = (trigger: WatchTrigger) => void

export class FileWatcher {
  private dirWatcher: FSWatcher | null = null
  private fileWatchers = new Map<string, FSWatcher>()
  private fallbackTimer: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private onChange: ChangeCallback
  private dbDir: string
  private dbFile: string
  private dbPrefix: string
  private walFile: string
  private shmFile: string
  private debounceMs: number
  private fallbackMs: number
  private lastSignature: string
  private pendingTrigger: { source: "dir" | "file"; event: string; filename: string | null } | null = null

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
    this.shmFile = dbPath + "-shm"
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

  private queueTrigger(source: "dir" | "file", event: string, filename: string | null): void {
    this.pendingTrigger = { source, event, filename }
    if (!this.relevantFile(filename)) return

    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      const trigger = this.pendingTrigger ?? { source, event, filename }
      this.pendingTrigger = null
      this.debounceTimer = null
      this.fireIfChanged(trigger.source, trigger.event, trigger.filename)
    }, this.debounceMs)
  }

  private fireIfChanged(
    source: "dir" | "file" | "fallback",
    event: string = "change",
    filename: string | null = null,
  ): void {
    try {
      this.ensureFileWatchers()
      const signatureBefore = this.lastSignature
      const signature = this.readSignature()
      const changed = signature !== this.lastSignature
      if (changed) {
        this.lastSignature = signature
      }
      this.onChange({
        source,
        event,
        filename,
        signatureBefore,
        signatureAfter: signature,
        changed,
      })
    } catch {
      // file gone — ignore
    }
  }

  private watchFile(path: string): void {
    if (this.fileWatchers.has(path) || !existsSync(path)) return
    try {
      const watcher = watch(path, (event, filename) => this.queueTrigger("file", event, filename ?? basename(path)))
      this.fileWatchers.set(path, watcher)
    } catch {
      // Windows can race when WAL/SHM files appear/disappear.
    }
  }

  private ensureFileWatchers(): void {
    this.watchFile(this.dbFile)
    this.watchFile(this.walFile)
    this.watchFile(this.shmFile)
  }

  start(): void {
    this.ensureFileWatchers()
    this.dirWatcher = watch(this.dbDir, (event, filename) => {
      this.ensureFileWatchers()
      this.queueTrigger("dir", event, filename)
    })
    this.fallbackTimer = setInterval(() => this.fireIfChanged("fallback", "interval", null), this.fallbackMs)
  }

  stop(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null }
    if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null }
    for (const watcher of this.fileWatchers.values()) watcher.close()
    this.fileWatchers.clear()
  }
}
