// 画布服务：openmods 版的「工作区」。
//
// dsh 的对应物是 `dsh-working-directory`：每个会话记录一个 durable 的 cwd，
// 子代理由 `childSessionMeta()` 继承父会话的 cwd，于是同一棵会话树读写同一个目录，
// 而 `ctx.fs` / `ctx.workingDirectory` 是唯一权威——没有"把 state 传给孩子"这种事。
//
// openmods 没有文件系统，画布就是那块 workspace：
// - 每个会话拥有一组画布（meta.canvasIds），其中 `canvasId` 是**活跃画布**（写进 <id>.meta.json）；
// - 建模子代理创建时用自己的 id 作为画布，不再继承父画布；
// - 本服务按 sessionId 解析活跃画布，负责载入/规整/编译/原子落盘/变更广播；
// - 运行时与插件只拿 `CanvasPort`（idOf/listOf/read/ensure/commit/setView/contextText），
//   不接触存储、不自己 fan-out，因此"子代理画布丢失"这类问题在结构上不会出现。
import { randomUUID } from 'node:crypto'
import type { CanvasPort, CanvasRef } from '@openmods/plugin-kit'
import { compile, createDoc } from '../../../plugins/bb-tools/bbmodel.js'
import type { SessionMeta, SessionStore } from './session-store.js'

/** 一次画布变更（服务端把它翻成 SSE model_update / view_update） */
export interface CanvasChange {
  canvasId: string
  /** 触发变更的会话：主会话或某个子代理 */
  originId: string
  agentName?: string
  kind: 'model' | 'view'
  bbmodel?: any
  elements?: number
  textures?: number
  animations?: { name: string; length: number; loop: string }[]
  view?: string
}

/** 规整文档字段：老快照/部分写入可能缺 outliner/textures 等，缺字段会让后续 sync 覆盖成 undefined */
function normalize(doc: any): any {
  const out = doc && typeof doc === 'object' ? doc : createDoc('未命名模型')
  out.elements ??= []
  out.outliner ??= out.elements.map((e: any) => e.uuid)
  out.textures ??= []
  out.animations ??= []
  out.view ??= '3d'
  out.name ??= '未命名模型'
  return out
}

function summarizeAnimations(doc: any): { name: string; length: number; loop: string }[] {
  return (doc.animations ?? []).map((a: any) => ({
    name: String(a?.name ?? ''),
    length: Number(a?.length ?? 1),
    loop: String(a?.loop ?? 'loop'),
  }))
}

export class CanvasService implements CanvasPort {
  /** canvasId → 文档（null 表示磁盘上确实没有，避免反复读盘） */
  private docs = new Map<string, any>()
  /** canvasId → 编译后的 bbmodel（画布渲染用） */
  private models = new Map<string, any>()
  /** sessionId → 活跃画布 canvasId 解析缓存（切换活跃画布时同步更新） */
  private bound = new Map<string, string>()
  private subs = new Set<(change: CanvasChange) => void>()

  constructor(private store: SessionStore) {}

