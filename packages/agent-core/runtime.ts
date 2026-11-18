// 会话运行时 + Agent 循环：surface 组装、压缩钩子、流式工具调用循环
import { SessionLog } from './session-log.js'
import { buildLlmMessages } from './surface.js'
import { estimateMessages, estimateText, estimateToolDefs } from './token-estimate.js'
import type { LlmAdapter } from './types.js'
import { isContextOverflowError } from './types.js'
import type {
  CanvasPort, SkillProvider, ToolDef, ToolExecContext, ToolResult, SessionRuntimeLike, TodoItem,
} from '@openmods/plugin-kit'

/** 纯文本路由的图片占位文本 —— 逐字移植 dsh `llm/content.ts textOnlyImageText()`。
 *  dsh 对“模型不能收图”的答案是一行确定性说明（不调用第二个模型去描述图片），
 *  图片本身仍完整存在会话里，换一个能收图的模型再看就能看到。 */
function textOnlyImageText(part: any): string {
  const id = String(part?.attachment?.attachmentId ?? part?.image_url?.url ?? '')
  const digest = id.startsWith('sha256:')
    ? id.slice('sha256:'.length, 'sha256:'.length + 8)
    : (id ? id.slice(0, 16) : 'unknown')
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

export interface ModelInfo {
  displayName: string
  badge?: string
  badgeType?: 'price' | 'peak'
  desc: string
  llmModel: string
  /** 供应商路由（设置系统合成模型时填写，llm 适配器据此现解析 baseURL/key） */
  providerRoute?: string
  disabled?: boolean
  disabledReason?: string
  contextWindow?: number
  /** 支持视觉（图片）输入 */
  vision?: boolean
  /** 复刻 dsh llm-deepseek: `inputModalities` 是能力事实源，vision 只是它的派生视图 */
  inputModalities?: string[]
  /** 单请求输出上限（dsh `defaultMaxTokens`；压缩用它算预算） */
  maxOutputTokens?: number
}

/** 代理角色档案：同一会话内不同"角色"的工具白名单与提示差异（复刻 dsh agentPreset 语义的简化版） */
export interface AgentProfile {
  id: string
  name: string
  /** 一句话职责介绍（前端角色下拉悬停时展示） */
  description?: string
  /** 模型可见的身份/职责声明 */
  prompt: string
  /** 工具白名单（模型只看到这些工具）；缺省 = 全部 */
  toolFilter?: string[]
  /** 工具排除名单（优先于白名单） */
  toolExclude?: string[]
  /** 技能白名单（系统提示只列这些、load_skill 只放行这些）；缺省 = 全部 */
  skills?: string[]
}

/**
 * 回合输入的归属（复刻 dsh `MessageSource` 的 `subagent-settled` 形态）。
 * 自动汇总回合的 user 消息不是用户手打的：它由 runtime 在子代理结算后投递，
 * UI 按 `form:'notice'` 渲染成系统行，模型侧仍是一条普通 user 消息。
 */
export interface TurnSource {
  kind: 'subagent-settled'
  form: 'notice'
  /** 本批结算的子代理（一条消息可合并多个，对应 dsh 一条 settlement message） */
  settled: {
    childId: string
    name: string
    description?: string
    status: string
    stopReason: string
    summary: string
  }[]
}

/** 授权请求的结果（复刻 dsh ApprovalOutcome 的最小面） */
export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  /** 用户勾了「本会话内总是允许这个工具」 */
  remember?: boolean
  cancelled?: boolean
}

/** 运行时需要的授权通道：server 按会话注入（策略、白名单、弹窗都归它管） */
export interface ApprovalPort {
  policy(): 'ask' | 'auto'
  /** 该工具是否已在会话白名单（「总是允许」记住的） */
  allowed(toolName: string): boolean
  request(req: { toolName: string; callId: string; reason: string; signal?: AbortSignal }): Promise<ApprovalDecision>
  remember(toolName: string): void
}

