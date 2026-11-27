export interface ModelInfoDto {
  id: string
  displayName: string
  badge?: string
  badgeType?: 'price' | 'peak'
  desc: string
  providerRoute?: string
  providerName?: string
  disabled?: boolean
  disabledReason?: string
  contextWindow?: number
  vision?: boolean
  inputModalities?: string[]
  maxOutputTokens?: number
  /** 支持的思考强度档位（检测时获取；空 = 不支持） */
  reasoningEfforts?: string[]
  /** 端点声明的默认档位 */
  reasoningDefault?: string
}

export interface StepItem {
  callId: string
  name: string
  args?: any
  done: boolean
  isError?: boolean
  /** 一行动作摘要（工具 + 关键对象），用于在“制作过程”里说明这一步做了什么 */
  detail?: string
}

/** 一张可渲染的参考图（src 是 /api/attachments/<id> 或迁移前的 data URL） */
export interface SessionImageDto {
  id: string
  name?: string
  src: string
}

/** 一个随消息上传的普通文件（非图片），可从 /api/attachments/<id>?download=1 下载 */
export interface SessionFileDto {
  id: string
  name: string
  bytes: number
}

/** 输入框里待发送的附件（本地文件，点发送时才上传） */
export interface PendingAttachmentDto {
  file: File
  name: string
  bytes: number
  kind: 'image' | 'file'
  /** 图片的本地预览（data URL）；普通文件为空 */
  previewUrl?: string
}

export interface TurnEntry {
  turnId: string
  userText: string
  attachments: number
  /** 本轮的参考图（引用形式；消息列表缩略图与右侧「图片」标签都用它） */
  images?: SessionImageDto[]
  /** 本轮上传的普通文件（图片之外） */
  files?: SessionFileDto[]
  /** 本轮模型是纯文本路由，图片没有发给模型（缩略图照常显示，只是标注一下） */
  imagesOmitted?: boolean
  steps: StepItem[]
  /** 思考过程（reasoning_content）；不参与上下文回放，只用于展示 */
  reasoning?: string
  assistantText: string
  streaming: boolean
  profile?: string
  error?: string
  /** 子代理完成通知（紧凑系统行，不是聊天消息） */
  notice?: SubagentNoticeDto
  /** 自动汇总回合开头的一组结算行（一条 runtime 投递的 user 消息可合并多个子代理） */
  notices?: SubagentNoticeDto[]
}

/** 等待中的子代理（服务端 waiting 集合的投影） */
export interface SubagentWaitDto {
  id: string
  name: string
  description: string
  status: SubagentStatusDto
}

export type SubagentStatusDto = 'running' | 'done' | 'error' | 'stopped' | 'idle'

export interface SubagentNoticeDto {
  childId: string
  name: string
  description?: string
  status: SubagentStatusDto
  summary: string
  /** 复刻 dsh SubagentSettledMessageSource：归属、形态与终止原因 */
  kind?: 'subagent-settled'
  form?: 'notice'
  senderSessionId?: string
  stopReason?: 'completed' | 'aborted' | 'error'
}

/** 会话列表项：服务端由 data/sessions 磁盘重建（重启后仍然存在） */
export interface SessionSummaryDto {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  hasModel: boolean
  mode: 'root' | 'subagent'
  parentId?: string
  canvasId?: string
  /** 会话绑定的本地工作目录（左栏在会话名下方显示） */
  cwd?: string
  agentName?: string
  description?: string
  status: SubagentStatusDto
  lastError?: string
  lastText?: string
  durationMs?: number
  outputTokens?: number
  modelId?: string
  /** 素材绑定：本会话是某个素材的编辑会话（左栏给个 ▤ 标记） */
  libraryId?: string
  libraryName?: string
  /** 是否已归档（来自项目注册表的全局归档集合） */
  archived?: boolean
  /** 所属项目；缺省 = 未分组 */
  projectId?: string
}

/** 一个项目/分组（对应 dsh Workspace；path 在这里叫 cwd） */
export interface ProjectDto {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 关联的本地目录（dsh Workspace.path）；该分组下的新会话继承它 */
  cwd?: string
  /** 手动顺序的会话记账：新建/移入时置顶，聊天活动不重排 */
  sessionIds: string[]
}

export interface ProjectBaselineDto {
  projects: ProjectDto[]
  /** 全局归档集合 */
  archivedSessionIds: string[]
}

/** 归档视图（dsh viewOptions.*） */
export type ArchivedView = 'hide' | 'all' | 'only'

