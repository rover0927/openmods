// plugin-kit: openmods 的插件契约与目录加载器
// 结构仿 dsh 的 Cordis 插件（name/inject/Config/apply），但收敛为一个注册面 ctx。

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolDef {
  name: string
  description: string
  parameters: ToolParameterSchema
  execute(args: any, exec: ToolExecContext): Promise<ToolResult | string | object>
  /**
   * 会改写文件 / 画布 / 进程的写操作。计划模式（只读出方案）下这类工具会被运行时拦截，
   * 模型必须先把方案通过 exit_plan_mode 交给用户批准，再动手。
   */
  mutates?: boolean
  /**
   * 是否需要用户授权（复刻 dsh `approval/request` 的最小面）：
   * - `true`：每次调用都要（会话内可以「总是允许」把该工具加入白名单）
   * - 函数：返回原因字符串表示这次需要授权，返回 null 表示这次不用
   *   （文件工具用它实现「工作目录内自由读写，目录外必须问」）。
   */
  requiresApproval?: boolean | ((args: any, exec: ToolExecContext) => string | null)
  /** 动态可用性：返回 false 时模型看不到这个工具（如 exit_plan_mode 只在计划模式下出现） */
  gate?: (session: SessionRuntimeLike) => boolean
}

export interface ToolResult {
  /** 给模型看的文本 */
  forModel: string
  /** 是否执行出错 */
  isError?: boolean
}

export interface ToolExecContext {
  sessionId: string
  /** 当前会话运行时（压缩感知的 surface、追加日志、SSE 发射） */
  session: SessionRuntimeLike
  /** 画布服务（复刻 dsh workingDirectory：按会话解析资源，服务是唯一读写入口） */
  canvas: CanvasPort
  /** 触发本次执行的工具调用 id（提问/授权事件要能和具体调用对上） */
  callId?: string
  /** 本轮中止信号：阻塞式交互（问用户、授权）必须能随「停止」结束 */
  signal?: AbortSignal
}

