// surface → OpenAI messages 组装 + 可注册的变换（如工具结果裁剪）
//
// 图片附件在这一层才还原成 provider 需要的 `image_url`（base64 data URL）：
// 会话日志里只有引用，字节由 server 提供的 resolveImage 在组装时取回。
// 这与 dsh 的 `readImageRequest()` 是同一个位置（请求投影期才取字节，日志不含像素）。
import type { ChatMessage } from './types.js'
import type { SurfaceItem } from './session-log.js'

export type SurfaceTransform = (items: SurfaceItem[]) => SurfaceItem[]

const transforms: SurfaceTransform[] = []

export function registerSurfaceTransform(t: SurfaceTransform) {
  transforms.push(t)
}

/** 把日志里的一条附件还原成 OpenAI content part。
 * - 新格式 `{type:'image', attachment:{attachmentId}}` → 请求时取字节
 * - 旧格式 `{type:'image_url', image_url:{url}}` → 历史会话直接沿用（不再迁移，只读兼容）
 * @param part 日志中的附件
 * @param resolveImage 引用 → data URL
 * @returns content part；取不到字节时退化成一句可诊断的文本 */
function toWirePart(part: any, resolveImage?: (ref: any) => string | undefined): any {
  if (part?.type === 'image_url' && part?.image_url?.url) return part
  if (part?.type === 'image' && part?.attachment?.attachmentId) {
    const url = resolveImage?.(part.attachment)
    if (url) return { type: 'image_url', image_url: { url } }
    return { type: 'text', text: `[image unavailable: ${part.attachment.attachmentId}]` }
  }
  if (typeof part?.text === 'string') return { type: 'text', text: part.text }
  return undefined
}

export function buildLlmMessages(
  systemPrompt: string,
  surfaceItems: SurfaceItem[],
  resolveImage?: (ref: any) => string | undefined,
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
          .map(p => toWirePart(p, resolveImage))
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
