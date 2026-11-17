// 素材库 v2：统一「多文件资产」。
//
// 一个素材 = 若干文件（模型快照 / 缩略图 / jar 构建产物 / 贴图 / bbmodel / 其它）
// + 派生出来的模型统计与构建产物索引。旧的「一个素材只能是一份画布快照 + 一个 jar」
// 结构在首次访问时懒迁移到新目录布局，旧文件保留回退读取。
//
// 存法（data/library/）：
//   <id>/meta.json          列表只读它（含 files 索引与派生字段）
//   <id>/files/f_xxx_原名    真实文件（rel 相对素材目录，路径一律由 meta 反查）
//   <id>/thumbs/t_xxx.png   模型缩略图（等距 3D 预览；渲染不出时回退第一张 PNG 贴图）
//
// 素材有两种"改"法：
//   - 引用到新会话：读快照种到新会话的画布，素材本身不动（副本迭代）；
//   - 就地改：素材绑定一个「编辑会话」，该会话的画布改动由服务端防抖回写（updateDoc）。
//
// 素材只做"归档/取回"，不参与画布同步：截取时从 canvas.read 拷一份，
// 送进画布时走 canvas.commit（服务仍是唯一写入口）。

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { renderModelPreview } from './model-preview.js'

export type AssetFileKind = 'model' | 'image' | 'jar' | 'archive' | 'text' | 'other'

/** 素材库顶层分类：一个资产只属于一类（schema 3 起） */
export type AssetKind = 'model' | 'jar' | 'image' | 'file'

/** 资产里的一个真实文件（rel 相对素材目录，绝不使用客户端传进来的路径拼接） */
export interface AssetFile {
  id: string
  name: string
  rel: string
  size: number
  mime: string
  kind: AssetFileKind
  sha256: string
  createdAt: number
}

export interface LibraryAsset {
  /** 3 = 模型 / Jar / 图片 / 文件分类拆分；旧数据按 legacy 读取并懒迁移 */
  schema?: number
  /** 顶层分类；derive() 会给旧数据补上 */
  kind?: AssetKind
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
  /** 自动入库的素材：会话画布模型由服务端自动 upsert（保证用户做的模型永不丢） */
  auto?: boolean
  /** 资产来源 */
  source: {
    provider: 'canvas' | 'auto' | 'upload' | 'cwd' | 'legacy' | 'legacy-split' | 'build'
    sessionId?: string
    path?: string
  }
  /** 从旧组合资产拆出来时记录原资产 id（幂等去重用） */
  splitFrom?: string
  /** 资产里的全部文件 */
  files: AssetFile[]
  /** 模型类资产（画布快照，或上传的 bbmodel/文档） */
  model?: {
    docFileId: string
    elementCount: number
    textureCount: number
    resolution: { width: number; height: number }
    palette?: string[]
    /** thumbs/ 下的文件名 */
    thumbFileId?: string
    /** 缩略图版本：2 = 等距 3D 预览（朝上）；旧素材没有或 <2 时首次展示懒升级 */
    previewVersion?: number
  }
  /** 构建产物（jar / zip 归档） */
  jar?: { fileId?: string; name: string; size: number }
  // —— 以下为兼容旧前端的派生字段（由 model 计算，不单独维护） ——
  elementCount: number
  textureCount: number
  resolution: { width: number; height: number }
  hasThumb: boolean
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

const MAX_FILES_PER_ASSET = 40
const MAX_IMPORT_FILES = 20
const MAX_TEXT_INLINE = 512 * 1024

/** 允许入库的扩展名（上传/从工作目录导入都走这里） */
const ALLOWED_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'jar', 'zip',
  'json', 'bbmodel',
  'md', 'txt', 'java', 'kt', 'gradle', 'properties', 'yml', 'yaml', 'toml',
  'ts', 'tsx', 'js', 'jsx', 'css', 'html',
])

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  jar: 'application/java-archive', zip: 'application/zip',
  json: 'application/json', bbmodel: 'application/json',
  md: 'text/markdown', txt: 'text/plain', html: 'text/html', css: 'text/css',
  java: 'text/plain', kt: 'text/plain', gradle: 'text/plain', properties: 'text/plain',
  yml: 'text/plain', yaml: 'text/plain', toml: 'text/plain',
  ts: 'text/plain', tsx: 'text/plain', js: 'text/plain', jsx: 'text/plain',
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const TEXT_EXT = new Set(['json', 'bbmodel', 'md', 'txt', 'java', 'kt', 'gradle', 'properties', 'yml', 'yaml', 'toml', 'ts', 'tsx', 'js', 'jsx', 'css', 'html'])

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function extOf(name: string): string {
  return extname(String(name ?? '')).toLowerCase().replace(/^\./, '')
}

