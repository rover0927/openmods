// Gemini Interactions API 适配器：POST /v1beta/interactions，SSE 流式。
// 同一套内部 OpenAI 风格消息在 buildGeminiRequest / toGeminiInput 里翻译成
// user_input / model_output / function_call / function_result steps。
import type { ChatMessage, LlmAdapter, LlmChatOptions, LlmResult } from './types.js'
import { LlmError } from './types.js'

export interface GeminiLlmConfig {
  baseUrl: string
  apiKey: string
}

type GeminiPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; uri?: string; mime_type?: string }

interface ToolAcc { id: string; name: string; args: string }

/** Base URL 可填根域名、/v1beta，或完整的 /v1beta/interactions */
export function geminiApiBase(baseUrl: string): string {
  const b = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!b) return 'https://generativelanguage.googleapis.com/v1beta'
  if (/\/interactions$/.test(b)) return b.slice(0, -'/interactions'.length)
  if (/\/(v1beta|v1)$/.test(b)) return b
  return `${b}/v1beta`
}

export function geminiInteractionsUrl(baseUrl: string): string {
  return `${geminiApiBase(baseUrl)}/interactions`
}

export function geminiModelsUrl(baseUrl: string): string {
  return `${geminiApiBase(baseUrl)}/models`
}

function contentParts(content: any): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const out: GeminiPart[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) out.push({ type: 'text', text: part })
      continue
    }
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text') {
      const text = String(part.text ?? '')
      if (text) out.push({ type: 'text', text })
      continue
    }
    if (part.type === 'image') {
      if (typeof part.data === 'string' && part.data) {
        out.push({ type: 'image', data: part.data, ...(part.mime_type ? { mime_type: String(part.mime_type) } : {}) })
      } else if (typeof part.uri === 'string' && part.uri) {
        out.push({ type: 'image', uri: part.uri, ...(part.mime_type ? { mime_type: String(part.mime_type) } : {}) })
      } else if (typeof part.inline_data?.data === 'string') {
        out.push({ type: 'image', data: part.inline_data.data, ...(part.inline_data.mime_type ? { mime_type: String(part.inline_data.mime_type) } : {}) })
      }
      continue
    }
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url !== 'string' || !url) continue
      const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      if (dataUrl) out.push({ type: 'image', data: dataUrl[2], mime_type: dataUrl[1] })
      else out.push({ type: 'image', uri: url })
    }
  }
  return out
}

function contentText(content: any): string {
  return contentParts(content)
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')
}

function thoughtText(step: any): string {
  if (typeof step?.text === 'string') return step.text
  if (Array.isArray(step?.summary)) return contentText(step.summary)
  if (Array.isArray(step?.content)) return contentText(step.content)
  return ''
}

function safeJson(raw: string): any {
  try { return JSON.parse(raw || '{}') } catch { return { _raw: raw } }
}

/** 内部 ChatMessage[] → Interactions API 的 input steps；system 单独返回。 */
export function toGeminiInput(messages: ChatMessage[]): { system?: string; input: any[] } {
  const system: string[] = []
  const input: any[] = []
  const toolNames = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = contentText(msg.content)
      if (text) system.push(text)
      continue
    }
    if (msg.role === 'user') {
      const parts = contentParts(msg.content)
      if (parts.length) input.push({ type: 'user_input', content: parts })
      continue
    }
    if (msg.role === 'assistant') {
      const parts = contentParts(msg.content)
      if (parts.length) input.push({ type: 'model_output', content: parts })
      for (const call of msg.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name)
        input.push({
          type: 'function_call',
          id: call.id,
          name: call.function.name,
          arguments: safeJson(call.function.arguments),
        })
      }
      continue
    }
    if (msg.role === 'tool') {
      const callId = msg.tool_call_id ?? ''
      input.push({
        type: 'function_result',
        call_id: callId,
        name: toolNames.get(callId) ?? 'tool',
        result: [{ type: 'text', text: contentText(msg.content) }],
      })
    }
  }

  return { system: system.length ? system.join('\n\n') : undefined, input }
}

/** 构造 Interactions API 请求体；导出便于测试与调试。 */
export function buildGeminiRequest(opts: LlmChatOptions): any {
  const { system, input } = toGeminiInput(opts.messages)
  const body: any = {
    model: String(opts.model).replace(/^models\//, ''),
    input,
    // 本地管理完整历史，避免服务端会话状态与 openmods 的 session log 分叉
    store: false,
    stream: true,
  }
  if (system) body.system_instruction = system
  if (opts.tools?.length) {
    body.tools = opts.tools.map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }))
  }
  if (opts.reasoningEffort) {
    const level = String(opts.reasoningEffort).toLowerCase()
    body.generation_config = { thinking_level: level === 'none' ? 'minimal' : level === 'xhigh' ? 'high' : level }
  }
  return body
}

function geminiUsage(raw: any, started: number, ttftMs: number): LlmResult['usage'] {
  return {
    promptTokens: Number(raw?.total_input_tokens ?? raw?.prompt_tokens ?? 0),
    outputTokens: Number(raw?.total_output_tokens ?? raw?.completion_tokens ?? 0),
    cachedTokens: Number(raw?.total_cached_tokens ?? 0),
    ttftMs: ttftMs || Date.now() - started,
    modelMs: Date.now() - started,
  }
}