/** 一个待答问题（复刻 dsh read_user_questions 的线上结构） */
export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionSpec {
  id: string
  header?: string
  question: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export interface QuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

/**
 * 人机交互端口（server 注入）：工具在这里阻塞等待用户，答案作为普通工具结果回到模型。
 * 与 dsh `ctx.userQuestions` / `ctx.approval` 的位置一致——插件只管问，UI 与传输不在插件里。
 */
export interface InteractionPort {
  ask(sessionId: string, req: {
    questions: QuestionSpec[]
    callId?: string
    signal?: AbortSignal
    /** 方案评审：附完整计划，UI 用评审视图而不是普通问题卡片 */
    plan?: string
  }): Promise<{ answers: QuestionAnswer[]; cancelled?: boolean }>
}

/** 会话待办（todo_write 的整表替换语义） */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 终端摘要（服务端 TerminalManager 的结构子集） */
export interface TerminalInfo {
  id: string
  sessionId: string
  title: string
  command: string
  cwd: string
  status: 'running' | 'exited'
  exitCode: number | null
  signal?: string
  startedAt: number
  endedAt?: number
}

/**
 * 终端端口（server 注入）：拉起/读取/终止某个会话的终端。
 * 所有方法都带 sessionId —— 插件不能碰别的会话的进程（归属校验在服务端做）。
 */
export interface TerminalPort {
  open(opts: { sessionId: string; command: string; cwd: string; title?: string }): TerminalInfo
  openShell(opts: { sessionId: string; cwd: string; title?: string }): TerminalInfo
  list(sessionId: string): TerminalInfo[]
  output(sessionId: string, terminalId: string, tailChars?: number): string | undefined
  write(sessionId: string, terminalId: string, text: string): boolean
  kill(sessionId: string, terminalId: string): boolean
  wait(sessionId: string, terminalId: string, timeoutMs: number): Promise<{ exitCode: number | null; signal?: string; timedOut: boolean }>
}

/**
 * 画布端口：会话树共享的一份 workspace 资源。
 *
 * dsh 里模型改的是 `session.header.cwd` 指向的目录，子代理通过
 * `childSessionMeta()` 继承父会话的 cwd，所有读写都经 `ctx.fs` / `ctx.workingDirectory`。
 * openmods 没有文件系统，画布就是那块 workspace：`canvasId` 写进会话 meta 并由子代理继承，
 * 本服务是唯一读写入口——插件不接触存储、不自己广播，只提交文档。
 */
export interface CanvasPort {
  /** 会话所属画布 id（同一会话树相同；durable，等价 dsh 的 cwd） */
  idOf(sessionId: string): string
  /** 当前文档；从未创建过返回 undefined */
  read(sessionId: string): any
  /** 读或惰性建空文档 */
  ensure(sessionId: string): any
  /** 提交几何/材质/动画变更：编译 + 广播 + 原子落盘由服务统一负责 */
  commit(sessionId: string, doc: any): void
  /** 提交视角变更（视角也是画布文档的一部分） */
  setView(sessionId: string, view: string): void
  /** 每轮拼进系统提示的现场描述（dsh `workingDirectory` 的 contextText） */
  contextText(sessionId: string): string
}

export interface SkillMeta {
  name: string
  description: string
}

export interface SkillProvider {
  id: string
  list(): SkillMeta[]
  /** 按需读取 SKILL.md 全文（渐进披露，不占常驻上下文） */
  load(name: string): Promise<string>
}

/** 压缩等插件在每步模型调用前插入逻辑 */
export interface StepHookContext {
  session: SessionRuntimeLike
  /** 中止本次 turn（如压缩失败不可恢复） */
  abort(reason: string): void
}

export interface OverflowHookContext extends StepHookContext {
  /** provider 报的上下文超限错误 */
  error: Error
}

export interface SurfaceTransform {
  id: string
  /** 在消息发往模型前原地变换 surface 条目（如工具结果裁剪），不改动日志 */
  transform(items: SurfaceItemLike[]): SurfaceItemLike[]
}

export interface SurfaceItemLike {
  kind: 'user' | 'assistant' | 'tool' | 'summary'
  /** 文本内容；assistant 带工具调用时可为空 */
  content: string | null
  toolCalls?: { id: string; name: string; args: string }[]
  toolCallId?: string
  /** 供压缩统计用 */
  _estimateTokens?: number
}

export interface SessionRuntimeLike {
  id: string
  /**
   * 会话绑定的本地工作目录（dsh `session.header.cwd` 的等价物）。
   * 与 `canvasId` 不同：canvasId 是"同一块画布"，cwd 是"磁盘上的哪个工程目录"。
   * 子代理继承父会话的 cwd。缺省时插件回落到自己的默认根。
   */
  cwd?: string
  /** 追加一条事件到 JSONL 日志并广播 */
  appendEvent(t: string, data?: Record<string, any>): void
  /** 压缩感知的 surface 视图（system 除外），工具结果经注册的 transform 变换 */
  getSurfaceMessages(): SurfaceItemLike[]
  /** 工具 schema 列表（发往模型用） */
  getToolDefs(): ToolDef[]
  /** 系统提示词（压缩估算需计入） */
  getSystemPrompt(): string
  /** 当前上下文 token 估算（system + surface + 工具 schema） */
  estimateContextTokens(): number
  /** 当前模型解析出的真实 LLM 模型串 */
  getModelLlmId(): string
  /** 当前模型的上下文窗口 */
  getModelContextWindow(): number
  /** 当前模型 id */
  currentModelId: string
  /** 画布服务（同一会话树共享一份文档） */
  canvas: CanvasPort
  emit(topic: string, data: any): void
  /** 计划模式（dsh plan-mode 的最小面）：只读出方案，写操作由运行时拦截 */
  readonly planMode: boolean
  setPlanMode(active: boolean): void
  /** 当前待办（最后一次 todo_write 的整表；null = 还没写过） */
  readonly todos: TodoItem[] | null
  setTodos(list: TodoItem[] | null): void
  /** 本会话的授权策略：ask=需要授权的工具弹窗；auto=全部放行 */
  readonly approvalPolicy: 'ask' | 'auto'
  /** 该工具是否已被用户「本会话内总是允许」 */
  isToolAllowed(toolName: string): boolean
}

/** 系统提示附加段的上下文：按会话现算（计划模式/待办/工作目录都是会话级状态） */
export interface SystemSectionContext {
  sessionId: string
  session: SessionRuntimeLike
}

export interface PluginContext {
  tools: { register(def: ToolDef): void }
  skills: { registerProvider(p: SkillProvider): void }
  /** 人机交互端口（问用户 / 方案评审）；与 dsh ctx.userQuestions 同位置 */
  interaction: InteractionPort
  /** 终端端口（拉起/读取/终止会话终端） */
  terminals: TerminalPort
  events: {
    on(topic: string, cb: (data: any) => void): void
    emit(topic: string, data: any): void
  }
  hooks: {
    beforeStep(cb: (s: StepHookContext) => Promise<void>): void
    onOverflow(cb: (s: OverflowHookContext) => Promise<boolean>): void
    /** 注册 surface 变换（发往模型前生效，如裁剪） */
    registerSurfaceTransform(t: SurfaceTransform): void
    /** 注册系统提示附加段（如材质表）；每步按当前会话现算 */
    registerSystemSection(cb: (ctx: SystemSectionContext) => string): void
  }
  /** LLM 适配器（压缩插件用来说一次摘要调用） */
  llm: {
    /** modelId 传模型注册表的 id，由运行时解析为真实模型串 */
    complete(opts: {
      messages: { role: string; content: any }[]
      modelId: string
      maxTokens?: number
      signal?: AbortSignal
    }): Promise<{ text: string; usage: { promptTokens: number; outputTokens: number } }>
  }
  env: Record<string, string | undefined>
}

export interface Plugin {
  name: string
  /** 可选 schemastery 风格配置默认值（简化为普通对象） */
  config?: Record<string, any>
  apply(ctx: PluginContext, config: Record<string, any>): void | Promise<void>
}

export interface LoadedPlugin {
  name: string
  dir: string
  plugin: Plugin
  config: Record<string, any>
}

/**
 * 扫描 plugins 目录，每个子目录的 index.ts 是一个插件。
 * 与 dsh 不同：不做 peerDependencies 兼容门禁，加载失败仅记录并跳过。
 */
export async function loadPlugins(pluginsDir: string, pluginCtx: PluginContext, configs?: Record<string, any>): Promise<LoadedPlugin[]> {
  const { readdirSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const path = await import('node:path')
  const loaded: LoadedPlugin[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } catch {
    return loaded
  }
  for (const dir of dirs.sort()) {
    const full = path.join(pluginsDir, dir)
    try {
      const mod: any = await import(pathToFileURL(path.join(full, 'index.ts')).href)
      const plugin: Plugin = mod.default ?? mod
      if (!plugin?.name || typeof plugin.apply !== 'function') {
        console.warn(`[plugins] 跳过 ${dir}: 缺少 name/apply`)
        continue
      }
      const config = { ...(plugin.config ?? {}), ...(configs?.[plugin.name] ?? {}) }
      await plugin.apply(pluginCtx, config)
      loaded.push({ name: plugin.name, dir: full, plugin, config })
      console.log(`[plugins] 已加载: ${plugin.name}`)
    } catch (err: any) {
      console.error(`[plugins] 加载 ${dir} 失败:`, err.message)
    }
  }
  return loaded
}
