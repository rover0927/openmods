export interface ModelInfoDto {
  id: string
  displayName: string
  badge?: string
  badgeType?: 'price' | 'peak'
  desc: string
  providerRoute?: string
  disabled?: boolean
  disabledReason?: string
  contextWindow?: number
  vision?: boolean
  inputModalities?: string[]
  maxOutputTokens?: number
}

export interface StepItem {
  callId: string
  name: string
  args?: any
  done: boolean
  isError?: boolean
}

/** 一张可渲染的参考图（src 是 /api/attachments/<id> 或迁移前的 data URL） */
export interface SessionImageDto {
  id: string
  name?: string
  src: string
}

export interface TurnEntry {
  turnId: string
  userText: string
  attachments: number
  /** 本轮的参考图（引用形式；消息列表缩略图与右侧「图片」标签都用它） */
  images?: SessionImageDto[]
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
  /** 画布归属（子代理与主会话共用同一块画布 = 根会话 id） */
  canvasId?: string
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
}

export interface RedactedProviderDto {
  displayName: string
  baseURL: string
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
  enterToSend: boolean
  maxActiveSubagents: number
  /** 子代理全部结算后自动唤醒主会话汇总 */
  autoWake: boolean
  /** 画布自动唤醒：AI 改画布 / 子任务结算时自动展开右侧拓展 */
  canvasAutoWake: boolean
  /** 运行中的子代理显示在当前对话里 */
  inlineSubagents: boolean
  /** mod-output：jar 导出保存目录（空 = 未配置，jar 按钮回退浏览器下载） */
  modOutput: string
}

export interface SettingsDto {
  revision: number
  providers: Record<string, RedactedProviderDto>
  bridge: BridgeConfigDto
  prefs: PrefsDto
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
  spawn_modeling_subagent: '派发建模子代理',
}

export function stepLabel(name: string): string {
  return STEP_LABELS[name] ?? name
}

/** 可选代理角色（dsh agentPreset 的简化版） */
export interface AgentProfileDto {
  id: string
  name: string
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

/** 素材库条目：画布快照的元信息（缩略图走 /api/library/:id/thumb?v=updatedAt） */
export interface LibraryAssetDto {
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
  elementCount: number
  textureCount: number
  resolution: { width: number; height: number }
  hasThumb: boolean
  /** 调色板（#RRGGBB 不带 #）：纯色贴图模型用它拼缩略图，比首张贴图更有辨识度 */
  palette?: string[]
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