export interface RuntimeDeps {
  sessionId: string
  log: SessionLog
  llm: LlmAdapter
  env: Record<string, string | undefined>
  /** 模型解析：id（可含 provider 路由前缀）→ 真实模型信息；由 server 注入（动态设置感知） */
  resolveModel: (modelId: string) => ModelInfo | undefined
  /** 图片引用 → data URL（server 注入；请求投影期才取字节，日志里只有引用） */
  resolveImage?: (ref: any) => string | undefined
  defaultModelId: string
  /**
   * 画布服务（复刻 dsh workingDirectory 的注入方式）：
   * 运行时只按 sessionId 读写，画布归属、落盘、广播全在服务里，
   * 同一会话树的 lead 与子代理因此天然共享一份文档。
   */
  canvas: CanvasPort
  /** 会话绑定的本地工作目录（dsh session.header.cwd）；插件通过 exec.session.cwd 读取 */
  cwd?: string
  /** 计划模式状态（server 注入；durable，写进 meta 与日志） */
  planMode?: () => boolean
  setPlanMode?: (active: boolean) => void
  /** 会话待办（todo_write 的整表投影） */
  todos?: () => TodoItem[] | null
  setTodos?: (list: TodoItem[] | null) => void
  /** 授权通道（write/edit/bash 等工具按需弹窗） */
  approval?: ApprovalPort
  /** SSE 事件出口（server 注入） */
  emit: (topic: string, data: any) => void
}

interface Registries {
  tools: ToolDef[]
  skillProviders: SkillProvider[]
  systemSections: ((ctx: { sessionId: string; session: SessionRuntimeLike }) => string)[]
  profiles: Record<string, AgentProfile>
  beforeStepHooks: ((s: any) => Promise<void>)[]
  overflowHooks: ((s: any) => Promise<boolean>)[]
}

export interface SessionRuntime extends SessionRuntimeLike {
  deps: RuntimeDeps
  setCurrentModel(id: string): void
  /** 切换会话工作目录（用户在左栏改绑定时调用；下一轮/下一件工具立刻生效） */
  setCwd(dir: string): void
  /** 上下文三段构成（系统提示词 / 工具定义 / 对话）；totalTokens 缺省时现算 */
  contextBreakdown(totalTokens?: number): { systemTokens: number; toolsTokens: number; messageTokens: number }
  runTurn(opts: { text: string; attachments?: any[]; modelId?: string; mode?: 'build' | 'refine'; profile?: string; source?: TurnSource }, signal: AbortSignal): Promise<{ text: string; aborted: boolean }>
}

/**
 * 单轮步数硬上限：默认 40。原来的 12 对 MC 模组开发（多文件读写 + 多轮构建修错）太紧，
 * 会在工程做一半时静默结束本轮，用户只看到「对话断了」。可用 OPENMODS_MAX_STEPS 覆盖。
 */
const MAX_STEPS = (() => {
  const n = Number(process.env.OPENMODS_MAX_STEPS)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 200) : 40
})()

function safeJsonParse(s: string): any {
  try { return JSON.parse(s) } catch { return {} }
}

