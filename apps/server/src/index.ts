// openmods server：REST + SSE + 静态托管（web 构建 / /bb/ 无头 Blockbench）
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { LoadedPlugin, PluginContext, SessionRuntimeLike, SkillProvider, ToolDef, ToolResult } from '@openmods/plugin-kit'
import { loadPlugins } from '@openmods/plugin-kit'
import { createSessionRuntime, createHttpLlm, createMockLlm, registerSurfaceTransform, SessionLog, type SessionRuntime, type LlmAdapter, LlmError } from '@openmods/agent-core'
import { DirSkillProvider } from './skills.js'
import { SettingsStore } from './settings.js'
import { SessionStore, isValidSessionId, summarize, type SessionSummary, type SubagentStatus } from './session-store.js'
import { CanvasService } from './canvas.js'
import { ProjectStore, ProjectActiveSessionError, type SessionActivity } from './project-store.js'
import { createAttachmentStore, MAX_IMAGES_PER_MESSAGE } from './attachments.js'
import { createLibraryStore, type LibraryAsset, type LibraryDoc } from './library.js'
import { createFileService } from './files.js'
import { probeWeb, proxyWeb } from './webview.js'
import { createInteractionHub, type InteractionReply, type PendingInteraction } from './interaction.js'
import { createTerminalManager } from './terminals.js'
import { projectStats } from '../../../plugins/stats/projection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../..')

/**
 * 新会话默认绑定的工作目录（左栏「目录」的来源）。
 * 与 mcdev 插件的 MC_ROOT 保持同一套解析：优先同级 mincraft-maker/projects，
 * 否则 data/mcprojects。OPENMODS_MC_ROOT 可覆盖。
 */
const DEFAULT_CWD = process.env.OPENMODS_MC_ROOT
  ?? (existsSync(join(ROOT, '..', 'mincraft-maker'))
    ? join(ROOT, '..', 'mincraft-maker', 'projects')
    : join(ROOT, 'data', 'mcprojects'))

// ---- .env 简易加载（无依赖） ----
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* 无 .env 用默认值 */ }

const env = process.env
const PORT = Number(env.PORT ?? 8787)
const DATA_DIR = join(ROOT, 'data', 'sessions')
const PLUGINS_DIR = join(ROOT, 'plugins')
const SKILLS_DIR = join(ROOT, 'skills')
// 会话持久化：目录即事实来源（server 重启后靠它恢复列表，而不是内存 Map）
const sessionStore = new SessionStore(DATA_DIR)
// 画布服务：会话树共享的一块 workspace（dsh workingDirectory 的对应物）
const canvas = new CanvasService(sessionStore)
// 项目注册表：会话列表的分组 + 全局归档集合（dsh workspace registry 的对应物）
const projectStore = new ProjectStore(join(ROOT, 'data', 'projects.json'))
// 图片附件：内容寻址落盘（data/attachments），会话日志里只写引用（复刻 dsh attachment-local）
const attachments = createAttachmentStore(join(ROOT, 'data', 'attachments'))
// 文档素材库：从建模画布截取快照归档（不会自动同步，纯手动）
const library = createLibraryStore(ROOT)
// 工作区文件浏览（右侧「文件」标签；路径限制在 ROOT 内）
const files = createFileService(ROOT)

// ---- 事件总线（插件与终端事件的中转；SSE 出口按会话查 sessions） ----
const bus = new EventEmitter()
bus.setMaxListeners(50)

// ---- 会话热缓存（声明提前：交互/终端的事件回调要按会话找 SSE 出口） ----
const sessions = new Map<string, SessionEntry>()

// ---- 人机交互（问用户 / 计划评审 / 执行授权） ----
// 事件只发给对应会话的 SSE；刷新页面后 GET 会话详情还能看到未答的问题。
const interactionHub = createInteractionHub({
  emit: (sessionId, topic, data) => {
    sessions.get(sessionId)?.sse.send(topic, data)
  },
})

// ---- 终端管理器（bash / terminal_* 的进程宿主，右侧「终端」标签的数据源） ----
const terminals = createTerminalManager({
  emit: (sessionId, topic, data) => {
    const s = sessions.get(sessionId)
    s?.sse.send(topic, data)
    bus.emit(topic, data)
  },
})

// ---- 设置存储（providers + credentials 持久化，模型目录动态化） ----
const settingsStore = new SettingsStore(join(ROOT, 'data'), env)

// ---- LLM 适配器：MOCK 或 per-request 解析供应商（下一轮生效） ----
// MOCK 仅由显式 MOCK=1 开启；供应商的 key 来自设置系统（credentials.json），无需 .env 的 LLM_API_KEY
const MOCK = env.MOCK === '1'
// 可选代理：.env 里配 HTTPS_PROXY（如 http://127.0.0.1:7890）时，所有对 LLM 端点的请求走该代理
if (env.HTTPS_PROXY || env.HTTP_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent(env.HTTPS_PROXY ?? env.HTTP_PROXY!))
    console.log(`[llm] 已启用代理 ${env.HTTPS_PROXY ?? env.HTTP_PROXY}`)
  } catch (e: any) {
    console.warn('[llm] 代理启用失败（未安装 undici？）:', e.message)
  }
}
const httpLlmFor = (baseUrl: string, apiKey: string) => createHttpLlm({ baseUrl, apiKey })

const llm: LlmAdapter = MOCK
  ? createMockLlm()
  : {
      async chat(opts) {
        // opts.model 可能是 "providerRoute/llmModel" 复合串
        const [route, ...rest] = String(opts.model).split('/')
        const llmModel = rest.join('/') || opts.model
        const profile = settingsStore.getProvider(route)
        if (!profile) throw new LlmError(`供应商 "${route}" 不存在（设置 → 模型 中配置）`, 400)
        // 无 key 也放行（本地/匿名端点可用）；真实端点的鉴权错误由端点明确报出
        const apiKey = settingsStore.getCredential(route)
        const delegate = httpLlmFor(profile.baseURL, apiKey ?? '')
        return delegate.chat({ ...opts, model: llmModel })
      },
    }
console.log(`[llm] ${MOCK ? 'MOCK 离线模式' : 'HTTP 模式（provider 按请求解析）'}`)

// ---- 注册表（插件注入目标） ----
const tools: ToolDef[] = []
const skillProviders: SkillProvider[] = []
const systemSections: ((ctx: { sessionId: string; session: SessionRuntimeLike }) => string)[] = []
const beforeStepHooks: ((s: any) => Promise<void>)[] = []
const overflowHooks: ((s: any) => Promise<boolean>)[] = []

const dirProvider = new DirSkillProvider(SKILLS_DIR)
skillProviders.push(dirProvider)

// 技能按需加载（渐进披露）：系统提示只列技能名，模型需要时读全文。
// 这个工具以前只在提示里提到、从未注册——模型调它会得到「未知工具」，技能永远读不进来。
tools.push({
  name: 'load_skill',
  description: '按需加载一项技能（SKILL.md 全文）。先用系统提示里的技能名调用；一次只加载当前需要的。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名，如 blockbench-modeling' } },
    required: ['name'],
  },
  async execute(args, exec) {
    const name = String(args.name ?? '').trim()
    // 技能按角色分配（设置 → 代理与技能）：不在本角色清单里的拒绝加载
    const entry = sessions.get(exec.sessionId)
    const allowed = entry ? effectiveSkills(entry.profile) : undefined
    for (const provider of skillProviders) {
      if (provider.list().some(m => m.name === name)) {
        if (allowed && !allowed.includes(name)) {
          return {
            forModel: `技能 "${name}" 未分配给当前角色（${entry?.profile ?? 'default'}）。可用: ${allowed.join(', ') || '无'}。`,
            isError: true,
          }
        }
        return { forModel: await provider.load(name) }
      }
    }
    const available = skillProviders.flatMap(p => p.list().map(m => m.name))
    return {
      forModel: `技能不存在: ${name}（可用: ${available.join(', ') || '无'}）`,
      isError: true,
    }
  },
})

// 工作台工具（fs-tools / shell-tools / interaction-tools 三个插件注册）：
// 主代理与 mcmod 都有完整一套——读写文件、搜索、执行命令、管终端、问用户、计划模式。
// 建模子代理是"画布上的手"，不进城也不问人，所以不放进它的白名单。
const WORKSPACE_TOOLS = [
  'read', 'write', 'edit', 'list_dir', 'glob', 'grep',
  'bash', 'terminal_open', 'terminal_list', 'terminal_read', 'terminal_send', 'terminal_kill',
  'ask_user_question', 'todo_write', 'exit_plan_mode',
]

// 各角色的默认技能分配（设置 → 代理与技能 可改，覆盖写进 data/agent-skills.json）。
// mcmod 只吃 Forge 技能；modeling 只吃画布三件套；lead 全量。
const PROFILE_SKILLS: Record<string, string[]> = {
  lead: ['blockbench-modeling', 'blockbench-texturing', 'blockbench-use', 'minecraft-forge-1.20.1'],
  mcmod: ['minecraft-forge-1.20.1'],
  modeling: ['blockbench-modeling', 'blockbench-texturing', 'blockbench-use'],
}
const SKILLS_OVERRIDES_PATH = join(ROOT, 'data', 'agent-skills.json')
let profileSkillsOverrides: Record<string, string[]> = {}
try {
  profileSkillsOverrides = JSON.parse(readFileSync(SKILLS_OVERRIDES_PATH, 'utf8'))
} catch { /* 首次运行没有覆盖文件 */ }
/** 生效的技能分配：持久化覆盖 > 代码内默认 */
function effectiveSkills(profileId: string): string[] {
  return profileSkillsOverrides[profileId] ?? PROFILE_SKILLS[profileId] ?? []
}
function saveSkillsOverrides() {
  mkdirSync(dirname(SKILLS_OVERRIDES_PATH), { recursive: true })
  writeFileSync(SKILLS_OVERRIDES_PATH, JSON.stringify(profileSkillsOverrides, null, 2))
}

// 代理角色档案（复刻 dsh agentPreset 的简化版）：lead=主代理，modeling=建模子代理
const AGENT_PROFILES: Record<string, import('@openmods/agent-core').AgentProfile> = {
  lead: {
    id: 'lead',
    name: '主代理（lead）',
    prompt: '你是 openmods 的主代理（lead）：既直接和用户干活，也可以把建模/动画派发给子代理。'
      + '你有完整工作台能力：read/write/edit/list_dir/glob/grep 读写会话工作目录、bash 执行命令、terminal_open/terminal_kill 拉起与结束终端、'
      + 'ask_user_question 问用户、todo_write 维护任务清单、exit_plan_mode 提交计划。动手前先看清现状（read/grep/list_dir），不要凭记忆改文件；'
      + '写工作目录外的文件、执行命令、开关终端都会请求用户授权，被拒绝时不要原样重试。\n'
      + '建模/动画任务一律派发给建模子代理（spawn_modeling_subagent），你不亲自建模。子代理属于当前会话：它们在同一个工作上下文里并行工作，'
      + '**共用用户正在看的这块画布**，改动实时出现在画布上，不会另开画布或新会话。派发完就结束这一轮，不要轮询、不要反复调 list_subagents 等结果：'
      + '主会话会进入等待态（这期间用户不能插话），最后一只子代理结算时系统会自动开一轮汇总回合，把各子代理的收尾汇报交给你。'
      + '到了汇总回合，你必须先核对画布（list_outline / list_animations）、修补缺口或冲突，再向用户汇报成果，不能只说"已完成"。',
    toolFilter: ['load_skill', 'spawn_modeling_subagent', 'list_subagents', ...WORKSPACE_TOOLS],
    skills: PROFILE_SKILLS.lead,
  },
  // 1.20.1 Forge 模组开发主代理：工程面工具（mcdev 插件）+ 完整工作台 + 建模委派。
  // 只做 Java + 1.20.1：越界的需求要在第一轮就说清不适用，不要自己改平台。
  mcmod: {
    id: 'mcmod',
    name: 'Minecraft 1.20.1 模组开发（mcmod）',
    prompt: '你是 Minecraft 1.20.1 Forge 模组开发主代理（mcmod）。只做 **Java + Minecraft 1.20.1 + Forge 47.x**；'
      + '用户要 Fabric / NeoForge / 1.20.2+ / Kotlin / 网易版时，明确说明本代理不覆盖，不要硬改工程。\n'
      + '你有完整工作台：read/write/edit/glob/grep 读写工程、bash 跑命令、terminal_open/terminal_kill 拉起/结束长任务终端、'
      + 'ask_user_question 问用户、todo_write 记步骤、exit_plan_mode 提交计划。工作目录就是当前工程目录，相对路径都以它为根。\n'
      + '工作流固定：\n'
      + '1) 先 load_skill("minecraft-forge-1.20.1") 拿到工具链与 API 约束；写代码前需要精确签名就读 skills/minecraft-forge-1.20.1/references/forge-1.20.1-api.md，不要凭记忆写。\n'
      + '2) 核对需求：modid、Java 包名、要加的东西（物品/方块/实体/命令/玩法）。信息不足时用 ask_user_question 一次问全，别反复问。\n'
      + '3) mc_scaffold 建工程（官方 MDK 模板 + 国内镜像已内置），再用 read/edit/write（或 mc_list/mc_read/mc_write）写 Java 与资源。\n'
      + '4) 造型（物品/方块/生物外观）派给 spawn_modeling_subagent；派发完结束这一轮，等系统汇总回合再用 mc_export_model 把画布模型导出成 models/item + 贴图。不要自己手搓几何。\n'
      + '5) 构建用 mc_gradle task=build；要验证能否进游戏就用 mc_gradle task=runClient background=true，'
      + '   然后 mc_log 读启动标记（Sound engine started / Forge mod loading），失败先看崩溃报告再改。\n'
      + '6) 收尾汇报：改了哪些文件、build 是否通过、客户端是否真的起来了、还有哪些没验证。\n'
      + '工具名以本清单为准，只能调用实际注册的工具；没有 mc_export、mc_edit、mc_canvas_outline、mc_list_outline、export_model、save_model 这些工具——'
      + '导出画布模型叫 mc_export_model，改工程文件用 edit/write。拿不准就先看函数目录（工具定义），不要凭名字猜。\n'
      + '铁律：不改 MC 版本、不换加载器、不动 gradle.properties 里的 minecraft_version/forge_version；'
      + '资源路径全小写；每次写完 Java 都要重新 build，不能只靠肉眼检查。',
    toolFilter: [
      'load_skill', 'mc_scaffold', 'mc_list', 'mc_read', 'mc_write', 'mc_gradle', 'mc_log', 'mc_export_model',
      'spawn_modeling_subagent', 'list_subagents', ...WORKSPACE_TOOLS,
    ],
    skills: PROFILE_SKILLS.mcmod,
  },
  modeling: {
    id: 'modeling',
    name: '建模子代理（modeling）',
    prompt: '你是建模子代理（modeling）：执行主代理派发的建模/动画任务。你工作在**当前会话的画布**上（与主代理、其它子代理共用同一份工程），你的每次修改都会实时显示给用户，因此要只做自己负责的部分、增量追加，不要清空或重建整个工程。动手前先 list_outline 看清已有分组与部件：已有同名骨骼（如 head、body）就直接往里加，用 place_cubes 的 group 参数指定父分组；确实需要新骨骼时才 add_group。除非主代理明确要求重做，否则不要调用 create_model（它会清空共享画布）。收尾一次简短总结（你新增/修改了什么、部件数、画布现状），不与用户寒暄，不派发任务。',
    // 子代理是无人值守的画布工作者：不给它终端/授权/提问/计划，避免等待一个不会有人回答的弹窗
    toolExclude: [
      'spawn_modeling_subagent', 'list_subagents', ...WORKSPACE_TOOLS,
    ],
    skills: PROFILE_SKILLS.modeling,
  },
}

