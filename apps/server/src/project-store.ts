// 项目注册表：会话列表的分组维度 + 全局归档集合。
//
// 对应 dsh 的 `dsh-workspace`（WorkspaceRegistry）：
// - 一个项目 = `{ id, title, createdAt, updatedAt }` + 有序的会话记账 `sessionIds`；
// - 归档是 registry-global 的 `archivedSessionIds`（跨所有分组面隐藏），
//   归档不动记账，因此取消归档能回到原位（dsh 注释原文：an archived session keeps its slot）；
// - 删除项目只删注册与记账，**绝不碰会话自己的日志**——这些会话回落到「未分组」
//   （dsh locales `delete.desc`：文件夹与会话记录会保留，其会话将显示在“未分组”下）；
// - 所有写操作走一条串行链（dsh `enqueueOperation`），check-then-write 不会互相插入；
// - 单文件 durable（`data/projects.json`），临时文件 + rename 原子落盘。
//
// 分组可关联一个**已存在的主机目录**（dsh Workspace 的 path；openmods 里叫 cwd）：
// 新建分组时绑定，该分组下的新会话继承它作为工作目录；会话仍可单独改绑。
// 目录的 realpath 校验在路由层做（与会话 cwd 共用 realpathSync + isDirectory）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 一个项目（对应 dsh Workspace；path 在这里叫 cwd） */
export interface ProjectRecord {
  id: string
  /** 展示名；允许重名（dsh 同样允许） */
  title: string
  createdAt: number
  updatedAt: number
  /** 关联的本地目录（dsh Workspace.path）；未关联时为空 */
  cwd?: string
}

/** 落盘状态：dsh WorkspaceRegistryState 的对应物 */
export interface ProjectState {
  version: 1
  projects: ProjectRecord[]
  /** projectId → 会话 id（手动顺序：新会话 attach 时置顶，聊天活动不重排） */
  membership: Record<string, string[]>
  /** 全局归档集合（归档顺序）；等价 dsh `archivedSessionIds` */
  archivedSessionIds: string[]
}

/** 带记账的项目视图（dsh WorkspaceView 的 sessionIds） */
export interface ProjectView extends ProjectRecord {
  sessionIds: string[]
}

/** 重连基线（dsh WorkspaceBaseline） */
export interface ProjectBaseline {
  projects: ProjectView[]
  archivedSessionIds: string[]
}

/** 归档准入：会话仍有正在跑的工作，且调用方没要求"先停再归档" */
export class ProjectActiveSessionError extends Error {
  constructor(readonly sessionId: string, readonly activity: SessionActivity[]) {
    super(`会话仍在运行（${activity.map(a => a.kind).join('、')}），不能直接归档`)
    this.name = 'ProjectActiveSessionError'
  }
}

export class ProjectUnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`会话不存在：${sessionId}`)
    this.name = 'ProjectUnknownSessionError'
  }
}

/** 一条"仍活着的工作"（dsh SessionActivity；openmods 只有 turn 与 subagent 两类） */
export interface SessionActivity {
  kind: 'turn' | 'subagent'
  items?: { id: string; label?: string }[]
}

export interface ArchiveOptions {
  /** 探测会话是否仍在运行；返回非空即拒绝归档（除非 stopActivity） */
  activity?: (sessionId: string) => SessionActivity[]
  /** true = 先写归档再停止工作（dsh 语义：归档集合是 durable 事实，停下引发的唤醒会被门控挡住） */
  stopActivity?: boolean
  /** 停止该会话的运行中工作；归档已落盘后才调用 */
  stop?: (sessionId: string) => void
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function emptyState(): ProjectState {
  return { version: 1, projects: [], membership: {}, archivedSessionIds: [] }
}

/** 规整：坏数据不能把整个侧栏带崩，缺字段按空处理 */
function normalize(raw: any): ProjectState {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  if (Array.isArray(raw.projects)) {
    for (const p of raw.projects) {
      if (!p || typeof p !== 'object') continue
      const id = String(p.id ?? '')
      if (!ID_RE.test(id)) continue
      state.projects.push({
        id,
        title: String(p.title ?? '').trim() || '未命名项目',
        createdAt: Number(p.createdAt) || Date.now(),
        updatedAt: Number(p.updatedAt) || Number(p.createdAt) || Date.now(),
        ...(p.cwd ? { cwd: String(p.cwd) } : {}),
      })
    }
  }
  if (raw.membership && typeof raw.membership === 'object') {
    for (const [projectId, ids] of Object.entries(raw.membership)) {
      if (!Array.isArray(ids)) continue
      state.membership[projectId] = ids
        .map(v => String(v))
        .filter((v, i, all) => ID_RE.test(v) && all.indexOf(v) === i)
    }
  }
  if (Array.isArray(raw.archivedSessionIds)) {
    state.archivedSessionIds = raw.archivedSessionIds
      .map((v: unknown) => String(v))
      .filter((v: string, i: number, all: string[]) => ID_RE.test(v) && all.indexOf(v) === i)
  }
  return state
}

export class ProjectStore {
  private state?: ProjectState
  /** 串行写链：一次只跑一个写操作（dsh enqueueOperation） */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private file: string) {}

