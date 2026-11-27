// 省 token 插件 —— 移植 dsh compaction 家族算法：
// - compaction-basic：阈值触发（thresholdRatio/headroom/retainRatio）、工具配对回退、
//   八段式检查点摘要、<compacted-summary> 事务替换（影子内容保留在日志）
// - tool-result-pruner：免费前置裁剪超长工具结果（8192/4096/1024）
// 触发点：每步模型调用前的压力检查（agent/pre-step）+ 上下文超限重试（agent/request-error）
import type {
  Plugin, SessionRuntimeLike, SurfaceItemLike,
} from '@openmods/plugin-kit'
import { buildLlmMessages, estimateMessage, type ChatMessage } from '@openmods/agent-core'

interface Config {
  thresholdRatio: number
  headroomTokens: number
  retainRatio: number
  reservedCompletionTokens: number
  prunerThresholdChars: number
  prunerHeadChars: number
  prunerTailChars: number
  /** 历史 assistant 工具调用参数超过该字符数时投影为占位 JSON（原始参数保留在会话日志） */
  toolArgThresholdChars: number
  /** 占位 JSON 中保留的参数开头字符数，供模型辨认是哪次调用 */
  toolArgPreviewChars: number
  /** 触发压缩的最小影子 token 数（太小不值得一次摘要调用） */
  minShadowedTokens: number
  /** 一轮内最多连续压缩几次（dsh compactionRetries：压一次可能仍超阈值） */
  compactionRetries: number
  /** 按模型覆盖阈值/保留比（dsh `modelPolicies`）：key 为目录里的模型 id */
  modelPolicies?: Record<string, { thresholdRatio?: number; retainRatio?: number }>
}

const COMPACTION_INSTRUCTION = `[compaction] 请把上面的对话压缩成一份"检查点"，供后续的你自己接续工作使用。严格输出以下八节的 Markdown（每节简短，没有内容写"无"）：
## 主要诉求与意图
## 关键技术概念
## 文件与代码
## 错误与修复
## 待办事项
## 当前工作
## 下一步
## 关键上下文
只输出这份检查点，不要任何额外解释。`

const MOCK_SUMMARY = `## 主要诉求与意图
用户在此前对话中要求用 AI 逐步搭建方块风格模型（已完成：冰晶法杖——银柄金箍、蓝色收分水晶、悬浮晶片）。
## 关键技术概念
openmods 工具流：create_model / place_cubes（from-to 角点，Y 向上）/ modify_cube / list_outline；材质关键字映射纯色贴图。
## 文件与代码
无本地文件；模型为服务端 bbmodel 文档（free 格式）。
## 错误与修复
无。
## 待办事项
按用户新指示继续修改模型。
## 当前工作
上一轮建模工具调用已完成并同步到只读画布。
## 下一步
处理本轮用户的新请求。
## 关键上下文
材质前缀命名约定；画布只读；每步前的压缩检查点本条即为其产物。`

function itemToMessage(item: SurfaceItemLike): ChatMessage {
  if (item.kind === 'assistant') {
    return {
      role: 'assistant',
      content: item.content ?? '',
      ...(item.toolCalls?.length ? {
        tool_calls: item.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } })),
      } : {}),
    }
  }
  if (item.kind === 'tool') return { role: 'tool', tool_call_id: item.toolCallId, content: item.content ?? '' }
  return { role: 'user', content: item.content ?? '' }
}

