// 会话持久化存储：data/sessions 目录是唯一事实来源
// （<id>.jsonl 事件日志 / <id>.meta.json 元数据 / <id>.bbdoc.json 画布快照）。
// 内存里的会话 Map 只是热缓存——服务重启后必须能仅凭磁盘重建会话列表与模型选择。
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export type SubagentStatus = 'running' | 'done' | 'error' | 'stopped' | 'idle'

export interface SessionMeta {
  /** root=主会话；subagent=子代理会话（不出现在普通会话列表） */
  mode?: 'root' | 'subagent'
  /** 子代理：父会话 id */
  parentId?: string
  /**
   * 会话的**活跃画布** id（durable，等价 dsh 会话头部的 cwd）。
   * 根会话 = 自己的 id；建模子代理创建时用自己的 id（独立画布）。
   */
  canvasId?: string
  /**
   * 会话拥有的画布集合（durable）。老会话没有这个字段时运行时按 `[canvasId]` 计算，
   * 不回填写盘；只有新建画布时才主动追加。
   */
  canvasIds?: string[]
  /** 会话绑定的本地工作目录（左栏显示；mcdev 工具的相对根） */
  cwd?: string
  /** 计划模式（只读出方案；持久化，重开/重启后仍然有效） */
  planMode?: boolean
  /** 最后一次 todo_write 的整表（界面「计划」标签与系统提示都用它） */
  todos?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] | null
  /** 授权策略：ask=写/命令类工具弹窗询问；auto=本会话自动放行 */
  permission?: 'ask' | 'auto'
  /** 用户「本会话内总是允许」的工具白名单 */
  allowedTools?: string[]
  /** 子代理：同级唯一名（agent-1…） */
  agentName?: string
  /** 子代理：派发时的 3-5 字任务简述 */
  description?: string
  /** 子代理：最近一次运行结果（running 由进程内状态推导，不落盘） */
  lastStatus?: Exclude<SubagentStatus, 'running'>
  lastError?: string
  lastText?: string
  durationMs?: number
  outputTokens?: number
  /** 会话级模型选择（复合 id：<providerRoute>/<llmModel>） */
  modelId?: string
  /** 本会话使用的代理角色（lead / mcmod / modeling），下一轮生效 */
  profile?: string
  /** 素材绑定：本会话是某个素材的「编辑会话」——画布改动会自动回写该素材 */
  libraryId?: string
  /** 素材名（页头徽标显示，避免每次去读素材库） */
  libraryName?: string
  createdAt?: number
  updatedAt?: number
  /** 首条用户消息摘要（列表展示用） */
  title?: string
}

export interface SessionSummary {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  hasModel: boolean
  mode: 'root' | 'subagent'
  parentId?: string
  canvasId?: string
  /** 会话绑定的本地工作目录（左栏显示；缺省 = 服务端默认目录） */
  cwd?: string
  agentName?: string
  description?: string
  /** 代理角色（会话详情/列表里回显，前端据此恢复选择） */
  profile?: string
  /** 素材绑定：本会话是某个素材的编辑会话（左栏给个 ▤ 标记） */
  libraryId?: string
  libraryName?: string
  status: SubagentStatus
  lastError?: string
  lastText?: string
  durationMs?: number
  outputTokens?: number
  modelId?: string
  /** 是否已归档（来自项目注册表的全局归档集合，不是会话自身字段） */
  archived?: boolean
  /** 所属项目；缺省 = 未分组 */
  projectId?: string
}

/** 会话 id 只允许十六进制/字母数字/下划线/连字符，避免路径穿越（../../etc/passwd） */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidSessionId(id: string): boolean {
  return ID_RE.test(id)
}

/** 写临时文件再 rename —— 崩溃时不会留下半截 JSON（Windows 的 rename 会覆盖目标文件） */
function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

const TITLE_SCAN_BYTES = 128 * 1024
/** 单行上限：带附图的 user/message 一行可能接近 1MB（base64），不能按字节硬截断 */
const TITLE_SCAN_MAX_LINE = 8 * 1024 * 1024

export class SessionStore {
  /** 标题/创建时间的解析缓存：jsonl 的 mtime 不变就不用重扫 */
  private cache = new Map<string, { mtimeMs: number; title: string; createdAt?: number }>()

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  logPath(id: string) {
    return join(this.dir, `${id}.jsonl`)
  }

  metaPath(id: string) {
    return join(this.dir, `${id}.meta.json`)
  }

  docPath(id: string) {
    return join(this.dir, `${id}.bbdoc.json`)
  }

  /** 磁盘上是否已有该会话（事件日志或元数据任一存在即算） */
  exists(id: string): boolean {
    if (!isValidSessionId(id)) return false
    return existsSync(this.logPath(id)) || existsSync(this.metaPath(id))
  }

  /** 新会话先占位空日志文件，避免"刷新/重启即消失" */
  ensureLogFile(id: string) {
    const file = this.logPath(id)
    if (!existsSync(file)) writeFileSync(file, '')
  }

  readMeta(id: string): SessionMeta {
    if (!isValidSessionId(id)) return {}
    try {
      const raw = readFileSync(this.metaPath(id), 'utf8')
      const meta = JSON.parse(raw)
      return meta && typeof meta === 'object' ? meta as SessionMeta : {}
    } catch {
      return {}
    }
  }

