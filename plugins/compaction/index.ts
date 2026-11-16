// 省 token 插件 —— 移植 dsh compaction 家族算法：
// - compaction-basic：阈值触发（thresholdRatio/headroom/retainRatio）、工具配对回退、
//   八段式检查点摘要、<compacted-summary> 事务替换（影子内容保留在日志）
// - tool-result-pruner：免费前置裁剪超长工具结果（8192/4096/1024）
// 触发点：每步模型调用前的压力检查（agent/pre-step）+ 上下文超限重试（agent/request-error）
import type {
  Plugin, SessionRuntimeLike, SurfaceItemLike,
} from '@openmods/plugin-kit'
import { estimateMessage, type ChatMessage } from '@openmods/agent-core'

interface Config {
  thresholdRatio: number
  headroomTokens: number
  retainRatio: number
  reservedCompletionTokens: number
  prunerThresholdChars: number
  prunerHeadChars: number
  prunerTailChars: number
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

function estimateItem(item: SurfaceItemLike): number {
  return estimateMessage(itemToMessage(item))
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
      prunerThresholdChars: config.prunerThresholdChars,
      prunerHeadChars: config.prunerHeadChars,
      prunerTailChars: config.prunerTailChars,
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

    // —— 免费前置裁剪（tool-result-pruner）：发往模型前生效，原文保留在日志 ——
    ctx.hooks.registerSurfaceTransform(items => items.map(item => {
      if (item.kind !== 'tool' || typeof item.content !== 'string') return item
      if (item.content.length <= cfg.prunerThresholdChars) return item
      const middle = item.content.length - cfg.prunerHeadChars - cfg.prunerTailChars
      return {
        ...item,
        content: `${item.content.slice(0, cfg.prunerHeadChars)}\n[...中间 ${middle} 字符已被裁剪以节省上下文；原文保留在会话日志中...]\n${item.content.slice(-cfg.prunerTailChars)}`,
      }
    }))

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

    async function compactIfNeeded(session: SessionRuntimeLike, reason: 'pressure' | 'overflow'): Promise<boolean> {
      const all = session.getSurfaceMessages()
      const live = all.filter(i => !i.shadowed)
      const contextTokens = session.estimateContextTokens()
      const window = session.getModelContextWindow()
      const policy = policyFor(session.currentModelId)
      const budget = Math.max(1024, window - cfg.reservedCompletionTokens)
      const threshold = Math.min(
        Math.floor(window * policy.thresholdRatio),
        Math.max(0, budget - cfg.headroomTokens),
      )
      const retainTokens = Math.floor(budget * policy.retainRatio)
      console.log(`[compaction:debug] reason=${reason} model=${session.currentModelId} window=${window} ctx=${contextTokens} threshold=${threshold} retain=${retainTokens} live=${live.length} ratio=${policy.thresholdRatio} retainRatio=${policy.retainRatio}`)

      if (reason === 'pressure' && contextTokens < threshold) return false
      if (live.length < 3) return false

      const blocks = toBlocks(live)
      // 保留预算：从尾部按块累积
      let retainSum = 0
      let cutBlock = blocks.length
      while (cutBlock > 0 && retainSum < retainTokens) {
        const b = blocks[cutBlock - 1]
        for (let i = b.start; i < b.end; i++) retainSum += estimateItem(live[i])
        cutBlock--
      }
      if (reason === 'overflow') {
        // 最大化收缩：只保留最后一个块
        cutBlock = Math.max(0, blocks.length - 1)
      }

      const rangeStart = blocks[cutBlock]?.start ?? live.length
      const range = live.slice(0, rangeStart)
      const shadowedTokens = range.reduce((s, i) => s + estimateItem(i), 0)
      if (range.length === 0 || shadowedTokens < cfg.minShadowedTokens) return false

      const compactionId = `c${Date.now().toString(36)}`
      const started = Date.now()
      session.appendEvent('compaction/start', { compactionId, reason, contextTokens, threshold })

      // 摘要调用：重放 system + 影子消息 + 检查点指令（缓存友好的前缀复用）
      let summaryText: string
      let summaryTokens = 0
      try {
        const messages = [
          { role: 'system', content: session.getSystemPrompt() },
          ...range.map(itemToMessage),
          { role: 'user', content: COMPACTION_INSTRUCTION },
        ]
        const res = await ctx.llm.complete({ messages, modelId: session.currentModelId })
        summaryText = res.text || '（摘要为空）'
        summaryTokens = res.usage.outputTokens
      } catch (err: any) {
        session.appendEvent('compaction/end', { compactionId, wallMs: Date.now() - started, error: err.message })
        throw new Error(`COMPACTION_SUMMARY_FAILED: ${err.message}`)
      }

      const fromSeq = range[0].seq
      const toSeq = range[range.length - 1].seq
      session.appendEvent('compaction/summary', {
        compactionId, fromSeq, toSeq, summaryText,
        shadowedTokens, summaryTokens, reason,
      })
      session.appendEvent('compaction/end', { compactionId, wallMs: Date.now() - started })
      session.emit('compaction/done', {
        sessionId: session.id, compactionId, shadowedTokens, summaryTokens,
        saved: Math.max(0, shadowedTokens - summaryTokens), wallMs: Date.now() - started,
      })
      return true
    }

    ctx.hooks.beforeStep(async ({ session }) => {
      // 一次压缩可能仍高于阈值（超大工具结果/稀疏可切分点），按 compactionRetries 连续压
      for (let attempt = 0; attempt <= cfg.compactionRetries; attempt++) {
        const compacted = await compactIfNeeded(session, 'pressure')
        if (!compacted) return
      }
    })
    ctx.hooks.onOverflow(async ({ session }) => {
      return compactIfNeeded(session, 'overflow')
    })
  },
}

export default plugin