  /** 串行执行一个写操作；前一个失败不影响后一个 */
  private enqueue<T>(op: () => T): Promise<T> {
    const run = this.chain.then(op, op)
    this.chain = run.catch(() => undefined)
    return Promise.resolve(run)
  }

  private require(): ProjectState {
    if (!this.state) this.state = this.load()
    return this.state
  }

  private load(): ProjectState {
    try {
      if (!existsSync(this.file)) return emptyState()
      return normalize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return emptyState()
    }
  }

  private persist(next: ProjectState) {
    this.state = next
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2))
      renameSync(tmp, this.file)
    } catch (e: any) {
      console.warn('[projects] 落盘失败:', e?.message ?? e)
    }
  }

  // ---- 读 ----

  /** 重连基线：项目（含记账）+ 归档集合 */
  baseline(): ProjectBaseline {
    return {
      projects: this.projects(),
      archivedSessionIds: [...this.require().archivedSessionIds],
    }
  }

  projects(): ProjectView[] {
    const state = this.require()
    return state.projects.map(p => ({ ...p, sessionIds: [...(state.membership[p.id] ?? [])] }))
  }

  get(projectId: string): ProjectView | undefined {
    return this.projects().find(p => p.id === projectId)
  }

  /** 会话落在哪个项目；undefined = 未分组 */
  projectOf(sessionId: string): string | undefined {
    const state = this.require()
    for (const project of state.projects) {
      if ((state.membership[project.id] ?? []).includes(sessionId)) return project.id
    }
    return undefined
  }

  get archivedSessionIds(): readonly string[] {
    return this.require().archivedSessionIds
  }

  isArchived(sessionId: string): boolean {
    return this.require().archivedSessionIds.includes(sessionId)
  }

  /**
   * 会话自身或它的子代理祖先被归档了吗（dsh `underArchivedSession`）：
   * 归档一个主会话，它派出去的子代理也不能再跑——否则子代理会在"已删除"的会话下面继续干活。
   */
  isArchivedLineage(sessionId: string, parentOf: (id: string) => string | undefined): boolean {
    const visited = new Set<string>()
    let cursor: string | undefined = sessionId
    while (cursor && !visited.has(cursor)) {
      if (this.isArchived(cursor)) return true
      visited.add(cursor)
      cursor = parentOf(cursor)
    }
    return false
  }

  // ---- 项目写 ----

  create(title: string, cwd?: string): Promise<ProjectView> {
    return this.enqueue(() => {
      const state = this.require()
      const now = Date.now()
      const project: ProjectRecord = {
        id: randomUUID().slice(0, 8),
        title: String(title ?? '').trim() || '未命名项目',
        createdAt: now,
        updatedAt: now,
        ...(cwd ? { cwd } : {}),
      }
      this.persist({
        ...state,
        projects: [...state.projects, project],
        membership: { ...state.membership, [project.id]: [] },
      })
      return { ...project, sessionIds: [] }
    })
  }

  rename(projectId: string, title: string): Promise<ProjectView> {
    return this.enqueue(() => {
      const state = this.require()
      const index = state.projects.findIndex(p => p.id === projectId)
      if (index < 0) throw new Error('项目不存在')
      const next = [...state.projects]
      next[index] = { ...next[index], title: String(title ?? '').trim() || next[index].title, updatedAt: Date.now() }
      this.persist({ ...state, projects: next })
      return { ...next[index], sessionIds: [...(state.membership[projectId] ?? [])] }
    })
  }

  /** 改分组关联的目录（传空串 = 解除关联）；只影响之后新建的会话，已有会话的 cwd 不动 */
  setCwd(projectId: string, cwd: string): Promise<ProjectView> {
    return this.enqueue(() => {
      const state = this.require()
      const index = state.projects.findIndex(p => p.id === projectId)
      if (index < 0) throw new Error('项目不存在')
      const next = [...state.projects]
      const clean = String(cwd ?? '').trim()
      next[index] = clean
        ? { ...next[index], cwd: clean, updatedAt: Date.now() }
        : (() => { const { cwd: _drop, ...rest } = next[index]; return { ...rest, updatedAt: Date.now() } })()
      this.persist({ ...state, projects: next })
      return { ...next[index], sessionIds: [...(state.membership[projectId] ?? [])] }
    })
  }

  /**
   * 删除项目注册：只删记录与记账，会话日志与画布分毫不动。
   * 这些会话因此变成"未分组"——正是 dsh `delete.desc` 描述的行为。
   */
  remove(projectId: string): Promise<{ deleted: true; movedSessionIds: string[] }> {
    return this.enqueue(() => {
      const state = this.require()
      const project = state.projects.find(p => p.id === projectId)
      if (!project) throw new Error('项目不存在')
      const movedSessionIds = [...(state.membership[projectId] ?? [])]
      const membership = { ...state.membership }
      delete membership[projectId]
      this.persist({
        ...state,
        projects: state.projects.filter(p => p.id !== projectId),
        membership,
      })
      return { deleted: true as const, movedSessionIds }
    })
  }

  /** 把会话记到项目名下（置顶）；已在名下则原样返回，不重排（dsh attachSession） */
  attach(projectId: string, sessionId: string): Promise<ProjectView> {
    return this.enqueue(() => {
      const state = this.require()
      const project = state.projects.find(p => p.id === projectId)
      if (!project) throw new Error('项目不存在')
      const current = state.membership[projectId] ?? []
      if (current.includes(sessionId)) return { ...project, sessionIds: [...current] }
      // 一个会话只能属于一个项目：先从别的项目摘掉
      const membership: Record<string, string[]> = { ...state.membership }
      for (const [pid, ids] of Object.entries(membership)) {
        if (pid !== projectId && ids.includes(sessionId)) membership[pid] = ids.filter(id => id !== sessionId)
      }
      membership[projectId] = [sessionId, ...current]
      this.persist({ ...state, membership })
      return { ...project, sessionIds: [...membership[projectId]] }
    })
  }

  /** 从项目移除会话 → 回落未分组；idempotent（dsh detachSession） */
  detach(projectId: string, sessionId: string): Promise<ProjectView> {
    return this.enqueue(() => {
      const state = this.require()
      const project = state.projects.find(p => p.id === projectId)
      if (!project) throw new Error('项目不存在')
      const current = state.membership[projectId] ?? []
      const next = current.filter(id => id !== sessionId)
      if (next.length !== current.length) {
        this.persist({ ...state, membership: { ...state.membership, [projectId]: next } })
      }
      return { ...project, sessionIds: next }
    })
  }

  // ---- 归档写 ----

  /**
   * 归档一个会话（软删除）。已归档则直接返回，不写、不探测、不停。
   * 与 dsh 一致：先落归档集合，再停工作——门控读的是 durable 集合，
   * 所以"停下"引发的任何唤醒都会被挡住。
   */
  archive(sessionId: string, options: ArchiveOptions = {}): Promise<void> {
    return this.enqueue(() => {
      const state = this.require()
      if (state.archivedSessionIds.includes(sessionId)) return
      if (options.stopActivity !== true) {
        const activity = options.activity?.(sessionId) ?? []
        if (activity.length > 0) throw new ProjectActiveSessionError(sessionId, activity)
      }
      this.persist({ ...state, archivedSessionIds: [...state.archivedSessionIds, sessionId] })
      if (options.stopActivity === true) options.stop?.(sessionId)
    })
  }

  /** 取消归档：只从集合里摘掉，记账没动过，所以回到原来的分组与位置 */
  unarchive(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      const state = this.require()
      if (!state.archivedSessionIds.includes(sessionId)) return
      this.persist({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }
}
