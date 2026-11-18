// 构建日志持久化：每次 mc_gradle build 在 <repo>/data/build-logs 下落一份完整
// stdout+stderr 与同名的 .json 元数据，供前端「构建日志」列表/详情接口读取。
//
// 命名：<YYYYMMDD-HHmmss>-<projectSlug>.log / .json（同秒重复时追加 -2、-3）。
// 写入侧由 mcdev 插件在构建过程中流式调用；读取侧只做列表/详情（防路径穿越）。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/** 构建日志目录（启动时按需创建） */
export const BUILD_LOGS_DIR = join(ROOT, 'data', 'build-logs')

/** 一次构建的元数据（.json 文件内容） */
export interface BuildLogMeta {
  id: string
  project: string
  task: string
  startedAt: number
  finishedAt?: number
  ok: boolean
  exitCode?: number
  jarPath?: string
  logPath: string
}

/** 构建进行中的日志写入器 */
export interface BuildLogWriter {
  id: string
  logPath: string
  meta: BuildLogMeta
  /** 追加一段输出（失败不阻塞构建） */
  write(chunk: string): void
  /** 结束写入（重复调用无副作用） */
  end(): void
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时间戳：20261118-153012 */
function stampOf(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 工程名 → 文件名安全片段 */
function slugOf(project: string): string {
  const slug = String(project ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'project'
}

/** id 只允许文件名安全字符，且解析后必须仍在 BUILD_LOGS_DIR 内 */
function safePath(id: string, ext: string): string | null {
  const raw = String(id ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) return null
  const path = resolve(join(BUILD_LOGS_DIR, `${raw}${ext}`))
  if (!path.startsWith(resolve(BUILD_LOGS_DIR) + sep)) return null
  return path
}

function metaPathOf(logPath: string): string {
  return logPath.replace(/\.log$/i, '.json')
}

/** 原子写元数据：先写 .tmp 再 rename，避免读到半截 JSON */
function writeMeta(meta: BuildLogMeta) {
  const path = metaPathOf(meta.logPath)
  try {
    mkdirSync(BUILD_LOGS_DIR, { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(meta, null, 2))
    try { renameSync(tmp, path) } catch {
      writeFileSync(path, JSON.stringify(meta, null, 2))
    }
  } catch { /* 元数据落盘失败不阻塞构建 */ }
}

function readMeta(id: string): BuildLogMeta | undefined {
  const path = safePath(id, '.json')
  if (!path) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as BuildLogMeta
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return undefined
    return {
      id: raw.id,
      project: String(raw.project ?? ''),
      task: String(raw.task ?? 'build'),
      startedAt: Number(raw.startedAt) || 0,
      ...(typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt) ? { finishedAt: raw.finishedAt } : {}),
      ok: !!raw.ok,
      ...(typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? { exitCode: raw.exitCode } : {}),
      ...(typeof raw.jarPath === 'string' && raw.jarPath ? { jarPath: raw.jarPath } : {}),
      logPath: String(raw.logPath ?? join(BUILD_LOGS_DIR, `${raw.id}.log`)),
    }
  } catch {
    return undefined
  }
}

/**
 * 开始一次构建日志：创建 .log 流 + 初始 .json（ok=false），返回写入器。
 * project 传工程名（basename）即可，内部会做文件名清洗。
 */
export function createBuildLog(opts: { project: string; task?: string; startedAt?: number }): BuildLogWriter {
  const project = String(opts.project ?? '').trim() || 'project'
  const startedAt = Number(opts.startedAt) || Date.now()
  mkdirSync(BUILD_LOGS_DIR, { recursive: true })

  const base = `${stampOf(new Date(startedAt))}-${slugOf(project)}`
  let id = base
  let n = 2
  while (existsSync(join(BUILD_LOGS_DIR, `${id}.log`))) id = `${base}-${n++}`

  const logPath = join(BUILD_LOGS_DIR, `${id}.log`)
  // 同步写：构建收尾时立刻 readBuildLog 也能读到完整内容，不依赖流 flush
  let fd: number | undefined
  try { fd = openSync(logPath, 'w') } catch { fd = undefined }
  const meta: BuildLogMeta = { id, project, task: String(opts.task ?? 'build'), startedAt, ok: false, logPath }
  writeMeta(meta)

  let closed = false
  return {
    id,
    logPath,
    meta,
    write(chunk: string) {
      if (closed || !chunk || fd === undefined) return
      try { writeSync(fd, chunk) } catch { /* 日志写失败不阻塞构建 */ }
    },
    end() {
      if (closed) return
      closed = true
      if (fd === undefined) return
      try { closeSync(fd) } catch { /* 已关闭 */ }
    },
  }
}

/** 结束一次构建：关闭日志流并写入最终元数据；返回最终 meta */
export function finishBuildLog(
  ref: BuildLogWriter | string,
  result: { ok: boolean; exitCode?: number; jarPath?: string; finishedAt?: number },
): BuildLogMeta | undefined {
  const writer = typeof ref === 'string' ? undefined : ref
  if (writer) writer.end()
  const meta = writer?.meta ?? readMeta(String(ref))
  if (!meta) return undefined
  const next: BuildLogMeta = {
    ...meta,
    ok: !!result.ok,
    finishedAt: Number(result.finishedAt) || Date.now(),
  }
  if (typeof result.exitCode === 'number' && Number.isFinite(result.exitCode)) next.exitCode = result.exitCode
  if (result.jarPath) next.jarPath = result.jarPath
  writeMeta(next)
  return next
}

/** 构建日志列表（按开始时间倒序） */
export function listBuildLogs(limit = 30): BuildLogMeta[] {
  const n = Math.max(1, Math.min(200, Number(limit) || 30))
  let files: string[] = []
  try { files = readdirSync(BUILD_LOGS_DIR) } catch { return [] }
  const metas: BuildLogMeta[] = []
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
    const meta = readMeta(f.slice(0, -5))
    if (meta) metas.push(meta)
  }
  metas.sort((a, b) => b.startedAt - a.startedAt)
  return metas.slice(0, n)
}

/** 读一份构建日志（元数据 + 全文）；不存在/路径非法返回 null */
export function readBuildLog(id: string): (BuildLogMeta & { text: string }) | null {
  const meta = readMeta(id)
  if (!meta) return null
  const fallback = safePath(meta.id, '.log')
  const path = resolve(meta.logPath).startsWith(resolve(BUILD_LOGS_DIR) + sep) ? meta.logPath : fallback
  if (!path) return null
  try {
    return { ...meta, text: readFileSync(path, 'utf8') }
  } catch {
    return null
  }
}
