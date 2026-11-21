// surface → OpenAI messages 组装 + 可注册的变换（如工具结果裁剪）
//
// 图片附件在这一层才还原成 provider 需要的 `image_url`（base64 data URL）：
// 会话日志里只有引用，字节由 server 提供的 resolveImage 在组装时取回。
// 这与 dsh 的 `readImageRequest()` 是同一个位置（请求投影期才取字节，日志不含像素）。
import type { ChatMessage } from './types.js'
import type { SurfaceItem } from './session-log.js'

export type SurfaceTransform = (items: SurfaceItem[]) => SurfaceItem[]

/** 文件引用 → 落盘位置（server 注入；请求投影期才解析，日志里只有引用） */
export type FileResolver = (ref: any) => { path: string; name?: string; bytes?: number; mediaType?: string } | undefined

const transforms: SurfaceTransform[] = []

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '未知大小'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function registerSurfaceTransform(t: SurfaceTransform) {
  transforms.push(t)
}

/** 把日志里的一条附件还原成 OpenAI content part。
 * - 新格式 `{type:'image', attachment:{attachmentId}}` → 请求时取字节
 * - 旧格式 `{type:'image_url', image_url:{url}}` → 历史会话直接沿用（不再迁移，只读兼容）
 * @param part 日志中的附件
 * @param resolveImage 引用 → data URL
 * @returns content part；取不到字节时退化成一句可诊断的文本 */
function toWirePart(
  part: any,
  resolveImage?: (ref: any) => string | undefined,
  resolveFile?: FileResolver,
): any {
  if (part?.type === 'image_url' && part?.image_url?.url) return part
  if (part?.type === 'image' && part?.attachment?.attachmentId) {
    const url = resolveImage?.(part.attachment)
    if (url) return { type: 'image_url', image_url: { url } }
    return { type: 'text', text: `[image unavailable: ${part.attachment.attachmentId}]` }
  }
  if (part?.type === 'file' && part?.attachment?.attachmentId) {
    const ref = part.attachment
    const found = resolveFile?.(ref)
    const name = String(ref.name || found?.name || ref.attachmentId)
    const size = fmtBytes(Number(ref.bytes ?? found?.bytes ?? 0))
    const mime = String(ref.mediaType || found?.mediaType || '')
    if (!found?.path) return { type: 'text', text: `[file unavailable: ${name} ${ref.attachmentId}]` }
    // 文件本身不塞进上下文：给模型一个可读路径，由它按需用 read / bash 打开
    return { type: 'text', text: `[附件] ${name}（${size}${mime ? `，${mime}` : ''}）→ ${found.path}` }
  }
  if (typeof part?.text === 'string') return { type: 'text', text: part.text }
  return undefined
}

export function buildLlmMessages(
  systemPrompt: string,
  surfaceItems: SurfaceItem[],
  resolveImage?: (ref: any) => string | undefined,
  resolveFile?: FileResolver,
): ChatMessage[] {
  let items = surfaceItems.filter(i => !i.shadowed)
  for (const t of transforms) items = t(items)

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const item of items) {
    if (item.kind === 'user') {
      // imagesOmitted / transcribed 都表示“这轮的图没有随请求发出”：
      // 前者是 dsh 的占位文本（模型不支持视觉），后者是历史桥接转述（旧数据）
      const sendImages = !!item.attachments?.length && !item.transcribed && !item.imagesOmitted
      if (sendImages) {
        const parts = (item.attachments ?? [])
          .map(p => toWirePart(p, resolveImage, resolveFile))
          .filter((p): p is any => p !== undefined)
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: item.content ?? '' }, ...parts],
        })
      } else {
        messages.push({ role: 'user', content: item.content ?? '' })
      }
    } else if (item.kind === 'assistant') {
      messages.push({
        role: 'assistant',
        content: item.content ?? '',
        ...(item.toolCalls?.length ? {
          tool_calls: item.toolCalls.map(c => ({
            id: c.id, type: 'function' as const,
            function: { name: c.name, arguments: c.args },
          })),
        } : {}),
      })
    } else if (item.kind === 'tool') {
      messages.push({ role: 'tool', tool_call_id: item.toolCallId, content: item.content ?? '' })
    } else if (item.kind === 'summary') {
      messages.push({ role: 'user', content: item.content ?? '' })
    }
  }
  return messages
}
