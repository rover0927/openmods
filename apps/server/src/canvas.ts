// 画布服务：openmods 版的「工作区」。
//
// dsh 的对应物是 `dsh-working-directory`：每个会话记录一个 durable 的 cwd，
// 子代理由 `childSessionMeta()` 继承父会话的 cwd，于是同一棵会话树读写同一个目录，
// 而 `ctx.fs` / `ctx.workingDirectory` 是唯一权威——没有"把 state 传给孩子"这种事。
//
// openmods 没有文件系统，画布就是那块 workspace：
// - `canvasId` 是会话的 durable 字段（写进 <id>.meta.json），子代理创建时继承父会话的值；
// - 本服务按 sessionId 解析画布，负责载入/规整/编译/原子落盘/变更广播；
// - 运行时与插件只拿 `CanvasPort`（idOf/read/ensure/commit/setView/contextText），
//   不接触存储、不自己 fan-out，因此"子代理画布丢失"这类问题在结构上不会出现。
import type { CanvasPort } from '@openmods/plugin-kit'
import { compile, createDoc } from '../../../plugins/bb-tools/bbmodel.js'
import type { SessionStore } from './session-store.js'

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
  /** sessionId → canvasId 解析缓存（画布归属在会话生命周期内不变） */
  private bound = new Map<string, string>()
  private subs = new Set<(change: CanvasChange) => void>()

  constructor(private store: SessionStore) {}

  /**
   * 会话所属画布：meta.canvasId 是 durable 事实；历史数据没有这个字段时沿 parentId 回溯，
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

  /** 把会话绑定到画布并落盘（创建会话时调用：子代理在这里继承父画布） */
  adopt(sessionId: string, canvasId: string): void {
    this.bound.set(sessionId, canvasId)
    if (this.store.readMeta(sessionId).canvasId !== canvasId) {
      try { this.store.writeMeta(sessionId, { canvasId }) } catch { /* 落盘失败不阻塞会话 */ }
    }
  }

  read(sessionId: string): any {
    return this.load(this.idOf(sessionId))
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
    const canvasId = this.idOf(sessionId)
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
    this.write(sessionId, doc, 'model')
  }

  setView(sessionId: string, view: string): void {
    const doc = this.read(sessionId)
    if (!doc) return
    doc.view = view
    this.write(sessionId, doc, 'view')
  }

  private write(sessionId: string, doc: any, kind: CanvasChange['kind']): void {
    const canvasId = this.idOf(sessionId)
    const normalized = normalize(doc)
    this.docs.set(canvasId, normalized)
    const model = compile(normalized)
    this.models.set(canvasId, model)
    try {
      this.store.writeDoc(canvasId, normalized)
    } catch (e: any) {
      console.warn(`[canvas] 快照落盘失败 ${canvasId}:`, e?.message ?? e)
    }
    // 视角变更只需推 view：画布渲染不重新加载模型，避免相机被重置
    this.publish(kind === 'view'
      ? { canvasId, originId: sessionId, agentName: this.store.readMeta(sessionId).agentName, kind, view: normalized.view }
      : {
        canvasId,
        originId: sessionId,
        agentName: this.store.readMeta(sessionId).agentName,
        kind,
        bbmodel: model,
        elements: normalized.elements.length,
        textures: normalized.textures.length,
        animations: summarizeAnimations(normalized),
        view: normalized.view,
      })
  }

  onChange(fn: (change: CanvasChange) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  /**
   * 每轮注入给模型的现场描述（dsh workingDirectory 的 contextText 同款）：
   * 子代理因此知道"这是同一份共享工程、已经有哪些分组"，不会以为画布是空的。
   */
  contextText(sessionId: string): string {
    const doc = this.read(sessionId)
    const elements = doc?.elements ?? []
    if (!elements.length) {
      return '画布目前是空的（与主代理是同一份工程）。可以直接 create_model 建工程，再用 place_cubes 搭几何体。'
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
    return `画布已有 ${elements.length} 个部件，${groupText}。这是与主代理/其它子代理共享的同一份工程：先 list_outline 核对结构，把新部件用 place_cubes 的 group 参数挂到已有骨骼上，不要调用 create_model（会清空共享画布）。`
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