function mimeOf(name: string): string {
  return EXT_MIME[extOf(name)] ?? 'application/octet-stream'
}

/** 文件名净化：去目录、去危险字符、Windows 保留名、限制长度（扩展名保留） */
export function sanitizeFileName(input: string): string {
  // 统一分隔符后只取最后一段，避免 `..\..\x` 这类客户端路径
  let name = basename(String(input ?? '').replace(/\\/g, '/'))
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim()
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!name) name = 'file'
  const ext = extname(name)
  let stem = ext ? name.slice(0, -ext.length) : name
  if (WIN_RESERVED.test(stem)) stem = `_${stem}`
  if (stem.length > 100) stem = stem.slice(0, 100)
  const safe = `${stem}${ext.slice(0, 20)}`
  return safe || 'file'
}

/** 上传/导入前的类型与大小校验（抛出的 message 直接给前端/模型看） */
export function assertAssetFile(name: string, size: number) {
  const ext = extOf(name)
  if (!ALLOWED_EXT.has(ext)) throw new Error(`不支持的文件类型：.${ext || '(无扩展名)'}`)
  const limit = ext === 'jar' || ext === 'zip'
    ? 64 * 1024 * 1024
    : IMAGE_EXT.has(ext) ? 10 * 1024 * 1024 : 5 * 1024 * 1024
  if (size > limit) throw new Error(`文件过大（${Math.round(size / 1024 / 1024)}MB，上限 ${Math.round(limit / 1024 / 1024)}MB）`)
}

/** 按扩展名 + magic 判定文件种类（只信扩展名不够） */
function detectKind(name: string, data?: Buffer): AssetFileKind {
  const ext = extOf(name)
  if (ext === 'jar') return 'jar'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'zip') return 'archive'
  if (data && data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) return 'archive'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'other'
}

/** JSON 是否是画布模型文档（上传的 bbmodel / 文档快照） */
function looksLikeModelDoc(data: Buffer): any | undefined {
  if (data.length === 0 || data.length > 32 * 1024 * 1024) return undefined
  try {
    const parsed = JSON.parse(data.toString('utf8'))
    return Array.isArray(parsed?.elements) ? parsed : undefined
  } catch {
    return undefined
  }
}

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

function firstPng(textures: any[]): Buffer | undefined {
  const t = textures.find(x => typeof x?.source === 'string' && x.source.startsWith('data:image/png;base64,'))
  if (!t) return undefined
  try { return Buffer.from(t.source.split(',')[1], 'base64') } catch { return undefined }
}

/** 扫描太大目录没意义：工程根、build 产物以外的源码/依赖目录不进去 */
const JAR_SCAN_SKIP = new Set(['node_modules', '.git', '.gradle', 'build', 'out', 'run', 'bin', 'obj', 'src', 'logs'])

/**
 * 在会话工作区里找最新的构建产物：`<dir>/build/libs/*.jar`。
 * 工作区布局通常是 <workspace>/<工程名>/build/libs，所以向下最多 3 层。
 */
function findLatestJar(root: string): { path: string; name: string; size: number } | undefined {
  let best: { path: string; name: string; size: number; mtime: number } | undefined
  const visit = (dir: string, depth: number) => {
    const libs = join(dir, 'build', 'libs')
    try {
      for (const file of readdirSync(libs)) {
        if (!file.endsWith('.jar')) continue
        const p = join(libs, file)
        const st = statSync(p)
        if (!st.isFile()) continue
        if (!best || st.mtimeMs > best.mtime) best = { path: p, name: file, size: st.size, mtime: st.mtimeMs }
      }
    } catch { /* 这个目录没有构建产物 */ }
    if (depth >= 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || JAR_SCAN_SKIP.has(e.name)) continue
      visit(join(dir, e.name), depth + 1)
    }
  }
  visit(root, 0)
  return best ? { path: best.path, name: best.name, size: best.size } : undefined
}

/** 找工程里的全部构建 jar（用于统一测试启动器的「工程构建」列表） */
export function findAllJars(root: string, max = 50): {
  path: string
  name: string
  size: number
  mtime: number
  project: string
}[] {
  const out: { path: string; name: string; size: number; mtime: number; project: string }[] = []
  const visit = (dir: string, depth: number) => {
    const libs = join(dir, 'build', 'libs')
    try {
      for (const file of readdirSync(libs)) {
        if (!file.endsWith('.jar')) continue
        if (/-sources\.jar$|-javadoc\.jar$/i.test(file)) continue
        const p = join(libs, file)
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          out.push({ path: p, name: file, size: st.size, mtime: st.mtimeMs, project: basename(dir) })
        } catch { /* 文件刚被删 */ }
      }
    } catch { /* 这个目录没有构建产物 */ }
    if (depth >= 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || JAR_SCAN_SKIP.has(e.name)) continue
      visit(join(dir, e.name), depth + 1)
    }
  }
  try { visit(resolve(root), 0) } catch { /* 根目录不存在 */ }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, max)
}

