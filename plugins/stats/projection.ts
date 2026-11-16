// 看板投影 —— 移植 dsh-session-stats 的"对整条日志折叠出统计"思路：
// 纯函数、无状态，翻页与压缩后重算依然正确（数据全部来自 durable log）。

export interface StepRow {
  stepId: string
  turnId: string
  model?: string
  contextTokens: number
  outputTokens: number
  cachedTokens: number
  ttftMs: number
  modelMs: number
  toolMs: number
  tps: number
}

export interface TurnRow {
  turnId: string
  firstUserText: string
  steps: StepRow[]
  /** 回合首个/最后事件的 ts：只用来算"回合内空档"，不参与展示 */
  startTs?: number
  endTs?: number
}

export interface CompactionRow {
  compactionId: string
  reason: string
  shadowedTokens: number
  summaryTokens: number
  saved: number
  wallMs: number
}

/** 单个工具的调用次数与总耗时 */
export interface ToolUsageRow {
  name: string
  count: number
  ms: number
  errors: number
}

/** 命令/任务排行（mc_gradle 的 task、shell 命令首词） */
export interface CommandRow {
  name: string
  count: number
}

/** 上下文面板的数据块（dsh token-meter 面板的等价物，全部来自 durable log） */
export interface ContextStats {
  /** 事件计数：段次/步/消息/工具/思考/压缩 */
  counts: {
    turns: number
    steps: number
    userMessages: number
    assistantMessages: number
    toolCalls: number
    reasoning: number
    compactions: number
  }
  /** 工具用量排行（次数降序） */
  tools: ToolUsageRow[]
  /** 命令/任务排行 */
  commands: CommandRow[]
  /**
   * Token 构成：
   * - system / tools / message 三段由 server 用 runtime.contextBreakdown() 填（日志里没有）
   * - output / reasoning / cacheRead 是累计量（从 llm/usage 与思考字数估）
   */
  tokenSplit: {
    system: number
    tools: number
    message: number
    output: number
    reasoning: number
    cacheRead: number
  }
  /** 耗时分布（ms）：首字等待 / 生成 / 工具 / 其它 */
  timeSplit: {
    ttft: number
    generation: number
    tool: number
    idle: number
  }
  /** 每步一行（底部时间轴色带） */
  timeline: {
    stepId: string
    turnId: string
    model?: string
    context: number
    output: number
    tps: number
  }[]
  /** 思考/正文的字符量（面板上按"字"展示，比 token 估更贴近用户直觉） */
  textChars: {
    reasoning: number
    assistant: number
  }
}

export interface StatsProjection {
  turns: TurnRow[]
  compactions: CompactionRow[]
  totals: {
    turns: number
    steps: number
    contextTokens: number
    outputTokens: number
    cacheHit: number
    avgTtftMs: number
    tps: number
    modelMs: number
    toolMs: number
    compactions: number
    savedTokens: number
  }
  context: ContextStats
}

/** 命令/任务名：把工具调用还原成"人看得懂的一条命令"（面板命令排行用） */
function commandOf(name: string, args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  if (name === 'mc_gradle') return args.task ? `gradle ${String(args.task)}` : 'gradle'
  if (name === 'mc_scaffold') return 'mc_scaffold'
  const raw = args.command ?? args.cmd ?? args.script
  if (typeof raw === 'string' && raw.trim()) {
    const first = raw.trim().split(/\s+/)[0]
    return first.length > 24 ? first.slice(0, 24) : first
  }
  return undefined
}

