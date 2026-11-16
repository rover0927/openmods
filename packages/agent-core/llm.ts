// OpenAI 兼容 /chat/completions 流式适配器（DeepSeek 等直连可用）
import type { ChatMessage, LlmAdapter, LlmChatOptions, LlmResult } from './types.js'
import { LlmError } from './types.js'

export interface HttpLlmConfig {
  baseUrl: string
  apiKey: string
}

interface ToolCallAcc { id: string; name: string; args: string }

export function createHttpLlm(config: HttpLlmConfig): LlmAdapter {
  return {
    async chat(opts: LlmChatOptions): Promise<LlmResult> {
      const started = Date.now()
      let ttftMs = 0
      const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
      const bodyPayload = JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.tools?.length
          ? { tools: opts.tools, tool_choice: 'auto', stream_options: { include_usage: true } }
          : { stream_options: { include_usage: true } }),
        stream: true,
      })
      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      }

      // 网络层失败/5xx/429 自动重试（复刻 dsh llm-retry 语义：流已开始后不重试）
      let res: Response | undefined
      let lastErr: any
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await fetch(url, { method: 'POST', signal: opts.signal, headers, body: bodyPayload })
          if (!res.ok && (res.status >= 500 || res.status === 429) && attempt < 3) {
            lastErr = new LlmError(`LLM HTTP ${res.status}`, res.status, (await res.text().catch(() => '')).slice(0, 500))
            await new Promise(r => setTimeout(r, 800 * attempt))
            continue
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
          throw new LlmError(`LLM HTTP ${res.status}`, res.status, body.slice(0, 2000))
        }
        throw new LlmError(`无法连接 LLM 端点：${lastErr?.message ?? 'fetch failed'}`, undefined, String(lastErr?.cause?.message ?? ''))
      }
      if (!res.body) throw new LlmError('LLM 响应无 body')

      let text = ''
      // 思考过程：DeepSeek 用 reasoning_content，部分 OpenAI 兼容端点用 reasoning / reasoning_text；
      // 一律累积下来交给上层展示，但不写回下一轮请求的 messages（DeepSeek 明确拒绝回传）。
      let reasoning = ''
      const acc: ToolCallAcc[] = []
      let usage: LlmResult['usage'] | undefined
      let finishReason = ''

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          let json: any
          try { json = JSON.parse(payload) } catch { continue }
          if (json.usage) {
            usage = {
              promptTokens: json.usage.prompt_tokens ?? 0,
              outputTokens: json.usage.completion_tokens ?? 0,
              cachedTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
              ttftMs: ttftMs || Date.now() - started,
              modelMs: Date.now() - started,
            }
          }
          const choice = json.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta ?? {}
          // 首字延迟按"第一个 token（思考或正文）"算，否则纯思考的步骤会一直被当成没开始
          const think = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text
          if (think) {
            if (!ttftMs) ttftMs = Date.now() - started
            reasoning += think
            opts.onReasoningDelta?.(think)
          }
          if (delta.content) {
            if (!ttftMs) ttftMs = Date.now() - started
            text += delta.content
            opts.onTextDelta?.(delta.content)
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              acc[i] ??= { id: '', name: '', args: '' }
              if (tc.id) acc[i].id = tc.id
              if (tc.function?.name) acc[i].name += tc.function.name
              if (tc.function?.arguments) acc[i].args += tc.function.arguments
            }
            if (!ttftMs) ttftMs = Date.now() - started
          }
        }
      }

      const toolCalls = acc.filter(Boolean).map(c => ({ id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, args: c.args || '{}' }))
      return {
        text,
        ...(reasoning ? { reasoning } : {}),
        toolCalls,
        finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        usage: usage ?? {
          promptTokens: 0, outputTokens: 0, cachedTokens: 0,
          ttftMs: ttftMs || Date.now() - started, modelMs: Date.now() - started,
        },
      }
    },
  }
}

// 保持 import 引用（避免 TS6133 噪音，同时给外部复用类型）
export type { ChatMessage, LlmAdapter, LlmResult }
