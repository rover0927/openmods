// 系统日志：捕获服务端 console 输出，保留内存环形缓冲并落盘到 data/logs。
//
// 前端「系统日志」抽屉按 seq 增量轮询；服务重启后 seq 归零，前端会检测到并重置。
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { format } from 'node:util'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  seq: number
  ts: number
  level: LogLevel
  text: string
}

const MAX_ENTRIES = 2000
const entries: LogEntry[] = []
let seq = 0
let logFile = ''
let installed = false

function push(level: LogLevel, args: any[]) {
  const text = format(...args)
  const entry: LogEntry = { seq: ++seq, ts: Date.now(), level, text }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (logFile) {
    try {
      appendFileSync(logFile, `[${new Date(entry.ts).toISOString()}] [${level.toUpperCase()}] ${text}\n`)
    } catch { /* 日志落盘失败不阻塞主流程 */ }
  }
}

/** 安装 console 捕获；在服务启动早期调用一次 */
export function installLogCapture(root: string) {
  if (installed) return
  installed = true
  const day = new Date().toISOString().slice(0, 10)
  logFile = join(root, 'data', 'logs', `app-${day}.log`)
  try { mkdirSync(dirname(logFile), { recursive: true }) } catch { /* 忽略 */ }
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  console.log = (...args: any[]) => { orig.log(...args); push('info', args) }
  console.warn = (...args: any[]) => { orig.warn(...args); push('warn', args) }
  console.error = (...args: any[]) => { orig.error(...args); push('error', args) }
}

/** 读取 seq 之后的日志（最多 limit 条） */
export function getLogs(after = 0, limit = 300): { logs: LogEntry[]; seq: number } {
  const n = Math.max(1, Math.min(500, Number(limit) || 300))
  const logs = entries.filter(e => e.seq > after).slice(-n)
  return { logs, seq }
}

/** 当前日志文件路径（按天分文件） */
export function logFilePath(): string {
  return logFile
}