export function projectStats(events: Array<{ seq: number; ts: number; t: string } & Record<string, any>>): StatsProjection {
  const turns: TurnRow[] = []
  const compactions: CompactionRow[] = []
  const stepRows = new Map<string, StepRow>()
  const toolStarts = new Map<string, number>()
  // —— 上下文面板的派生量 ——
  const counts = { turns: 0, steps: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, reasoning: 0, compactions: 0 }
  const toolAgg = new Map<string, ToolUsageRow>()
  const cmdAgg = new Map<string, number>()
  const textChars = { reasoning: 0, assistant: 0 }
  const reasoningSteps = new Set<string>()
  let cacheRead = 0

  let turnRow: TurnRow | undefined

  for (const ev of events) {
    switch (ev.t) {
      case 'turn/start':
        turnRow = { turnId: ev.turnId, firstUserText: '', steps: [], startTs: ev.ts, endTs: ev.ts }
        turns.push(turnRow)
        counts.turns++
        break
      case 'user/message':
        counts.userMessages++
        if (turnRow && !turnRow.firstUserText) turnRow.firstUserText = String(ev.text ?? '').slice(0, 60)
        break
      case 'assistant/message': {
        counts.assistantMessages++
        // 思考过程随 assistant/message 一起落盘（单步截 64k），在这里数段数与字数；
        // 流式的 assistant/reasoning 只走 SSE、不进日志，不能拿它统计。
        const rs = typeof ev.reasoning === 'string' ? ev.reasoning : ''
        if (rs.length > 0) {
          textChars.reasoning += rs.length
          if (ev.stepId && !reasoningSteps.has(ev.stepId)) { reasoningSteps.add(ev.stepId); counts.reasoning++ }
        }
        if (typeof ev.text === 'string') textChars.assistant += ev.text.length
        break
      }
      case 'assistant/delta':
        // 兜底：只有流式、没有落盘正文时也记一点字数（正常路径走 assistant/message）
        break
      case 'step/start':
        counts.steps++
        stepRows.set(ev.stepId, {
          stepId: ev.stepId, turnId: ev.turnId,
          contextTokens: 0, outputTokens: 0, cachedTokens: 0,
          ttftMs: 0, modelMs: 0, toolMs: 0, tps: 0,
        })
        break
      case 'llm/usage': {
        cacheRead += ev.cachedTokens ?? 0
        const row = stepRows.get(ev.stepId)
        if (row) {
          row.model = ev.model
          row.contextTokens = ev.promptTokens ?? 0
          row.outputTokens = ev.outputTokens ?? 0
          row.cachedTokens = ev.cachedTokens ?? 0
          row.ttftMs = ev.ttftMs ?? 0
          row.modelMs = ev.modelMs ?? 0
          row.tps = row.modelMs > 0 ? Math.round((row.outputTokens / row.modelMs) * 1000) : 0
          if (turnRow && !turnRow.steps.find(s => s.stepId === ev.stepId)) turnRow.steps.push(row)
        }
        break
      }
      case 'tool/call': {
        toolStarts.set(ev.callId, ev.ts)
        counts.toolCalls++
        const name = String(ev.name ?? 'unknown')
        const agg = toolAgg.get(name) ?? { name, count: 0, ms: 0, errors: 0 }
        agg.count++
        toolAgg.set(name, agg)
        const cmd = commandOf(name, ev.args)
        if (cmd) cmdAgg.set(cmd, (cmdAgg.get(cmd) ?? 0) + 1)
        break
      }
      case 'tool/result': {
        const started = toolStarts.get(ev.callId)
        if (started) {
          const row = stepRows.get(ev.stepId)
          if (row) row.toolMs += Math.max(0, ev.ts - started)
          toolStarts.delete(ev.callId)
        }
        if (ev.isError) {
          const agg = toolAgg.get(String(ev.name ?? 'unknown'))
          if (agg) agg.errors++
        }
        break
      }
      case 'compaction/summary':
        counts.compactions++
        compactions.push({
          compactionId: ev.compactionId,
          reason: ev.reason ?? 'pressure',
          shadowedTokens: ev.shadowedTokens ?? 0,
          summaryTokens: ev.summaryTokens ?? 0,
          saved: Math.max(0, (ev.shadowedTokens ?? 0) - (ev.summaryTokens ?? 0)),
          wallMs: 0,
        })
        break
      case 'compaction/end': {
        const row = compactions.find(c => c.compactionId === ev.compactionId)
        if (row) row.wallMs = Math.max(0, ev.ts - (ev.ts - (ev.wallMs ?? 0)))
        break
      }
    }
    // 回合边界：同一 turnId 的最后一条事件时间（用于回合内空档，排除用户离开的时间）
    if (turnRow && ev.turnId === turnRow.turnId) turnRow.endTs = ev.ts
  }

  const allSteps = turns.flatMap(t => t.steps)
  const sumContext = allSteps.reduce((s, r) => s + r.contextTokens, 0)
  const sumOutput = allSteps.reduce((s, r) => s + r.outputTokens, 0)
  const sumCache = allSteps.reduce((s, r) => s + r.cachedTokens, 0)
  const sumModel = allSteps.reduce((s, r) => s + r.modelMs, 0)
  const sumTool = allSteps.reduce((s, r) => s + r.toolMs, 0)
  const ttftSteps = allSteps.filter(r => r.ttftMs > 0)
  const sumTtft = allSteps.reduce((s, r) => s + r.ttftMs, 0)
  // 回合内墙钟（只算模型/工具真正在跑的时段；用户关掉页面过夜的那段不计入）
  const turnWall = turns.reduce((s, t) => {
    const from = t.startTs ?? 0
    const to = t.endTs ?? from
    return s + Math.max(0, to - from)
  }, 0)

  return {
    turns,
    compactions,
    totals: {
      turns: turns.length,
      steps: allSteps.length,
      contextTokens: sumContext,
      outputTokens: sumOutput,
      cacheHit: sumContext > 0 ? sumCache / sumContext : 0,
      avgTtftMs: ttftSteps.length ? Math.round(ttftSteps.reduce((s, r) => s + r.ttftMs, 0) / ttftSteps.length) : 0,
      tps: sumModel > 0 ? Math.round((sumOutput / sumModel) * 1000) : 0,
      modelMs: sumModel,
      toolMs: sumTool,
      compactions: compactions.length,
      savedTokens: compactions.reduce((s, c) => s + c.saved, 0),
    },
    // 上下文面板：段次/工具/命令/耗时/时间轴全部由事件日志折叠而来，
    // system/tools/message 三段日志里没有，由 server 用 runtime.contextBreakdown() 回填。
    context: {
      counts: { ...counts, turns: turns.length, steps: allSteps.length, compactions: compactions.length },
      tools: [...toolAgg.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      commands: [...cmdAgg.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 12),
      tokenSplit: {
        system: 0,
        tools: 0,
        message: sumContext,
        output: sumOutput,
        // 思考按字数/4 折算（日志里只有 delta 文本，没有 reasoning token 计量）
        reasoning: Math.round(textChars.reasoning / 4),
        cacheRead: sumCache,
      },
      timeSplit: {
        ttft: sumTtft,
        generation: Math.max(0, sumModel - sumTtft),
        tool: sumTool,
        idle: Math.max(0, turnWall - sumModel - sumTool),
      },
      timeline: allSteps.slice(-80).map(r => ({
        stepId: r.stepId,
        turnId: r.turnId,
        model: r.model,
        context: r.contextTokens,
        output: r.outputTokens,
        tps: r.tps,
      })),
      textChars: { ...textChars },
    },
  }
}