export function createSessionRuntime(deps: RuntimeDeps, registries: Registries): SessionRuntime {
  let currentModelId = deps.defaultModelId
  // 会话工作目录：deps 上是初始值，改绑定走 setCwd（同时写回 deps，使 fork 出的子代理继承新值）
  let cwd = deps.cwd
  // 系统提示按当前角色组装（上下文估算与真实请求必须同源，否则面板会低估 profile 提示词）
  let lastProfileId: string | undefined

  const rt: SessionRuntime = {
    id: deps.sessionId,
    deps,
    canvas: deps.canvas,
    get currentModelId() { return currentModelId },
    get cwd() { return cwd },
    setCwd(dir: string) {
      if (!dir) return
      cwd = dir
      deps.cwd = dir
    },
    setCurrentModel(id: string) { if (id) currentModelId = id },
    appendEvent(t: string, data: Record<string, any> = {}) { return deps.log.append(t, data) as any },
    getToolDefs: () => registries.tools,
    getSurfaceMessages: () => deps.log.buildSurface() as any,
    getSystemPrompt: () => buildSystemPrompt(registries, deps, undefined, lastProfileId),
    // 计划模式 / 待办 / 授权策略都是会话级协作状态：运行时只读，写入归 server（durable）
    get planMode() { return deps.planMode?.() ?? false },
    setPlanMode(active: boolean) { deps.setPlanMode?.(!!active) },
    get todos() { return deps.todos?.() ?? null },
    setTodos(list: TodoItem[] | null) { deps.setTodos?.(list ?? null) },
    get approvalPolicy() { return deps.approval?.policy() ?? 'ask' },
    isToolAllowed(toolName: string) { return deps.approval?.allowed(toolName) ?? false },
    // 上下文构成（dsh token-meter `contextBreakdown` 的等价物）：系统提示词与工具定义按
    // chars/4 启发式单算，"对话"取**总量减去这两段**——总量用 estimateContextTokens
    // （provider 锚定），于是三段之和恒等于环上的分子，面板与环不会自相矛盾。
    // 图片只按引用计（不给 resolveImage：base64 字节不是上下文里的常驻文本）。
    contextBreakdown: (totalTokens?: number) => {
      const systemTokens = estimateText(buildSystemPrompt(registries, deps, undefined, lastProfileId, rt))
      const toolsTokens = estimateToolDefs(toOpenAiTools(registries.tools))
      const total = totalTokens ?? rt.estimateContextTokens()
      return { systemTokens, toolsTokens, messageTokens: Math.max(0, total - systemTokens - toolsTokens) }
    },
    estimateContextTokens: () => {
      const surface = deps.log.buildSurface().filter(i => !i.shadowed)
      // 不传 resolveImage：图片在上下文里只是引用（dsh estimateStructuralBlock 同款），
      // 请求期才换字节；否则一张图就会把"上下文占用"算成几十万 token。
      const messages = buildLlmMessages(buildSystemPrompt(registries, deps, undefined, lastProfileId, rt), surface as any)
      const heuristic = estimateMessages(messages) + estimateToolDefs(toOpenAiTools(registries.tools))
      // 上下文占用优先取"模型自己报的数"（复刻 dsh token-meter 的 anchor 语义）：
      // 最近一次 llm/usage 的 promptTokens = 那次请求的真实 prompt 大小，只把它之后新增的
      // surface 用启发式补上；一旦发生过压缩（surface 被影子化），锚点失效回落到全量估算。
      let anchor: { seq: number; promptTokens: number } | undefined
      for (const ev of deps.log.all()) {
        if (ev.t === 'llm/usage' && Number(ev.promptTokens) > 0) {
          anchor = { seq: ev.seq, promptTokens: Number(ev.promptTokens) }
        } else if (ev.t === 'compaction/summary') {
          anchor = undefined // 影子化后 provider 报的 prompt 已不代表当前 surface
        }
      }
      if (!anchor) return heuristic
      const tail = surface.filter(i => i.seq > anchor!.seq)
      if (!tail.length) return anchor.promptTokens
      const tailTokens = estimateMessages(buildLlmMessages('', tail as any))
      return anchor.promptTokens + Math.max(0, tailTokens - 2 /* 空 system 占位 */)
    },
    getModelLlmId: () => {
      // 可能是 "providerRoute/llmModel" 复合串（server 端 per-request 解析 provider）
      const m = deps.resolveModel(currentModelId)
      if (!m) throw new Error(`模型 "${currentModelId}" 不在模型目录中（设置 → 模型 已变更？请重新选择模型）`)
      return m.providerRoute ? `${m.providerRoute}/${m.llmModel}` : m.llmModel
    },
    getModelContextWindow: () => {
      const m = deps.resolveModel(currentModelId)
      const fromEnv = Number(deps.env.COMPACTION_CONTEXT_WINDOW)
      // 复刻 dsh：模型目录声明的窗口优先，其次 env 覆盖，最后 1M 兜底（DEFAULT_CONTEXT_WINDOW）
      return m?.contextWindow ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1_000_000)
    },
    emit(topic: string, data: any) { deps.emit(topic, data) },

    async runTurn(opts, signal) {
      currentModelId = opts.modelId ?? currentModelId
      // 默认走 lead 主代理（对话/委派）；显式 profile 或未知 profile 回落规则见下
      const requested = opts.profile ?? 'lead'
      const profileId = registries.profiles[requested] ? requested : (registries.profiles['lead'] ? 'lead' : undefined)
      lastProfileId = profileId
      const turn = deps.log.append('turn/start', { modelId: currentModelId, mode: opts.mode ?? 'build', profile: profileId })
      const turnId = `t${turn.seq}`

      // —— 图片输入链路（复刻 dsh LlmRuntime + llm/content.ts）：能收图就直接发给模型 ——
      // dsh 没有“转述模型”这一层：路由声明 image 就把图像块原样发给上游；
      // 声明为纯文本则投影成一行确定性占位文本（projectImagesForTextModel），不猜图里的内容。
      let userFinalText = opts.text
      let imagesOmitted = false
      const imgCount = opts.attachments?.length ?? 0
      if (imgCount > 0) {
        const modelInfo = deps.resolveModel(currentModelId)
        // 能力事实源优先 inputModalities（dsh llm-deepseek 语义），vision 是兼容旧设置的派生字段
        const supportsImage = modelInfo?.inputModalities
          ? modelInfo.inputModalities.includes('image')
          : !!modelInfo?.vision
        if (!supportsImage) {
          imagesOmitted = true
          const placeholders = (opts.attachments ?? []).map((p: any) => textOnlyImageText(p))
          userFinalText = `${opts.text}\n\n${placeholders.join('\n')}`
        }
      }

      // 归属随事件落盘：dsh 把 source 钉在消息上，UI 才能把"runtime 投递的结算"
      // 和"用户手打的消息"区分开（模型侧两者都是 user 消息，不需要额外标记）
      const messageSource = opts.source ? { source: opts.source } : {}
      deps.log.append('user/message', {
        turnId, text: userFinalText, attachments: opts.attachments, imagesOmitted, ...messageSource,
      })
      rt.emit('turn/start', { turnId, modelId: currentModelId, profile: profileId, ...messageSource })
      rt.emit('user/message', {
        turnId, text: userFinalText, attachments: opts.attachments ?? [], imagesOmitted, profile: profileId, ...messageSource,
      })

      let finalText = ''
      let overflowRetried = false
      let aborted = false
      // 跑满 MAX_STEPS 且没有自然收尾（无工具调用）＝步数上限截断，要在对话里明确告诉用户
      let hitStepLimit = false
      let stepNo = 0

      try {
        for (stepNo = 1; stepNo <= MAX_STEPS; stepNo++) {
          if (signal.aborted) { aborted = true; break }
          const stepId = `${turnId}s${stepNo}`

          // 每步前：压缩钩子（省 token 机制挂载点）
          for (const hook of registries.beforeStepHooks) {
            await hook({ session: rt, abort: (reason: string) => { throw new Error(`hook-abort: ${reason}`) } })
          }

          deps.log.append('step/start', { turnId, stepId })
          rt.emit('step/start', { turnId, stepId })

          const turnTools = selectTools(registries.tools, profileId, registries.profiles, rt)
          const messages = buildLlmMessages(buildSystemPrompt(registries, deps, opts.mode, profileId, rt), rt.getSurfaceMessages() as any, deps.resolveImage)
          let res
          try {
            res = await deps.llm.chat({
              messages,
              tools: toOpenAiTools(turnTools),
              model: rt.getModelLlmId(),
              signal,
              onTextDelta: (delta: string) => rt.emit('assistant/delta', { turnId, stepId, delta }),
              // 思考过程单独一条流：前端边收边显示（纯思考的步骤原先在界面上是"已想 0 字"）
              onReasoningDelta: (delta: string) => rt.emit('assistant/reasoning', { turnId, stepId, delta }),
            })
          } catch (err: any) {
            if (signal.aborted) { aborted = true; break }
            if (isContextOverflowError(err) && !overflowRetried) {
              // 上下文超限：绕过阈值做一次最大化收缩再重试（dsh overflowRetries 语义）
              overflowRetried = true
              rt.emit('compaction/overflow', { turnId, stepId })
              let handled = false
              for (const hook of registries.overflowHooks) {
                handled = (await hook({ session: rt, error: err, abort: (r: string) => { throw new Error(r) } })) || handled
              }
              deps.log.append('step/end', { turnId, stepId, error: 'overflow-retry' })
              if (handled) { stepNo--; continue }
              throw err
            }
            throw err
          }

          // 流式调用期间被用户停止：不落 usage/assistant，直接把本轮标记为中止
          if (signal.aborted) { aborted = true; break }

          deps.log.append('llm/usage', { turnId, stepId, model: rt.getModelLlmId(), ...res.usage })
          rt.emit('llm/usage', { turnId, stepId, ...res.usage, contextTokens: rt.estimateContextTokens() })

          // 思考过程落日志（回放时能复现），单步上限 64k 字符防止异常长的推理把 JSONL 撑爆；
          // 注意它只用于展示，buildSurface 不会把它拼进下一轮上下文。
          deps.log.append('assistant/message', {
            turnId, stepId, text: res.text, toolCalls: res.toolCalls,
            ...(res.reasoning ? { reasoning: res.reasoning.slice(0, 64_000) } : {}),
          })

          if (res.toolCalls.length) {
            for (const call of res.toolCalls) {
              deps.log.append('tool/call', { turnId, stepId, callId: call.id, name: call.name, args: call.args })
              rt.emit('tool/call', { turnId, stepId, callId: call.id, name: call.name, args: safeJsonParse(call.args) })
              const def = registries.tools.find(d => d.name === call.name)
              let result: ToolResult
              if (!def) result = { forModel: `未知工具: ${call.name}`, isError: true }
              else {
                const exec: ToolExecContext = {
                  sessionId: rt.id, session: rt, canvas: deps.canvas, callId: call.id, signal,
                }
                const args = safeJsonParse(call.args)
                // 计划模式：只读出方案。写操作一律拦在运行时，插件不需要各自实现；
                // 工具可用 planSafe 放行无副作用的只读用法（如 bash 里的 grep/cat）。
                if (def.mutates && rt.planMode && !def.planSafe?.(args, exec)) {
                  result = {
                    forModel: `计划模式中：${def.name} 会修改内容，已被拦截。继续调研，把步骤写进 todo_write；方案完整后用 exit_plan_mode 提交给用户批准（批准后本模式自动关闭）。`,
                    isError: true,
                  }
                } else {
                  const denial = await guardApproval(def, args, exec, deps)
                  if (denial) result = { forModel: denial, isError: true }
                  else {
                    try {
                      const r = await def.execute(args, exec)
                      result = typeof r === 'string' ? { forModel: r }
                        : (r && typeof r === 'object' && 'forModel' in (r as any)) ? r as ToolResult
                        : { forModel: JSON.stringify(r) }
                    } catch (e: any) {
                      result = { forModel: `工具执行出错: ${e.message}`, isError: true }
                    }
                  }
                }
              }
              deps.log.append('tool/result', {
                turnId, stepId, callId: call.id, name: call.name,
                forModel: result.forModel.slice(0, 100_000), isError: result.isError,
              })
              rt.emit('tool/result', {
                turnId, stepId, callId: call.id, name: call.name,
                forModelPreview: result.forModel.slice(0, 200), isError: result.isError,
              })
              if (signal.aborted) { aborted = true; break }
            }
            deps.log.append('step/end', { turnId, stepId })
            rt.emit('step/end', { turnId, stepId })
            if (aborted) break
            continue
          }

          // 无工具调用 → 本轮结束
          finalText = res.text
          deps.log.append('step/end', { turnId, stepId })
          rt.emit('step/end', { turnId, stepId })
          break
        }
        // for 循环走完（stepNo 超出上限）且不是用户中止 → 判定为步数上限截断
        if (stepNo > MAX_STEPS && !aborted) hitStepLimit = true
      } finally {
        if (hitStepLimit && !finalText) {
          finalText = `已达到单轮 ${MAX_STEPS} 步上限，任务还没做完。回复「继续」我接着做。`
        }
        const reason = hitStepLimit ? 'step-limit' : aborted ? 'aborted' : 'natural'
        deps.log.append('turn/end', { turnId, text: finalText, aborted, reason })
        rt.emit('turn/end', { turnId, text: finalText, aborted, reason })
      }
      return { text: finalText, aborted }
    },
  }
  return rt
}

