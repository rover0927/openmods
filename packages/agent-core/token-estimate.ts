// token 估算 —— 移植自 dsh packages/llm/token-meter/src/estimate.ts 的固定密度启发式：
// 4 字符/Token，每条消息/工具调用有固定开销。README 自述该启发式对 CJK 文本偏低估，够用。
import type { ChatMessage } from './types.js'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

const est = (len: number) => Math.ceil(len / CHARS_PER_TOKEN) + BLOCK_OVERHEAD

export function estimateText(text: string): number {
  return est(text.length)
}

export function estimateMessage(msg: ChatMessage): number {
  let n = ROLE_OVERHEAD
  if (typeof msg.content === 'string') n += est(msg.content.length)
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text') n += est(part.text?.length ?? 0)
      else if (part.type === 'image_url') n += est(JSON.stringify(part.image_url).length) // 图片按结构化 JSON 计
    }
  }
  if (msg.tool_calls) {
    for (const c of msg.tool_calls) n += est(c.function.name.length) + est(c.function.arguments.length)
  }
  return n
}

export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0) + BLOCK_OVERHEAD
}

export function estimateToolDefs(tools: { function: { name: string; description: string; parameters: any } }[]): number {
  if (!tools.length) return 0
  return est(JSON.stringify(tools).length)
}