/** 把文件移进素材目录，跨盘/占用时退化成复制 + 删除 */
function moveFile(from: string, to: string) {
  try { renameSync(from, to); return } catch { /* 跨盘或占用 */ }
  copyFileSync(from, to)
  unlinkSync(from)
}

export function createLibraryStore(root: string) {
  const dir = join(root, 'data', 'library')
  mkdirSync(dir, { recursive: true })

  const assetDir = (id: string) => join(dir, id)
  const metaPath = (id: string) => join(assetDir(id), 'meta.json')
  const filesDir = (id: string) => join(assetDir(id), 'files')
  const thumbsDir = (id: string) => join(assetDir(id), 'thumbs')

  // 旧扁平布局
  const legacyMetaPath = (id: string) => join(dir, `${id}.meta.json`)
  const legacyDocPath = (id: string) => join(dir, `${id}.doc.json`)
  const legacyThumbPath = (id: string) => join(dir, `${id}.png`)
  const legacyJarPath = (id: string) => join(dir, `${id}.jar`)

  function safeInside(id: string, rel: string): string | undefined {
    const base = resolve(assetDir(id))
    const full = resolve(base, rel)
    return full === base || full.startsWith(base + sep) ? full : undefined
  }

  function writeMeta(meta: LibraryAsset) {
    mkdirSync(assetDir(meta.id), { recursive: true })
    const tmp = `${metaPath(meta.id)}.tmp`
    writeFileSync(tmp, JSON.stringify(meta, null, 2))
    try { renameSync(tmp, metaPath(meta.id)) } catch {
      writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2))
      try { unlinkSync(tmp) } catch { /* 忽略 */ }
    }
  }

  /** 把派生字段从 model 重新算一遍（旧前端只认这些顶层字段） */
  function derive(meta: LibraryAsset): LibraryAsset {
    meta.schema = 3
    meta.files = Array.isArray(meta.files) ? meta.files : []
    meta.source = meta.source ?? { provider: 'legacy' }
    // 一个资产只属于一类：模型 > jar > 图片 > 文件
    if (meta.model) meta.kind = 'model'
    else if (meta.jar || meta.files.some(f => f.kind === 'jar')) meta.kind = 'jar'
    else if (meta.files.some(f => f.kind === 'image')) meta.kind = 'image'
    else meta.kind = 'file'
    if (!meta.model) {
      meta.elementCount = Number(meta.elementCount ?? 0) || 0
      meta.textureCount = Number(meta.textureCount ?? 0) || 0
      meta.resolution = meta.resolution ?? { width: 16, height: 16 }
      meta.hasThumb = !!meta.hasThumb
      return meta
    }
    meta.elementCount = meta.model.elementCount
    meta.textureCount = meta.model.textureCount
    meta.resolution = meta.model.resolution
    meta.palette = meta.model.palette
    meta.hasThumb = !!meta.model.thumbFileId
    return meta
  }

  /** 旧组合资产懒拆分：模型保留原 id，jar 拆成独立 jar 资产（幂等） */
  function splitCombined(id: string, meta: LibraryAsset): LibraryAsset {
    if (!meta.model) return meta
    const jarFiles = meta.files.filter(f => f.kind === 'jar')
    const toDelete: AssetFile[] = []
    for (const f of jarFiles) {
      const newId = `${id}-${f.id}`.slice(0, 64)
      try {
        const p = safeInside(id, f.rel)
        if (!p || !existsSync(p)) continue
        if (!existsSync(metaPath(newId))) {
          const data = readFileSync(p)
          const entry = storeFile(newId, f.name, data, 'jar')
          const jarMeta: LibraryAsset = {
            schema: 3,
            kind: 'jar',
            id: newId,
            name: f.name,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            version: 1,
            sessionId: meta.sessionId,
            source: { provider: 'legacy-split', sessionId: meta.sessionId },
            splitFrom: id,
            files: [entry],
            jar: { fileId: entry.id, name: f.name, size: f.size },
            elementCount: 0,
            textureCount: 0,
            resolution: { width: 16, height: 16 },
            hasThumb: false,
          }
          writeMeta(jarMeta)
        }
        toDelete.push(f)
      } catch { /* 单个 jar 失败不影响模型 */ }
    }
    // 没有文件条目的旧 jar 字段：直接清掉（模型优先）
    meta.jar = undefined
    meta.files = meta.files.filter(f => f.kind !== 'jar')
    meta.kind = 'model'
    meta.schema = 3
    try {
      writeMeta(meta)
      // 只有模型 meta 写成功后才删旧文件，避免写失败时模型引用丢失
      for (const f of toDelete) deleteFileEntry(id, f)
    } catch { /* 下次读取再试 */ }
    return meta
  }

  function maybeSplit(id: string, meta: LibraryAsset): LibraryAsset {
    if (!meta.model) return meta
    if (!meta.jar && !meta.files.some(f => f.kind === 'jar')) return meta
    try { return splitCombined(id, meta) } catch { return meta }
  }

  function readMeta(id: string): LibraryAsset | undefined {
    if (!ID_RE.test(id)) return undefined
    try {
      const meta = JSON.parse(readFileSync(metaPath(id), 'utf8')) as LibraryAsset
      return maybeSplit(id, derive(meta))
    } catch { /* 新布局不存在，试迁移 */ }
    if (migrateLegacy(id)) {
      try { return derive(JSON.parse(readFileSync(metaPath(id), 'utf8')) as LibraryAsset) } catch { /* 落到回退 */ }
    }
    return legacyMeta(id)
  }

  /** 迁移失败时的只读回退：内存里合成 v2 结构，读写仍指向旧扁平文件 */
  function legacyMeta(id: string): LibraryAsset | undefined {
    if (!ID_RE.test(id)) return undefined
    try {
      const old = JSON.parse(readFileSync(legacyMetaPath(id), 'utf8')) as any
      const meta: LibraryAsset = {
        schema: 2,
        id,
        name: String(old.name ?? id),
        createdAt: Number(old.createdAt ?? Date.now()),
        updatedAt: Number(old.updatedAt ?? old.createdAt ?? Date.now()),
        version: Number(old.version ?? 1),
        sessionId: old.sessionId,
        canvasId: old.canvasId,
        editingSessionId: old.editingSessionId,
        auto: old.auto === true,
        source: { provider: 'legacy' },
        files: [],
        model: {
          docFileId: '',
          elementCount: Number(old.elementCount ?? 0) || 0,
          textureCount: Number(old.textureCount ?? 0) || 0,
          resolution: resOf(old),
          palette: old.palette,
          thumbFileId: '',
        },
        jar: old.jar ? { name: String(old.jar.name ?? `${id}.jar`), size: Number(old.jar.size ?? 0) } : undefined,
        elementCount: Number(old.elementCount ?? 0) || 0,
        textureCount: Number(old.textureCount ?? 0) || 0,
        resolution: resOf(old),
        hasThumb: existsSync(legacyThumbPath(id)),
        palette: old.palette,
      }
      return derive(meta)
    } catch {
      return undefined
    }
  }

  /** 旧扁平布局 → 目录布局；成功返回 true（中途失败下次重试，旧文件最后才删） */
  function migrateLegacy(id: string): boolean {
    if (!ID_RE.test(id) || !existsSync(legacyMetaPath(id))) return false
    try {
      const old = JSON.parse(readFileSync(legacyMetaPath(id), 'utf8')) as any
      const files: AssetFile[] = []
      let model: LibraryAsset['model']
      let jar: LibraryAsset['jar']

      const docFile = legacyDocPath(id)
      if (existsSync(docFile)) {
        const data = readFileSync(docFile)
        const entry = storeFile(id, `${sanitizeFileName(String(old.name ?? id))}.json`, data, 'model')
        files.push(entry)
        const snap = snapshotOf(JSON.parse(data.toString('utf8')))
        model = {
          docFileId: entry.id,
          elementCount: snap.elements.length,
          textureCount: snap.textures.length,
          resolution: snap.resolution,
          palette: paletteOf(snap.textures),
        }
      }

      const thumb = legacyThumbPath(id)
      if (model && existsSync(thumb)) {
        model.thumbFileId = writeThumb(id, readFileSync(thumb))
      }

      const jarFile = legacyJarPath(id)
      if (existsSync(jarFile)) {
        const data = readFileSync(jarFile)
        const name = String(old.jar?.name ?? `${id}.jar`)
        const entry = storeFile(id, name, data, 'jar')
        files.push(entry)
        jar = { fileId: entry.id, name, size: data.length }
      }

      const meta: LibraryAsset = {
        schema: 2,
        id,
        name: String(old.name ?? id),
        createdAt: Number(old.createdAt ?? Date.now()),
        updatedAt: Number(old.updatedAt ?? old.createdAt ?? Date.now()),
        version: Number(old.version ?? 1),
        sessionId: old.sessionId,
        canvasId: old.canvasId,
        editingSessionId: old.editingSessionId,
        auto: old.auto === true,
        source: { provider: 'legacy' },
        files,
        model,
        jar,
        elementCount: model?.elementCount ?? 0,
        textureCount: model?.textureCount ?? 0,
        resolution: model?.resolution ?? resOf(old),
        hasThumb: !!model?.thumbFileId,
        palette: model?.palette,
      }
      writeMeta(derive(meta))
      maybeSplit(id, meta)
      for (const p of [legacyMetaPath(id), legacyDocPath(id), legacyThumbPath(id), legacyJarPath(id)]) {
        try { if (existsSync(p)) unlinkSync(p) } catch { /* 忽略 */ }
      }
      return true
    } catch {
      return false
    }
  }

  /** 写一个文件进素材目录（文件名净化后加随机前缀，永不使用客户端路径） */
  function storeFile(id: string, name: string, data: Buffer, kind?: AssetFileKind): AssetFile {
    const d = filesDir(id)
    mkdirSync(d, { recursive: true })
    const fileId = randomUUID().slice(0, 10)
    const safeName = sanitizeFileName(name)
    const diskName = `${fileId}_${safeName}`
    writeFileSync(join(d, diskName), data)
    return {
      id: fileId,
      name: safeName,
      rel: `files/${diskName}`,
      size: data.length,
      mime: mimeOf(safeName),
      kind: kind ?? detectKind(safeName, data),
      sha256: createHash('sha256').update(data).digest('hex'),
      createdAt: Date.now(),
    }
  }

  function deleteFileEntry(id: string, entry?: AssetFile) {
    if (!entry) return
    const p = safeInside(id, entry.rel)
    if (!p) return
    try { if (existsSync(p)) unlinkSync(p) } catch { /* 忽略 */ }
  }

  function clearThumbs(id: string) {
    try {
      for (const f of readdirSync(thumbsDir(id))) {
        try { unlinkSync(join(thumbsDir(id), f)) } catch { /* 忽略 */ }
      }
    } catch { /* 没有缩略图目录 */ }
  }

  function writeThumb(id: string, png: Buffer): string {
    mkdirSync(thumbsDir(id), { recursive: true })
    const name = `t_${randomUUID().slice(0, 8)}.png`
    writeFileSync(join(thumbsDir(id), name), png)
    return name
  }

  /**
   * 写入/替换模型快照：删掉旧文档文件，落新快照 + 缩略图，刷新 model 与派生字段。
   */
  function applySnapshot(id: string, meta: LibraryAsset, snap: LibraryDoc) {
    const prevDoc = meta.files.find(f => f.id === meta.model?.docFileId)
    if (prevDoc) {
      deleteFileEntry(id, prevDoc)
      meta.files = meta.files.filter(f => f.id !== prevDoc.id)
    }
    const docEntry = storeFile(id, `${sanitizeFileName(meta.name)}.json`, Buffer.from(JSON.stringify(snap)), 'model')
    meta.files.push(docEntry)
    clearThumbs(id)
    const thumb = renderModelPreview(snap)
    const legacyThumb = thumb ? undefined : firstPng(snap.textures)
    const png = thumb ?? legacyThumb
    meta.model = {
      docFileId: docEntry.id,
      elementCount: snap.elements.length,
      textureCount: snap.textures.length,
      resolution: snap.resolution,
      palette: paletteOf(snap.textures),
      thumbFileId: png ? writeThumb(id, png) : undefined,
      // 2 = 已是摆正的 3D 预览；0 = 渲染失败，已回退贴图（不再重试）
      previewVersion: thumb ? 2 : 0,
    }
    derive(meta)
  }

  /**
   * 上传/导入的文档也能当模型：原文件保留（素材库是归档，不能因为第一次编辑就删掉用户的源文件），
   * 另外落一份归一化快照作为画布文档。
   */
  function adoptModelFile(id: string, meta: LibraryAsset, doc: any) {
    applySnapshot(id, meta, snapshotOf(doc))
  }

  /** 读快照（素材送进画布 / 渲染缩略图共用）；上传的 bbmodel 在这里归一化 */
  function readDocOf(id: string): LibraryDoc | undefined {
    const meta = readMeta(id)
    if (!meta?.model) {
      // 迁移失败回退：旧扁平布局
      try {
        return JSON.parse(readFileSync(legacyDocPath(id), 'utf8')) as LibraryDoc
      } catch { return undefined }
    }
    if (!meta.model.docFileId) {
      try {
        return snapshotOf(JSON.parse(readFileSync(legacyDocPath(id), 'utf8')))
      } catch { return undefined }
    }
    const found = store.readFile(id, meta.model.docFileId)
    if (!found) return undefined
    try { return snapshotOf(JSON.parse(found.data.toString('utf8'))) } catch { return undefined }
  }

  /** 新建一个独立 jar 资产（一个资产只装一个 jar） */
  function createJarAsset(opts: {
    name: string
    data: Buffer
    sessionId?: string
    sourcePath?: string
    provider?: LibraryAsset['source']['provider']
  }): LibraryAsset {
    assertAssetFile(opts.name, opts.data.length)
    if (extOf(opts.name) !== 'jar') throw new Error('只能归档 .jar')
    const id = randomUUID().slice(0, 10)
    const now = Date.now()
    const meta: LibraryAsset = {
      schema: 3,
      kind: 'jar',
      id,
      name: opts.name,
      createdAt: now,
      updatedAt: now,
      version: 1,
      sessionId: opts.sessionId,
      source: { provider: opts.provider ?? 'upload', sessionId: opts.sessionId, path: opts.sourcePath },
      files: [],
      elementCount: 0,
      textureCount: 0,
      resolution: { width: 16, height: 16 },
      hasThumb: false,
    }
    const entry = storeFile(id, opts.name, opts.data, 'jar')
    meta.files.push(entry)
    meta.jar = { fileId: entry.id, name: entry.name, size: entry.size }
    writeMeta(meta)
    return meta
  }

  const store = {
    dir,

    list(): LibraryAsset[] {
      let names: string[]
      try { names = readdirSync(dir) } catch { return [] }
      const out: LibraryAsset[] = []
      for (const name of names) {
        let id: string | undefined
        let isDir = false
        try { isDir = lstatSync(join(dir, name)).isDirectory() } catch { continue }
        if (isDir) {
          if (!existsSync(join(dir, name, 'meta.json'))) continue
          id = name
        } else if (name.endsWith('.meta.json')) {
          id = name.slice(0, -'.meta.json'.length)
        }
        if (!id) continue
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
      /** 会话工作区：截取时顺带归档最新构建产物（build/libs/*.jar） */
      cwd?: string
    }): { asset: LibraryAsset; jarAsset?: LibraryAsset } {
      const snap = snapshotOf(opts.doc ?? {})
      if (snap.elements.length === 0) throw new Error('当前画布没有模型元素，先让建模子代理建好再截取')

      const id = randomUUID().slice(0, 10)
      const now = Date.now()
      const meta: LibraryAsset = {
        schema: 3,
        kind: 'model',
        id,
        name: String(opts.name || '').trim().slice(0, 60) || `素材 ${new Date().toLocaleString('zh-CN')}`,
        createdAt: now,
        updatedAt: now,
        version: 1,
        sessionId: opts.sessionId,
        canvasId: opts.canvasId,
        source: { provider: 'canvas', sessionId: opts.sessionId },
        files: [],
        elementCount: 0,
        textureCount: 0,
        resolution: snap.resolution,
        hasThumb: false,
      }
      applySnapshot(id, meta, snap)
      writeMeta(meta)
      // 构建产物单独归档为 jar 资产，不再混进模型
      let jarAsset: LibraryAsset | undefined
      if (opts.cwd) {
        const jar = findLatestJar(opts.cwd)
        if (jar) {
          try {
            jarAsset = createJarAsset({
              name: jar.name,
              data: readFileSync(jar.path),
              sessionId: opts.sessionId,
              sourcePath: jar.path,
              provider: 'canvas',
            })
          } catch { /* 复制失败不影响模型归档 */ }
        }
      }
      return { asset: meta, jarAsset }
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
      applySnapshot(id, meta, snap)
      meta.version = (typeof meta.version === 'number' ? meta.version : 1) + 1
      meta.updatedAt = Date.now()
      writeMeta(meta)
      return meta
    },

    /** 绑定编辑会话（就地改） */
    bind(id: string, editingSessionId: string): LibraryAsset | undefined {
      const meta = readMeta(id)
      if (!meta) return undefined
      meta.editingSessionId = editingSessionId
      writeMeta(meta)
      return meta
    },

    rename(id: string, name: string): LibraryAsset | undefined {
      const meta = readMeta(id)
      if (!meta) return undefined
      const clean = String(name || '').trim().slice(0, 60)
      if (!clean) return meta
      meta.name = clean
      writeMeta(meta)
      return meta
    },

    /** 新建资产并放入第一个文件 */
    create(opts: {
      name?: string
      fileName: string
      data: Buffer
      sessionId?: string
      provider?: 'upload' | 'cwd'
      sourcePath?: string
    }): LibraryAsset {
      assertAssetFile(opts.fileName, opts.data.length)
      const ext = extOf(opts.fileName)
      const firstKind = detectKind(opts.fileName, opts.data)
      const isModel = (ext === 'bbmodel' || ext === 'json') && !!looksLikeModelDoc(opts.data)
      const kind: AssetKind = firstKind === 'jar' ? 'jar' : isModel ? 'model' : firstKind === 'image' ? 'image' : 'file'
      const id = randomUUID().slice(0, 10)
      const now = Date.now()
      const baseName = String(opts.name || '').trim().slice(0, 60)
        || sanitizeFileName(opts.fileName).replace(/\.[^.]+$/, '')
        || `素材 ${new Date(now).toLocaleString('zh-CN')}`
      const meta: LibraryAsset = {
        schema: 3,
        kind,
        id,
        name: baseName,
        createdAt: now,
        updatedAt: now,
        version: 1,
        sessionId: opts.sessionId,
        source: { provider: opts.provider ?? 'upload', sessionId: opts.sessionId, path: opts.sourcePath },
        files: [],
        elementCount: 0,
        textureCount: 0,
        resolution: { width: 16, height: 16 },
        hasThumb: false,
      }
      store.addFile(id, { fileName: opts.fileName, data: opts.data, meta })
      writeMeta(meta)
      return meta
    },

    /** 新建独立 jar 资产（归档扫描结果 / 上传 jar 共用） */
    createJar(opts: {
      name: string
      data: Buffer
      sessionId?: string
      sourcePath?: string
      provider?: LibraryAsset['source']['provider']
    }): LibraryAsset {
      return createJarAsset(opts)
    },

    /** 追加文件（也可用于新建后的首个文件） */
    addFile(id: string, opts: { fileName: string; data: Buffer; meta?: LibraryAsset }): LibraryAsset {
      const meta = opts.meta ?? readMeta(id)
      if (!meta) throw new Error('素材不存在')
      assertAssetFile(opts.fileName, opts.data.length)
      if (meta.files.length >= MAX_FILES_PER_ASSET) throw new Error(`单个素材最多 ${MAX_FILES_PER_ASSET} 个文件`)
      const kind = meta.kind ?? derive(meta).kind
      const fileKind = detectKind(opts.fileName, opts.data)
      const ext = extOf(opts.fileName)
      const isModelDoc = (ext === 'bbmodel' || ext === 'json') && !!looksLikeModelDoc(opts.data)
      // 一个资产只属于一类：jar 与模型/文件不混装
      if (fileKind === 'jar') {
        if (kind !== 'jar') throw new Error('jar 请作为独立素材上传')
        if (meta.jar) throw new Error('一个 jar 资产只能包含一个 jar')
      }
      if (kind === 'jar' && fileKind !== 'jar') throw new Error('jar 资产只能包含 jar 文件')
      if (kind === 'model' && isModelDoc && meta.model) throw new Error('模型资产只能包含一个模型文档')
      const entry = storeFile(id, opts.fileName, opts.data, fileKind)
      meta.files.push(entry)
      if (entry.kind === 'jar' && !meta.jar) {
        meta.jar = { fileId: entry.id, name: entry.name, size: entry.size }
      } else if (!meta.model && isModelDoc) {
        adoptModelFile(id, meta, looksLikeModelDoc(opts.data)!)
      }
      meta.updatedAt = Date.now()
      if (!opts.meta) writeMeta(meta)
      return meta
    },

    /** 从工作目录导入：每个文件单独成资产（模型/jar 不再混装） */
    importFiles(opts: { root: string; paths: string[]; name?: string; sessionId?: string }): { asset: LibraryAsset; assets: LibraryAsset[] } {
      const paths = (opts.paths ?? []).map(p => String(p ?? '').trim()).filter(Boolean)
      if (!paths.length) throw new Error('没有要导入的文件')
      if (paths.length > MAX_IMPORT_FILES) throw new Error(`一次最多导入 ${MAX_IMPORT_FILES} 个文件`)
      const rootAbs = resolve(opts.root)
      const assets: LibraryAsset[] = []
      for (const p of paths) {
        const abs = resolve(rootAbs, p)
        try {
          const st = lstatSync(abs)
          if (st.isSymbolicLink() || !st.isFile()) throw new Error(`不是普通文件：${p}`)
          if (!abs.startsWith(rootAbs + sep)) throw new Error(`路径超出会话工作目录：${p}`)
          assertAssetFile(abs, st.size)
          assets.push(store.create({
            name: assets.length === 0 ? opts.name : undefined,
            fileName: basename(abs),
            data: readFileSync(abs),
            sessionId: opts.sessionId,
            provider: 'cwd',
            sourcePath: abs,
          }))
        } catch (e: any) {
          throw new Error(e?.message ?? `无法读取 ${p}`)
        }
      }
      return { asset: assets[0], assets }
    },

    /** 读资产里的某个文件（fileId 只用来在 meta 里反查 rel） */
    readFile(id: string, fileId: string): { file: AssetFile; data: Buffer } | undefined {
      const meta = readMeta(id)
      const file = meta?.files.find(f => f.id === fileId)
      if (!meta || !file) return undefined
      const p = safeInside(id, file.rel)
      if (!p) return undefined
      try { return { file, data: readFileSync(p) } } catch { return undefined }
    },

    /** 读完整快照（送进画布 / 种到新会话用）；上传的 bbmodel 在这里归一化成快照 */
    readDoc(id: string): LibraryDoc | undefined {
      return readDocOf(id)
    },

    readThumb(id: string): Buffer | undefined {
      const meta = readMeta(id)
      if (meta?.model && (meta.model.previewVersion ?? 0) < 2) {
        // 旧素材（贴图缩略图或方向反了的旧预览）：首次展示时重渲染，失败则记 0 不再重试
        const png = renderModelPreview(readDocOf(id) ?? { elements: [], textures: [] })
        if (png) {
          clearThumbs(id)
          meta.model.thumbFileId = writeThumb(id, png)
          meta.model.previewVersion = 2
        } else {
          meta.model.previewVersion = 0
        }
        try { writeMeta(meta) } catch { /* 写不了就下次再试 */ }
      }
      if (meta?.model?.thumbFileId) {
        const p = safeInside(id, join('thumbs', meta.model.thumbFileId))
        if (p) {
          try { return readFileSync(p) } catch { /* 落到旧布局 */ }
        }
      }
      try { return readFileSync(legacyThumbPath(id)) } catch { return undefined }
    },

    /** 归档的构建产物（没有 jar 时返回 undefined） */
    readJar(id: string): Buffer | undefined {
      const meta = readMeta(id)
      if (meta?.jar?.fileId) {
        const found = store.readFile(id, meta.jar.fileId)
        if (found) return found.data
      }
      try { return readFileSync(legacyJarPath(id)) } catch { return undefined }
    },

    remove(id: string): boolean {
      if (!ID_RE.test(id)) return false
      let ok = false
      try {
        if (existsSync(assetDir(id))) {
          rmSync(assetDir(id), { recursive: true, force: true })
          ok = true
        }
      } catch { /* 忽略 */ }
      for (const p of [legacyMetaPath(id), legacyDocPath(id), legacyThumbPath(id), legacyJarPath(id)]) {
        try {
          if (statSync(p).isFile()) { unlinkSync(p); ok = true }
        } catch { /* 文件不存在就跳过 */ }
      }
      return ok
    },

    /**
     * 会话画布自动入库：按 canvasId upsert 一份「auto」素材。
     * 每个会话建立的模型在素材库始终有一份最新快照——画布被覆盖/清空也丢不了。
     * 已有同 canvasId 的 auto 素材就 updateDoc（版本+1），没有就新建；
     * 用户手动截取的素材（auto 缺省）不会被自动更新，保持"冻结版"语义。
     */
    upsertByCanvas(opts: { canvasId: string; sessionId?: string; doc: any }): LibraryAsset | undefined {
      const snap = snapshotOf(opts.doc ?? {})
      if (snap.elements.length === 0) return undefined
      const existing = store.list().find(a => a.auto === true && a.canvasId === opts.canvasId)
      if (existing) return store.updateDoc(existing.id, opts.doc)
      const now = Date.now()
      const id = randomUUID().slice(0, 10)
      const meta: LibraryAsset = {
        schema: 2,
        id,
        name: (snap.name && snap.name !== '未命名模型' ? snap.name : `自动存档 ${opts.canvasId.slice(0, 6)} ${new Date(now).toLocaleDateString('zh-CN')}`).slice(0, 60),
        createdAt: now,
        updatedAt: now,
        version: 1,
        sessionId: opts.sessionId,
        canvasId: opts.canvasId,
        auto: true,
        source: { provider: 'auto', sessionId: opts.sessionId },
        files: [],
        elementCount: 0,
        textureCount: 0,
        resolution: snap.resolution,
        hasThumb: false,
      }
      applySnapshot(id, meta, snap)
      writeMeta(meta)
      return meta
    },
  }
  return store
}

export type LibraryStore = ReturnType<typeof createLibraryStore>

/** 文本文件按 inline 预览截断的上限（供下载接口判断） */
export const LIBRARY_TEXT_INLINE_LIMIT = MAX_TEXT_INLINE