  /** 合并写入元数据（原子）；用于模型选择、创建时间、标题 */
  writeMeta(id: string, patch: SessionMeta) {
    if (!isValidSessionId(id)) throw new Error('非法会话 id')
    const next: SessionMeta = { ...this.readMeta(id), ...patch, updatedAt: Date.now() }
    writeJsonAtomic(this.metaPath(id), next)
    return next
  }

  readDoc(id: string): any | null {
    if (!isValidSessionId(id)) return null
    try {
      return JSON.parse(readFileSync(this.docPath(id), 'utf8'))
    } catch {
      return null
    }
  }

  writeDoc(id: string, doc: unknown) {
    if (!isValidSessionId(id)) throw new Error('非法会话 id')
    writeJsonAtomic(this.docPath(id), doc)
  }

  /** 扫描目录重建会话列表：新会话/历史会话一视同仁，按最后活跃时间倒序 */
  list(): SessionSummary[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: SessionSummary[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -'.jsonl'.length)
      if (!isValidSessionId(id)) continue
      const logFile = join(this.dir, name)
      let mtimeMs = 0
      let birthtimeMs = 0
      try {
        const st = statSync(logFile)
        mtimeMs = st.mtimeMs
        birthtimeMs = st.birthtimeMs || st.ctimeMs || st.mtimeMs
      } catch {
        continue
      }
      const meta = this.readMeta(id)
      const derived = this.deriveFromLog(id, logFile, mtimeMs)
      // 画布归属：canvasId 缺省就是自己（历史数据由 CanvasService 沿 parentId 回溯）
      const canvasId = meta.canvasId ?? id
      out.push({
        id,
        createdAt: meta.createdAt ?? derived.createdAt ?? birthtimeMs,
        updatedAt: Math.max(mtimeMs, meta.updatedAt ?? 0),
        title: meta.title ?? derived.title,
        hasModel: existsSync(this.docPath(canvasId)),
        mode: meta.mode === 'subagent' ? 'subagent' : 'root',
        parentId: meta.parentId,
        canvasId,
        cwd: meta.cwd,
        agentName: meta.agentName,
        description: meta.description,
        status: meta.lastStatus ?? 'idle',
        lastError: meta.lastError,
        lastText: meta.lastText,
        durationMs: meta.durationMs,
        outputTokens: meta.outputTokens,
        modelId: meta.modelId,
        profile: meta.profile,
        libraryId: meta.libraryId,
        libraryName: meta.libraryName,
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 从事件日志头部提取首条用户消息作为标题 + 首事件时间作为创建时间 */
  private deriveFromLog(id: string, file: string, mtimeMs: number): { title: string; createdAt?: number } {
    const cached = this.cache.get(id)
    if (cached && cached.mtimeMs === mtimeMs) return { title: cached.title, createdAt: cached.createdAt }

    let title = ''
    let createdAt: number | undefined
    try {
      // 按"完整行"扫描：先快扫前 128KB；若首条消息被超大行（附图 base64）挡在后面，
      // 再按行继续读到 TITLE_SCAN_MAX_LINE —— 绝不能在半行处截断，否则 JSON.parse 全失败、标题丢失。
      const fd = openSync(file, 'r')
      try {
        const buf = Buffer.alloc(64 * 1024)
        let carry = ''
        let scanned = 0
        let stop = false
        while (!stop) {
          const n = readSync(fd, buf, 0, buf.length, null)
          if (n <= 0) break
          scanned += n
          carry += buf.toString('utf8', 0, n)
          let nl: number
          while ((nl = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, nl)
            carry = carry.slice(nl + 1)
            if (!line.trim()) continue
            let ev: any
            try { ev = JSON.parse(line) } catch { continue }
            if (createdAt === undefined && typeof ev.ts === 'number') createdAt = ev.ts
            if (ev.t === 'user/message') {
              title = summarize(ev.text)
              stop = true
              break
            }
          }
          if (!stop && scanned >= TITLE_SCAN_BYTES && !carry) stop = true
          if (!stop && scanned >= TITLE_SCAN_MAX_LINE) {
            // 超大行兜底：从半截行里抠 text 字段，避免整条会话无标题
            const m = carry.match(/"t":"user\/message"[\s\S]*?"text":"((?:[^"\\]|\\.)*)"/)
            if (m) {
              try { title = summarize(JSON.parse(`"${m[1]}"`)) } catch { title = summarize(m[1]) }
            }
            break
          }
        }
        // 扫完整个文件仍没找到 user/message（极小概率：无换行结尾的最后一行）
        if (!stop && carry.trim()) {
          try {
            const ev: any = JSON.parse(carry)
            if (createdAt === undefined && typeof ev.ts === 'number') createdAt = ev.ts
            if (ev.t === 'user/message') title = summarize(ev.text)
          } catch { /* 忽略 */ }
        }
      } finally {
        closeSync(fd)
      }
    } catch { /* 读不到就用空标题 */ }

    this.cache.set(id, { mtimeMs, title, createdAt })
    return { title, createdAt }
  }
}

/** 标题：首行 + 截断，避免把整段任务描述塞进侧栏 */
export function summarize(text: unknown, max = 40): string {
  const s = String(text ?? '')
    .replace(/^\s*\[(?:建模子代理任务|系统通知)[^\]]*\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}