/** 上下文构成（复刻 dsh token-meter 的 `contextBreakdown`）：图形化面板三段的启发式 token */
export interface ContextBreakdownDto {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** 会话待办（todo_write 的整表） */
export interface TodoItemDto {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 一个待处理的交互（提问 / 方案评审 / 执行授权） */
export interface PendingInteractionDto {
  id: string
  sessionId: string
  kind: 'question' | 'plan' | 'approval'
  createdAt: number
  callId?: string
  toolName?: string
  reason?: string
  questions?: {
    id: string
    header?: string
    question: string
    options?: { label: string; description?: string }[]
    multiSelect?: boolean
  }[]
  /** 方案评审：完整计划 markdown */
  plan?: string
}

/** 会话终端摘要（服务端 TerminalManager 的投影） */
export interface TerminalDto {
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
  truncatedChars?: number
}

export interface SessionInfoDto {
  id: string
  /** 首条消息派生的标题（主区页头） */
  title?: string
  events: any[]
  /** 服务端当前已发出的最大 SSE 帧序号 */
  streamSeq?: number
  contextTokens: number
  /** 当前模型的上下文窗口（上下文环分母） */
  modelWindow?: number
  /** 系统提示词 / 工具定义 / 对话 三段（点击上下文环展开的图） */
  contextBreakdown?: ContextBreakdownDto
  modelId?: string
  /** 当前代理角色（lead / mcmod） */
  profile?: string
  mode: 'root' | 'subagent'
  parentId?: string
  /** 会话的活跃画布（画布 id，不再是会话 id） */
  canvasId?: string
  /** 会话拥有的画布集合（活跃画布在第一项） */
  canvasIds?: string[]
  /** 会话绑定的本地工作目录 */
  cwd?: string
  /** 素材绑定：本会话是某个素材的编辑会话（改动自动回写素材） */
  libraryId?: string
  libraryName?: string
  agentName?: string
  description?: string
  status: SubagentStatusDto
  busy: boolean
  /** 等待中的子代理：非空 = 等待态（输入锁定，全部结算后自动汇总） */
  waiting?: SubagentWaitDto[]
  /** 计划模式：只读出方案（写操作被运行时拦截） */
  planMode?: boolean
  /** 当前待办（最后一次 todo_write） */
  todos?: TodoItemDto[] | null
  /** 授权策略：ask=写/命令工具弹窗；auto=本会话自动放行 */
  permission?: 'ask' | 'auto'
  /** 「本会话内总是允许」的工具 */
  allowedTools?: string[]
  /** 还没回答的提问/授权（刷新后补弹窗） */
  pendingInteractions?: PendingInteractionDto[]
}

export interface AnimationMetaDto {
  name: string
  length: number
  loop: string
}

export interface CanvasState {
  hasModel: boolean
  modelName: string
  elements: number
  textures: number
  view: '3d' | 'front' | 'side' | 'back'
  animations: AnimationMetaDto[]
}

/** 会话树里的一块画布（GET /api/sessions/:id/canvases 的每一项） */
export interface CanvasRefDto {
  canvasId: string
  name: string
  /** 拥有这块画布的会话（主会话或某个子代理） */
  ownerSessionId: string
  /** 展示名：主会话 / 子代理名 */
  ownerName: string
  elements: number
  textures: number
  hasModel: boolean
  /** 是否是 owner 会话的活跃画布 */
  active: boolean
}

export interface CanvasTreeDto {
  sessionId: string
  activeCanvasId: string
  canvases: CanvasRefDto[]
}

/**
 * 右侧「建模」页签里的一页：
 * key=canvasId（画布页）/ `asset:<assetId>`（素材只读预览）/ `blank:<n>`（空白页，展示可选画布列表）
 */
export interface CanvasPageDto {
  key: string
  kind: 'canvas' | 'asset' | 'blank'
  assetId?: string
  /** 素材页签的标题（画布页的工程名从 canvases 列表里取） */
  assetName?: string
}

export interface StepRowDto {
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

export interface TurnRowDto {
  turnId: string
  firstUserText: string
  steps: StepRowDto[]
}

export interface CompactionRowDto {
  compactionId: string
  reason: string
  shadowedTokens: number
  summaryTokens: number
  saved: number
  wallMs: number
}

export interface StatsDto {
  turns: TurnRowDto[]
  compactions: CompactionRowDto[]
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
  /** 上下文面板的数据块（段次/工具/命令/token 构成/耗时分布/时间轴） */
  context: ContextStatsDto
}

export interface ContextStatsDto {
  counts: {
    turns: number
    steps: number
    userMessages: number
    assistantMessages: number
    toolCalls: number
    reasoning: number
    compactions: number
  }
  tools: { name: string; count: number; ms: number; errors: number }[]
  commands: { name: string; count: number }[]
  tokenSplit: {
    system: number
    tools: number
    message: number
    output: number
    reasoning: number
    cacheRead: number
  }
  timeSplit: { ttft: number; generation: number; tool: number; idle: number }
  timeline: { stepId: string; turnId: string; model?: string; context: number; output: number; tps: number }[]
  textChars: { reasoning: number; assistant: number }
}

/** stats 接口附带：上下文环 + 编队（主/子代理） */
export interface StatsFrameDto {
  stats: StatsDto
  contextTokens?: number
  modelWindow?: number
  contextBreakdown?: ContextBreakdownDto
  fleet?: { main: number; subagents: number; subagentCount: number }
}

// ---- 设置（复刻 dsh ui-settings-models 的数据形态） ----

export interface ProviderModelDto {
  id: string
  name: string
  contextWindow?: number
  badge?: string
  badgeType?: 'price' | 'peak'
  desc?: string
  memberOnly?: boolean
  vision?: boolean
  /** 输入模态（dsh `inputModalities`）：能力事实源，vision 由其派生 */
  inputModalities?: string[]
  maxOutputTokens?: number
  /** 支持的思考强度档位（检测时获取；空 = 不支持） */
  reasoningEfforts?: string[]
  /** 端点声明的默认档位 */
  reasoningDefault?: string
}

export interface RedactedProviderDto {
  displayName: string
  baseURL: string
  /** 供应商 API 线格式；旧服务端可能不返回，前端按 openai 处理 */
  format?: 'openai' | 'gemini'
  models: ProviderModelDto[]
  apiKey: { set: boolean }
}

export interface BridgeConfigDto {
  enabled: boolean
  modelId?: string
}

/** 行为偏好（设置里的 通用 / 子代理 / 自动化 三页写的就是它） */
export interface PrefsDto {
  fontSize: number
  /** MC 主题 id（写 documentElement[data-theme]，mc-theme.css 按主题覆盖令牌） */
  theme: 'mc-grass' | 'mc-cherry' | 'mc-ocean' | 'mc-nether' | 'mc-end'
  enterToSend: boolean
  maxActiveSubagents: number
  /** 子代理全部结算后自动唤醒主会话汇总 */
  autoWake: boolean
  /** 画布自动唤醒：AI 改画布 / 子任务结算时自动展开右侧拓展 */
  canvasAutoWake: boolean
  /** 运行中的子代理显示在当前对话里 */
  inlineSubagents: boolean
  /** 界面音效：点击 / 切换 / 提示条播放 MC 原版 UI 音效 */
  uiSound: boolean
  /** mod-output：jar 导出保存目录（空 = 未配置，jar 按钮回退浏览器下载） */
  modOutput: string
  /** 测试客户端 .minecraft 目录（空 = 自动安装到 data/mc-test-client） */
  testClientDir: string
  /** 测试客户端来源：auto（优先本地 MDK 离线组装）/ mdk（仅离线）/ production（联网或现成目录） */
  testClientMode: 'auto' | 'mdk' | 'production'
  /** 指定 MDK 工程目录，用于定位其 ForgeGradle 缓存（空 = 自动检测） */
  testMdkDir: string
  /** 功能开关（canvas / mc / library …）；改动需重启生效 */
  features: Record<string, boolean>
  /** 上下文压缩：按阈值自动压缩（关闭后只保留超限兜底） */
  compactionEnabled: boolean
  /** 压缩方式：summary = 模型摘要；drop = 直接丢弃超出部分 */
  compactionStrategy: 'summary' | 'drop'
  /** 摘要模型 id；空 = 跟随当前会话模型 */
  compactionModelId: string
  /** 触发阈值：上下文占模型窗口的比例 */
  compactionThresholdRatio: number
  /** 压缩后保留的尾部比例 */
  compactionRetainRatio: number
  /** 工具结果投影裁剪阈值（字符）；0 = 关闭 */
  compactionResultChars: number
  /** 历史工具参数投影裁剪阈值（字符）；0 = 关闭 */
  compactionArgChars: number
}

export interface SettingsDto {
  revision: number
  providers: Record<string, RedactedProviderDto>
  bridge: BridgeConfigDto
  prefs: PrefsDto
}

// ---- 环境检测（首次运行向导 / 设置 → 环境） ----

/** data/settings.json 的 environment 字段 */
export interface EnvironmentConfigDto {
  /** 首次运行向导是否已处理过（保存或「稍后配置」都算） */
  setupDone: boolean
  /** JDK 17 的 home */
  javaHome: string
  /** Gradle 用户目录（GRADLE_USER_HOME，离线缓存所在） */
  gradleHome: string
  /** git 可执行文件路径（空 = 用 PATH 里的 git） */
  gitPath: string
}

/** 一个候选路径（vendor 离线包用空字符串 value：不覆盖 GRADLE_USER_HOME） */
export interface EnvCandidateDto {
  value: string
  label: string
  version?: string
  ok: boolean
  note?: string
}

export interface EnvCheckDto {
  id: 'java' | 'gradle' | 'git' | 'test-client'
  status: 'ok' | 'warn' | 'fail'
  summary: string
  details: string[]
  candidates: EnvCandidateDto[]
  actions?: { id: 'fix-vendor'; label: string }[]
}

export interface EnvStatusDto {
  configured: boolean
  config: EnvironmentConfigDto
  /** 测试客户端 / MDK 路径（存在 prefs，不在 environment） */
  prefs?: { testClientDir?: string; testMdkDir?: string }
  checks: EnvCheckDto[]
  updatedAt?: number
}

/** 在线下载离线构建包的实时状态（/api/env/vendor/download） */
export interface VendorDownloadDto {
  status: 'idle' | 'downloading' | 'extracting' | 'done' | 'cancelled' | 'error'
  /** 下载落盘位置（服务端返回） */
  targetPath?: string
  /** 本次下载使用的源 */
  source?: 'official' | 'release'
  /** 已下载字节数 */
  received: number
  /** 总字节数（服务端未给 content-length 时为 0） */
  total: number
  /** 平滑后的瞬时速度，字节/秒 */
  speed: number
  startedAt: number
  finishedAt?: number
  error?: string
}

/** 画布唤醒记录（自动化页展示最近几次 AI 自己唤醒右侧拓展） */
export interface WakeEntry {
  at: number
  reason: string
}

export const STEP_LABELS: Record<string, string> = {
  load_skill: '加载建模技能',
  create_model: '创建模型项目',
  place_cubes: '放置几何体',
  modify_cube: '调整部件',
  delete_elements: '删除部件',
  add_group: '创建分组',
  list_outline: '核对大纲',
  set_camera_view: '调整视角',
  set_animation: '添加动画',
  remove_animation: '移除动画',
  list_animations: '查看动画列表',
  spawn_modeling_subagent: '派发制作子代理',
}

export function stepLabel(name: string): string {
  return STEP_LABELS[name] ?? name
}

/**
 * 从工具参数里提取一行“它做了什么”。
 * 只取文件名 / 路径 / 任务名这类关键字段，不把 write 的正文、bash 的完整输出等
 * 大段内容带进界面；未知工具也只尝试常见标识字段。
 */
export function toolDetail(name: string, args: any): string {
  const a = args && typeof args === 'object' ? args : {}
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k]
      if (typeof v === 'string' && v.trim()) return v
    }
    return ''
  }
  const oneLine = (v: unknown, max = 120): string => {
    if (v === undefined || v === null || v === '') return ''
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max)}…` : flat
  }
  switch (name) {
    case 'bash': return oneLine(str('description') || '执行命令')
    case 'read':
    case 'write':
    case 'edit': return oneLine(str('file_path', 'path'))
    case 'list_dir': return oneLine(str('path') || '.')
    case 'glob':
    case 'grep': {
      const pattern = str('pattern')
      const path = str('path')
      return oneLine(path ? `${pattern} @ ${path}` : pattern)
    }
    case 'todo_write': {
      const list = Array.isArray(a.todos) ? a.todos : []
      if (!list.length) return '待办清单'
      const active = list.find((t: any) => t?.status === 'in_progress') ?? list.find((t: any) => t?.status === 'pending')
      return oneLine(`${list.length} 项${active?.content ? ` · ${active.content}` : ''}`)
    }
    case 'ask_user_question': {
      const qs = Array.isArray(a.questions) ? a.questions : []
      return oneLine(qs[0]?.question ?? a.question ?? '')
    }
    case 'spawn_modeling_subagent': return oneLine(str('description', 'name') || '派发子代理')
    case 'exit_plan_mode': return a.plan ? '提交计划' : ''
    case 'load_skill': return oneLine(str('name', 'skill'))
    case 'mc_gradle': return oneLine(str('task'))
    case 'create_model': return oneLine(str('name'))
    case 'set_animation':
    case 'remove_animation': return oneLine(str('name'))
    default: return oneLine(str('name', 'id', 'file_path', 'path', 'command', 'description', 'task'))
  }
}

/** 可选代理角色（dsh agentPreset 的简化版） */
export interface AgentProfileDto {
  id: string
  name: string
  /** 一句话职责介绍（角色下拉悬停时展示） */
  description?: string
}

/** 空上下文块：SSE 帧缺字段时的兜底，避免面板渲染崩 */
export const EMPTY_CONTEXT_STATS: ContextStatsDto = {
  counts: { turns: 0, steps: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, reasoning: 0, compactions: 0 },
  tools: [],
  commands: [],
  tokenSplit: { system: 0, tools: 0, message: 0, output: 0, reasoning: 0, cacheRead: 0 },
  timeSplit: { ttft: 0, generation: 0, tool: 0, idle: 0 },
  timeline: [],
  textChars: { reasoning: 0, assistant: 0 },
}

/** 素材里的一个真实文件（下载/预览地址：/api/library/:id/files/:fileId） */
export interface LibraryFileDto {
  id: string
  name: string
  size: number
  mime: string
  kind: 'model' | 'image' | 'jar' | 'archive' | 'text' | 'other'
  createdAt: number
}

export type LibraryAssetKind = 'model' | 'jar' | 'image' | 'file'

/**
 * 素材库条目：模型 / Jar / 图片 / 文件四类互相独立。
 * 模型资产装画布快照与缩略图；jar 资产一个资产只装一个 jar；图片/文件资产装其余文件。
 * 缩略图走 /api/library/:id/thumb?v=updatedAt。
 */
export interface LibraryAssetDto {
  /** 3 = 分类拆分；旧数据缺省（懒迁移中） */
  schema?: number
  /** 顶层分类 */
  kind: LibraryAssetKind
  id: string
  name: string
  createdAt: number
  /** 最后一次内容更新（就地编辑回写）；老数据缺省时用 createdAt */
  updatedAt?: number
  /** 内容版本：截取=1，每次就地回写 +1 */
  version?: number
  sessionId?: string
  canvasId?: string
  /** 绑定的编辑会话（就地改）：存在即表示「这个素材正在被这个会话编辑」 */
  editingSessionId?: string
  /** 自动入库（会话画布快照） */
  auto?: boolean
  /** 资产来源 */
  source: {
    provider: 'canvas' | 'auto' | 'upload' | 'cwd' | 'legacy' | 'legacy-split' | 'build'
    sessionId?: string
    path?: string
  }
  /** 从旧组合资产拆出来时记录原资产 id */
  splitFrom?: string
  /** 资产内的全部文件 */
  files: LibraryFileDto[]
  /** 模型能力（有它才能「画布打开 / 接着改 / 引用 / 送入画布」） */
  model?: {
    docFileId: string
    elementCount: number
    textureCount: number
    resolution: { width: number; height: number }
    palette?: string[]
  }
  /** 构建产物（jar / zip），地址 /api/library/:id/jar 或 files/:fileId */
  jar?: { fileId?: string; name: string; size: number }
  // ---- 兼容派生字段（由 model 计算） ----
  elementCount: number
  textureCount: number
  resolution: { width: number; height: number }
  hasThumb: boolean
  /** 调色板（#RRGGBB 不带 #）：纯色贴图模型用它拼缩略图，比首张贴图更有辨识度 */
  palette?: string[]
}

/** Jar 构建列表项：素材库已归档 jar 或工程 build/libs 扫描结果 */
export interface LibraryJarItemDto {
  source: 'library' | 'build'
  assetId?: string
  fileId?: string
  path?: string
  name: string
  size: number
  updatedAt?: number
  mtime?: number
  project?: string
  /** 扫描结果是否已有同名同大小的归档 jar */
  archived?: boolean
}

/** 统一测试启动器的选择项 */
export interface McTestJarSelectionDto {
  source: 'library' | 'build'
  assetId?: string
  fileId?: string
  path?: string
  name?: string
}

export type McTestPhase = 'idle' | 'installing' | 'starting' | 'running' | 'exited' | 'error'

/** 统一测试启动器状态（GET /api/mc/test） */
export interface McTestStatusDto {
  phase: McTestPhase
  running: boolean
  pid?: number
  startedAt?: number
  selected: { name: string; source: 'library' | 'build' }[]
  logTail: string
  projectDir?: string
  error?: string
  /** 本次运行的日志归档目录 */
  runDir?: string
  /** 游戏 latest.log 路径 */
  logFile?: string
  /** FML Mod List 解析出的模组状态 */
  mods: { jar: string; modId: string; state: string }[]
  /** 能归因到具体 jar 的错误 */
  issues: { jar: string; modId?: string; message: string }[]
}

/** 系统日志（GET /api/logs） */
export type LogLevel = 'info' | 'warn' | 'error'
export interface LogEntryDto {
  seq: number
  ts: number
  level: LogLevel
  text: string
}

export interface LogsDto {
  logs: LogEntryDto[]
  seq: number
  /** 当天落盘日志文件 */
  file: string
}

/** 构建日志（GET /api/build-logs 的列表项；单条详情再带 text） */
export interface BuildLogMetaDto {
  id: string
  project: string
  task: string
  startedAt: number
  /** 缺省 = 还在构建中 */
  finishedAt?: number
  ok: boolean
  exitCode?: number
  /** 构建产物 jar（失败时可能没有） */
  jarPath?: string
  logPath: string
}

/** 自更新：本地与 GitHub main 的差异（/api/update/status） */
export interface UpdateCommitDto {
  sha: string
  short: string
  subject: string
  date: string
  author: string
}

export interface UpdateStatusDto {
  repo: string
  branch: string
  local?: UpdateCommitDto
  remote?: UpdateCommitDto
  state: 'identical' | 'behind' | 'ahead' | 'diverged' | 'unknown'
  aheadBy: number
  behindBy: number
  commits: UpdateCommitDto[]
  dirty: boolean
  dirtyFiles: string[]
  error?: string
}

export interface UpdateApplyDto {
  ok: boolean
  error?: string
  before?: string
  after?: string
  changed?: string[]
  stashed?: boolean
  build?: 'ok' | 'failed' | 'skipped'
  output?: string
  needsRestart?: boolean
}

/** 功能开关（/api/features） */
export interface FeatureDto {
  id: string
  name: string
  description: string
  /** 本次进程实际加载的状态 */
  enabled: boolean
  default: boolean
  /** 设置已改但还没重启，需要提示用户 */
  pendingRestart: boolean
}

export interface FeaturesDto {
  features: FeatureDto[]
  profiles: AgentProfileDto[]
  plugins: {
    loaded: string[]
    skipped: { name: string; reason: string }[]
    /** import/apply 抛错的插件（name 在 import 失败时是目录名） */
    failed: { name: string; phase: string; error: string }[]
  }
}

// ---- MC 工程（mcdev）状态：右侧 dock 的「测试 Mod」/ jar 导出 ----
export interface McBuildRecordDto {
  task: string
  ok: boolean
  code: number
  time: number
}

export interface McProjectUiDto {
  name: string
  dir: string
  lastBuild?: McBuildRecordDto
  runClientRunning: boolean
  runClientStartedAt?: number
  jars: { name: string; path: string; size: number; mtime: number }[]
}

/** runClient 控制台日志（/api/mc/runlog，只含 run-console.log 尾部） */
export interface McRunLogDto {
  project: string
  dir: string
  path: string
  running: boolean
  startedAt?: number
  updatedAt?: number
  text: string
}

/** Java 后台进程（Gradle daemon / gradlew 启动器 / Minecraft 客户端） */
export interface JavaProcDto {
  pid: number
  ppid: number
  kind: 'gradle-daemon' | 'gradle-launcher' | 'minecraft-client'
  cmd: string
  memoryMB: number
  cpuSec: number
  startedAt: number
}

export interface JavaProcsDto {
  ok: boolean
  error?: string
  processes: JavaProcDto[]
}

// ---- 设置 → 代理与技能 ----
export interface AgentToolMetaDto {
  name: string
  /** 全量描述：首行是摘要，展开后看完整正文 */
  description: string
  /** 工具入参 JSON Schema（properties / required） */
  parameters?: any
  /** 写操作（计划模式下会被拦截） */
  mutates?: boolean
  /** 输出格式说明 */
  returns?: string
}

export interface AgentDetailDto {
  id: string
  name: string
  prompt: string
  tools: AgentToolMetaDto[]
  skills: string[]
}

export interface SkillMetaDto {
  name: string
  description: string
  /** 用户在设置里注入的技能 */
  custom?: boolean
}

export interface SkillContentDto {
  name: string
  description: string
  content: string
}
