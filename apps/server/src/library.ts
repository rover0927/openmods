// 文档素材库：把建模画布的快照（几何 + 贴图 + 分组 + 动画）归档下来，供以后复用。
//
// 存法（data/library/）：
//   <id>.meta.json  列表用的元信息（小，列表只读它）
//   <id>.doc.json   完整快照 { name, resolution, elements, outliner, textures, animations, view }
//   <id>.png        缩略图（第一张 PNG 贴图；没有贴图时不产生）
//
// 素材有两种"改"法：
//   - 引用到新会话：读快照种到新会话的画布，素材本身不动（副本迭代）；
//   - 就地改：素材绑定一个「编辑会话」（meta.editingSessionId），该会话的画布改动
//     由服务端防抖回写到这里（updateDoc），版本号递增，始终只有一份素材。
//
// 素材只做"归档/取回"，不参与画布同步：截取时从 canvas.read 拷一份，
// 送进画布时走 canvas.commit（服务仍是唯一写入口）。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface LibraryAsset {
  id: string
  name: string
  createdAt: number
  /** 最后一次内容更新（就地编辑回写 / 覆盖）；排序与缩略图缓存都以它为准 */
  updatedAt: number
  /** 内容版本：截取=1，每次就地回写 +1（卡片上显示 v3） */
  version: number
  /** 来源会话与画布（可追溯"这是哪个会话做出来的"） */
  sessionId?: string
  canvasId?: string
  /** 绑定的「编辑会话」：该会话画布改动自动回写本素材（就地迭代，不产生副本） */
  editingSessionId?: string
  elementCount: number
  textureCount: number
  resolution: { width: number; height: number }
  /** 主贴图的 dataURL 前 64 字符做指纹，前端不需要 */
  hasThumb: boolean
  /**
   * 调色板（最多 8 个 #RRGGBB，不带 #）。
   * bb-tools 的贴图是「一个材质一张纯色图」（名字就是 mat_<hex>），首张贴图往往只是底色，
   * 拿它当缩略图会是一块空白 —— 卡片改用调色板方块拼图，至少能区分不同模型。
   */
  palette?: string[]
}

