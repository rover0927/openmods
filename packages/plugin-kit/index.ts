// plugin-kit: openmods 的插件契约与目录加载器
// 结构仿 dsh 的 Cordis 插件（name/inject/Config/apply），但收敛为一个注册面 ctx。

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

/**
 * 通用工作台工具名（fs-tools / shell-tools / interaction-tools 注册）。
 * 角色白名单直接引用这里：功能插件（mcdev / bb-tools）注册角色时也用它，
 * 避免各处手抄一份工具名清单后跟实际注册脱节。
 */
export const WORKSPACE_TOOL_NAMES = [
  'read', 'write', 'edit', 'list_dir', 'glob', 'grep',
  'bash', 'terminal_open', 'terminal_list', 'terminal_read', 'terminal_send', 'terminal_kill',
  'ask_user_question', 'todo_write', 'exit_plan_mode',
]

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
   * 计划模式下也允许执行的只读调用：mutates=true 的工具可以在这里放行无副作用的用法
   * （例如 bash 里的 grep/cat）。返回 false 或未提供时仍按写操作拦截。
   */
  planSafe?: (args: any, exec: ToolExecContext) => boolean
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
  /** ephemeral=true：前台一次性命令，进程退出后自动从终端列表移除（输出缓冲短期保留） */
  open(opts: { sessionId: string; command: string; cwd: string; title?: string; ephemeral?: boolean }): TerminalInfo
  openShell(opts: { sessionId: string; cwd: string; title?: string }): TerminalInfo
  list(sessionId: string): TerminalInfo[]
  output(sessionId: string, terminalId: string, tailChars?: number): string | undefined
  write(sessionId: string, terminalId: string, text: string): boolean
  kill(sessionId: string, terminalId: string): boolean
  wait(sessionId: string, terminalId: string, timeoutMs: number): Promise<{ exitCode: number | null; signal?: string; timedOut: boolean }>
}

/**
 * 画布端口：每个会话拥有自己的画布集合，其中一块是**活跃画布**。
 *
 * dsh 里模型改的是 `session.header.cwd` 指向的目录，子代理通过
 * `childSessionMeta()` 继承父会话的 cwd，所有读写都经 `ctx.fs` / `ctx.workingDirectory`。
 * openmods 没有文件系统，画布就是那块 workspace：每个会话的 `canvasId`（活跃画布）
 * 与 `canvasIds`（画布集合）写进会话 meta，建模子代理用自己的 id 作为独立画布。
 * 本服务是唯一读写入口——插件不接触存储、不自己广播，只提交文档。
 */
export interface CanvasRef {
  canvasId: string
  /** 工程名（画布文档的 name） */
  name: string
  /** 归属会话：根会话或某个子代理 */
  ownerSessionId: string
  /** 归属展示名：根会话为「主会话」，子代理为 agentName */
  ownerName: string
  elements: number
  textures: number
  hasModel: boolean
  /** 是否为该归属会话的活跃画布 */
  active: boolean
}