const plugin: Plugin = {
  name: 'compaction',
  config: {
    thresholdRatio: 0.8,
    headroomTokens: 65536,
    retainRatio: 0.16,
    reservedCompletionTokens: 8192,
    prunerThresholdChars: 8192,
    prunerHeadChars: 4096,
    prunerTailChars: 1024,
    toolArgThresholdChars: 16384,
    toolArgPreviewChars: 1200,
    minShadowedTokens: 1200,
    compactionRetries: 2,
  },
  apply(ctx, config) {
    // 环境变量覆盖（便于演示：COMPACTION_THRESHOLD_RATIO=0.02 + RETAIN_RATIO=0.03 即刻触发压缩）
    const num = (v: string | undefined, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : d
    }
    const cfg: Config = {
      thresholdRatio: num(ctx.env.COMPACTION_THRESHOLD_RATIO, config.thresholdRatio),
      headroomTokens: num(ctx.env.COMPACTION_HEADROOM_TOKENS, config.headroomTokens),
      retainRatio: Math.min(1, num(ctx.env.COMPACTION_RETAIN_RATIO, config.retainRatio)),
      reservedCompletionTokens: config.reservedCompletionTokens,
      prunerThresholdChars: num(ctx.env.COMPACTION_RESULT_CHARS, config.prunerThresholdChars),
      prunerHeadChars: config.prunerHeadChars,
      prunerTailChars: config.prunerTailChars,
      toolArgThresholdChars: num(ctx.env.COMPACTION_ARG_THRESHOLD_CHARS, config.toolArgThresholdChars),
      toolArgPreviewChars: config.toolArgPreviewChars,
      minShadowedTokens: num(ctx.env.COMPACTION_MIN_SHADOWED, config.minShadowedTokens),
      compactionRetries: Math.max(0, Math.floor(num(ctx.env.COMPACTION_RETRIES, config.compactionRetries))),
      modelPolicies: config.modelPolicies,
    }

    /** 按模型解析阈值/保留比（dsh `modelPolicies`：一个后端服务多种上下文大小的模型） */
    const policyFor = (modelId: string) => {
      const p = cfg.modelPolicies?.[modelId]
      return {
        thresholdRatio: Math.min(1, Math.max(0.05, p?.thresholdRatio ?? cfg.thresholdRatio)),
        retainRatio: Math.min(0.9, Math.max(0.01, p?.retainRatio ?? cfg.retainRatio)),
      }
    }

    /**
     * 设置页「上下文」页签的策略：每次投影/压缩前现读，保存后下一步请求生效。
     * 环境变量仍然优先（离线演示用 COMPACTION_THRESHOLD_RATIO 等强制触发）。
     */
    const prefs = () => ctx.prefs.get() as Record<string, any>
    const resultLimit = () => {
      if (ctx.env.COMPACTION_RESULT_CHARS !== undefined) return cfg.prunerThresholdChars
      const v = Number(prefs().compactionResultChars)
      return Number.isFinite(v) ? v : cfg.prunerThresholdChars
    }
    const argLimit = () => {
      if (ctx.env.COMPACTION_ARG_THRESHOLD_CHARS !== undefined) return cfg.toolArgThresholdChars
      const v = Number(prefs().compactionArgChars)
      return Number.isFinite(v) ? v : cfg.toolArgThresholdChars
    }

    // —— 免费前置裁剪（tool-result-pruner）：发往模型前生效，原文保留在日志 ——
    const pruneToolResult = (item: SurfaceItemLike): SurfaceItemLike => {
      const limit = resultLimit()
      if (!limit || item.kind !== 'tool' || typeof item.content !== 'string') return item
      if (/^---\r?\nname:/.test(item.content)) return item
      if (item.content.length <= limit) return item
      const head = Math.min(cfg.prunerHeadChars, Math.floor(limit * 0.6))
      const tail = Math.min(cfg.prunerTailChars, Math.max(0, limit - head - 32))
      const middle = item.content.length - head - tail
      const tailText = tail > 0 ? item.content.slice(-tail) : ''
      return {
        ...item,
        content: `${item.content.slice(0, head)}\n[...中间 ${middle} 字符已被裁剪以节省上下文；原文保留在会话日志中...]\n${tailText}`,
      }
    }

    // —— 超长工具参数：模型偶尔会生成巨大的 args（例如一次写入整个工程文件）。
    // 这些参数存在于历史里，每次请求都会重发；投影成合法 JSON 占位符，避免上下文被一次调用撑爆。
    const pruneToolArgs = (item: SurfaceItemLike): SurfaceItemLike => {
      const limit = argLimit()
      if (!limit || item.kind !== 'assistant' || !item.toolCalls?.length) return item
      let changed = false
      const toolCalls = item.toolCalls.map(call => {
        if (typeof call.args !== 'string' || call.args.length <= limit) return call
        changed = true
        return {
          ...call,
          args: JSON.stringify({
            _truncated: true,
            _originalChars: call.args.length,
            _note: '历史工具参数过长，已从上下文裁剪；完整参数保留在会话日志中。',
            preview: call.args.slice(0, Math.min(cfg.toolArgPreviewChars, limit)),
          }),
        }
      })
      return changed ? { ...item, toolCalls } : item
    }

    const projectItem = (item: SurfaceItemLike): SurfaceItemLike => pruneToolArgs(pruneToolResult(item))
    ctx.hooks.registerSurfaceTransform(items => items.map(projectItem))

    /** retain / shadowed 都按“实际会发出去的投影”估算，否则巨型参数会把保留预算一次吃光 */
    const estimateProjectedItem = (item: SurfaceItemLike): number =>
      estimateMessage(itemToMessage(projectItem(item)))

    // —— 按块划分（保证 assistant 工具调用与其结果永不拆散，dsh tool-pairing 语义） ——
    function toBlocks(live: SurfaceItemLike[]): { start: number; end: number }[] {
      const blocks: { start: number; end: number }[] = []
      let i = 0
      while (i < live.length) {
        const item = live[i]
        if (item.kind === 'assistant' && item.toolCalls?.length) {
          let j = i + 1
          while (j < live.length && live[j].kind === 'tool') j++
          blocks.push({ start: i, end: j })
          i = j
        } else {
          blocks.push({ start: i, end: i + 1 })
          i++
        }
      }
      return blocks
    }

    async function compactIfNeeded(
      session: SessionRuntimeLike,
      reason: 'pressure' | 'overflow',
      signal?: AbortSignal,
    ): Promise<boolean> {
      if (signal?.aborted) return false
      const all = session.getSurfaceMessages()
      const live = all.filter(i => !i.shadowed)
      const contextTokens = session.estimateContextTokens()
      const window = session.getModelContextWindow()
      const policy = policyFor(session.currentModelId)
      // 用户策略优先于 modelPolicies；环境变量优先于一切（演示/排障用）
      const pref = prefs()
      const thresholdRatio = ctx.env.COMPACTION_THRESHOLD_RATIO !== undefined
        ? cfg.thresholdRatio
        : Math.min(0.95, Math.max(0.05, Number(pref.compactionThresholdRatio) || policy.thresholdRatio))
      const retainRatio = ctx.env.COMPACTION_RETAIN_RATIO !== undefined
        ? cfg.retainRatio
        : Math.min(0.9, Math.max(0.01, Number(pref.compactionRetainRatio) || policy.retainRatio))
      const budget = Math.max(1024, window - cfg.reservedCompletionTokens)
      const threshold = Math.min(
        Math.floor(window * thresholdRatio),
        Math.max(0, budget - cfg.headroomTokens),
      )
      const retainTokens = Math.floor(budget * retainRatio)
      console.log(`[compaction:debug] reason=${reason} model=${session.currentModelId} window=${window} ctx=${contextTokens} threshold=${threshold} retain=${retainTokens} live=${live.length} ratio=${thresholdRatio} retainRatio=${retainRatio}`)

      if (reason === 'pressure' && contextTokens < threshold) return false
      if (live.length < 3) return false

      const blocks = toBlocks(live)
      // 保留预算：从尾部按块累积
      let retainSum = 0
      let cutBlock = blocks.length
      while (cutBlock > 0 && retainSum < retainTokens) {
        const b = blocks[cutBlock - 1]
        for (let i = b.start; i < b.end; i++) retainSum += estimateProjectedItem(live[i])
        cutBlock--
      }
      if (reason === 'overflow') {
        // 最大化收缩：只保留最后一个块
        cutBlock = Math.max(0, blocks.length - 1)
      }

      const rangeStart = blocks[cutBlock]?.start ?? live.length
      const range = live.slice(0, rangeStart)
      const shadowedTokens = range.reduce((s, i) => s + estimateProjectedItem(i), 0)
      if (range.length === 0 || shadowedTokens < cfg.minShadowedTokens) return false

      const compactionId = `c${Date.now().toString(36)}`
      const started = Date.now()
      session.appendEvent('compaction/start', { compactionId, reason, contextTokens, threshold })

      // 压缩方式：summary 调模型生成检查点；drop 直接把超出的旧块影子化，不调用任何模型。
      const strategy = prefs().compactionStrategy === 'drop' ? 'drop' : 'summary'
      const configuredModel = String(prefs().compactionModelId ?? '').trim()
      const summaryModelId = configuredModel || session.currentModelId
      let usedModelId = summaryModelId
      let summaryText = ''
      let summaryTokens = 0
      if (strategy === 'drop') {
        summaryText = '（已按“直接丢弃”策略省略最早的一批对话；完整内容保留在会话日志中。）'
        summaryTokens = estimateMessage({ role: 'user', content: summaryText })
      } else {
        // 摘要调用：与主请求走同一条投影（含工具结果/参数裁剪），
        // 否则会把已经被裁掉的长内容再完整读一遍。
        try {
          const messages = [
            ...buildLlmMessages(session.getSystemPrompt(), range as any),
            { role: 'user', content: COMPACTION_INSTRUCTION },
          ]
          let res
          try {
            res = await ctx.llm.complete({ messages, modelId: summaryModelId, signal })
          } catch (err: any) {
            if (signal?.aborted || summaryModelId === session.currentModelId) throw err
            // 配置的摘要模型失效（被删除/改名）时回退当前模型，别让压缩卡死
            console.warn(`[compaction] 摘要模型 ${summaryModelId} 不可用（${err?.message ?? err}），回退当前模型`)
            res = await ctx.llm.complete({ messages, modelId: session.currentModelId, signal })
            usedModelId = session.currentModelId
          }
          summaryText = res.text || '（摘要为空）'
          summaryTokens = res.usage.outputTokens
        } catch (err: any) {
          session.appendEvent('compaction/end', { compactionId, wallMs: Date.now() - started, error: err.message })
          throw new Error(`COMPACTION_SUMMARY_FAILED: ${err.message}`)
        }
      }

      const fromSeq = range[0].seq
      const toSeq = range[range.length - 1].seq
      session.appendEvent('compaction/summary', {
        compactionId, fromSeq, toSeq, summaryText,
        shadowedTokens, summaryTokens, reason,
        strategy, summaryModelId: strategy === 'summary' ? usedModelId : undefined,
      })
      session.appendEvent('compaction/end', { compactionId, wallMs: Date.now() - started })
      session.emit('compaction/done', {
        sessionId: session.id, compactionId, shadowedTokens, summaryTokens,
        saved: Math.max(0, shadowedTokens - summaryTokens), wallMs: Date.now() - started,
      })
      return true
    }

    ctx.hooks.beforeStep(async ({ session, signal }) => {
      // 设置页可关闭主动压缩；请求真的超限时仍走 onOverflow 兜底，避免直接报错
      if (prefs().compactionEnabled === false) return
      // 一次压缩可能仍高于阈值（超大工具结果/稀疏可切分点），按 compactionRetries 连续压
      for (let attempt = 0; attempt <= cfg.compactionRetries; attempt++) {
        if (signal?.aborted) return
        const compacted = await compactIfNeeded(session, 'pressure', signal)
        if (!compacted) return
      }
    })
    ctx.hooks.onOverflow(async ({ session, signal }) => {
      return compactIfNeeded(session, 'overflow', signal)
    })
  },
}

export default plugin