/** 快照文档：比 BbDoc 多一个 resolution（mc 贴图分辨率，卡片展示用） */
export interface LibraryDoc {
  name?: string
  resolution: { width: number; height: number }
  elements: any[]
  outliner?: (string | any)[]
  textures: any[]
  animations?: any[]
  view?: string
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function resOf(doc: any): { width: number; height: number } {
  const res = doc?.resolution ?? {}
  return { width: Number(res.width ?? 16) || 16, height: Number(res.height ?? 16) || 16 }
}

/** 画布文档 → 素材快照（分组/动画/视角一起存，取回时才不会把结构拍平） */
export function snapshotOf(doc: any): LibraryDoc {
  const elements = Array.isArray(doc?.elements) ? doc.elements : []
  const textures = Array.isArray(doc?.textures) ? doc.textures : []
  const outliner = Array.isArray(doc?.outliner) && doc.outliner.length
    ? doc.outliner
    : elements.map((e: any) => e?.uuid).filter(Boolean)
  return {
    name: String(doc?.name ?? '未命名模型'),
    resolution: resOf(doc),
    elements,
    outliner,
    textures,
    animations: Array.isArray(doc?.animations) ? doc.animations : [],
    view: typeof doc?.view === 'string' ? doc.view : '3d',
  }
}

/** 调色板：bb-tools 的纯色贴图名字就是 mat_<hex>，从中提取最多 8 个不重复颜色 */
function paletteOf(textures: any[]): string[] {
  const out: string[] = []
  for (const t of textures) {
    const m = /^mat_([0-9a-f]{6})$/i.exec(String(t?.name ?? ''))
    if (!m) continue
    const hex = m[1].toUpperCase()
    if (!out.includes(hex)) out.push(hex)
    if (out.length >= 8) break
  }
  return out
}

export function createLibraryStore(root: string) {
  const dir = join(root, 'data', 'library')
  mkdirSync(dir, { recursive: true })
  const metaPath = (id: string) => join(dir, `${id}.meta.json`)
  const docPath = (id: string) => join(dir, `${id}.doc.json`)
  const thumbPath = (id: string) => join(dir, `${id}.png`)

  function readMeta(id: string): LibraryAsset | undefined {
    if (!ID_RE.test(id)) return undefined
    try {
      return JSON.parse(readFileSync(metaPath(id), 'utf8')) as LibraryAsset
    } catch {
      return undefined
    }
  }

  function writeMeta(meta: LibraryAsset) {
    writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2))
  }

  /** 落盘快照 + 缩略图，返回要合并进 meta 的计数字段 */
  function writeSnapshot(id: string, snap: LibraryDoc): Pick<LibraryAsset, 'elementCount' | 'textureCount' | 'resolution' | 'hasThumb' | 'palette'> {
    writeFileSync(docPath(id), JSON.stringify(snap))
    // 缩略图：取第一张 PNG 贴图原样落盘（mc 端导出时同款来源）
    const first = snap.textures.find(t => typeof t?.source === 'string' && t.source.startsWith('data:image/png;base64,'))
    let hasThumb = false
    if (first) {
      try {
        writeFileSync(thumbPath(id), Buffer.from(first.source.split(',')[1], 'base64'))
        hasThumb = true
      } catch { /* 贴图坏了不影响归档 */ }
    } else {
      // 换成没有位图贴图的快照：旧缩略图必须删掉，否则卡片显示的是上一版
      try { if (existsSync(thumbPath(id))) unlinkSync(thumbPath(id)) } catch { /* 忽略 */ }
    }
    return {
      elementCount: snap.elements.length,
      textureCount: snap.textures.length,
      resolution: snap.resolution,
      hasThumb,
      palette: paletteOf(snap.textures),
    }
  }

  return {
    dir,

    list(): LibraryAsset[] {
      let names: string[]
      try { names = readdirSync(dir) } catch { return [] }
      const out: LibraryAsset[] = []
      for (const name of names) {
        if (!name.endsWith('.meta.json')) continue
        const id = name.slice(0, -'.meta.json'.length)
        const meta = readMeta(id)
        if (!meta) continue
        // 老文件没有 updatedAt/version：补齐后内存里排序，不为了排序去写盘
        if (typeof meta.updatedAt !== 'number') meta.updatedAt = meta.createdAt
        if (typeof meta.version !== 'number') meta.version = 1
        out.push(meta)
      }
      return out.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    },

    get(id: string): LibraryAsset | undefined {
      const meta = readMeta(id)
      if (!meta) return undefined
      if (typeof meta.updatedAt !== 'number') meta.updatedAt = meta.createdAt
      if (typeof meta.version !== 'number') meta.version = 1
      return meta
    },

    /** 从画布文档截取一份快照；doc.elements 为空时报错（没有可归档的东西） */
    capture(opts: {
      sessionId: string
      canvasId?: string
      name: string
      doc: any
    }): LibraryAsset {
      const snap = snapshotOf(opts.doc ?? {})
      if (snap.elements.length === 0) throw new Error('当前画布没有模型元素，先让建模子代理建好再截取')

      const id = randomUUID().slice(0, 10)
      const now = Date.now()
      const meta: LibraryAsset = {
        id,
        name: String(opts.name || '').trim().slice(0, 60) || `素材 ${new Date().toLocaleString('zh-CN')}`,
        createdAt: now,
        updatedAt: now,
        version: 1,
        sessionId: opts.sessionId,
        canvasId: opts.canvasId,
        elementCount: snap.elements.length,
        textureCount: snap.textures.length,
        resolution: snap.resolution,
        hasThumb: false,
      }
      Object.assign(meta, writeSnapshot(id, snap))
      writeMeta(meta)
      return meta
    },

    /**
     * 就地更新：编辑会话的画布改动写回素材（版本 +1）。
     * 素材已被删除时返回 undefined —— 调用方不需要先查存在性。
     */
    updateDoc(id: string, doc: any): LibraryAsset | undefined {
      const meta = readMeta(id)
      if (!meta) return undefined
      const snap = snapshotOf(doc ?? {})
      if (snap.elements.length === 0) return meta
      const counts = writeSnapshot(id, snap)
      const next: LibraryAsset = {
        ...meta,
        ...counts,
        version: (typeof meta.version === 'number' ? meta.version : 1) + 1,
        updatedAt: Date.now(),
      }
      writeMeta(next)
      return next
    },

    /** 绑定编辑会话（就地改） */
    bind(id: string, editingSessionId: string): LibraryAsset | undefined {
      const meta = readMeta(id)
      if (!meta) return undefined
      const next = { ...meta, editingSessionId }
      writeMeta(next)
      return next
    },

    rename(id: string, name: string): LibraryAsset | undefined {
      const meta = readMeta(id)
      if (!meta) return undefined
      const clean = String(name || '').trim().slice(0, 60)
      if (!clean) return meta
      const next = { ...meta, name: clean }
      writeMeta(next)
      return next
    },

    /** 读完整快照（送进画布 / 种到新会话用） */
    readDoc(id: string): LibraryDoc | undefined {
      if (!ID_RE.test(id)) return undefined
      try {
        return JSON.parse(readFileSync(docPath(id), 'utf8')) as LibraryDoc
      } catch {
        return undefined
      }
    },

    readThumb(id: string): Buffer | undefined {
      if (!ID_RE.test(id)) return undefined
      try {
        if (!existsSync(thumbPath(id))) return undefined
        return readFileSync(thumbPath(id))
      } catch {
        return undefined
      }
    },

    remove(id: string): boolean {
      if (!ID_RE.test(id)) return false
      let ok = false
      for (const p of [metaPath(id), docPath(id), thumbPath(id)]) {
        try {
          if (statSync(p).isFile()) { unlinkSync(p); ok = true }
        } catch { /* 文件不存在就跳过 */ }
      }
      return ok
    },
  }
}

export type LibraryStore = ReturnType<typeof createLibraryStore>