function toOpenAiTools(defs: ToolDef[]) {
  return defs.map(d => ({
    type: 'function' as const,
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }))
}

function filterToolsForProfile(tools: ToolDef[], profileId: string | undefined, profiles: Record<string, AgentProfile>): ToolDef[] {
  const profile = profileId ? profiles[profileId] : undefined
  let scoped = tools
  if (profile?.toolFilter) scoped = scoped.filter(t => profile.toolFilter!.includes(t.name))
  if (profile?.toolExclude) scoped = scoped.filter(t => !profile.toolExclude!.includes(t.name))
  return scoped
}

/** 角色白名单 + 动态 gate（exit_plan_mode 只在计划模式下出现） */
function selectTools(
  tools: ToolDef[],
  profileId: string | undefined,
  profiles: Record<string, AgentProfile>,
  session: Pick<SessionRuntimeLike, 'planMode'>,
): ToolDef[] {
  const scoped = filterToolsForProfile(tools, profileId, profiles)
  return scoped.filter(t => !t.gate || t.gate(session as SessionRuntimeLike))
}

/**
 * 授权门（复刻 dsh approval/request 的位置：工具执行前，运行时统一判定）：
 * 返回 null = 放行；返回字符串 = 拒绝原因（作为工具结果回给模型）。
 */