tools.push({
  name: 'spawn_modeling_subagent',
  description: '在当前会话里派发一个建模/动画任务（后台并行，共享当前画布）。可连续调用多次，同时派出多个子代理并行工作；它们的改动会实时出现在同一块画布上。立即返回子代理名，随后你就该结束这一轮——主会话进入等待态（用户不能插话），全部子代理结算后系统会自动开一轮汇总回合，把它们的收尾汇报交给你。不要轮询 list_subagents 等结果。description 为 3-5 字任务简述（面板展示），prompt 为完整任务描述（外形/配色/细节/动画；多子代理时写明各自负责的部件，避免抢同一块）。',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '任务简述（3-5 字，面板展示用）' },
      prompt: { type: 'string', description: '给子代理的完整任务描述（外形/配色/细节/动画）' },
      name: { type: 'string', description: '可选：子代理名（小写字母/数字/连字符，如 armor、weapon），省略则自动 agent-1、agent-2…' },
    },
    required: ['description', 'prompt'],
  },
  async execute(args, exec) {
    const parent = sessions.get(exec.sessionId)
    if (!parent) throw new Error('父会话不存在或已结束')
    const child = startSubagent(parent, {
      description: String(args.description ?? '').trim() || '建模任务',
      prompt: String(args.prompt ?? '').trim(),
      name: args.name ? String(args.name).trim() : undefined,
    })
    return {
      forModel: `started subagent ${child.agentName}（${child.id}，后台运行）。它和你在同一会话、共用当前画布，改动会实时显示。本轮到此即可收尾：主会话进入等待态，全部子代理结算后系统自动开一轮汇总回合，把结果交给你；不要轮询等结果。`,
    }
  },
})

tools.push({
  name: 'list_subagents',
  description: '列出本会话派发过的子代理：名称、任务、状态（运行中/完成/出错）、最终汇报。主要用于汇总回合里核对各自成果；运行中时不必反复调用——结算会自动触发汇总回合。',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, exec) {
    const rows = subagentRows(exec.sessionId)
    if (!rows.length) return { forModel: '还没有派发过子代理。' }
    const lines = rows.map(r => {
      const head = `- ${r.agentName ?? r.id}（${r.description || '无描述'}）：${subagentStatusLabel(r.status)} · ${r.id}`
      if (r.status === 'running') return `${head}（可打开它的会话查看实时进度）`
      if (r.lastError) return `${head}\n  错误：${r.lastError.slice(0, 500)}`
      if (r.lastText) return `${head}\n  汇报：${r.lastText.slice(0, 1200)}`
      return head
    })
    return { forModel: lines.join('\n') }
  },
})

// ---- 插件加载 ----
const pluginCtx: PluginContext = {
  tools: { register: d => tools.push(d) },
  skills: { registerProvider: p => skillProviders.push(p) },
  interaction: interactionHub.port,
  // 终端端口带归属校验：插件只能碰自己会话的进程
  terminals: {
    open: o => terminals.open(o),
    openShell: o => terminals.openShell(o),
    list: sid => terminals.list(sid),
    output: (sid, id, tail) => (terminals.get(id)?.sessionId === sid ? terminals.output(id, tail) : undefined),
    write: (sid, id, text) => terminals.get(id)?.sessionId === sid && terminals.write(id, text),
    kill: (sid, id) => terminals.get(id)?.sessionId === sid && terminals.kill(id),
    wait: (sid, id, ms) => (terminals.get(id)?.sessionId === sid
      ? terminals.wait(id, ms)
      : Promise.resolve({ exitCode: null, timedOut: false })),
  },
  events: { on: (t, cb) => bus.on(t, cb), emit: (t, d) => bus.emit(t, d) },
  hooks: {
    beforeStep: cb => beforeStepHooks.push(cb),
    onOverflow: cb => overflowHooks.push(cb),
    // plugin-kit 的 SurfaceItemLike 是 agent-core SurfaceItem 的结构子集：
    // 插件只处理自己关心的字段，返回同形状条目，边界处断言即可
    registerSurfaceTransform: t => registerSurfaceTransform(t as any),
    registerSystemSection: cb => systemSections.push(cb),
  },
  llm: {
    complete: async ({ messages, modelId, signal }) => {
      const r = await llm.chat({ messages: messages as any, model: modelId, signal })
      return { text: r.text, usage: { promptTokens: r.usage.promptTokens, outputTokens: r.usage.outputTokens } }
    },
  },
  env,
}
const loadedPlugins: LoadedPlugin[] = await loadPlugins(PLUGINS_DIR, pluginCtx)

// ---- 会话管理 ----
/** 会话级协作状态：计划模式 / 待办 / 授权策略（durable：写 meta，计划与待办同时进日志） */
interface CoopState {
  planMode: boolean
  todos: import('@openmods/plugin-kit').TodoItem[] | null
  permission: 'ask' | 'auto'
  /** 用户点过「本会话内总是允许」的工具 */
  allowedTools: Set<string>
}

interface SessionEntry {
  id: string
  createdAt: number
  log: SessionLog
  runtime: SessionRuntime
  sse: SseWriter
  abortController: AbortController | null
  busy: boolean
  /** root=主会话；subagent=子代理（同一会话树里的一个 agent，共享画布，不是独立 workspace） */
  mode: 'root' | 'subagent'
  parentId?: string
  /** 会话所属画布（durable；子代理继承父会话，整棵树读写同一份文档） */
  canvasId: string
  agentName?: string
  description?: string
  /** 本会话使用的代理角色（lead / mcmod / modeling）；每个回合都可以切换 */
  profile: string
  /** 会话绑定的本地工作目录（左栏显示、mcdev 工具的相对根） */
  cwd: string
  status: SubagentStatus
  lastError?: string
  lastText?: string
  durationMs?: number
  outputTokens?: number
  /**
   * 本批次仍在跑的子代理 id（dsh `ActivationPool` 里"未结算 activation"的对应物）。
   * 非空 = 会话处于 `waiting`：既不是 idle 也不是 running，用户不能插话。
   */
  waiting: Set<string>
  /** 已结算、还没交回模型的子代理结果（dsh 结算收件箱；父会话忙时先在这里排队） */
  settlements: SettledChild[]
  /** 自动汇总回合进行中（防重入：结算触发 + 回合收尾触发可能同时到达） */
  autoTurn: boolean
  /** 计划模式 / 待办 / 授权（dsh plan-mode + todo + approval 的会话级状态） */
  coop: CoopState
}

/** 一个已结算的子代理：字段对齐 dsh `SubagentResult` + `SubagentSettledMessageSource` */
interface SettledChild {
  childId: string
  name: string
  description?: string
  status: SubagentStatus
  stopReason: 'completed' | 'aborted' | 'error'
  /** 子代理收尾文本（dsh: "Its closing message:" 段） */
  closingText: string
  summary: string
}

class SseWriter {
  private subs = new Set<(frame: string) => void>()
  private seq = 0
  /** 进行中回合的帧缓冲：客户端晚连/断线重连时补发（dsh 事件流语义的简化版） */
  private buffer: { id: number; frame: string }[] = []
  private buffering = false

  beginTurn() {
    this.buffering = true
    this.buffer = []
  }

  endTurn() {
    this.buffering = false
    this.buffer = []
  }

