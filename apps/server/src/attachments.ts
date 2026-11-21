// 附件存储 —— 复刻 dsh `packages/attachment`（attachment + attachment-local）的最小实现。
//
// 与 dsh 一致的三条硬规则：
//   1. 会话日志只存**引用**（attachmentId + 元数据），绝不存 base64 / 临时路径 / object URL；
//   2. 内容寻址：id = `sha256:<digest>`，相同字节只落一份（不同显示名也复用）；
//   3. 准入先于发布：先解码校验格式与体积，通过后才原子写入。
//
// 图片与普通文件共用同一套引用：图片按魔数识别后仍走视觉链路，其余保存为文件引用，
// 请求投影时给模型一个可读路径（surface.ts），不把字节塞进上下文。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 一条图片引用（写进 JSONL 的就是这个，不含像素数据） */
export interface ImageRef {
  attachmentId: string
  mediaType: ImageMediaType
  /** 归一化后的字节数 */
  bytes: number
  name?: string
}

/** 写进 user/message 的附件 part（dsh `AdmittedPromptContentPart` 的 image 分支） */
export interface ImagePart {
  type: 'image'
  attachment: ImageRef
}

/** 一条普通文件引用（非图片） */
export interface FileRef {
  attachmentId: string
  mediaType: string
  bytes: number
  name: string
}

/** 写进 user/message 的附件 part：文件本身留在附件库，日志只记引用 */
export interface FilePart {
  type: 'file'
  attachment: FileRef
}

export type AdmittedPart = ImagePart | FilePart

const EXT: Record<ImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** 常见扩展名 → MIME（仅用于 HTTP 回读，不参与准入判断） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.css': 'text/css', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml',
  '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'text/plain', '.csv': 'text/csv', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.jar': 'application/java-archive',
  '.java': 'text/plain', '.py': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain',
  '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain', '.sh': 'text/plain', '.ps1': 'text/plain', '.bat': 'text/plain',
}

/** dsh attachment-local 的默认准入限制：图片与普通文件同一档 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 20

/** 从魔数判类型 —— 不信任客户端声明的 mediaType（dsh 的“验证后再发布”）
 * @param buf 图片字节
 * @returns 识别出的 raster 类型；不认识返回 undefined */
export function sniffImageType(buf: Buffer): ImageMediaType | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

/** 把一个 data URL 拆成字节（兼容旧客户端） */
function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('附件数据格式不正确')
  const base64 = dataUrl.slice(comma + 1)
  return Buffer.from(base64, 'base64')
}

function safeExt(name: string): string {
  const ext = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '.bin'
}