async function guardApproval(
  def: ToolDef,
  args: any,
  exec: ToolExecContext,
  deps: RuntimeDeps,
): Promise<string | null> {
  const spec = def.requiresApproval
  if (!spec) return null
  const reason = typeof spec === 'function' ? spec(args, exec) : `${def.name} 需要你的许可才能执行`
  if (!reason) return null
  const port = deps.approval
  if (!port) {
    return `「${def.name}」需要用户授权，但当前会话没有可用的授权通道，操作未执行。请告知用户改用其他方式。`
  }
  if (port.policy() === 'auto') return null
  if (port.allowed(def.name)) return null
  deps.log.append('approval/asked', { callId: exec.callId, toolName: def.name, reason })
  const res = await port.request({ toolName: def.name, callId: exec.callId ?? '', reason, signal: exec.signal })
  deps.log.append('approval/decided', {
    callId: exec.callId, toolName: def.name, outcome: res.cancelled ? 'cancelled' : res.decision,
  })
  if (res.cancelled) return `用户中止了「${def.name}」的授权请求，操作未执行。`
  if (res.decision !== 'allow') {
    return `用户拒绝对「${def.name}」的授权，操作未执行。不要原样重试；先弄清原因，或改用不需要授权的方式，必要时用 ask_user_question 问用户。`
  }
  if (res.remember) port.remember(def.name)
  return null
}

