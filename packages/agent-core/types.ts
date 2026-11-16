// agent-core 共享类型

export interface ToolCall {
  id: string
  name: string
  args: string // JSON 字符串
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: any // string 或 OpenAI content parts 数组（图片）
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface LlmUsage {
  promptTokens: number
  outputTokens: number
  cachedTokens: number
  ttftMs: number
  modelMs: number
}

export interface LlmResult {
  text: string
  /** 思考过程（deepseek 等推理模型的 reasoning_content）；不参与上下文回放 */
  reasoning?: string
  toolCalls: ToolCall[]
  usage: LlmUsage
  finishReason: string
}

export interface LlmChatOptions {
  messages: ChatMessage[]
  tools?: { type: 'function'; function: { name: string; description: string; parameters: any } }[]
  model: string
  signal?: AbortSignal
  onTextDelta?(delta: string): void
  /** 推理模型的思考增量（delta.reasoning_content） */
  onReasoningDelta?(delta: string): void
}

export interface LlmAdapter {
  chat(opts: LlmChatOptions): Promise<LlmResult>
}

export class LlmError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message)
    this.name = 'LlmError'
  }
}

/** provider 确认的上下文超限（触发 overflow 压缩重试） */
export function isContextOverflowError(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false
  const s = `${err.message} ${err.body ?? ''}`.toLowerCase()
  return (err.status === 400 || err.status === 413 || err.status === 429) &&
    /(context (length|window)|maximum context|too many tokens|token limit|context_length_exceeded|length)/i.test(s)
}