  subscribe(fn: (frame: string) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  send(topic: string, data: Record<string, any> = {}) {
    const id = ++this.seq
    const frame = `id: ${id}\ndata: ${JSON.stringify({ topic, ...data })}\n\n`
    if (this.buffering) {
      this.buffer.push({ id, frame })
      if (this.buffer.length > 5000) this.buffer.splice(0, 1000)
    }
    for (const fn of this.subs) fn(frame)
  }

  /**
   * 分配下一个帧序号：画布等"会话外"事件也走同一条编号空间，
   * 客户端的 lastEventId 去重与重连语义才成立（无 id 的帧会被当成重复丢掉）。
   */
  nextId(): number {
    return ++this.seq
  }

  /** 只补发"当前进行中回合"的帧，避免历史回合的增量被重复渲染 */
  replay(sinceId: number): string[] {
    if (!this.buffering) return []
    return this.buffer.filter(b => b.id > sinceId).map(b => b.frame)
  }
}


type MetaFields = Partial<Pick<SessionEntry,
  'mode' | 'parentId' | 'canvasId' | 'agentName' | 'description' | 'status' | 'lastError' | 'lastText' | 'durationMs' | 'outputTokens'>>

/** 会话元数据落盘：模型选择 + 创建时间 + 标题 + 画布归属 + 子代理结果。任何"会话状态变了"的时机都要调它 */
function persistMeta(entry: SessionEntry) {
  try {
    const firstUser = entry.log.all().find(e => e.t === 'user/message') as { text?: string } | undefined
    const patch: import('./session-store.js').SessionMeta = {
      modelId: entry.runtime.currentModelId,
      createdAt: entry.createdAt,
    }
    // 画布归属是 durable 契约：等价 dsh 把 cwd 钉在会话头部
    if (entry.canvasId) patch.canvasId = entry.canvasId
    // 工作目录同样 durable（左栏会读它显示"这个会话在改哪个目录"）
    if (entry.cwd) patch.cwd = entry.cwd
    // 只有真的取到标题才写：否则 merge 会把已有标题抹掉
    if (firstUser) patch.title = summarize(firstUser.text)
    if (entry.profile) patch.profile = entry.profile
    // 协作状态（计划模式 / 待办 / 授权）是 durable 的：重开页面、重启服务都要恢复
    patch.planMode = entry.coop.planMode
    patch.todos = entry.coop.todos
    patch.permission = entry.coop.permission
    patch.allowedTools = [...entry.coop.allowedTools]
    if (entry.mode === 'subagent') {
      patch.mode = 'subagent'
      if (entry.parentId) patch.parentId = entry.parentId
      if (entry.agentName) patch.agentName = entry.agentName
      if (entry.description) patch.description = entry.description
      // running 由进程内状态推导，不落盘（重启后不会卡在"运行中"）
      if (entry.status && entry.status !== 'running') patch.lastStatus = entry.status
      if (entry.lastError) patch.lastError = entry.lastError
      if (entry.lastText) patch.lastText = entry.lastText
      if (entry.durationMs != null) patch.durationMs = entry.durationMs
      if (entry.outputTokens != null) patch.outputTokens = entry.outputTokens
    }
    sessionStore.writeMeta(entry.id, patch)
  } catch (e: any) {
    console.warn(`[session] 元数据落盘失败 ${entry.id}:`, e?.message ?? e)
  }
}

/**
 * 计划模式切换（dsh plan/mode）：durable 一次写三处——
 * 日志（回放即状态）、SSE（前端立刻切只读提示）、meta（重启恢复）。
 */
function setPlanModeOf(entry: SessionEntry, active: boolean, source = 'user') {
  if (entry.coop.planMode === active) return
  entry.coop.planMode = active
  entry.log.append('plan/mode', { active, source })
  entry.sse.send('plan/mode', { active, source, sessionId: entry.id })
  persistMeta(entry)
}

/** 待办整表替换（dsh todo/write）：日志 + SSE + meta，UI「计划」标签与系统提示同源 */
function setTodosOf(entry: SessionEntry, list: CoopState['todos']) {
  entry.coop.todos = list
  entry.log.append('todo/write', { todos: list })
  entry.sse.send('todo/update', { todos: list, sessionId: entry.id })
  persistMeta(entry)
}

interface CreateSessionOptions {  parentId?: string
  agentName?: string
  description?: string
  modelId?: string
  /** 会话所属画布：子代理在这里继承父会话的画布（等价 dsh 子会话继承 cwd） */
  canvasId?: string
  /** 会话绑定的本地工作目录；缺省落 DEFAULT_CWD，子代理继承父会话 */
  cwd?: string
}

function createSession(id = randomUUID().slice(0, 8), opts: CreateSessionOptions = {}): SessionEntry {
  if (!isValidSessionId(id)) throw new Error('非法会话 id')
  // 先占位空日志 + 读到旧 meta：这样"新建后刷新/重启"仍然是一个存在的会话
  sessionStore.ensureLogFile(id)
  const meta = sessionStore.readMeta(id)
  const log = new SessionLog(sessionStore.logPath(id))
  const sse = new SseWriter()
  const mode = meta.mode ?? (meta.parentId || opts.parentId ? 'subagent' : 'root')
  const parentId = meta.parentId ?? opts.parentId
  const agentName = meta.agentName ?? opts.agentName
  const description = meta.description ?? opts.description
  // 画布归属：durable 值优先，其次继承父会话，最后才是自己——永不产生"第二个 workspace"
  const canvasId = meta.canvasId ?? opts.canvasId ?? (mode === 'root' ? id : canvas.idOf(parentId ?? id))
  canvas.adopt(id, canvasId)
  // 工作目录：durable 值优先 → 创建参数 → 父会话继承 → 全局默认（MC_PROJECTS_ROOT 之上）
  const parentCwd = parentId ? (sessions.get(parentId)?.cwd ?? sessionStore.readMeta(parentId).cwd) : undefined
  const cwd = meta.cwd ?? opts.cwd ?? parentCwd ?? DEFAULT_CWD

  // —— 协作状态恢复：meta 优先；老日志里可能只有 plan/mode、todo/write 事件 ——
  const lastEvent = (t: string) => {
    const all = log.all()
    for (let i = all.length - 1; i >= 0; i--) if (all[i].t === t) return all[i]
    return undefined
  }
  const loggedPlan = lastEvent('plan/mode')?.active
  const loggedTodos = lastEvent('todo/write')?.todos
  const coop: CoopState = {
    planMode: typeof meta.planMode === 'boolean' ? meta.planMode : (loggedPlan ?? false),
    todos: meta.todos !== undefined ? (meta.todos ?? null) : (loggedTodos ?? null),
    permission: meta.permission === 'auto' ? 'auto' : 'ask',
    allowedTools: new Set(Array.isArray(meta.allowedTools) ? meta.allowedTools.map(String) : []),
  }
  let entry: SessionEntry | undefined

  /** 计划模式变更：日志（可回放）+ SSE + meta 一次完成 */
  const applyPlanMode = (active: boolean, source = 'user') => {
    if (entry) setPlanModeOf(entry, active, source)
  }
  /** 待办变更：整表替换（dsh todo_write 语义） */
  const applyTodos = (list: CoopState['todos']) => {
    if (entry) setTodosOf(entry, list)
  }

  const runtime = createSessionRuntime(
    {
      sessionId: id,
      log,
      llm,
      env,
      resolveModel: modelId => settingsStore.modelDirectory()[modelId],
      // 请求投影期才把引用还原成字节（日志不含 base64，与 dsh readImageRequest 同位置）
      resolveImage: ref => attachments.dataUrl(ref),
      defaultModelId: settingsStore.defaultModelId(),
      canvas,
      cwd,
      // 会话级协作状态：运行时只读，写入走上面的 apply*（durable + 广播）
      planMode: () => coop.planMode,
      setPlanMode: active => applyPlanMode(!!active, 'tool'),
      todos: () => coop.todos,
      setTodos: list => applyTodos(list),
      // 授权：策略/白名单在会话上，弹窗走 interactionHub（一次授权只对本次调用有效）
      approval: {
        policy: () => coop.permission,
        allowed: toolName => coop.allowedTools.has(toolName),
        remember: toolName => {
          coop.allowedTools.add(toolName)
          if (entry) persistMeta(entry)
        },
        request: req => interactionHub.approval.request({ ...req, sessionId: id }),
      },
      emit: (topic, data) => {
        sse.send(topic, data)
        bus.emit(topic, data)
      },
    },
    { tools, skillProviders, systemSections, profiles: AGENT_PROFILES, beforeStepHooks, overflowHooks },
  )

  // 恢复会话级模型选择：meta 优先，其次创建参数（子代理继承父模型），失效则回落默认
  const dir = settingsStore.modelDirectory()
  const wanted = meta.modelId && dir[meta.modelId]
    ? meta.modelId
    : (opts.modelId && dir[opts.modelId] ? opts.modelId : undefined)
  if (wanted) runtime.setCurrentModel(wanted)

  entry = {
    id,
    // 老会话可能没有 meta：用日志首事件时间兜底，避免"一打开就变成今天创建的"
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : (log.all()[0]?.ts ?? Date.now()),
    log,
    runtime,
    sse,
    abortController: null,
    busy: false,
    mode,
    parentId,
    canvasId,
    cwd,
    agentName,
    description,
    profile: meta.profile ?? (mode === 'root' ? 'lead' : 'modeling'),
    status: meta.lastStatus ?? 'idle',
    lastError: meta.lastError,
    lastText: meta.lastText,
    durationMs: meta.durationMs,
    outputTokens: meta.outputTokens,
    waiting: new Set<string>(),
    settlements: [],
    autoTurn: false,
    coop,
  }
  sessions.set(id, entry)
  // 立即落盘（含被纠正后的模型 id 与画布归属），保证"只建会话没聊天"的会话也不丢
  persistMeta(entry)

  return entry
}

async function ensureSession(id: string): Promise<SessionEntry> {
  let entry = sessions.get(id)
  if (!entry) {
    // 磁盘上有（日志或 meta）即可恢复；不再要求"必须已有 jsonl 事件"。
    // 画布归属由 CanvasService 从 meta.canvasId 解析（缺失时沿 parentId 回溯），
    // 因此这里不需要先把父会话恢复出来——恢复顺序与画布无关。
    if (!sessionStore.exists(id)) throw new Error('会话不存在')
    entry = createSession(id)
  }
  return entry
}

// ---- 项目归属 / 归档门控（dsh workspace registry + archived-session-gate 的对应物） ----

/** 父会话 id：内存优先，其次磁盘 meta（子代理链路的归档判定要用它回溯） */
function parentOfSession(id: string): string | undefined {
  return sessions.get(id)?.parentId ?? sessionStore.readMeta(id).parentId
}

/** 会话自身或祖先被归档即视为归档（归档主会话 = 整棵子代理树一起停） */
function isArchivedLineage(id: string): boolean {
  return projectStore.isArchivedLineage(id, parentOfSession)
}

/** 会话树下所有后代 id（含自己） */
function descendantIds(rootId: string): string[] {
  const out = [rootId]
  for (let i = 0; i < out.length; i++) {
    for (const s of sessions.values()) {
      if (s.parentId === out[i] && !out.includes(s.id)) out.push(s.id)
    }
  }
  return out
}

/** 归档准入探测：这一轮还跑着、或有子代理在跑，就不许静默归档 */
function sessionActivity(id: string): SessionActivity[] {
  const out: SessionActivity[] = []
  const entry = sessions.get(id)
  if (entry?.busy) out.push({ kind: 'turn' })
  const running = descendantIds(id)
    .slice(1)
    .map(childId => sessions.get(childId))
    .filter((child): child is SessionEntry => !!child && child.status === 'running')
  if (running.length > 0) {
    out.push({
      kind: 'subagent',
      items: running.map(child => ({ id: child.id, label: child.agentName ?? child.id })),
    })
  }
  return out
}

/** 归档后停止这棵树的工作：中断当前回合 + 把子代理标记为已中止 */
function stopSessionWork(id: string) {
  for (const targetId of descendantIds(id)) {
    const target = sessions.get(targetId)
    if (!target) continue
    try { target.abortController?.abort() } catch { /* 已结束 */ }
    // 阻塞在提问/授权上的工具必须被结算掉，否则回合永远挂着
    interactionHub.cancelSession(targetId, 'session-stopped')
    // 会话的终端（含子代理的）一并收掉：归档不等于留着后台进程
    terminals.killSession(targetId)
    if (target.status === 'running') {
      target.status = 'stopped'
      persistMeta(target)
      target.sse.send('subagent/status', { status: 'stopped' })
    }
    // 归档的会话不该再被自动汇总唤醒：等待集合与结算收件箱一并清掉
    if (target.waiting.size > 0) target.waiting.clear()
    if (target.settlements.length > 0) target.settlements = []
  }
}

// ---- 子代理（dsh 风格：独立子会话 + 并发 + 目录面板，不向主对话自动发消息） ----
// 并发上限来自设置（子代理页），env 只作为默认值兜底
const ENV_MAX_ACTIVE_SUBAGENTS = Math.max(1, Number(env.MAX_ACTIVE_SUBAGENTS ?? 4) || 4)
function maxActiveSubagents(): number {
  return settingsStore.getPrefs().maxActiveSubagents ?? ENV_MAX_ACTIVE_SUBAGENTS
}
const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: '运行中',
  done: '已完成',
  error: '出错',
  stopped: '已中止',
  idle: '未运行',
}

function subagentStatusLabel(s: SubagentStatus): string {
  return SUBAGENT_STATUS_LABEL[s] ?? s
}

function siblingNames(parentId: string): Set<string> {
  const names = new Set<string>()
  for (const row of sessionStore.list()) {
    if (row.parentId === parentId && row.agentName) names.add(row.agentName)
  }
  for (const s of sessions.values()) {
    if (s.parentId === parentId && s.agentName) names.add(s.agentName)
  }
  return names
}

function pickAgentName(parentId: string, requested?: string): string {
  const used = siblingNames(parentId)
  if (requested) {
    if (requested === 'lead' || !AGENT_NAME_RE.test(requested)) {
      throw new Error(`非法子代理名 "${requested}"（小写字母开头，仅小写字母/数字/连字符，且不能是 lead）`)
    }
    if (used.has(requested)) throw new Error(`子代理名 "${requested}" 已被同级使用`)
    return requested
  }
  for (let i = 1; ; i++) {
    const name = `agent-${i}`
    if (!used.has(name)) return name
  }
}

function liveSubagentCount(parentId: string): number {
  let n = 0
  for (const s of sessions.values()) {
    if (s.parentId === parentId && (s.busy || s.status === 'running')) n++
  }
  return n
}

/** 子代理目录：磁盘 meta + 进程内实时状态 */
function subagentRows(parentId: string): SessionSummary[] {
  const rows = sessionStore.list()
    .filter(r => r.mode === 'subagent' && r.parentId === parentId)
    .map(r => {
      const live = sessions.get(r.id)
      if (!live) return r
      return {
        ...r,
        status: live.status,
        lastError: live.lastError ?? r.lastError,
        lastText: live.lastText ?? r.lastText,
        durationMs: live.durationMs ?? r.durationMs,
        outputTokens: live.outputTokens ?? r.outputTokens,
        updatedAt: Math.max(r.updatedAt, live.createdAt),
      }
    })
  // 运行中的排前面，其余按创建时间新→旧
  return rows.sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
    return b.createdAt - a.createdAt
  })
}

/** 终止原因：对齐 dsh `SubagentStopReasonMap` 的词汇（completed/aborted/error/…） */
function stopReasonOf(status: SubagentStatus): 'completed' | 'aborted' | 'error' {
  switch (status) {
    case 'done': return 'completed'
    case 'error': return 'error'
    default: return 'aborted'
  }
}

/**
 * 结算：dsh `notifySettlement()` 的等价物。
 *
 * 主代理派发的子代理都登记在 `parent.waiting` 里（dsh 的未结算 activation）。
 * 结算做三件事：出等待集合 → 进结算收件箱 → 最后一只落地时自动开一轮汇总。
 * 用户手动给子代理派活（不在等待集合里）的，仍走旧的独立通知行，不唤醒主会话——
 * 那是"人和子代理的对话"，不该让主代理插进来。
 */
function settleChild(parent: SessionEntry, child: SessionEntry) {
  notifySubagentUpdate(child)
  const owed = parent.waiting.delete(child.id)
  const status = child.status
  const closingText = child.lastText || ''
  const settled: SettledChild = {
    childId: child.id,
    name: child.agentName ?? child.id,
    description: child.description,
    status,
    stopReason: stopReasonOf(status),
    closingText,
    summary: summarize(closingText || child.lastError || '', 160),
  }

  // 关闭「自动唤醒」时，批量派发的子代理也只落通知行：主会话不会自己开新一轮。
  // 这正是 dsh 里"下一个结果开启新回合"的开关语义——关掉即退化成纯通知。
  const autoWake = settingsStore.getPrefs().autoWake
  if (!owed || !autoWake) {
    // 非本批次（用户直接对话的子代理）：只落紧凑通知行，不进入自动汇总
    try {
      const notice = {
        kind: 'subagent-settled' as const,
        form: 'notice' as const,
        senderSessionId: child.id,
        childId: child.id,
        name: settled.name,
        description: settled.description ?? '',
        status,
        stopReason: settled.stopReason,
        summary: settled.summary,
      }
      const ev = parent.log.append('subagent/notice', notice)
      parent.sse.send('subagent/notice', { sessionId: parent.id, ...notice, seq: ev.seq, at: ev.ts })
    } catch (e: any) {
      console.warn('[subagent] 通知写入失败:', e?.message ?? e)
    }
    // 批次里的一只落地也要推等待帧，否则关闭自动唤醒后输入会一直锁着
    if (owed) parent.sse.send('session/waiting', { sessionId: parent.id, waiting: waitingRows(parent) })
    return
  }

  parent.settlements.push(settled)
  parent.sse.send('session/waiting', { sessionId: parent.id, waiting: waitingRows(parent) })
  if (parent.waiting.size === 0) void maybeAutoContinue(parent)
}