export interface CanvasPort {
  /** 会话的活跃画布 id（durable，等价 dsh 的 cwd） */
  idOf(sessionId: string): string
  /** 会话拥有的画布集合（活跃画布永远第一项；老会话按单一画布计算） */
  listOf(sessionId: string): string[]
  /** 当前活跃画布的文档；从未创建过返回 undefined */
  read(sessionId: string): any
  /** 按 canvasId 直接读文档（跨会话迁移工具用） */
  readCanvas(canvasId: string): any
  /** 读或惰性建空文档 */
  ensure(sessionId: string): any
  /** 提交几何/材质/动画变更：编译 + 广播 + 原子落盘由服务统一负责 */
  commit(sessionId: string, doc: any): void
  /** 按 canvasId 直接提交（跨会话迁移工具写目标画布用） */
  commitCanvas(canvasId: string, doc: any, originSessionId: string): void
  /** 新建一块空白画布并登记到该会话；返回新 canvasId */
  createCanvas(sessionId: string, opts?: { name?: string; activate?: boolean }): string
  /** 切换活跃画布（只能切到该会话拥有的画布） */
  activateCanvas(sessionId: string, canvasId: string): void
  /** 提交视角变更（视角也是画布文档的一部分） */
  setView(sessionId: string, view: string): void
  /** 每轮拼进系统提示的现场描述（dsh `workingDirectory` 的 contextText） */
  contextText(sessionId: string): string
  /** 会话树（根 + 直属子代理）的画布列表，按 canvasId 去重（根优先） */
  listTree(rootSessionId: string): CanvasRef[]
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
  /** 技能目录（system prompt / load_skill 用来告诉模型 references 在哪）；非目录型技能可不实现 */
  dirOf?(name: string): string | null
  /** 读取技能目录内的附加文件（如 references/xxx.md），实现方必须做路径越界校验 */
  read?(name: string, file: string): Promise<string>
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

// ---- HTTP 路由端口 ----
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 插件路由的请求视图（只读字段；插件不依赖具体 HTTP 框架） */
export interface HttpRequestLike {
  params: Record<string, string>
  query: Record<string, any>
  body: any
}

/** 插件路由的响应视图（最小面：状态码、响应头、发送） */
export interface HttpReplyLike {
  code(status: number): HttpReplyLike
  header(name: string, value: string): HttpReplyLike
  send(payload?: any): HttpReplyLike
}

export interface HttpRouteOptions {
  /** 请求体上限（字节）；缺省沿用宿主全局上限 */
  bodyLimit?: number
}

/**
 * 路由端口：功能相关的 HTTP 接口由插件在自己的 apply 里挂载。
 * 插件被 `requires` 跳过时路由根本不会注册——功能开关不再需要靠 URL 前缀拦截。
 */
export interface HttpPort {
  route(
    method: HttpMethod,
    path: string,
    handler: (req: HttpRequestLike, reply: HttpReplyLike) => any,
    opts?: HttpRouteOptions,
  ): void
}

/** 会话只读端口：插件按 sessionId 解析工作目录，不接触会话存储实现 */
export interface SessionPort {
  exists(id: string): boolean
  /** 会话绑定的工作目录（realpath 后的绝对路径）；会话不存在或目录无效返回 null */
  cwdOf(id: string): string | null
}

/** 偏好只读端口（设置 → 通用）；写偏好仍走宿主接口 */
export interface PrefsPort {
  get(): Record<string, any>
}

export interface PluginContext {
  tools: { register(def: ToolDef): void }
  skills: { registerProvider(p: SkillProvider): void }
  /** 角色注册面：功能插件在这里注册自己的代理角色（mcmod / modeling …） */
  profiles: { register(p: ProfileDecl): void }
  /** 功能面：声明开关、查询某个开关在本次启动是否开启 */
  features: { declare(f: FeatureDecl): void; enabled(id: string): boolean }
  /** 路由面：插件自己的 HTTP 接口（插件未 apply 时不存在） */
  http: HttpPort
  /** 会话只读面：按 sessionId 取工作目录 */
  sessions: SessionPort
  /** 偏好只读面（mod-output 等运行配置） */
  prefs: PrefsPort
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

/**
 * 功能声明：插件可以自带开关（canvas / mc / …），由服务端汇总后暴露给前端。
 * `requires` 不满足（开关被关掉）时插件的 `apply` 根本不会执行——
 * 对应工具、系统提示、角色一起消失，而不是"加载了但藏起来"。
 */
export interface FeatureDecl {
  id: string
  name: string
  description?: string
  /** 缺省是否开启（不填 = 开启） */
  default?: boolean
}

/**
 * 角色声明：代理角色的提示词、工具白名单与技能都归插件自己。
 * server 只保留 lead / coding 这类与具体功能无关的内置角色。
 */
export interface ProfileDecl {
  id: string
  name: string
  /** 一句话职责介绍（前端角色下拉悬停时展示） */
  description?: string
  prompt: string
  toolFilter?: string[]
  toolExclude?: string[]
  skills?: string[]
  /** 依赖的功能 id（任一被关闭则不注册该角色） */
  requires?: string[]
  /** 内部角色：不出现在前端的角色选择里（子代理专用） */
  internal?: boolean
}

export interface Plugin {
  name: string
  /** 可选 schemastery 风格配置默认值（简化为普通对象） */
  config?: Record<string, any>
  /** 本插件声明的功能开关 */
  features?: FeatureDecl[]
  /** 依赖的功能（任一处于关闭态就不加载本插件） */
  requires?: string[]
  /** 本插件提供的技能名（插件被跳过时这些技能也会从列表/提示里隐藏） */
  skills?: string[]
  apply(ctx: PluginContext, config: Record<string, any>): void | Promise<void>
}

export interface LoadedPlugin {
  name: string
  dir: string
  plugin: Plugin
  config: Record<string, any>
}

export interface PluginLoadOptions {
  /** 启动态功能开关：插件 requires 里任一为 false 就不 apply */
  featureStates?: Record<string, boolean>
}

export interface SkippedPlugin {
  name: string
  dir: string
  /** 命中的关闭项（requires 的子集） */
  requires: string[]
  /** 插件声明的技能：被跳过时这些技能也要从列表/提示里隐藏 */
  skills: string[]
  reason: string
}

/**
 * 插件加载失败（import 抛错 / 缺 name·apply / apply 抛错）。
 * 以前只打 console：前端只能看到"少了个插件"，不知道是加载失败还是被开关跳过。
 */
export interface PluginFailure {
  /** import 失败时拿不到插件名，用目录名代替 */
  name: string
  dir: string
  phase: 'import' | 'apply'
  error: string
}

/** 发现阶段的产物：只有元数据，尚未 apply */
export interface PluginDiscovery {
  plugins: { dir: string; full: string; plugin: Plugin }[]
  /** 所有插件声明过的功能（含之后会被跳过的） */
  features: FeatureDecl[]
  failed: PluginFailure[]
}

export interface PluginLoadResult {
  loaded: LoadedPlugin[]
  skipped: SkippedPlugin[]
  /** 所有插件声明过的功能（含被跳过的，前端设置页要能开关回来） */
  features: FeatureDecl[]
  /** 加载失败（import/apply 抛错），前端设置页要能直接看到 */
  failed: PluginFailure[]
}

/**
 * 第一段：扫描 plugins 目录、import 全部插件并收集 features/requires。
 *
 * 单独暴露的原因：功能声明必须先于「功能开关解析」——插件自带的开关 id
 * 只有进了启动态，`requires` 才可能被关掉；否则插件声明的开关只是界面上一个无效开关。
 */
export async function discoverPlugins(pluginsDir: string): Promise<PluginDiscovery> {
  const { readdirSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const path = await import('node:path')
  const plugins: PluginDiscovery['plugins'] = []
  const features: FeatureDecl[] = []
  const failed: PluginFailure[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } catch {
    return { plugins, features, failed }
  }

  for (const dir of dirs.sort()) {
    const full = path.join(pluginsDir, dir)
    try {
      const mod: any = await import(pathToFileURL(path.join(full, 'index.ts')).href)
      const plugin: Plugin = mod.default ?? mod
      if (!plugin?.name || typeof plugin.apply !== 'function') {
        console.warn(`[plugins] 跳过 ${dir}: 缺少 name/apply`)
        failed.push({ name: dir, dir: full, phase: 'import', error: '缺少 name/apply' })
        continue
      }
      plugins.push({ dir, full, plugin })
      for (const f of plugin.features ?? []) {
        if (f?.id && !features.some(x => x.id === f.id)) features.push(f)
      }
    } catch (err: any) {
      console.error(`[plugins] 加载 ${dir} 失败:`, err.message)
      failed.push({ name: dir, dir: full, phase: 'import', error: err?.message ?? String(err) })
    }
  }
  return { plugins, features, failed }
}

/**
 * 第二段：按 requires 决定是否 apply。
 * 这样"关掉 mc"时 mcdev 的工具/角色/系统提示根本不会注册，而不是加载后隐藏。
 * 与 dsh 不同：不做 peerDependencies 兼容门禁，加载失败记录进 failed 并继续。
 */
export async function applyPlugins(
  discovery: PluginDiscovery,
  pluginCtx: PluginContext,
  configs?: Record<string, any>,
  opts?: PluginLoadOptions,
): Promise<PluginLoadResult> {
  const loaded: LoadedPlugin[] = []
  const skipped: SkippedPlugin[] = []
  const failed: PluginFailure[] = [...discovery.failed]

  for (const { full, plugin } of discovery.plugins) {
    const requires = plugin.requires ?? []
    const blocked = requires.filter(id => opts?.featureStates?.[id] === false)
    if (blocked.length) {
      skipped.push({ name: plugin.name, dir: full, requires: blocked, skills: plugin.skills ?? [], reason: `功能已关闭：${blocked.join(', ')}` })
      console.log(`[plugins] 跳过 ${plugin.name}: ${blocked.join(', ')} 已关闭`)
      continue
    }
    try {
      const config = { ...(plugin.config ?? {}), ...(configs?.[plugin.name] ?? {}) }
      await plugin.apply(pluginCtx, config)
      loaded.push({ name: plugin.name, dir: full, plugin, config })
      console.log(`[plugins] 已加载: ${plugin.name}`)
    } catch (err: any) {
      console.error(`[plugins] 加载 ${plugin.name} 失败:`, err.message)
      failed.push({ name: plugin.name, dir: full, phase: 'apply', error: err?.message ?? String(err) })
    }
  }
  return { loaded, skipped, features: discovery.features, failed }
}

/** 兼容入口：发现 + 应用一次完成（不需要先解析功能开关的调用方用） */
export async function loadPlugins(
  pluginsDir: string,
  pluginCtx: PluginContext,
  configs?: Record<string, any>,
  opts?: PluginLoadOptions,
): Promise<PluginLoadResult> {
  return applyPlugins(await discoverPlugins(pluginsDir), pluginCtx, configs, opts)
}