  /**
   * 会话的活跃画布：meta.canvasId 是 durable 事实；历史数据没有这个字段时沿 parentId 回溯，
   * 结果会缓存并在下次写 meta 时补上（与 dsh 从 header.cwd 读、缺失回落默认目录同构）。
   */
  idOf(sessionId: string): string {
    const cached = this.bound.get(sessionId)
    if (cached) return cached
    let canvasId = sessionId
    const seen = new Set<string>()
    let cursor: string | undefined = sessionId
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const meta = this.store.readMeta(cursor)
      if (meta.canvasId) { canvasId = meta.canvasId; break }
      if (meta.parentId) { cursor = meta.parentId; continue }
      canvasId = cursor
      break
    }
    this.bound.set(sessionId, canvasId)
    return canvasId
  }

  /** 把会话的活跃画布钉到指定画布并落盘（创建会话时调用） */
  adopt(sessionId: string, canvasId: string): void {
    this.bound.set(sessionId, canvasId)
    if (this.store.readMeta(sessionId).canvasId !== canvasId) {
      try { this.store.writeMeta(sessionId, { canvasId }) } catch { /* 落盘失败不阻塞会话 */ }
    }
  }

  /**
   * 会话拥有的画布集合：meta.canvasIds 优先；老会话没有该字段时按活跃画布补齐，
   * **不回填写盘**（旧数据保持不动）。活跃画布永远在第一项。
   */
  listOf(sessionId: string): string[] {
    const active = this.idOf(sessionId)
    const meta = this.store.readMeta(sessionId)
    const owned = Array.isArray(meta.canvasIds) ? meta.canvasIds.map(String) : []
    const out: string[] = [active]
    for (const id of owned) if (id && !out.includes(id)) out.push(id)
    return out
  }

  /**
   * 新建一块空白画布并登记到该会话（唯一允许主动写 meta.canvasIds 的时机）。
   * activate !== false 时顺带把活跃画布指过去。
   */
  createCanvas(sessionId: string, opts: { name?: string; activate?: boolean } = {}): string {
    let canvasId = ''
    do { canvasId = `c-${randomUUID().slice(0, 8)}` } while (this.store.exists(canvasId) || this.docs.has(canvasId))
    const fresh = normalize(createDoc(opts.name?.trim() || '未命名模型'))
    this.docs.set(canvasId, fresh)
    this.models.set(canvasId, compile(fresh))
    try { this.store.writeDoc(canvasId, fresh) } catch (e: any) {
      console.warn(`[canvas] 新画布落盘失败 ${canvasId}:`, e?.message ?? e)
    }
    const ids = this.listOf(sessionId)
    if (!ids.includes(canvasId)) ids.push(canvasId)
    const patch: SessionMeta = { canvasIds: ids }
    if (opts.activate !== false) patch.canvasId = canvasId
    this.store.writeMeta(sessionId, patch)
    if (patch.canvasId) this.bound.set(sessionId, patch.canvasId)
    return canvasId
  }

  /** 切换活跃画布：只能切到该会话拥有的画布 */
  activateCanvas(sessionId: string, canvasId: string): void {
    if (!this.listOf(sessionId).includes(canvasId)) {
      throw new Error(`画布不属于该会话：${canvasId}`)
    }
    if (this.idOf(sessionId) === canvasId) return
    this.store.writeMeta(sessionId, { canvasId })
    this.bound.set(sessionId, canvasId)
  }

  read(sessionId: string): any {
    return this.load(this.idOf(sessionId))
  }

  /** 按 canvasId 直接读文档（跨会话迁移工具用） */
  readCanvas(canvasId: string): any {
    return this.load(canvasId)
  }

  /** 按 canvasId 直接提交（跨会话迁移工具写目标画布用） */
  commitCanvas(canvasId: string, doc: any, originSessionId: string): void {
    this.write(canvasId, doc, 'model', originSessionId)
  }

  ensure(sessionId: string): any {
    const canvasId = this.idOf(sessionId)
    const doc = this.load(canvasId)
    if (doc) return doc
    const fresh = normalize(createDoc('未命名模型'))
    this.docs.set(canvasId, fresh)
    return fresh
  }

  /** 画布编译结果（只读画布 iframe 用）；没有文档时返回 undefined */
  model(sessionId: string): any {
    return this.modelOf(this.idOf(sessionId))
  }

  /** 按 canvasId 取编译结果（多画布快照推送用，不能走 idOf——它解析的是会话的活跃画布） */
  modelOf(canvasId: string): any {
    if (this.models.has(canvasId)) return this.models.get(canvasId)
    const doc = this.load(canvasId)
    if (!doc) return undefined
    const model = compile(doc)
    this.models.set(canvasId, model)
    return model
  }

  has(sessionId: string): boolean {
    return !!this.load(this.idOf(sessionId))
  }

  commit(sessionId: string, doc: any): void {
    this.write(this.idOf(sessionId), doc, 'model', sessionId)
  }

  setView(sessionId: string, view: string): void {
    const doc = this.read(sessionId)
    if (!doc) return
    doc.view = view
    this.write(this.idOf(sessionId), doc, 'view', sessionId)
  }

  /** 唯一写入路径：显式 canvasId + 触发变更的会话（迁移工具可跨会话写） */
  private write(canvasId: string, doc: any, kind: CanvasChange['kind'], originSessionId: string): void {
    const normalized = normalize(doc)
    this.docs.set(canvasId, normalized)
    const model = compile(normalized)
    this.models.set(canvasId, model)
    try {
      this.store.writeDoc(canvasId, normalized)
    } catch (e: any) {
      console.warn(`[canvas] 快照落盘失败 ${canvasId}:`, e?.message ?? e)
    }
    const agentName = this.store.readMeta(originSessionId).agentName
    // 视角变更只需推 view：画布渲染不重新加载模型，避免相机被重置
    this.publish(kind === 'view'
      ? { canvasId, originId: originSessionId, agentName, kind, view: normalized.view }
      : {
        canvasId,
        originId: originSessionId,
        agentName,
        kind,
        bbmodel: model,
        elements: normalized.elements.length,
        textures: normalized.textures.length,
        animations: summarizeAnimations(normalized),
        view: normalized.view,
      })
  }

  /**
   * 会话树的画布列表：根会话 + 直属子代理各自拥有的画布并集，按 canvasId 去重（根优先）。
   * 旧共享画布（父子 meta.canvasId 相同）只出现一次并归属根会话。
   */
  listTree(rootSessionId: string): CanvasRef[] {
    const rootMeta = this.store.readMeta(rootSessionId)
    const owners: { id: string; agentName?: string; root: boolean }[] = [
      { id: rootSessionId, agentName: rootMeta.agentName, root: true },
      ...this.store.list()
        .filter(row => row.id !== rootSessionId && row.parentId === rootSessionId)
        .map(row => ({ id: row.id, agentName: row.agentName, root: false })),
    ]
    const refs: CanvasRef[] = []
    const seen = new Set<string>()
    for (const owner of owners) {
      const activeCanvasId = this.idOf(owner.id)
      for (const canvasId of this.listOf(owner.id)) {
        if (seen.has(canvasId)) continue
        seen.add(canvasId)
        const doc = this.load(canvasId)
        const elements = doc?.elements?.length ?? 0
        refs.push({
          canvasId,
          name: String(doc?.name ?? ''),
          ownerSessionId: owner.id,
          ownerName: owner.root ? '主会话' : (owner.agentName ?? owner.id),
          elements,
          textures: doc?.textures?.length ?? 0,
          hasModel: elements > 0,
          active: canvasId === activeCanvasId,
        })
      }
    }
    // 根的活跃画布排第一；其余活跃画布先于非活跃（sort 稳定，其余保持原有顺序）
    const rootActive = this.idOf(rootSessionId)
    return refs.sort((a, b) => {
      if (a.canvasId === rootActive) return -1
      if (b.canvasId === rootActive) return 1
      if (a.active !== b.active) return a.active ? -1 : 1
      return 0
    })
  }

  onChange(fn: (change: CanvasChange) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  /**
   * 每轮注入给模型的现场描述（dsh workingDirectory 的 contextText 同款）：
   * 说明本会话的独立活跃画布与已有分组，模型不会以为画布是别的会话的。
   */
  contextText(sessionId: string): string {
    const doc = this.read(sessionId)
    const elements = doc?.elements ?? []
    const name = String(doc?.name ?? '未命名模型')
    if (!elements.length) {
      return `当前活跃画布（本会话独立）「${name}」是空的，可以直接 create_model 建工程，再用 place_cubes 搭几何体。`
    }
    const names: string[] = []
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        if (!n || typeof n === 'string') continue
        if (names.length < 24) names.push(String(n.name ?? ''))
        walk(n.children ?? [])
      }
    }
    walk(doc?.outliner ?? [])
    const groupText = names.length
      ? `分组：${names.join('、')}${names.length >= 24 ? '…' : ''}`
      : '还没有分组'
    return `当前活跃画布（本会话独立）「${name}」已有 ${elements.length} 个部件，${groupText}。这是本会话的独立画布；新建独立模型前先确认是否要新建画布或 create_model（会清空当前活跃画布）。`
  }

  private load(canvasId: string): any {
    if (this.docs.has(canvasId)) return this.docs.get(canvasId)
    let doc: any = null
    try {
      const raw = this.store.readDoc(canvasId)
      if (raw) doc = normalize(raw)
    } catch { /* 快照损坏按没有处理 */ }
    this.docs.set(canvasId, doc)
    return doc
  }

  private publish(change: CanvasChange): void {
    for (const fn of this.subs) {
      try { fn(change) } catch (e: any) {
        console.warn('[canvas] 订阅者异常:', e?.message ?? e)
      }
    }
  }
}