/** 等待中的子代理（给 UI 的等待条 / open 帧 / GET 会话详情） */
function waitingRows(parent: SessionEntry) {
  // 自愈：等待集合里若有 id 在内存中已不存在（异常路径），就地剔除，
  // 否则 waiting.size 永远 > 0 —— 输入被永久锁死、自动汇总也永不触发
  for (const id of [...parent.waiting]) if (!sessions.get(id)) parent.waiting.delete(id)
  return [...parent.waiting]
    .map(id => sessions.get(id))
    .filter((c): c is SessionEntry => !!c)
    .map(c => ({
      id: c.id,
      name: c.agentName ?? c.id,
      description: c.description ?? '',
      status: c.status,
    }))
}

/**
 * 自动汇总回合：dsh "the next result starts a new turn" 的落点。
 *
 * 结算消息在 dsh 里是一条 `source: subagent-settled` 的 user 消息，父会话 idle 时
 * 走 `queue` 唤醒新一轮。openmods 没有 steer 通道，所以父会话忙时先把结果留在
 * `settlements` 里，由回合收尾（runSessionTurn 末尾）再来一次。
 */
async function maybeAutoContinue(parent: SessionEntry) {
  if (parent.busy || parent.autoTurn) return
  if (parent.waiting.size > 0 || !parent.settlements.length) return
  // 归档的会话不再被自动唤醒（dsh archived-session-gate）
  if (isArchivedLineage(parent.id)) {
    parent.settlements = []
    return
  }
  const batch = parent.settlements.splice(0)
  parent.autoTurn = true
  try {
    await runSessionTurn(parent, {
      text: formatSettlementPrompt(batch),
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        settled: batch.map(b => ({
          childId: b.childId,
          name: b.name,
          description: b.description,
          status: b.status,
          stopReason: b.stopReason,
          summary: b.summary,
        })),
      },
    })
  } catch (e: any) {
    console.warn('[subagent] 自动汇总回合失败:', e?.message ?? e)
  } finally {
    parent.autoTurn = false
    // 汇总回合运行期间又有一批结算到达：这时的 afterRootTurn 会撞上 autoTurn 标记，
    // 所以在这里复查一次，避免这批结果被静默吞掉（dsh 靠 steer 通道不存在这个问题）
    if (!parent.busy && parent.waiting.size === 0 && parent.settlements.length > 0) {
      void maybeAutoContinue(parent)
    }
  }
}

/** 结算消息正文：对齐 dsh `createSettlementMessage()` 的措辞，再接一段汇总/验收要求 */
function formatSettlementPrompt(batch: SettledChild[]): string {
  const parts: string[] = []
  for (const b of batch) {
    const subject = `Background subagent ${b.name}`
    const head = b.stopReason === 'completed'
      ? `${subject} finished and will do no further work unless you send it more.`
      : b.stopReason === 'error'
        ? `${subject} failed before it finished.`
        : `${subject} was stopped before it finished.`
    parts.push(head)
    if (b.closingText.trim()) {
      parts.push('Its closing message:', b.closingText.trim())
    } else {
      parts.push('It left no closing message.')
    }
  }
  parts.push(
    '',
    '[runtime] 子代理已全部结算，这一轮是自动开启的汇总回合。收尾前必须完成验收：',
    '1) 用 list_outline / list_animations 核对画布现状（部件数、贴图、动画、分组命名），确认每个子代理负责的部分都在；',
    '2) 有重叠部件、命名冲突、漏做或明显错误就直接修（只补缺口，不要重做整块，更不要 create_model）；',
    '3) 最后向用户汇报：每个子代理做了什么、画布最终状态、还有什么没完成。不要只说"已完成"。',
  )
  return parts.join('\n')
}

/**
 * 启动子代理：立即返回，后台并发执行。
 * 子代理是**同一会话树**里的一个 agent（复刻 dsh startActivation 的 parent/child 关系）：
 * 有自己的对话日志与上下文，但共享当前会话的画布——它改的就是用户正在看的那块画布。
 * 不占用父会话的 busy gate，但会登记到父会话的 `waiting`：主会话从此进入等待态
 * （用户不能插话），最后一只结算时自动开一轮汇总（dsh 的 settlement → 新回合）。
 */
function startSubagent(parent: SessionEntry, input: { description: string; prompt: string; name?: string }): SessionEntry {
  if (parent.mode === 'subagent') throw new Error('子代理不能再派发子代理（深度上限 1）')
  if (isArchivedLineage(parent.id)) throw new Error('会话已归档，不能再派发子代理')
  if (!input.prompt.trim()) throw new Error('prompt 不能为空')
  if (liveSubagentCount(parent.id) >= maxActiveSubagents()) {
    throw new Error(`同时运行的子代理已达上限 ${maxActiveSubagents()} 个，等一个完成后再派发`)
  }
  const name = pickAgentName(parent.id, input.name)
  const id = randomUUID().slice(0, 8)
  const child = createSession(id, {
    parentId: parent.id,
    // 子代理继承父会话的画布（dsh：childSessionMeta 带上 parentHeader.cwd）
    canvasId: parent.canvasId,
    agentName: name,
    description: input.description,
    modelId: parent.runtime.currentModelId,
  })
  child.status = 'running'
  // 派发即登记：主会话的等待集合是"这次派发还没回来"的唯一事实源
  parent.waiting.add(child.id)
  parent.sse.send('subagent/updated', {
    childId: child.id, name, description: child.description, status: 'running',
  })
  parent.sse.send('session/waiting', { sessionId: parent.id, waiting: waitingRows(parent) })
  void runSessionTurn(child, { text: input.prompt, profile: 'modeling', modelId: child.runtime.currentModelId })
    .catch(e => {
      console.warn('[subagent] 运行异常:', e?.message ?? e)
      // 兜底：回合在结算前炸掉也要解锁，否则主会话永远卡在等待态
      if (parent.waiting.has(child.id)) {
        child.status = 'error'
        child.lastError = e?.message ?? String(e)
        settleChild(parent, child)
      }
    })
  return child
}

function notifySubagentUpdate(child: SessionEntry) {
  const parent = child.parentId ? sessions.get(child.parentId) : undefined
  if (!parent) return
  parent.sse.send('subagent/updated', {
    childId: child.id,
    name: child.agentName,
    description: child.description,
    status: child.status,
    durationMs: child.durationMs,
    outputTokens: child.outputTokens,
  })
}

/**
 * 执行一轮对话：先挂 busy + 开启帧缓冲，结束后统一落盘、发 stats/done、关闭缓冲。
 * 子代理会话复用同一条路径——状态、父会话结算、独立画布都在这里收口。
 */
async function runSessionTurn(
  s: SessionEntry,
  opts: {
    text: string
    attachments?: any[]
    modelId?: string
    mode?: 'build' | 'refine'
    profile?: string
    /** 回合输入归属：自动汇总回合由 runtime 投递（dsh MessageSource） */
    source?: import('@openmods/agent-core').TurnSource
  },
) {
  const startedAt = Date.now()
  const aborter = new AbortController()
  s.busy = true
  s.abortController = aborter
  s.sse.beginTurn()
  const isSubagent = s.mode === 'subagent'
  if (isSubagent) {
    s.status = 'running'
    s.lastError = undefined
    notifySubagentUpdate(s)
  }

  let result: { text: string; aborted: boolean } | undefined
  let failure: Error | undefined
  try {
    result = await s.runtime.runTurn(opts, aborter.signal)
  } catch (e: any) {
    failure = e
  }

  s.busy = false
  s.abortController = null

  if (isSubagent) {
    const stats = projectStats(s.log.all())
    s.durationMs = Date.now() - startedAt
    s.outputTokens = stats.totals.outputTokens
    if (failure) {
      s.status = 'error'
      s.lastError = failure.message
    } else {
      s.status = result?.aborted ? 'stopped' : 'done'
      s.lastText = result?.text ?? ''
    }
    persistMeta(s)
    if (failure) s.sse.send('error', { message: failure.message })
    s.sse.send('stats', {
      ...stats,
      ...contextFigures(s),
    })
    s.sse.send('done', { text: result?.text ?? '', aborted: result?.aborted ?? false })
    s.sse.endTurn()
    const parent = s.parentId ? sessions.get(s.parentId) : undefined
    if (parent) settleChild(parent, s)
    return
  }

  // 无论成功/中止/报错都落盘：模型选择与首条消息标题不能因异常而丢失
  persistMeta(s)
  // 先把"仍在等待"告诉前端，再发 done：否则按钮会先闪一下"发送"再变"取消等待"
  const waitingNow = waitingRows(s)
  if (waitingNow.length > 0) s.sse.send('session/waiting', { sessionId: s.id, waiting: waitingNow })
  if (failure) {
    s.sse.send('error', { message: failure.message })
  } else {
    s.sse.send('stats', {
      ...projectStats(s.log.all()),
      ...contextFigures(s),
    })
    s.sse.send('done', { text: result?.text ?? '', aborted: result?.aborted ?? false })
  }
  s.sse.endTurn()
  afterRootTurn(s)
}

/**
 * 主会话回合收尾：决定"继续等 / 立刻汇总 / 真正空闲"。
 * 这是 dsh 里 `parent.status === 'idle' ? queue : steer` 那段分派在 openmods 的落点——
 * 没有 steer 通道，所以忙时结算先留在收件箱，由这里再启动。
 */
function afterRootTurn(s: SessionEntry) {
  // 先跑一遍 waitingRows 触发自愈（剔除已不存在的子代理），再判断去留
  const waiting = waitingRows(s)
  if (waiting.length > 0) {
    s.sse.send('session/waiting', { sessionId: s.id, waiting })
    return
  }
  if (s.settlements.length > 0) {
    void maybeAutoContinue(s)
    return
  }
  s.sse.send('session/waiting', { sessionId: s.id, waiting: [] })
}

/**
 * 上下文占用三件套：环的分子/分母 + 图形化面板的三段构成。
 * 会话详情、`/stats` 接口、每次 stats SSE 帧都从这里取，保证环、数字、图永远一致。
 */
function contextFigures(s: SessionEntry) {
  const contextTokens = s.runtime.estimateContextTokens()
  return {
    contextTokens,
    modelWindow: s.runtime.getModelContextWindow(),
    contextBreakdown: s.runtime.contextBreakdown(contextTokens),
  }
}

// ---- 内部事件 → SSE 桥 ----
// 画布变更不再由 server 手动 fan-out：CanvasService 是唯一权威，一次 commit 广播一次，
// 每条 SSE 连接自己按 canvasId 过滤（与 dsh 的事件总线 + 会话投影同构）。
bus.on('compaction/done', (data: any) => {
  const s = sessions.get(data.sessionId)
  if (!s) return
  s.sse.send('compaction', data)
  s.sse.send('stats', {
    ...projectStats(s.log.all()),
    ...contextFigures(s),
  })
})

// ---- Fastify ----
const app = Fastify({ logger: false, bodyLimit: 15 * 1024 * 1024 })

app.get('/api/health', async () => ({ ok: true, mock: MOCK, plugins: loadedPlugins.map(p => p.name) }))

// 可选代理角色（dsh agentPreset 的简化版）：modeling 是内部子代理角色，不出现在这里
app.get('/api/profiles', async () => ({
  profiles: Object.values(AGENT_PROFILES)
    .filter(p => p.id !== 'modeling')
    .map(p => ({ id: p.id, name: p.name })),
}))

// ---- 设置 → 代理与技能 ----

/** 按角色解析生效工具（与 runtime 的 selectTools 同一语义：白名单 ∩ 非排除） */
function resolveProfileTools(profileId: string): { name: string; description: string }[] {
  const p = AGENT_PROFILES[profileId]
  if (!p) return []
  let list = tools
  if (p.toolFilter) list = list.filter(t => p.toolFilter!.includes(t.name))
  if (p.toolExclude) list = list.filter(t => !p.toolExclude!.includes(t.name))
  return list.map(t => ({ name: t.name, description: t.description.split('\n')[0] }))
}

/** 设置页看全三个角色（含 modeling 子代理）：工具清单 + 技能分配 */
app.get('/api/agents/detail', async () => ({
  agents: Object.values(AGENT_PROFILES).map(p => ({
    id: p.id,
    name: p.name,
    prompt: p.prompt,
    tools: resolveProfileTools(p.id),
    skills: effectiveSkills(p.id),
  })),
  allSkills: skillProviders.flatMap(p => p.list()),
}))

/** 改某角色的技能分配（持久化覆盖默认值） */
app.patch('/api/agents/:id/skills', async (req, reply) => {
  const { id } = req.params as { id: string }
  if (!AGENT_PROFILES[id]) return reply.code(404).send({ error: `角色不存在: ${id}` })
  const { skills } = req.body as { skills?: unknown }
  if (!Array.isArray(skills) || skills.some(s => typeof s !== 'string')) {
    return reply.code(400).send({ error: 'skills 必须是字符串数组' })
  }
  const known = new Set(skillProviders.flatMap(p => p.list().map(m => m.name)))
  profileSkillsOverrides[id] = [...new Set(skills.map(String))].filter(s => known.has(s))
  saveSkillsOverrides()
  return { ok: true, skills: profileSkillsOverrides[id] }
})

const CUSTOM_SKILLS_PATH = join(ROOT, 'data', 'custom-skills.json')
function readCustomSkills(): string[] {
  try { return JSON.parse(readFileSync(CUSTOM_SKILLS_PATH, 'utf8')) } catch { return [] }
}
function writeCustomSkills(names: string[]) {
  mkdirSync(dirname(CUSTOM_SKILLS_PATH), { recursive: true })
  writeFileSync(CUSTOM_SKILLS_PATH, JSON.stringify(names, null, 2))
}
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** 技能列表（custom 标记用户注入的） */
app.get('/api/skills', async () => {
  const custom = new Set(readCustomSkills())
  return { skills: skillProviders.flatMap(p => p.list()).map(s => ({ ...s, custom: custom.has(s.name) })) }
})

