// 图片附件存储 —— 复刻 dsh `packages/attachment`（attachment + attachment-local）的最小实现。
//
// 与 dsh 一致的三条硬规则：
//   1. 会话日志只存**引用**（attachmentId + 元数据），绝不存 base64 / 临时路径 / object URL；
//   2. 内容寻址：id = `sha256:<digest>`，相同字节只落一份（不同显示名也复用）；
//   3. 准入先于发布：先解码校验格式与体积，通过后才原子写入。
//
// 简化点（与 dsh 的差异，记录在 README）：不做按路由重编码（dsh 会按模型预算压长边/字节），
// 也不做 image/offload（历史图片超预算时换文本句柄）；这两层等需要时再补。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

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

const EXT: Record<ImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** dsh attachment-local 的默认准入限制 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 20

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

/** 把一个 data URL 拆成字节（客户端只发 data URL） */
function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('图片数据格式不正确')
  const base64 = dataUrl.slice(comma + 1)
  return Buffer.from(base64, 'base64')
}

export interface AttachmentStore {
  /** 准入 + 落盘：接受 data URL / 已是引用两种输入，返回可写进日志的 part */
  admit(input: any): ImagePart
  /** 请求时把引用还原成 data URL（OpenAI 协议要求内联字节） */
  dataUrl(ref: ImageRef): string | undefined
  /** HTTP 读取（右侧「图片」标签用） */
  read(id: string): { mediaType: ImageMediaType; bytes: Buffer } | undefined
  /** 已落盘的附件总数与占用（设置/调试用） */
  stats(): { count: number; bytes: number }
}

export function createAttachmentStore(root: string): AttachmentStore {
  mkdirSync(root, { recursive: true })
  const cache = new Map<string, string>()

  const fileOf = (id: string, mediaType: ImageMediaType): string =>
    join(root, `${id.replace(/^sha256:/, '')}${EXT[mediaType]}`)

  /** 按 id 找已有文件（类型可能在缓存里，所以四种扩展都试一遍） */
  const findExisting = (id: string): { path: string; mediaType: ImageMediaType } | undefined => {
    for (const t of Object.keys(EXT) as ImageMediaType[]) {
      const p = fileOf(id, t)
      if (existsSync(p)) return { path: p, mediaType: t }
    }
    return undefined
  }

  return {
    admit(input: any): ImagePart {
      // 已经是引用（重放/子代理转发/客户端显式引用）→ 原样通过
      if (input?.type === 'image' && input.attachment?.attachmentId) return input as ImagePart
      const dataUrl: string | undefined = input?.dataUrl
        ?? (input?.type === 'image_url' ? input?.image_url?.url : undefined)
        ?? (input?.type === 'image' ? input?.data : undefined)
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new Error('附件缺少图片数据')
      }
      if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) throw new Error('单张图片超过 50 MiB 限制')
      const bytes = decodeDataUrl(dataUrl)
      const mediaType = sniffImageType(bytes)
      if (!mediaType) throw new Error('只支持 png / jpeg / webp / gif 图片')
      const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      const ref: ImageRef = {
        attachmentId: id, mediaType, bytes: bytes.length,
        ...(typeof input?.name === 'string' && input.name ? { name: input.name } : {}),
      }
      // 内容寻址：同一份字节只写一次（原子写，避免半截文件）
      if (!findExisting(id)) {
        const tmp = `${fileOf(id, mediaType)}.tmp`
        writeFileSync(tmp, bytes)
        renameSync(tmp, fileOf(id, mediaType))
      }
      cache.set(id, dataUrl)
      return { type: 'image', attachment: ref }
    },

    dataUrl(ref: ImageRef): string | undefined {
      const hit = cache.get(ref.attachmentId)
      if (hit) return hit
      const found = findExisting(ref.attachmentId)
      if (!found) return undefined
      const bytes = readFileSync(found.path)
      const url = `data:${found.mediaType};base64,${bytes.toString('base64')}`
      cache.set(ref.attachmentId, url)
      return url
    },

    read(id: string) {
      const found = findExisting(id)
      if (!found) return undefined
      return { mediaType: found.mediaType, bytes: readFileSync(found.path) }
    },

    stats() {
      // 轻量：只数缓存与本次进程见过的对象，磁盘清理由 users 自己决定（dsh 也不自动删）
      let bytes = 0
      for (const [, url] of cache) bytes += Math.floor(url.length * 0.75)
      return { count: cache.size, bytes }
    },
  }
}