function mimeOfExt(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 显示名去掉路径分隔符与控制字符，避免日志/下载头被污染 */
function safeName(input: unknown, digest: string, ext: string): string {
  const s = typeof input === 'string'
    ? input.replace(/[\\/\r\n\t]/g, '_').trim().slice(0, 160)
    : ''
  return s || `附件-${digest.slice(0, 8)}${ext}`
}

function validMediaType(input: unknown): string | undefined {
  return typeof input === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(input) ? input : undefined
}

interface StoredEntry {
  path: string
  mediaType: string
  name?: string
  bytes: number
}

export interface AttachmentStore {
  /** 准入 + 落盘：接受 data URL / 已是引用两种输入，返回可写进日志的 part */
  admit(input: any): AdmittedPart
  /** 原始字节准入（输入框上传走这个，不经过 base64） */
  admitBytes(bytes: Buffer, meta: { name?: string; mediaType?: string }): AdmittedPart
  /** 请求时把图片引用还原成 data URL（OpenAI 协议要求内联字节） */
  dataUrl(ref: ImageRef): string | undefined
  /** 文件引用的绝对路径（surface 投影给模型的提示用） */
  filePath(ref: FileRef): string | undefined
  /** HTTP 读取（图片预览 / 文件下载） */
  read(id: string): { mediaType: string; bytes: Buffer; name?: string } | undefined
  /** 已落盘的附件总数与占用（设置/调试用） */
  stats(): { count: number; bytes: number }
}

export function createAttachmentStore(root: string): AttachmentStore {
  mkdirSync(root, { recursive: true })
  const cache = new Map<string, string>()
  const index = new Map<string, StoredEntry>()

  // 启动时扫一遍内容寻址目录：重启后图片/文件引用仍能解析（文件名就是 sha256 + 扩展名）
  for (const name of readdirSync(root)) {
    const m = /^([0-9a-f]{64})(\.[a-z0-9]{1,12})?$/i.exec(name)
    if (!m) continue
    const id = `sha256:${m[1].toLowerCase()}`
    if (index.has(id)) continue
    const path = join(root, name)
    let bytes = 0
    try { bytes = statSync(path).size } catch { continue }
    const ext = m[2]?.toLowerCase() ?? ''
    index.set(id, { path, mediaType: mimeOfExt(ext), bytes })
  }

  const persist = (bytes: Buffer, meta: { name?: unknown; mediaType?: unknown }, dataUrl?: string): AdmittedPart => {
    const digest = createHash('sha256').update(bytes).digest('hex')
    const id = `sha256:${digest}`
    const imageType = sniffImageType(bytes)
    if (imageType) {
      const ref: ImageRef = { attachmentId: id, mediaType: imageType, bytes: bytes.length }
      if (typeof meta.name === 'string' && meta.name) ref.name = safeName(meta.name, digest, EXT[imageType])
      if (!index.has(id)) {
        const path = join(root, `${digest}${EXT[imageType]}`)
        const tmp = `${path}.tmp`
        writeFileSync(tmp, bytes)
        renameSync(tmp, path)
        index.set(id, { path, mediaType: imageType, ...(ref.name ? { name: ref.name } : {}), bytes: bytes.length })
      }
      if (dataUrl) cache.set(id, dataUrl)
      return { type: 'image', attachment: ref }
    }
    const name = safeName(meta.name, digest, safeExt(String(meta.name ?? '')))
    const ext = safeExt(name)
    const mediaType = validMediaType(meta.mediaType) ?? mimeOfExt(ext)
    const ref: FileRef = { attachmentId: id, mediaType, bytes: bytes.length, name }
    if (!index.has(id)) {
      const path = join(root, `${digest}${ext}`)
      const tmp = `${path}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, path)
      index.set(id, { path, mediaType, name, bytes: bytes.length })
    }
    return { type: 'file', attachment: ref }
  }

  return {
    admit(input: any): AdmittedPart {
      // 已经是引用（重放/子代理转发/客户端显式引用）→ 原样通过
      if (input?.type === 'image' && input.attachment?.attachmentId) return input as ImagePart
      if (input?.type === 'file' && input.attachment?.attachmentId) return input as FilePart
      const claimedFile = input?.type === 'file'
      const dataUrl: string | undefined = input?.dataUrl
        ?? (input?.type === 'image_url' ? input?.image_url?.url : undefined)
        ?? (input?.type === 'image' ? input?.data : undefined)
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new Error(claimedFile ? '附件缺少文件数据' : '附件缺少图片数据')
      }
      if (dataUrl.length > MAX_ATTACHMENT_BYTES * 1.4) {
        throw new Error(`单个附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 限制`)
      }
      const bytes = decodeDataUrl(dataUrl)
      if (!claimedFile && !sniffImageType(bytes)) throw new Error('只支持 png / jpeg / webp / gif 图片')
      return persist(bytes, { name: input?.name, mediaType: input?.mediaType }, dataUrl)
    },

    admitBytes(bytes: Buffer, meta: { name?: string; mediaType?: string }): AdmittedPart {
      if (!bytes.length) throw new Error('文件内容为空')
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`单个附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 限制`)
      }
      return persist(bytes, meta)
    },

    dataUrl(ref: ImageRef): string | undefined {
      const hit = cache.get(ref.attachmentId)
      if (hit) return hit
      const found = index.get(ref.attachmentId)
      if (!found) return undefined
      const bytes = readFileSync(found.path)
      const url = `data:${found.mediaType};base64,${bytes.toString('base64')}`
      cache.set(ref.attachmentId, url)
      return url
    },

    filePath(ref: FileRef): string | undefined {
      const found = index.get(String(ref?.attachmentId ?? ''))
      return found && existsSync(found.path) ? found.path : undefined
    },

    read(id: string) {
      const found = index.get(id)
      if (!found || !existsSync(found.path)) return undefined
      return { mediaType: found.mediaType, bytes: readFileSync(found.path), ...(found.name ? { name: found.name } : {}) }
    },

    stats() {
      let bytes = 0
      for (const [, entry] of index) bytes += entry.bytes
      return { count: index.size, bytes }
    },
  }
}