/** 读技能全文（编辑用） */
app.get('/api/skills/:name', async (req, reply) => {
  const { name } = req.params as { name: string }
  const meta = skillProviders.flatMap(p => p.list()).find(s => s.name === name)
  if (!meta) return reply.code(404).send({ error: `技能不存在: ${name}` })
  try {
    return { name, description: meta.description, content: readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8') }
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message ?? String(e) })
  }
})

/** 注入/更新技能：写 skills/<name>/SKILL.md（热扫描，下一次会话即生效） */
app.put('/api/skills/:name', async (req, reply) => {
  const { name } = req.params as { name: string }
  if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: '技能名只能用小写字母/数字/连字符（2-64 位）' })
  const { description, content } = req.body as { description?: unknown; content?: unknown }
  const desc = String(description ?? '').trim().slice(0, 300)
  const body = String(content ?? '').slice(0, 400_000)
  if (!desc) return reply.code(400).send({ error: 'description 不能为空（会进系统提示，模型靠它决定是否加载）' })
  if (!body.trim()) return reply.code(400).send({ error: 'content 不能为空' })
  // 内置技能只读：磁盘上已存在且不在 custom 清单里的名字不允许覆盖（保护随项目分发的技能）
  if (existsSync(join(SKILLS_DIR, name, 'SKILL.md')) && !readCustomSkills().includes(name)) {
    return reply.code(400).send({ error: '内置技能只读，不能覆盖；请换个名字注入' })
  }
  const dir = join(SKILLS_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`)
  const custom = readCustomSkills()
  if (!custom.includes(name)) writeCustomSkills([...custom, name])
  return { ok: true, name, description: desc }
})

/** 删除技能（含目录）；仍被角色分配引用时先从分配里摘除 */
app.delete('/api/skills/:name', async (req, reply) => {
  const { name } = req.params as { name: string }
  const dir = join(SKILLS_DIR, name)
  if (!existsSync(join(dir, 'SKILL.md'))) return reply.code(404).send({ error: `技能不存在: ${name}` })
  // 内置技能不可删除（只能删用户注入的）
  if (!readCustomSkills().includes(name)) {
    return reply.code(400).send({ error: '内置技能不可删除（随项目分发，仅可查看）' })
  }
  rmSync(dir, { recursive: true, force: true })
  writeCustomSkills(readCustomSkills().filter(n => n !== name))
  for (const id of Object.keys(AGENT_PROFILES)) {
    if (profileSkillsOverrides[id]) {
      profileSkillsOverrides[id] = profileSkillsOverrides[id].filter(s => s !== name)
    }
  }
  saveSkillsOverrides()
  return { ok: true }
})


// 模型目录：settings 动态合成（供应商 + 模型，含 key 状态）
app.get('/api/models', async () => {
  const models = Object.entries(settingsStore.modelDirectory()).map(([id, m]) => ({ id, ...m }))
  return { models, defaultModelId: settingsStore.defaultModelId() }
})

// ---- 设置（providers / credentials） ----
app.get('/api/settings', async () => ({ settings: settingsStore.getRedacted() }))

// 打开配置文件：下载原始 settings.json（对应 dsh 设置窗口的"打开配置文件"动作）
app.get('/api/settings/file', async (req, reply) => {
  const file = join(ROOT, 'data', 'settings.json')
  if (!existsSync(file)) return reply.code(404).send({ error: '配置文件不存在' })
  reply.header('content-type', 'application/json')
  reply.header('content-disposition', 'attachment; filename="settings.json"')
  return readFileSync(file)
})

app.put('/api/settings', async (req, reply) => {
  // providers / bridge / prefs 都是可选的：设置页按分区保存，不会互相覆盖
  const body = (req.body ?? {}) as { providers?: any; bridge?: any; prefs?: any; expectedRevision?: number }
  try {
    const newRevision = settingsStore.save(
      { providers: body.providers, bridge: body.bridge, prefs: body.prefs },
      body.expectedRevision,
    )
    // 广播（所有会话的 composer 模型选择器即时刷新）
    for (const s of sessions.values()) {
      s.sse.send('settings/updated', { revision: newRevision, prefs: settingsStore.getPrefs() })
      s.sse.send('models/updated', {})
    }
    return { ok: true, revision: newRevision, prefs: settingsStore.getPrefs() }
  } catch (e: any) {
    if (e.name === 'SettingsConflictError') return reply.code(409).send({ error: e.message })
    return reply.code(400).send({ error: e.message })
  }
})

app.put('/api/settings/credentials/:route', async (req, reply) => {
  const route = (req.params as any).route as string
  const body = (req.body ?? {}) as { apiKey?: string }
  try {
    settingsStore.setCredential(route, String(body.apiKey ?? ''))
    for (const s of sessions.values()) {
      s.sse.send('credentials/updated', { route })
      s.sse.send('models/updated', {})
    }
    return { ok: true }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 模型发现：向 OpenAI 兼容端点探测 /models（复刻 dsh llm.discoverModels）
/**
 * 解析模型列表里的一条能力声明 —— 搬运 dsh `llm-deepseek/src/listing.ts` 与
 * `llm-pi-ai` 的 discovery 解析：接受 data 数组或 models map，字段别名兼容各家网关。
 */
function normalizeListedModel(entry: any): { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number; inputModalities?: string[] } | undefined {
  if (typeof entry === 'string') return { id: entry }
  if (!entry || typeof entry !== 'object') return undefined
  const id = entry.id ?? entry.name ?? entry.model
  if (typeof id !== 'string' || !id.trim()) return undefined
  const top = entry.top_provider ?? {}
  const num = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
    return undefined
  }
  const contextWindow = num(
    entry.context_window, entry.context_length, entry.contextWindow,
    entry.max_input_tokens, entry.max_context_length, entry.max_model_len,
    top.context_length, entry.limits?.context_window,
  )
  const maxOutputTokens = num(
    entry.max_output_tokens, entry.max_tokens, entry.maxOutputTokens,
    top.max_completion_tokens, entry.limits?.max_output_tokens,
  )
  // 模态：dsh 用 `input_modalities`；OpenRouter 用 `architecture.input_modalities`；
  // 还有些网关只给 `capabilities`/`supports_vision` 布尔。
  const rawModalities = entry.input_modalities ?? entry.inputModalities
    ?? entry.architecture?.input_modalities ?? entry.architecture?.modality
    ?? entry.input
  let inputModalities: string[] | undefined
  if (Array.isArray(rawModalities)) {
    inputModalities = rawModalities
      .flatMap((m: any) => String(m).split(/[+/]/))
      .map((m: string) => m.trim().toLowerCase())
      .filter((m: string): m is string => m === 'text' || m === 'image')
  } else if (typeof rawModalities === 'string') {
    inputModalities = /image/.test(rawModalities) ? ['text', 'image'] : ['text']
  }
  if (!inputModalities?.length) {
    const visionFlag = entry.supports_vision ?? entry.vision ?? entry.capabilities?.vision
      ?? (Array.isArray(entry.capabilities) ? entry.capabilities.includes('vision') : undefined)
    if (typeof visionFlag === 'boolean') inputModalities = visionFlag ? ['text', 'image'] : ['text']
  }
  return {
    id,
    name: typeof entry.display_name === 'string' ? entry.display_name
      : typeof entry.name === 'string' && entry.name !== id ? entry.name : undefined,
    contextWindow, maxOutputTokens, inputModalities,
  }
}

app.post('/api/settings/discover-models', async (req, reply) => {
  const body = (req.body ?? {}) as { baseURL?: string; route?: string; apiKey?: string }
  const baseURL = String(body.baseURL ?? '').trim()
  if (!baseURL) return reply.code(400).send({ error: 'baseURL 不能为空' })
  const apiKey = body.apiKey?.trim() || (body.route ? settingsStore.getCredential(body.route) : undefined)
  try {
    const url = `${baseURL.replace(/\/+$/, '')}/models`
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      const hint = res.status === 401 || res.status === 403 ? '（API key 缺失或无效）' : ''
      return reply.code(400).send({ error: `端点返回 HTTP ${res.status}${hint} ${detail}` })
    }
    const json: any = await res.json()
    // dsh：标准 `data` 数组或富化的 `models` map 都接受
    const raw: any[] = Array.isArray(json) ? json
      : Array.isArray(json?.data) ? json.data
        : json?.models && typeof json.models === 'object' ? Object.entries(json.models).map(([k, v]) => ({ id: k, ...(v ?? {}) }))
          : []
    const models = raw.map(normalizeListedModel).filter((m): m is NonNullable<typeof m> => !!m)
    const seen = new Set<string>()
    const unique = models.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    if (!unique.length) return reply.code(400).send({ error: '端点响应中没有可识别的模型列表（期望 OpenAI 兼容 {data:[{id}]} 格式）' })
    return { models: unique }
  } catch (e: any) {
    const msg = e.name === 'TimeoutError' ? '端点连接超时（15s）' : `无法访问端点：${e.message}`
    return reply.code(400).send({ error: msg })
  }
})

// ---- 会话 ----
app.post('/api/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { projectId?: string; cwd?: string }
  // dsh 语义：在有关联目录的分组下新建会话，继承该分组的 cwd（显式 cwd 优先）
  // 必须在 createSession 之前解析——cwd 在会话创建时就要定下来并落 meta
  let cwd = body.cwd
  if (!cwd && body.projectId) {
    cwd = projectStore.get(body.projectId)?.cwd
  }
  const s = createSession(undefined, { cwd })
  // 在某个项目下新建的会话，直接记到该项目名下（dsh 在选中工作区里新建会话即 attach）
  if (body.projectId) {
    try {
      await projectStore.attach(body.projectId, s.id)
    } catch (e: any) {
      return reply.code(404).send({ error: e.message })
    }
  }
  return { id: s.id, projectId: body.projectId, cwd: s.cwd }
})

app.get('/api/sessions', async (req) => {
  const query = (req.query ?? {}) as { archived?: string }
  // hide=隐藏已归档（默认，dsh viewOptions.hideArchived）/ all=全部 / only=仅已归档
  const archivedView = query.archived === 'all' || query.archived === 'only' ? query.archived : 'hide'
  // 普通会话列表不含子代理会话（它们只在父会话的子代理面板里出现，复刻 dsh）
  const list = sessionStore.list().filter(s => s.mode !== 'subagent')
  // 画布归属以服务为准（历史数据没有 meta.canvasId 时会在服务里回溯父链）
  for (const row of list) {
    row.hasModel = canvas.has(row.id)
    // 历史会话没有 meta.cwd：列表按默认目录回显（真正绑定发生在下次打开/改绑时落盘）
    if (!row.cwd) row.cwd = DEFAULT_CWD
  }
  const known = new Set(list.map(s => s.id))
  for (const s of sessions.values()) {
    if (s.mode === 'subagent') continue
    if (!known.has(s.id)) {
      list.push({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: Date.now(),
        title: '',
        hasModel: canvas.has(s.id),
        mode: 'root',
        canvasId: s.canvasId,
        status: 'idle',
        modelId: s.runtime.currentModelId,
      })
    }
  }
  // 归档标记与项目归属都在 registry 里，会话自身不带这两个字段（dsh 同构）
  const archivedIds = new Set(projectStore.archivedSessionIds)
  for (const row of list) {
    row.archived = archivedIds.has(row.id)
    row.projectId = projectStore.projectOf(row.id)
  }
  const filtered = list.filter(row =>
    archivedView === 'all' ? true : archivedView === 'only' ? row.archived : !row.archived)
  return { sessions: filtered.sort((a, b) => b.updatedAt - a.updatedAt), archivedView }
})

// ---- 项目（dsh workspace-controller 的对应物） ----

/** 目录入参统一 realpath 校验（分组 cwd 与会话 cwd 共用）；返回 null 表示非法 */
function resolveDir(raw: string): string | null {
  const p = String(raw ?? '').trim()
  if (!p) return null
  try {
    const abs = realpathSync(p)
    return statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

/** 重连基线：项目 + 各自的会话记账 + 全局归档集合 */
app.get('/api/projects', async () => projectStore.baseline())

// ---- 资源管理器 / MC 工程状态（右侧 dock 的「测试 Mod」按钮、左栏的「打开目录」） ----

/** 用系统资源管理器打开目录（或定位文件）；纯 UI 动作，不经 LLM */
app.post('/api/explorer', async (req, reply) => {
  const body = (req.body ?? {}) as { path?: string }
  const raw = String(body.path ?? '').trim()
  if (!raw) return reply.code(400).send({ error: 'path 不能为空' })
  const abs = resolveDir(raw)
  if (!abs) return reply.code(400).send({ error: `目录不存在：${raw}` })
  if (process.platform !== 'win32') return reply.code(400).send({ error: '仅支持 Windows 资源管理器' })
  const { spawn } = await import('node:child_process')
  spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true }
})

const mcdevUi = await import('../../../plugins/mcdev/index.js')

/** 会话工作目录（durable），未绑定回落 DEFAULT_CWD；不存在时回落 MC_ROOT 同款解析 */
function sessionRoot(sessionId: string): string | null {
  if (!sessionStore.exists(sessionId)) return null
  const cwd = sessionStore.readMeta(sessionId).cwd
  const root = typeof cwd === 'string' && cwd.trim() ? cwd : DEFAULT_CWD
  try { return realpathSync(root) } catch { return null }
}

/** 会话 cwd 下的 MC 工程状态：构建结果 / runClient 运行中 / jar 产物 */
app.get('/api/mc/state', async (req, reply) => {
  const sid = String((req.query as any).sessionId ?? '')
  const root = sessionRoot(sid)
  if (!root) return reply.code(404).send({ error: '会话不存在或目录无效' })
  const projects = await mcdevUi.listMcProjects(root)
  return { root, projects }
})

/** jar 导出：把工程的最新构建产物复制到设置里的 mod-output 目录（prefs.modOutput） */
app.post('/api/mc/export', async (req, reply) => {
  const sid = String((req.body as any)?.sessionId ?? '')
  const project = String((req.body as any)?.project ?? '')
  const root = sessionRoot(sid)
  if (!root) return reply.code(404).send({ error: '会话不存在或目录无效' })
  const dest = settingsStore.getPrefs().modOutput
  if (!dest) return reply.code(400).send({ error: '尚未配置 mod-output：请到 设置 → 通用 → Mod 构建里填写 jar 导出目录' })
  const resolved = resolveDir(dest)
  if (!resolved) return reply.code(400).send({ error: `mod-output 目录不存在：${dest}` })
  const projects = await mcdevUi.listMcProjects(root)
  const p = projects.find(x => x.name === project) ?? projects[0]
  if (!p?.jars?.length) return reply.code(404).send({ error: '该工程还没有构建产物 jar（先跑 gradlew build）' })
  const jar = p.jars[0]
  try {
    const out = join(resolved, jar.name)
    await import('node:fs/promises').then(fs => fs.copyFile(jar.path, out))
    return { ok: true, name: jar.name, dest: out, size: jar.size }
  } catch (e: any) {
    return reply.code(500).send({ error: `复制失败：${e.message}` })
  }
})

/** 启动 runClient（等价 mc_gradle task=runClient background=true，同一套状态登记） */
app.post('/api/mc/run', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; project?: string }
  const root = sessionRoot(String(body.sessionId ?? ''))
  if (!root) return reply.code(404).send({ error: '会话不存在或目录无效' })
  const raw = String(body.project ?? '').trim()
  if (!raw) return reply.code(400).send({ error: 'project 不能为空' })
  const dir = raw.includes('\\') || raw.includes('/') ? resolve(raw) : resolve(root, raw)
  try { if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'build.gradle'))) throw new Error() } catch {
    return reply.code(400).send({ error: `不是有效的 MC 工程：${raw}` })
  }
  try {
    const r = await mcdevUi.startRunClient(dir, root)
    return { ok: true, ...r }
  } catch (e: any) {
    return reply.code(500).send({ error: e.message })
  }
})

/** 停掉工程的 runClient */
app.post('/api/mc/stop', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; project?: string }
  const root = sessionRoot(String(body.sessionId ?? ''))
  if (!root) return reply.code(404).send({ error: '会话不存在' })
  const dir = resolve(root, String(body.project ?? '').replace(/^[/\\]+/, ''))
  try { if (!statSync(dir).isDirectory()) throw new Error() } catch { return reply.code(400).send({ error: '工程目录不存在' }) }
  return { ok: true, stopped: mcdevUi.stopRunClient(dir) }
})

/** 下载构建出的 mod jar（必须是 .jar 且真实存在） */
app.get('/api/mc/jar', async (req, reply) => {
  const raw = String((req.query as any).path ?? '')
  if (!raw.endsWith('.jar')) return reply.code(400).send({ error: '只允许下载 .jar' })
  const abs = resolve(raw)
  try { if (!statSync(abs).isFile()) throw new Error() } catch { return reply.code(404).send({ error: '文件不存在' }) }
  const stream = (await import('node:fs')).createReadStream(abs)
  return reply.header('content-type', 'application/java-archive')
    .header('content-disposition', `attachment; filename="${encodeURIComponent(abs.split(/[\\/]/).pop() ?? 'mod.jar')}"`)
    .send(stream)
})

app.post('/api/projects', async (req, reply) => {
  const body = (req.body ?? {}) as { title?: string; cwd?: string }
  const title = String(body.title ?? '').trim()
  if (!title) return reply.code(400).send({ error: '项目名不能为空' })
  // 关联目录（可选）：给了就必须真实存在，存 realpath 后的绝对路径
  let cwd: string | undefined
  if (body.cwd) {
    const abs = resolveDir(body.cwd)
    if (!abs) return reply.code(400).send({ error: `目录不存在：${body.cwd}` })
    cwd = abs
  }
  return { project: await projectStore.create(title, cwd) }
})

app.patch('/api/projects/:pid', async (req, reply) => {
  const body = (req.body ?? {}) as { title?: string; cwd?: string | null }
  const title = body.title !== undefined ? String(body.title).trim() : undefined
  if (title !== undefined && !title) return reply.code(400).send({ error: '项目名不能为空' })
  try {
    const pid = (req.params as any).pid
    let view: any
    // 改目录：cwd 为空/null = 解除关联；给了就必须真实存在
    if (body.cwd !== undefined) {
      const abs = body.cwd ? resolveDir(body.cwd) : null
      if (body.cwd && !abs) return reply.code(400).send({ error: `目录不存在：${body.cwd}` })
      view = await projectStore.setCwd(pid, abs ?? '')
    }
    if (title !== undefined) view = await projectStore.rename(pid, title)
    if (!view) view = projectStore.get(pid)
    if (!view) return reply.code(404).send({ error: '项目不存在' })
    return { project: view }
  } catch (e: any) {
    return reply.code(404).send({ error: e.message })
  }
})

// 删除项目只删注册：会话日志与画布保留，这些会话回落「未分组」
app.delete('/api/projects/:pid', async (req, reply) => {
  try {
    return await projectStore.remove((req.params as any).pid)
  } catch (e: any) {
    return reply.code(404).send({ error: e.message })
  }
})

// 把会话记到项目名下（一个会话只属于一个项目）
app.post('/api/projects/:pid/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string }
  const sessionId = String(body.sessionId ?? '').trim()
  if (!isValidSessionId(sessionId)) return reply.code(400).send({ error: '非法会话 id' })
  if (!sessionStore.exists(sessionId)) return reply.code(404).send({ error: '会话不存在' })
  try {
    return { project: await projectStore.attach((req.params as any).pid, sessionId) }
  } catch (e: any) {
    return reply.code(404).send({ error: e.message })
  }
})

// 从项目移除 → 回落「未分组」（会话本身不动）
app.delete('/api/projects/:pid/sessions/:sid', async (req, reply) => {
  const params = req.params as any
  try {
    return { project: await projectStore.detach(params.pid, params.sid) }
  } catch (e: any) {
    return reply.code(404).send({ error: e.message })
  }
})

// ---- 归档（软删除；dsh workspace/archiveSession） ----

app.post('/api/sessions/:id/archive', async (req, reply) => {
  const id = (req.params as any).id
  if (!sessionStore.exists(id)) return reply.code(404).send({ error: '会话不存在' })
  const body = (req.body ?? {}) as { stopActivity?: boolean }
  try {
    await projectStore.archive(id, {
      activity: sessionActivity,
      stopActivity: body.stopActivity === true,
      stop: stopSessionWork,
    })
    return { ok: true, archivedSessionIds: projectStore.archivedSessionIds }
  } catch (e: any) {
    if (e instanceof ProjectActiveSessionError) {
      // 409：把"还有什么在跑"告诉前端，由它决定是弹确认还是放弃
      return reply.code(409).send({ error: e.message, code: 'session-active', activity: e.activity })
    }
    return reply.code(400).send({ error: e.message })
  }
})

app.post('/api/sessions/:id/unarchive', async (req, reply) => {
  await projectStore.unarchive((req.params as any).id)
  return { ok: true, archivedSessionIds: projectStore.archivedSessionIds }
})

// 会话级模型选择持久化：切换即落盘（不必等到下一轮对话结束）
app.put('/api/sessions/:id/model', async (req, reply) => {
  const body = (req.body ?? {}) as { modelId?: string }
  const modelId = String(body.modelId ?? '').trim()
  if (!modelId) return reply.code(400).send({ error: 'modelId 不能为空' })
  try {
    const s = await ensureSession((req.params as any).id)
    if (!settingsStore.modelDirectory()[modelId]) {
      return reply.code(400).send({ error: `模型 "${modelId}" 不在模型目录中` })
    }
    s.runtime.setCurrentModel(modelId)
    persistMeta(s)
    s.sse.send('model/selected', { modelId })
    return { ok: true, modelId }
  } catch (e: any) {
    return reply.code(e.message === '会话不存在' ? 404 : 400).send({ error: e.message })
  }
})

// 切换会话绑定的本地工作目录（左栏「目录」用）。
// 只接受存在的目录：写进 meta 后，mcdev 的 resolveProject 会以它为相对根。
app.put('/api/sessions/:id/cwd', async (req, reply) => {
  const body = (req.body ?? {}) as { cwd?: string }
  const raw = String(body.cwd ?? '').trim()
  if (!raw) return reply.code(400).send({ error: 'cwd 不能为空' })
  let abs: string
  try {
    abs = realpathSync(raw)
    if (!statSync(abs).isDirectory()) return reply.code(400).send({ error: '不是目录' })
  } catch {
    return reply.code(400).send({ error: `目录不存在：${raw}` })
  }
  try {
    const s = await ensureSession((req.params as any).id)
    s.cwd = abs
    s.runtime.setCwd(abs)
    persistMeta(s)
    s.sse.send('session/cwd', { cwd: abs })
    bus.emit('session/updated', { sessionId: s.id })
    return { ok: true, cwd: abs }
  } catch (e: any) {
    return reply.code(e.message === '会话不存在' ? 404 : 400).send({ error: e.message })
  }
})

// 计划模式开关（对应 dsh /plan）：只读、先出方案；写操作由运行时统一拦截
app.put('/api/sessions/:id/plan', async (req, reply) => {
  const s = await ensureSession((req.params as any).id).catch(() => undefined)
  if (!s) return reply.code(404).send({ error: '会话不存在' })
  if (isArchivedLineage(s.id)) return reply.code(409).send({ error: '该会话已归档，先取消归档' })
  const active = !!(req.body as any)?.active
  setPlanModeOf(s, active, 'user')
  return { ok: true, active: s.coop.planMode }
})

// 授权策略（dsh approval policy）：ask=写/命令工具弹窗，auto=本会话自动放行
app.put('/api/sessions/:id/permissions', async (req, reply) => {
  const s = await ensureSession((req.params as any).id).catch(() => undefined)
  if (!s) return reply.code(404).send({ error: '会话不存在' })
  const body = (req.body ?? {}) as { policy?: string; resetAllowed?: boolean }
  if (body.policy !== undefined && body.policy !== 'ask' && body.policy !== 'auto') {
    return reply.code(400).send({ error: 'policy 只能是 ask 或 auto' })
  }
  if (body.policy) s.coop.permission = body.policy
  if (body.resetAllowed) s.coop.allowedTools.clear()
  persistMeta(s)
  s.sse.send('session/permissions', {
    policy: s.coop.permission, allowedTools: [...s.coop.allowedTools], sessionId: s.id,
  })
  return { ok: true, policy: s.coop.permission, allowedTools: [...s.coop.allowedTools] }
})

// 回答提问 / 方案评审 / 授权（弹窗提交；工具在那边 await 着）
app.post('/api/sessions/:id/interactions/:reqId', async (req, reply) => {
  const s = await ensureSession((req.params as any).id).catch(() => undefined)
  if (!s) return reply.code(404).send({ error: '会话不存在' })
  const body = (req.body ?? {}) as InteractionReply
  const r = interactionHub.answer(s.id, String((req.params as any).reqId), body)
  if (!r.ok) return reply.code(404).send({ error: r.error })
  return { ok: true }
})

// ---- 终端（右侧「终端」标签 + 用户手动拉起） ----
app.get('/api/terminals', async (req, reply) => {
  const sid = String((req.query as any)?.sessionId ?? '').trim()
  if (!sid) return reply.code(400).send({ error: 'sessionId 不能为空' })
  return { terminals: terminals.list(sid), shell: terminals.shellLabel }
})

app.post('/api/terminals', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; command?: string; cwd?: string; title?: string }
  const sid = String(body.sessionId ?? '').trim()
  if (!sid) return reply.code(400).send({ error: 'sessionId 不能为空' })
  const s = await ensureSession(sid).catch(() => undefined)
  if (!s) return reply.code(404).send({ error: '会话不存在' })
  const command = String(body.command ?? '').trim()
  const cwd = String(body.cwd ?? s.cwd ?? DEFAULT_CWD)
  const title = String(body.title ?? '').trim()
  try {
    const t = command
      ? terminals.open({ sessionId: sid, command, cwd, title })
      : terminals.openShell({ sessionId: sid, cwd, title })
    return { terminal: t }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

app.get('/api/terminals/:tid/output', async (req, reply) => {
  const sid = String((req.query as any)?.sessionId ?? '').trim()
  const t = terminals.get(String((req.params as any).tid))
  if (!t || t.sessionId !== sid) return reply.code(404).send({ error: '终端不存在' })
  const tail = Math.max(200, Math.min(60_000, Number((req.query as any)?.tail) || 8000))
  return { terminal: t, output: terminals.output(t.id, tail) ?? '' }
})

app.post('/api/terminals/:tid/input', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; text?: string; submit?: boolean }
  const sid = String(body.sessionId ?? '').trim()
  const t = terminals.get(String((req.params as any).tid))
  if (!t || t.sessionId !== sid) return reply.code(404).send({ error: '终端不存在' })
  const text = String(body.text ?? '')
  const ok = terminals.write(t.id, body.submit === false ? text : `${text}\n`)
  if (!ok) return reply.code(409).send({ error: '终端不在运行或不可写' })
  return { ok: true }
})

app.post('/api/terminals/:tid/kill', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string }
  const sid = String(body.sessionId ?? '').trim()
  const t = terminals.get(String((req.params as any).tid))
  if (!t || t.sessionId !== sid) return reply.code(404).send({ error: '终端不存在' })
  const ok = terminals.kill(t.id)
  return { ok, terminal: terminals.get(t.id) }
})

// 目录浏览（左栏选择工作目录用）：只列子目录，不读文件
app.get('/api/fs/browse', async (req, reply) => {
  const raw = String((req.query as any)?.path ?? '').trim() || DEFAULT_CWD
  let abs: string
  try {
    abs = realpathSync(raw)
    if (!statSync(abs).isDirectory()) return reply.code(400).send({ error: '不是目录' })
  } catch {
    return reply.code(400).send({ error: `目录不存在：${raw}` })
  }
  const dirs: { name: string; path: string }[] = []
  try {
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      let st
      try { st = statSync(join(abs, name)) } catch { continue }
      if (st.isDirectory()) dirs.push({ name, path: join(abs, name) })
    }
  } catch { /* 权限不足：当作空目录 */ }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const parent = dirname(abs)
  return { path: abs, parent: parent === abs ? null : parent, dirs, defaultRoot: DEFAULT_CWD }
})

app.get('/api/sessions/:id', async (req, reply) => {
  try {
    const s = await ensureSession((req.params as any).id)
    const meta = sessionStore.readMeta(s.id)
    return {
      id: s.id,
      /** 首条消息派生的标题（主区页头显示；子代理通常为空，用 agentName） */
      title: sessionStore.list().find(r => r.id === s.id)?.title ?? '',
      events: s.log.all(),
      /** 上下文环的分子/分母 + 图形化面板的三段构成（与 stats 帧同源） */
      ...contextFigures(s),
      modelId: s.runtime.currentModelId,
      mode: s.mode,
      parentId: s.parentId,
      /** 画布归属：同一会话树共享的画布 id（durable，等价 dsh 会话的 cwd） */
      canvasId: s.canvasId,
      /** 会话绑定的本地工作目录 */
      cwd: s.cwd,
      /** 素材绑定（就地编辑会话）：页头显示「改动自动保存到素材」 */
      libraryId: meta.libraryId,
      libraryName: meta.libraryName,
      agentName: s.agentName,
      description: s.description,
      /** 当前代理角色（前端据此恢复下拉选择） */
      profile: s.profile,
      status: s.status,
      busy: s.busy,
      /** 等待中的子代理：非空 = 会话在等待态（输入锁定，结算后自动汇总） */
      waiting: waitingRows(s),
      // —— 协作状态（刷新/重开页面都要恢复） ——
      /** 计划模式：只读出方案，写操作被运行时拦截 */
      planMode: s.coop.planMode,
      /** 最后一次 todo_write 的任务清单 */
      todos: s.coop.todos,
      /** 授权策略与「本会话内总是允许」的工具白名单 */
      permission: s.coop.permission,
      allowedTools: [...s.coop.allowedTools],
      /** 还没回答的提问/授权（前端重连后补弹窗，不会丢） */
      pendingInteractions: interactionHub.list(s.id),
    }
  } catch (e: any) { return reply.code(404).send({ error: e.message }) }
})

// 子代理目录（dsh SubagentHeaderLineage 的数据源）：直接子会话 + 实时状态
app.get('/api/sessions/:id/subagents', async (req, reply) => {
  try {
    const s = await ensureSession((req.params as any).id)
    return { subagents: subagentRows(s.id) }
  } catch (e: any) { return reply.code(404).send({ error: e.message }) }
})

// 统一事件流：会话的所有 SSE 帧都走这里（聊天改为异步启动，不再在 POST 响应里推流）
app.get('/api/sessions/:id/stream', async (req, reply) => {
  let s: SessionEntry
  try { s = await ensureSession((req.params as any).id) } catch (e: any) { return reply.code(404).send({ error: e.message }) }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const write = (frame: string) => {
    try { reply.raw.write(frame) } catch { /* 客户端已断开 */ }
  }
  write(`data: ${JSON.stringify({ topic: 'open', sessionId: s.id, busy: s.busy, status: s.status, mode: s.mode, canvasId: s.canvasId, waiting: waitingRows(s) })}\n\n`)

  // 晚连/断线重连：补发当前进行中回合的帧（EventSource 会自动带 Last-Event-ID）
  const headerSince = (req.headers['last-event-id'] as string | undefined) ?? (req.query as any)?.since
  const since = Number(headerSince)
  for (const frame of s.sse.replay(Number.isFinite(since) ? since : -1)) write(frame)

  // 画布快照随流下发（dsh 会话投影的 snapshot 语义）：连上即拿到当前文档，无需再额外 GET
  const sendCanvas = (topic: string, data: Record<string, any>) => {
    write(`id: ${s.sse.nextId()}\ndata: ${JSON.stringify({ topic, ...data })}\n\n`)
  }
  const model = canvas.model(s.id)
  if (model) {
    const doc = canvas.read(s.id)
    sendCanvas('model_update', {
      sessionId: s.canvasId,
      originId: s.canvasId,
      bbmodel: model,
      elements: doc?.elements?.length ?? 0,
      textures: doc?.textures?.length ?? 0,
      view: doc?.view ?? '3d',
      animations: (doc?.animations ?? []).map((a: any) => ({ name: a.name, length: a.length, loop: a.loop })),
    })
  }

  const unsub = s.sse.subscribe(write)
  // 画布订阅：同一 canvasId 的任意 agent 改动都会推给这条连接（主会话与子代理因此实时同步）
  const unsubCanvas = canvas.onChange(change => {
    if (change.canvasId !== s.canvasId) return
    if (change.kind === 'view') {
      sendCanvas('view_update', { view: change.view, originId: change.originId })
      return
    }
    sendCanvas('model_update', {
      sessionId: change.canvasId,
      originId: change.originId,
      agentName: change.agentName,
      bbmodel: change.bbmodel,
      elements: change.elements,
      textures: change.textures,
      view: change.view,
      animations: change.animations,
    })
  })
  const ping = setInterval(() => write(': ping\n\n'), 15000)
  const close = () => {
    clearInterval(ping)
    unsub()
    unsubCanvas()
  }
  req.raw.on('close', close)
  req.raw.on('error', close)
  return reply
})

app.post('/api/sessions/:id/chat', async (req, reply) => {
  const id = (req.params as any).id
  let s: SessionEntry
  try { s = await ensureSession(id) } catch (e: any) { return reply.code(404).send({ error: e.message }) }
  // 归档门控（dsh archived-session-gate）：归档的会话（或归档会话下的子代理）不再接受新的回合
  if (isArchivedLineage(s.id)) {
    return reply.code(409).send({ error: '该会话已归档，先取消归档再继续', code: 'session-archived' })
  }
  // 等待子代理期间不接新指令：这一轮还没结束（dsh 里父会话此时仍在 activation 等待）。
  // 必须先于 busy 判定：派发发生在回合内，两个条件会同时成立，只有 waiting 能给出准确原因。
  const waitingNow = waitingRows(s)
  if (waitingNow.length > 0) {
    return reply.code(409).send({
      error: `正在等待 ${waitingNow.length} 个子代理完成，结算后会自动汇总；如需打断请先停止`,
      code: 'session-waiting',
    })
  }
  if (s.busy) return reply.code(409).send({ error: '上一轮还在进行中' })
  const body = (req.body ?? {}) as {
    text?: string; modelId?: string; mode?: 'build' | 'refine'; attachments?: any[]; profile?: string
  }
  if (!body.text?.trim()) return reply.code(400).send({ error: 'text 不能为空' })
  // 代理角色：未知 id 直接回落当前角色（不 400——老客户端不会带这个字段）
  const wantedProfile = typeof body.profile === 'string' && AGENT_PROFILES[body.profile] ? body.profile : undefined
  if (wantedProfile && wantedProfile !== s.profile) {
    s.profile = wantedProfile
    persistMeta(s)
  }

  // 图片准入（dsh PromptContentPart → AdmittedPromptContentPart）：
  // 客户端发来的是 data URL，这里换成内容寻址引用；日志与事件里不再出现 base64。
  let admitted: any[] | undefined
  if (body.attachments?.length) {
    if (body.attachments.length > MAX_IMAGES_PER_MESSAGE) {
      return reply.code(400).send({ error: `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片` })
    }
    try {
      admitted = body.attachments.map(part => attachments.admit(part))
    } catch (e: any) {
      return reply.code(400).send({ error: `附件不可用：${e.message}` })
    }
  }

  // 异步启动：事件全部走 GET /api/sessions/:id/stream（子代理也是这样后台跑）
  void runSessionTurn(s, {
    text: body.text,
    attachments: admitted,
    modelId: body.modelId,
    mode: body.mode,
    profile: wantedProfile ?? s.profile,
  }).catch(e => { console.warn('[chat] 运行异常:', e?.message ?? e) })
  return reply.code(202).send({ ok: true, sessionId: s.id })
})

app.post('/api/sessions/:id/stop', async (req, reply) => {
  const s = await ensureSession((req.params as any).id).catch(() => undefined)
  if (!s) return reply.code(404).send({ error: '会话不存在' })
  // 等待态下的"停止"= 取消这批子代理并解锁会话（对应 dsh 归档前的 stopActivity）
  const cancelled = s.waiting.size
  if (cancelled > 0) {
    cancelWaiting(s)
    return { ok: true, cancelled }
  }
  // 先结算挂在提问/授权上的工具，再 abort 回合——否则工具永远等不到答案
  interactionHub.cancelSession(s.id, 'stopped')
  s.abortController?.abort()
  return { ok: true, cancelled: 0 }
})

/** 取消等待中的子代理：中断它们、清空结算收件箱、解锁输入（不再自动汇总） */
function cancelWaiting(s: SessionEntry) {
  const ids = [...s.waiting]
  s.waiting.clear()
  s.settlements = []
  for (const id of ids) {
    const child = sessions.get(id)
    if (!child) continue
    try { child.abortController?.abort() } catch { /* 已结束 */ }
    interactionHub.cancelSession(id, 'cancelled')
    terminals.killSession(id)
    if (child.status === 'running') {
      child.status = 'stopped'
      persistMeta(child)
      child.sse.send('subagent/status', { status: 'stopped' })
    }
  }
  s.sse.send('session/waiting', { sessionId: s.id, waiting: [] })
}

app.get('/api/sessions/:id/stats', async (req, reply) => {
  try {
    const s = await ensureSession((req.params as any).id)
    const stats = projectStats(s.log.all())
    const figures = contextFigures(s)
    // 日志里只有 prompt/output 总量，没有 system / tools 的拆分：
    // 用运行时现算的 contextBreakdown 回填，保证环上三段之和 == 上下文总量。
    if (figures.contextBreakdown) {
      stats.context.tokenSplit.system = figures.contextBreakdown.systemTokens
      stats.context.tokenSplit.tools = figures.contextBreakdown.toolsTokens
      stats.context.tokenSplit.message = figures.contextBreakdown.messageTokens
    }
    // 编队：同一画布下的子代理累计输出（面板「主 / 子代理」那一行）
    // 走磁盘列表而不是内存 sessions：重启后子代理的执行态已丢失，但它们的 token 账还在日志里
    const rootCanvas = s.canvasId ?? s.id
    let subagentTokens = 0
    let subagentCount = 0
    for (const row of sessionStore.list()) {
      if (row.mode !== 'subagent' || !row.parentId) continue
      if ((row.canvasId ?? row.id) !== rootCanvas) continue
      subagentCount++
      subagentTokens += row.outputTokens ?? 0
    }
    return {
      stats,
      ...figures,
      fleet: { main: stats.totals.outputTokens, subagents: subagentTokens, subagentCount },
    }
  } catch (e: any) { return reply.code(404).send({ error: e.message }) }
})

// ---- 文档素材库 ----
// 素材 = 画布快照（几何 + 贴图 + 分组 + 动画）。两条"改"的路径：
//   POST /fork  引用到新会话（副本迭代，素材不动）
//   POST /edit  就地改（素材绑定一个编辑会话，改动自动回写，始终只有一份）
// 截取与取回都走 canvas 服务，这里只负责归档与列表；没有自动截取（用户手动按下才发生）。

// ---- 素材库：就地编辑的种子与回写 ----

/** 种子写入的护罩：libId → 失效时间。刚种进画布的那一次 commit 不算一次内容修改 */
const libSeedGuard = new Map<string, number>()

/** 会话树往上找素材绑定：子代理共享父会话的画布，它的改动也算这个素材的改动 */
function libraryOfSession(sessionId: string): string | undefined {
  let cursor: string | undefined = sessionId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const meta = sessionStore.readMeta(cursor)
    if (meta.libraryId) return meta.libraryId
    cursor = meta.parentId
  }
  return undefined
}

/** 素材来源会话的 cwd / 角色 / 模型：新开的编辑会话沿用同一套环境 */
function inheritFromAsset(asset: LibraryAsset, fallbackSessionId?: string) {
  const srcId = asset.sessionId && sessionStore.exists(asset.sessionId) ? asset.sessionId : fallbackSessionId
  const live = srcId ? sessions.get(srcId) : undefined
  const meta = srcId ? sessionStore.readMeta(srcId) : {}
  return {
    cwd: live?.cwd ?? meta.cwd ?? DEFAULT_CWD,
    profile: live?.profile ?? meta.profile,
    modelId: live?.runtime.currentModelId ?? meta.modelId,
  }
}

/** 把素材快照种进会话画布（commit 是唯一写入口，服务端仍负责规整与广播） */
function seedCanvas(sessionId: string, snap: LibraryDoc, libId?: string) {
  // 种子本身不是"用户改了这一版"：先上防抖护罩，否则点一下「接着改」版本号就被顶到 v2
  if (libId) libSeedGuard.set(libId, Date.now() + 1500)
  canvas.commit(sessionId, {
    name: snap.name ?? '未命名模型',
    resolution: snap.resolution,
    elements: snap.elements ?? [],
    outliner: snap.outliner,
    textures: snap.textures ?? [],
    animations: snap.animations ?? [],
    view: snap.view ?? '3d',
  })
}

app.get('/api/library', async () => ({ assets: library.list() }))

app.post('/api/library/capture', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; name?: string }
  const sessionId = String(body.sessionId ?? '').trim()
  if (!sessionId) return reply.code(400).send({ error: 'sessionId 不能为空' })
  try {
    const s = await ensureSession(sessionId)
    const doc = canvas.read(sessionId)
    const asset = library.capture({
      sessionId,
      canvasId: s.canvasId ?? canvas.idOf(sessionId),
      name: String(body.name ?? ''),
      doc,
    })
    return { asset }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 引用到新会话：开一个独立会话，把素材种到它的画布上；素材本身保持不变
app.post('/api/library/:id/fork', async (req, reply) => {
  const id = String((req.params as any).id)
  const asset = library.get(id)
  if (!asset) return reply.code(404).send({ error: '素材不存在' })
  const snap = library.readDoc(id)
  if (!snap) return reply.code(404).send({ error: '素材快照已损坏' })
  const body = (req.body ?? {}) as { sessionId?: string }
  const inherit = inheritFromAsset(asset, String(body.sessionId ?? '').trim() || undefined)
  const s = createSession(undefined, { cwd: inherit.cwd, modelId: inherit.modelId })
  if (inherit.profile) {
    s.profile = inherit.profile
    persistMeta(s)
  }
  // 标题先占位成「改·素材名」；用户发出第一条消息后会被真实标题替换
  sessionStore.writeMeta(s.id, { title: `改·${asset.name}` })
  seedCanvas(s.id, snap)
  return { sessionId: s.id, cwd: s.cwd, name: asset.name }
})

// 就地改：素材自带一个「编辑会话」，画布改动由下方 canvas.onChange 订阅自动回写
app.post('/api/library/:id/edit', async (req, reply) => {
  const id = String((req.params as any).id)
  const asset = library.get(id)
  if (!asset) return reply.code(404).send({ error: '素材不存在' })
  const body = (req.body ?? {}) as { sessionId?: string }
  let sid = asset.editingSessionId
  let created = false
  // 绑定会话还在（且没归档）就复用：它就是这份素材的工作区，不每次开新会话
  const reusable = !!sid && sessionStore.exists(sid) && !isArchivedLineage(sid)
  if (!reusable) {
    const inherit = inheritFromAsset(asset, String(body.sessionId ?? '').trim() || undefined)
    const s = createSession(undefined, { cwd: inherit.cwd, modelId: inherit.modelId })
    if (inherit.profile) {
      s.profile = inherit.profile
      persistMeta(s)
    }
    sid = s.id
    created = true
    sessionStore.writeMeta(sid, { title: `改·${asset.name}`, libraryId: id, libraryName: asset.name })
    library.bind(id, sid)
    const snap = library.readDoc(id)
    if (snap) seedCanvas(sid, snap, id)
  } else if (sid) {
    // 老素材/换绑：补上 durable 绑定；画布空了才补种子（绝不覆盖已有工作）
    if (sessionStore.readMeta(sid).libraryId !== id) {
      sessionStore.writeMeta(sid, { libraryId: id, libraryName: asset.name })
    }
    if (!canvas.has(sid)) {
      const snap = library.readDoc(id)
      if (snap) seedCanvas(sid, snap, id)
    }
  }
  return { sessionId: sid, created, name: asset.name }
})

// 改名（只改标签，不动内容；快照与缩略图保持不变）
app.put('/api/library/:id', async (req, reply) => {
  const id = String((req.params as any).id)
  const body = (req.body ?? {}) as { name?: string }
  const asset = library.rename(id, String(body.name ?? ''))
  if (!asset) return reply.code(404).send({ error: '素材不存在' })
  // 编辑会话的页头徽标同步改名
  if (asset.editingSessionId && sessionStore.exists(asset.editingSessionId)) {
    try { sessionStore.writeMeta(asset.editingSessionId, { libraryName: asset.name }) } catch { /* 忽略 */ }
  }
  return { asset }
})

app.delete('/api/library/:id', async (req, reply) => {
  const id = String((req.params as any).id)
  const asset = library.get(id)
  const ok = library.remove(id)
  if (!ok) return reply.code(404).send({ error: '素材不存在' })
  // 素材没了，编辑会话就不该再声称"自动保存"：摘掉绑定（会话本身保留）
  if (asset?.editingSessionId && sessionStore.exists(asset.editingSessionId)) {
    try { sessionStore.writeMeta(asset.editingSessionId, { libraryId: undefined, libraryName: undefined }) } catch { /* 忽略 */ }
  }
  return { ok: true }
})

app.get('/api/library/:id/thumb', async (req, reply) => {
  const buf = library.readThumb(String((req.params as any).id))
  if (!buf) return reply.code(404).send({ error: '没有缩略图' })
  return reply
    .header('content-type', 'image/png')
    .header('cache-control', 'public, max-age=31536000, immutable')
    .send(buf)
})

// 把素材送回某个会话的画布（覆盖式写入：几何 + 分组 + 贴图 + 动画 + 分辨率）
app.post('/api/library/:id/to-canvas', async (req, reply) => {
  const id = String((req.params as any).id)
  const body = (req.body ?? {}) as { sessionId?: string }
  const sessionId = String(body.sessionId ?? '').trim()
  if (!sessionId) return reply.code(400).send({ error: 'sessionId 不能为空' })
  const snap = library.readDoc(id)
  if (!snap) return reply.code(404).send({ error: '素材不存在或已损坏' })
  try {
    await ensureSession(sessionId)
    const current = canvas.read(sessionId) ?? {}
    const elements = snap.elements ?? []
    const next = {
      ...current,
      name: snap.name ?? current.name,
      resolution: snap.resolution ?? current.resolution,
      elements,
      // 分组/动画必须一起换：只换 elements 会让 outliner 指向已不存在的 uuid，分组被拍平
      outliner: snap.outliner ?? elements.map((e: any) => e.uuid),
      animations: snap.animations ?? [],
      textures: snap.textures ?? [],
      view: snap.view ?? current.view ?? '3d',
    }
    canvas.commit(sessionId, next)
    return { ok: true, elementCount: elements.length }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// ---- 素材就地编辑：画布 → 素材的自动回写 ----
// 挂在 canvas.onChange 上而不是某个工具里：AI 工具、子代理、手动编辑三种来源一视同仁。
// 防抖 700ms：一轮对话里可能连续改十几次画布，没必要每次都写快照（贴图 dataURL 不小）。
const libSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
canvas.onChange(change => {
  if (change.kind !== 'model') return
  const libId = libraryOfSession(change.originId)
  if (!libId) return
  // 刚把素材种进画布（打开编辑会话）：这一次 commit 不是内容修改，别顶版本号
  const guard = libSeedGuard.get(libId)
  if (guard !== undefined) {
    if (guard > Date.now()) return
    libSeedGuard.delete(libId)
  }
  const prev = libSyncTimers.get(libId)
  if (prev) clearTimeout(prev)
  libSyncTimers.set(libId, setTimeout(() => {
    libSyncTimers.delete(libId)
    const doc = canvas.read(change.canvasId)
    if (!doc) return
    const meta = library.updateDoc(libId, doc)
    if (!meta) console.warn(`[library] 素材 ${libId} 已不存在，跳过回写`)
  }, 700))
})

// 图片字节出口（右侧「图片」标签、历史回看、灯箱都用它）
// 内容寻址 → 永久缓存；id 形如 sha256:<digest>（与日志里的引用一致）
app.get('/api/attachments/:id', async (req, reply) => {
  const found = attachments.read((req.params as any).id)
  if (!found) return reply.code(404).send({ error: '附件不存在或已被删除' })
  return reply
    .header('content-type', found.mediaType)
    .header('cache-control', 'public, max-age=31536000, immutable')
    .send(found.bytes)
})

// ---- 右侧「文件」标签：一次列一层 + 文本/图片预览（复刻 dsh ui-sidebar-files 的最小面） ----
app.get('/api/fs', async (req, reply) => {
  try {
    const rel = String((req.query as any)?.path ?? '')
    return { root: files.root, ...files.list(rel) }
  } catch (e: any) { return reply.code(400).send({ error: e.message }) }
})

app.get('/api/fs/text', async (req, reply) => {
  try {
    const rel = String((req.query as any)?.path ?? '')
    return files.readText(rel)
  } catch (e: any) { return reply.code(400).send({ error: e.message }) }
})

// 图片走原始字节，<img src> 直接用（比 base64 进 JSON 小得多）
app.get('/api/fs/raw', async (req, reply) => {
  try {
    const rel = String((req.query as any)?.path ?? '')
    const found = files.readBytes(rel)
    if (!found) return reply.code(415).send({ error: '不是可直接预览的图片' })
    return reply.header('content-type', found.mediaType).header('cache-control', 'no-cache').send(found.bytes)
  } catch (e: any) { return reply.code(400).send({ error: e.message }) }
})

// ---- 右侧「网页」标签：先探测能不能被 iframe 嵌入，再按需走本机代理 ----
// dsh 的 Web 版只用 iframe 且不代理；没有 Electron 时这是让"被拒绝嵌入"的站点仍可查看的兜底。
app.get('/api/web/probe', async (req) => {
  return probeWeb(String((req.query as any)?.url ?? ''))
})

app.get('/api/web/proxy', async (req, reply) => {
  const found = await proxyWeb(String((req.query as any)?.url ?? ''))
  if ('error' in found) return reply.code(400).send({ error: found.error })
  return reply
    .header('content-type', found.contentType)
    .header('cache-control', 'no-store')
    // 代理页只允许本应用嵌入（同源 iframe）；不要把本机变成任意页面的公开代理
    .header('content-security-policy', "frame-ancestors 'self'")
    .header('x-openmods-final-url', encodeURIComponent(found.finalUrl))
    .header('x-openmods-truncated', found.truncated ? '1' : '0')
    .send(found.body)
})

app.get('/api/sessions/:id/bbmodel', async (req, reply) => {
  try {
    const s = await ensureSession((req.params as any).id)
    // 子代理没有自己的画布：一律返回它所属会话树的画布
    const bbmodel = canvas.model(s.id)
    if (!bbmodel) return reply.code(404).send({ error: '画布还没有模型' })
    reply.header('content-type', 'application/json')
    reply.header('x-canvas-session', s.canvasId)
    reply.header('content-disposition', 'attachment; filename="model.bbmodel"')
    return bbmodel
  } catch (e: any) { return reply.code(404).send({ error: e.message }) }
})

// 用户在画布上手动编辑后同步回服务端文档（AI 后续修改基于此版本）
app.put('/api/sessions/:id/bbmodel', async (req, reply) => {
  try {
    const s = await ensureSession((req.params as any).id)
    const body = (req.body ?? {}) as { model?: any }
    const model = body.model
    if (!model?.elements) return reply.code(400).send({ error: '缺少 model.elements' })
    const doc = {
      name: model.name ?? model.meta?.name ?? 'model',
      elements: model.elements,
      outliner: model.outliner ?? model.elements.map((e: any) => e.uuid),
      textures: model.textures ?? [],
      animations: (model.animations ?? []).map((a: any) => ({
        name: String(a.name ?? '').split('.').pop() ?? a.name,
        length: a.length ?? 1,
        loop: a.loop === 'once' || a.loop === 'hold' ? a.loop : 'loop',
        bones: Object.fromEntries(Object.entries(a.animators ?? {}).map(([bone, an]: [string, any]) => [
          bone,
          (an.keyframes ?? []).reduce((acc: any[], kf: any) => {
            const t = kf.time ?? 0
            let entry = acc.find((x: any) => Math.abs(x.time - t) < 1e-6)
            if (!entry) { entry = { time: t }; acc.push(entry) }
            if (kf.channel === 'rotation' && kf.data_points?.[0]) entry.rotation = [kf.data_points[0].x, kf.data_points[0].y, kf.data_points[0].z]
            if (kf.channel === 'position' && kf.data_points?.[0]) entry.position = [kf.data_points[0].x, kf.data_points[0].y, kf.data_points[0].z]
            return acc
          }, []).sort((x: any, y: any) => x.time - y.time),
        ])),
      })),
      view: canvas.read(s.id)?.view ?? '3d',
    }
    // 提交走服务：编译 + 广播 + 原子落盘一次完成
    canvas.commit(s.id, doc)
    return { ok: true, elements: doc.elements.length, textures: doc.textures.length, canvasId: s.canvasId }
  } catch (e: any) { return reply.code(400).send({ error: e.message }) }
})

// ---- 静态托管 ----
const bbDist = join(ROOT, 'bbcanvas', 'dist')
if (existsSync(bbDist)) {
  await app.register(fastifyStatic, { root: bbDist, prefix: '/bb/', decorateReply: false })
} else {
  console.warn('[static] bbcanvas/dist 不存在 —— 先运行 npm run build:bbcanvas')
}
const webDist = join(ROOT, 'apps', 'web', 'dist')
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false })
}

app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
  console.log(`[openmods] server ready → http://127.0.0.1:${PORT}`)
  console.log(`[openmods] 插件: ${loadedPlugins.map(p => p.name).join(', ') || '无'}`)
  console.log(`[openmods] 技能: ${dirProvider.list().map(s => s.name).join(', ') || '无'}`)
  console.log(`[openmods] 模型目录: ${Object.keys(settingsStore.modelDirectory()).join(', ')}`)
  console.log(`[openmods] 终端 shell: ${terminals.shellLabel}`)
})

// 进程退出前收掉所有终端，别把 gradle/dev server 留成孤儿
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try { terminals.killAll() } catch { /* 忽略 */ }
    try { interactionHub.cancelAll() } catch { /* 忽略 */ }
    process.exit(0)
  })
}