export function buildSystemPrompt(
  registries: Registries,
  deps: RuntimeDeps,
  mode?: 'build' | 'refine',
  profileId?: string,
  session?: SessionRuntimeLike,
): string {
  const profile = profileId ? registries.profiles[profileId] : undefined
  const turnTools = selectTools(registries.tools, profileId, registries.profiles, session ?? { planMode: deps.planMode?.() ?? false })
  const skillList = registries.skillProviders.flatMap(p => p.list())
    .filter(s => !profile?.skills || profile.skills.includes(s.name))
  const lines: string[] = []
  if (profile) {
    lines.push(`[代理角色：${profile.name}] ${profile.prompt}`)
    lines.push('')
  } else {
    lines.push('你是 openmods 的 AI 建模师，工作在网页版 Blockbench 只读画布旁。用户用一句话描述模型，你调用工具把它一步步在画布上做出来。')
    lines.push('')
  }
  // 会话现场：由画布服务提供（dsh 对应 workingDirectory 的 contextText 贡献）
  const sessionContext = deps.canvas.contextText(deps.sessionId)
  if (sessionContext) {
    lines.push(`[当前会话] ${sessionContext}`)
    lines.push('')
  }
  // 工作目录：文件/命令工具的解析根（dsh session.header.cwd 的提示面）
  if (deps.cwd) {
    lines.push(`[工作目录] ${deps.cwd}`)
    lines.push('相对路径以它为根；目录外的读写与命令会先请求用户授权。改文件前先 read 看清现状，不要凭记忆改。')
    lines.push('')
  }
  // 授权策略：让模型知道"会不会被拦"，避免它把拒绝当成工具故障反复重试
  if (deps.approval) {
    if (deps.approval.policy() === 'auto') {
      lines.push('[授权] 本会话已开启自动放行：写文件、执行命令、开关终端不再询问用户。')
    } else {
      lines.push('[授权] 写工作目录外的文件、执行命令、拉起/结束终端会先请求用户授权；用户拒绝时不要原样重试。')
    }
    lines.push('')
  }
  // 计划模式：只读出方案（写操作已被运行时拦截，这里负责行为指导）
  if (deps.planMode?.()) {
    lines.push('# 计划模式（只读）')
    lines.push('现在处于计划模式：不要修改文件、画布或运行改变状态的命令。先调研（read/grep/list_dir 等），用 todo_write 记录步骤，')
    lines.push('然后把完整方案交给 exit_plan_mode 请用户评审。用户批准后本模式自动关闭，再按方案执行；用户要求继续完善时，按反馈修改并再次提交。')
    lines.push('')
  }
  const todos = deps.todos?.()
  if (todos?.length) {
    lines.push('# 当前待办')
    for (const t of todos) lines.push(`- [${t.status === 'in_progress' ? '进行中' : t.status === 'completed' ? '已完成' : '待办'}] ${t.content}`)
    lines.push('')
  }
  lines.push('# 工具')
  for (const t of turnTools) lines.push(`- ${t.name}: ${t.description.split('\n')[0]}`)
  if (turnTools.some(t => t.name === 'ask_user_question')) {
    lines.push('- 缺少关键信息、需要在方案之间做选择时，用 ask_user_question 一次问全（带选项）；不要靠猜。')
  }
  lines.push('')
  if (skillList.length) {
    lines.push('# 可插拔技能（按需加载，不加载不要假装读过）')
    for (const s of skillList) lines.push(`- ${s.name}: ${s.description.split('\n')[0]}`)
    lines.push('- 用 load_skill 工具加载全文；一次只加载当前需要的。')
    lines.push('')
  }
  if (!profile) {
    lines.push('# 建模流程')
    lines.push('1. 首次建模先 load_skill 加载 blockbench-modeling 获取规范。')
    lines.push('2. create_model 创建项目（free 通用模型格式）。')
    lines.push('3. 分批 place_cubes 搭几何体：先大轮廓后细节；部件名用材质前缀（如 hair_/dress_red_/shoe_/crystal_）。')
    lines.push('4. 修改用 modify_cube / delete_elements；不确定结构时 list_outline 核对。')
    lines.push('5. 完成后向用户简短总结（部件数、材质分组、下一步建议）。')
  }
  // 附加段按会话现算（计划模式/待办/材质表都可能是会话级状态）
  const sectionSession = session ?? ({ planMode: deps.planMode?.() ?? false } as SessionRuntimeLike)
  for (const section of registries.systemSections) {
    const s = section({ sessionId: deps.sessionId, session: sectionSession })
    if (s) { lines.push(''); lines.push(s) }
  }
  lines.push('')
  lines.push('# 回复风格')
  lines.push('中文；简短；不承诺画布之外的功能。每轮工具调用间不要向用户长篇汇报，收尾一次说清。')
  if (mode === 'refine') {
    lines.push('')
    lines.push('[完善想法模式] 当前用户点的是"AI 帮我完善想法"：不要调用任何工具，只输出打磨后的建模描述（外形/配色/细节/尺寸/动画），并在结尾给出一句可以直接建模的描述。')
  }
  return lines.join('\n')
}