function unaryResult(json: any, started: number): LlmResult {
  let text = String(json?.output_text ?? '')
  let reasoning = ''
  const toolCalls: LlmResult['toolCalls'] = []
  const steps = Array.isArray(json?.steps) ? json.steps : Array.isArray(json?.outputs) ? json.outputs : []
  for (const step of steps) {
    if (step?.type === 'model_output') text += contentText(step.content)
    else if (step?.type === 'text') text += String(step.text ?? '')
    else if (step?.type === 'thought') reasoning += thoughtText(step)
    else if (step?.type === 'function_call') {
      toolCalls.push({
        id: String(step.id ?? `call_${Math.random().toString(36).slice(2)}`),
        name: String(step.name ?? ''),
        args: JSON.stringify(step.arguments ?? {}),
      })
    }
  }
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: geminiUsage(json?.usage, started, 0),
  }
}

/** 把上游错误体压成一行可读消息（UI 只显示 message，不能把 detail 藏在对象里） */
function geminiErrorMessage(status: number, body: string): string {
  const raw = String(body ?? '').trim()
  if (!raw) return `Gemini HTTP ${status}`
  try {
    const json = JSON.parse(raw)
    const msg = json?.error?.message ?? json?.[0]?.error?.message
    if (typeof msg === 'string' && msg) return `Gemini HTTP ${status}：${msg}`
  } catch { /* 非 JSON 错误体，按原文截断 */ }
  return `Gemini HTTP ${status}：${raw.slice(0, 400)}`
}

export function createGeminiLlm(config: GeminiLlmConfig): LlmAdapter {
  return {
    async chat(opts: LlmChatOptions): Promise<LlmResult> {
      const started = Date.now()
      let ttftMs = 0
      const url = geminiInteractionsUrl(config.baseUrl)
      const bodyPayload = JSON.stringify(buildGeminiRequest(opts))
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(config.apiKey ? { 'x-goog-api-key': config.apiKey } : {}),
      }

      let res: Response | undefined
      let lastErr: any
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await fetch(url, { method: 'POST', signal: opts.signal, headers, body: bodyPayload })
          if (!res.ok) {
            // 先读错误体：上游用 message 说明是模型不支持、参数错误还是鉴权问题
            const bodyText = await res.text().catch(() => '')
            lastErr = new LlmError(geminiErrorMessage(res.status, bodyText), res.status, bodyText.slice(0, 2000))
            if ((res.status >= 500 || res.status === 429) && attempt < 3) {
              await new Promise(r => setTimeout(r, 800 * attempt))
              continue
            }
          }
          break
        } catch (err: any) {
          if (opts.signal?.aborted) throw err
          lastErr = err
          if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt))
        }
      }
      if (!res || !res.ok) {
        if (lastErr instanceof LlmError) throw lastErr
        if (res) {
          const body = await res.text().catch(() => '')
          throw new LlmError(`Gemini HTTP ${res.status}`, res.status, body.slice(0, 2000))
        }
        throw new LlmError(`无法连接 Gemini 端点：${lastErr?.message ?? 'fetch failed'}`, undefined, String(lastErr?.cause?.message ?? ''))
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const json: any = await res.json().catch(() => ({}))
        return unaryResult(json, started)
      }
      if (!res.body) throw new LlmError('Gemini 响应无 body')

      let text = ''
      let reasoning = ''
      let usage: LlmResult['usage'] | undefined
      const acc: ToolAcc[] = []
      const emitText = (delta: string) => {
        if (!delta) return
        if (!ttftMs) ttftMs = Date.now() - started
        text += delta
        opts.onTextDelta?.(delta)
      }
      const emitReasoning = (delta: string) => {
        if (!delta) return
        if (!ttftMs) ttftMs = Date.now() - started
        reasoning += delta
        opts.onReasoningDelta?.(delta)
      }

      const handleEvent = (ev: any) => {
        if (!ev || typeof ev !== 'object') return
        if (ev.error) {
          const message = ev.error.message ?? ev.error.status ?? JSON.stringify(ev.error)
          throw new LlmError(`Gemini 流错误：${message}`, Number(ev.error.code) || undefined, String(message))
        }
        const type = ev.event_type ?? ev.type ?? ''
        if (type === 'step.start') {
          const index = Number(ev.index ?? 0)
          const step = ev.step ?? {}
          if (step.type === 'model_output') emitText(contentText(step.content))
          else if (step.type === 'thought') emitReasoning(thoughtText(step))
          else if (step.type === 'function_call') {
            acc[index] = {
              id: String(step.id ?? ''),
              name: String(step.name ?? ''),
              args: typeof step.arguments === 'string' ? step.arguments : step.arguments ? JSON.stringify(step.arguments) : '',
            }
          }
          return
        }
        if (type === 'step.delta') {
          const index = Number(ev.index ?? 0)
          const delta = ev.delta ?? {}
          if (delta.type === 'text' && typeof delta.text === 'string') emitText(delta.text)
          else if (delta.type === 'thought') emitReasoning(thoughtText(delta))
          else if (typeof delta.arguments_delta === 'string') {
            acc[index] ??= { id: '', name: '', args: '' }
            acc[index].args += delta.arguments_delta
            if (!ttftMs) ttftMs = Date.now() - started
          }
          return
        }
        if (type === 'interaction.completed') {
          usage = geminiUsage(ev.interaction?.usage ?? ev.usage, started, ttftMs)
        }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let dataLines: string[] = []
      const flush = () => {
        if (!dataLines.length) return
        const payload = dataLines.join('\n')
        dataLines = []
        if (!payload || payload === '[DONE]') return
        let ev: any
        try { ev = JSON.parse(payload) } catch { return }
        handleEvent(ev)
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (!line) { flush(); continue }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
      }
      flush()

      const toolCalls = acc
        .filter(Boolean)
        .map(a => ({
          id: a.id || `call_${Math.random().toString(36).slice(2)}`,
          name: a.name,
          args: a.args || '{}',
        }))
      return {
        text,
        ...(reasoning ? { reasoning } : {}),
        toolCalls,
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        usage: usage ?? geminiUsage(undefined, started, ttftMs),
      }
    },
  }
}
