// openmods server：REST + SSE + 静态托管（web 构建 / /bb/ 无头 Blockbench）
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { FeatureDecl, HttpMethod, HttpRouteOptions, LoadedPlugin, PluginContext, SessionRuntimeLike, SkillProvider, ToolDef, ToolResult } from '@openmods/plugin-kit'
import { applyPlugins, discoverPlugins, WORKSPACE_TOOL_NAMES } from '@openmods/plugin-kit'
import { createSessionRuntime, createHttpLlm, createMockLlm, geminiInteractionsUrl, geminiModelsUrl, registerSurfaceTransform, SessionLog, type SessionRuntime, type LlmAdapter, LlmError } from '@openmods/agent-core'
import { DirSkillProvider, FilteredSkillProvider } from './skills.js'
import { SettingsStore } from './settings.js'
import { applyEnvironment, checkEnvStatus, fixVendorLayout, validateEnvironmentPatch } from './env-check.js'
import { cancelVendorDownload, isVendorSource, startVendorDownload, vendorDownloadStatus } from './vendor-download.js'
import { cancelTestClientDownload, isTestClientSource, startTestClientDownload, testClientDownloadStatus } from './test-client-download.js'
import { FEATURE_DEFS, resolveFeatureStates, type FeatureStates } from './features.js'
import { createProfileRegistry, registerBuiltinProfiles } from './profiles.js'
import { SessionStore, isValidSessionId, summarize, type SessionSummary, type SubagentStatus } from './session-store.js'
import { CanvasService } from './canvas.js'
import { ProjectStore, ProjectActiveSessionError, type SessionActivity } from './project-store.js'
import { createAttachmentStore, MAX_ATTACHMENTS_PER_MESSAGE } from './attachments.js'
import { createLibraryStore, findAllJars, type LibraryAsset, type LibraryDoc } from './library.js'
import { createFileService } from './files.js'
import { probeWeb, proxyWeb } from './webview.js'
import { createInteractionHub, type InteractionReply, type PendingInteraction } from './interaction.js'
import { createTerminalManager } from './terminals.js'
import { installLogCapture, getLogs, logFilePath } from './log-bus.js'
import { listBuildLogs, readBuildLog } from './build-logs.js'
import { killJavaProcess, killJavaProcesses, listJavaProcesses } from './java-procs.js'
import { inferModelCapabilities, inferReasoningEfforts } from './model-caps.js'
import { applyUpdate, getUpdateStatus } from './update.js'
import {
  getTestClientStatus, startTestClient, stopTestClient, testClientBusy, type TestClientJar,
} from './mc-test-client.js'
import { projectStats } from '../../../plugins/stats/projection.js'
import { compile as compileBb } from '../../../plugins/bb-tools/bbmodel.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../..')

// 系统日志：尽早接管 console，启动/插件/构建日志都会进内存缓冲与 data/logs
installLogCapture(ROOT)

/**
 * 新会话默认绑定的工作目录（左栏「目录」的来源）。
 * 与 mcdev 插件的 MC_ROOT 保持同一套解析：优先同级 mincraft-maker/projects，
 * 否则 data/mcprojects。OPENMODS_MC_ROOT 可覆盖。
 */
const DEFAULT_CWD = process.env.OPENMODS_MC_ROOT
  ?? (existsSync(join(ROOT, '..', 'mincraft-maker'))
    ? join(ROOT, '..', 'mincraft-maker', 'projects')
    : join(ROOT, 'data', 'mcprojects'))

/**
 * 未显式绑定目录的新会话工作区：<ROOT>/data/workspaces/<sessionId>。
 * 这样两个会话各自 mc_scaffold / gradlew build 互不覆盖（历史会话仍用自己 meta 里的 cwd）。
 */
const WORKSPACES_DIR = join(ROOT, 'data', 'workspaces')

/** 取（并确保存在）某个会话的独立工作区 */
function sessionWorkspace(sessionId: string): string {
  const dir = join(WORKSPACES_DIR, sessionId)
  mkdirSync(dir, { recursive: true })
  return dir
}

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

// 插件全局事件 → 对应会话 SSE（mcdev 构建完成等；插件拿不到会话入口，只发 bus）
bus.on('mc/build', data => {
  const sid = String((data as any)?.sessionId ?? '')
  if (sid) sessions.get(sid)?.sse.send('mc/build', data)
})

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
// 环境配置（设置 → 环境）写进 OPENMODS_JAVA_HOME / OPENMODS_GRADLE_HOME / OPENMODS_GIT，
// 供 mc_gradle、测试客户端与自更新读取；保存后立即生效，无需重启。
applyEnvironment(settingsStore.getEnvironment())
// 启动态功能开关在插件发现之后解析（要合并插件自带的声明），见下方「插件发现」。

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
const httpLlmFor = (baseUrl: string, apiKey: string, format?: 'openai' | 'gemini') => createHttpLlm({ baseUrl, apiKey, format })

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
        const delegate = httpLlmFor(profile.baseURL, apiKey ?? '', profile.format)
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
  description: '按需加载一项技能（SKILL.md 全文）。先用系统提示里的技能名调用；一次只加载当前需要的。'
    + '返回末尾会带技能目录与 references 清单；需要精确签名时再传 file（如 references/forge-1.20.1-api.md）读取附加文件。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名，如 blockbench-modeling' },
      file: { type: 'string', description: '可选：技能目录内的相对路径（如 references/forge-1.20.1-api.md）' },
    },
    required: ['name'],
  },
  async execute(args, exec) {
    const name = String(args.name ?? '').trim()
    const file = String(args.file ?? '').trim()
    // 技能按角色分配（设置 → 代理与技能）：不在本角色清单里的拒绝加载
    const entry = sessions.get(exec.sessionId)
    const allowed = entry ? effectiveSkills(entry.profile) : undefined
    for (const provider of skillProviders) {
      if (!provider.list().some(m => m.name === name)) continue
      if (allowed && !allowed.includes(name)) {
        return {
          forModel: `技能 "${name}" 未分配给当前角色（${entry?.profile ?? 'default'}）。可用: ${allowed.join(', ') || '无'}。`,
          isError: true,
        }
      }
      try {
        if (file) {
          if (!provider.read) return { forModel: `技能 ${name} 不支持读取附加文件`, isError: true }
          return { forModel: await provider.read(name, file) }
        }
        const content = await provider.load(name)
        const dir = provider.dirOf?.(name)
        if (!dir) return { forModel: content }
        // 技能正文里的 references/... 是相对技能目录的；把目录和清单直接给模型，
        // 否则它只能从会话 cwd 猜路径（历史会话为此浪费了 4 次调用和 3 次授权）。
        let refs: string[] = []
        try {
          refs = readdirSync(join(dir, 'references'))
            .filter(f => f.endsWith('.md'))
            .slice(0, 20)
            .map(f => `references/${f}`)
        } catch { /* 技能没有 references 目录 */ }
        return {
          forModel: content
            + `\n\n---\n技能目录：${dir}\n`
            + (refs.length
              ? `参考文件：${refs.join('、')}\n需要精确签名时用 load_skill name="${name}" file="${refs[0]}" 读取，不要凭记忆写。`
              : ''),
        }
      } catch (e: any) {
        return { forModel: `读取技能 ${name} 失败：${e?.message ?? e}`, isError: true }
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
// 白名单常量由 plugin-kit 提供，功能插件注册角色时用同一份，避免手抄脱节。
const WORKSPACE_TOOLS = WORKSPACE_TOOL_NAMES

// ---- 插件发现（只 import，不 apply） ----
// 顺序很关键：功能声明必须先于开关解析。插件自带的开关（不只是内置 canvas/mc/library）
// 要进 bootFeatures，requires 才可能被关掉；先解析再发现会让插件开关永远无效。
const pluginDiscovery = await discoverPlugins(PLUGINS_DIR)

/** 启动时收集到的功能声明（内置 + 插件），供 /api/features 与设置页展示 */
const declaredFeatures: FeatureDecl[] = [...FEATURE_DEFS]
for (const f of pluginDiscovery.features) {
  if (f?.id && !declaredFeatures.some(x => x.id === f.id)) declaredFeatures.push(f)
}

/** 启动态功能开关：按合并后的声明表解析（改动需重启才重新加载插件） */
const bootFeatures: FeatureStates = resolveFeatureStates(settingsStore.getPrefs().features, declaredFeatures)

// 角色注册表：内置 lead / coding 在这里，mcmod / modeling 由插件启动时注册
// （插件 requires 依赖的开关被关掉时，对应角色根本不会出现）。
const profileRegistry = createProfileRegistry()
registerBuiltinProfiles(profileRegistry, bootFeatures)

// 各角色的技能覆盖（设置 → 代理与技能 可改，覆盖写进 data/agent-skills.json）。
// 默认技能归角色注册者所有：内置角色在 profiles.ts，mcmod/modeling 在各自插件里。
const SKILLS_OVERRIDES_PATH = join(ROOT, 'data', 'agent-skills.json')
let profileSkillsOverrides: Record<string, string[]> = {}
try {
  profileSkillsOverrides = JSON.parse(readFileSync(SKILLS_OVERRIDES_PATH, 'utf8'))
} catch { /* 首次运行没有覆盖文件 */ }
/** 生效的技能分配：持久化覆盖 > 角色声明 */
function effectiveSkills(profileId: string): string[] {
  return profileSkillsOverrides[profileId] ?? profileRegistry.get(profileId)?.skills ?? []
}
function saveSkillsOverrides() {
  mkdirSync(dirname(SKILLS_OVERRIDES_PATH), { recursive: true })
  writeFileSync(SKILLS_OVERRIDES_PATH, JSON.stringify(profileSkillsOverrides, null, 2))
}

// 代理角色由注册表提供：lead/coding 内置（profiles.ts），mcmod/modeling 由插件注册。

if (bootFeatures.canvas !== false) {
tools.push({
  name: 'spawn_modeling_subagent',
  description: '在当前会话里派发一个建模/动画任务（后台并行，每个子代理在自己的独立画布上建模）。可连续调用多次，同时派出多个子代理并行工作；它们各自在自己的独立画布上建模，画布可通过右侧拓展页签查看，互不覆盖。立即返回子代理名，随后你就该结束这一轮——主会话进入等待态（用户不能插话），全部子代理结算后系统会自动开一轮汇总回合，把它们的收尾汇报交给你。不要轮询 list_subagents 等结果。已经完成的子代理要接着改，用 resume_subagent，不要用同名再派一次（会报「已被同级使用」）。description 为 3-5 字任务简述（面板展示），prompt 为完整任务描述（外形/配色/细节/动画；多子代理时写明各自负责的部件）。',
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
      forModel: `started subagent ${child.agentName}（${child.id}，后台运行）。它和你在同一会话、在自己的独立画布上建模（画布可通过右侧拓展页签查看），改动会实时显示。本轮到此即可收尾：主会话进入等待态，全部子代理结算后系统自动开一轮汇总回合，把结果交给你；不要轮询等结果。`,
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

tools.push({
  name: 'resume_subagent',
  description: '给本会话中一个已完成的建模/动画子代理继续下发任务（续作，不是新建）。它复用原来的子会话与原画布，不会出现「子代理名已被同级使用」；改动完成后照样会结算并触发汇总回合。参数传 id 或 name 之一，再加新的 prompt。运行中的子代理要等结算；上次出错的子代理请用 spawn_modeling_subagent 重新派发。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '子代理会话 id（list_subagents 返回）' },
      name: { type: 'string', description: '子代理名（如 frostwolf）' },
      prompt: { type: 'string', description: '要它继续做的修改任务（写清改哪里、要保持什么）' },
    },
    required: ['prompt'],
  },
  async execute(args, exec) {
    const parent = sessions.get(exec.sessionId)
    if (!parent) return { forModel: '会话不存在或已结束，无法续作子代理。', isError: true }
    if (parent.mode === 'subagent') return { forModel: '只有主会话可以续作子代理。', isError: true }
    try {
      const child = await resumeSubagent(parent, {
        id: args.id ? String(args.id).trim() : undefined,
        name: args.name ? String(args.name).trim() : undefined,
        prompt: String(args.prompt ?? '').trim(),
      })
      return {
        forModel: `已把修改任务发给子代理 ${child.agentName ?? child.id}（${child.id}），它在原画布上继续工作。`
          + '本轮到此收尾：全部子代理结算后系统会自动开一轮汇总回合；不要轮询等结果。',
      }
    } catch (e: any) {
      return { forModel: `续作失败：${e?.message ?? e}`, isError: true }
    }
  },
})
}

// ---- 插件加载（按 requires 应用；发现阶段已在前面完成） ----
/**
 * 插件声明的 HTTP 路由：apply 阶段先收集，Fastify 实例创建后统一挂载。
 * 插件因 requires 被跳过时这里不会有它的路由——功能关闭即接口不存在，
 * 不需要再在 onRequest 里按 URL 前缀拦。
 */
const pluginHttpRoutes: { method: HttpMethod; path: string; handler: (req: any, reply: any) => any; opts?: HttpRouteOptions }[] = []

const pluginCtx: PluginContext = {
  tools: { register: d => tools.push(d) },
  skills: { registerProvider: p => skillProviders.push(p) },
  // 功能插件在这里注册自己的角色（mcmod / modeling），关掉对应开关时不会被调用
  profiles: { register: p => profileRegistry.register(p) },
  http: {
    route: (method, path, handler, opts) => { pluginHttpRoutes.push({ method, path, handler, opts }) },
  },
  sessions: {
    exists: id => sessionStore.exists(id),
    cwdOf: id => {
      if (!sessionStore.exists(id)) return null
      const cwd = sessionStore.readMeta(id).cwd
      const root = typeof cwd === 'string' && cwd.trim() ? cwd : DEFAULT_CWD
      try { return realpathSync(root) } catch { return null }
    },
  },
  prefs: { get: () => settingsStore.getPrefs() as unknown as Record<string, any> },
  features: {
    declare: f => {
      if (f?.id && !declaredFeatures.some(x => x.id === f.id)) declaredFeatures.push(f)
    },
    enabled: id => bootFeatures[id] !== false,
  },
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
const pluginLoad = await applyPlugins(pluginDiscovery, pluginCtx, undefined, { featureStates: bootFeatures })
const loadedPlugins: LoadedPlugin[] = pluginLoad.loaded
const skippedPlugins = pluginLoad.skipped
/** import/apply 失败的插件：/api/features 与设置页直接展示，不再只打 console */
const failedPlugins = pluginLoad.failed
// 被跳过的功能插件，其技能也要一起隐藏（系统提示 / load_skill / /api/skills 同步）
const hiddenSkills = new Set(skippedPlugins.flatMap(s => s.skills))
if (hiddenSkills.size) {
  for (let i = 0; i < skillProviders.length; i++) {
    skillProviders[i] = new FilteredSkillProvider(skillProviders[i], hiddenSkills)
  }
}
// 插件角色全部注册完毕后，将持久化的技能覆盖同步进 profileRegistry.records（保证 buildSystemPrompt 与 effectiveSkills 同源）
for (const [profileId, overrideSkills] of Object.entries(profileSkillsOverrides)) {
  if (Array.isArray(overrideSkills)) profileRegistry.setSkills(profileId, overrideSkills)
}

// ---- lead → mcmod 任务移交 ----
// 只在 mcmod 角色真正存在（mc 开关开启、插件已 apply）时注册；lead 的 toolFilter 也按同一开关加白名单。
// lead 只负责方案，判定进入实施阶段后直接调用（提示词里写明，不再征询用户），这里只做执行侧校验。
if (bootFeatures.mc !== false && profileRegistry.has('mcmod')) {
  tools.push({
    name: 'handoff_to_mcmod',
    description: '把当前会话移交给 mcmod（Minecraft 1.20.1 Forge 开发主代理）。lead 只制订方案、不做实施，实施（脚手架/构建/写 Java 与资源/加物品方块等）一律调用本工具，无需征询用户；'
      + 'task 传本回合用户的原始需求全文，并在其后追加【方案要点】或【已确认方案】段落（至少包含范围、关键选择、验收点）。'
      + '移交后会话角色持久化为 mcmod，本轮结束后系统会自动用该需求续跑一轮，用户不需要重发。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '本回合用户的原始需求全文（原样粘贴），末尾追加【方案要点】或【已确认方案】（范围、关键选择、验收点）' },
      },
      required: ['task'],
    },
    async execute(args, exec) {
      const s = sessions.get(exec.sessionId)
      if (!s) return { forModel: '会话不存在或已结束，无法移交。', isError: true }
      if (s.mode === 'subagent') return { forModel: '子代理不能移交角色。', isError: true }
      if (s.profile !== 'lead') {
        return { forModel: `当前角色是 ${s.profile}，只有 lead 才能移交给 mcmod。`, isError: true }
      }
      // 等待子代理时面板会锁输入，移交后的续跑也没有意义——直接拒绝
      if (s.waiting.size > 0) {
        return { forModel: '正在等待子代理完成，等结算后再移交。', isError: true }
      }
      const text = String(args.task ?? '').trim()
      if (!text) return { forModel: 'task 不能为空：请传本回合用户的原始需求。', isError: true }

      s.profile = 'mcmod'
      persistMeta(s)
      // 本轮结束后由 afterRootTurn 取出，用同一份需求自动续跑一轮 mcmod
      s.pendingHandoff = { text, at: Date.now() }
      s.sse.send('session/profile', { sessionId: s.id, profile: 'mcmod' })
      return {
        forModel: '已将会话移交给 mcmod。本轮结束后系统会自动用你传入的任务续跑一轮（用户不需要重发），'
          + '请在本轮收尾时用一句话告诉用户「已切换到 mcmod，正在继续」。',
      }
    },
  })
}

// ---- 会话管理 ----
/** 会话级协作状态：计划模式 / 待办 / 授权策略（durable：写 meta，计划与待办同时进日志） */
interface CoopState {
  planMode: boolean
  todos: import('@openmods/plugin-kit').TodoItem[] | null
  permission: 'ask' | 'auto'
  /** 用户点过「本会话内总是允许」的工具 */
  allowedTools: Set<string>
  /** 本会话当前选择的思考强度（low/medium/high…）；空 = 用模型默认 */
  reasoningEffort?: string
}

interface SessionEntry {
  id: string
  createdAt: number
  log: SessionLog
  runtime: SessionRuntime
  sse: SseWriter
  abortController: AbortController | null
  busy: boolean
  /** root=主会话；subagent=子代理（同一会话树里的一个 agent，各自拥有独立画布） */
  mode: 'root' | 'subagent'
  parentId?: string
  /** 会话的活跃画布（durable；模型工具、导出、素材捕获都只作用到它） */
  canvasId: string
  /** 会话拥有的画布集合（durable；老会话缺省时运行时不回填，按单一活跃画布计算） */
  canvasIds?: string[]
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
  /**
   * 本次用户请求已自动续跑的次数（mcmod 触发 step-limit 时使用）。
   * 用户发新消息时清零；结算回合（autoTurn）不计入、也不触发续跑。
   */
  autoContinues: number
  /**
   * 待执行的 lead → mcmod 移交：本轮结束后用这份用户需求自动续跑一轮 mcmod。
   * 只存在内存里（回合收尾即消费），不需要落盘。
   */
  pendingHandoff?: { text: string; at: number }
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

  /** 当前已发出的最大 SSE 帧序号（客户端初次打开进行中会话时据此对齐增量起点） */
  currentSeq(): number {
    return this.seq
  }

  /** 只补发"当前进行中回合"的帧，避免历史回合的增量被重复渲染 */
  replay(sinceId: number): string[] {
    if (!this.buffering) return []
    return this.buffer.filter(b => b.id > sinceId).map(b => b.frame)
  }
}


type MetaFields = Partial<Pick<SessionEntry,
  'mode' | 'parentId' | 'canvasId' | 'canvasIds' | 'agentName' | 'description' | 'status' | 'lastError' | 'lastText' | 'durationMs' | 'outputTokens'>>

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
    // 画布集合：只在已知（新建/已登记）时写，老会话缺字段不回填
    if (entry.canvasIds?.length) patch.canvasIds = entry.canvasIds
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

/** 目录是否是 MC 工程根：gradle.properties 有 minecraft_version，或 build.gradle 引用 ForgeGradle */
function looksLikeMcProject(cwd: string): boolean {
  try {
    const props = join(cwd, 'gradle.properties')
    if (existsSync(props) && /^\s*minecraft_version\s*=/m.test(readFileSync(props, 'utf8'))) return true
    const build = join(cwd, 'build.gradle')
    if (existsSync(build) && /(forgegradle|net\.minecraftforge)/i.test(readFileSync(build, 'utf8'))) return true
  } catch { /* 读不到就当普通目录 */ }
  return false
}

interface CreateSessionOptions {  parentId?: string
  agentName?: string
  description?: string
  modelId?: string
  /** 显式指定会话的活跃画布（一般不传：根会话用自己的 id，建模子代理用自己的独立画布） */
  canvasId?: string
  /** 会话绑定的本地工作目录；缺省给新会话建独立工作区（data/workspaces/<id>），子代理继承父会话 */
  cwd?: string
}

function createSession(id = randomUUID().slice(0, 8), opts: CreateSessionOptions = {}): SessionEntry {
  if (!isValidSessionId(id)) throw new Error('非法会话 id')
  // 是否是从磁盘恢复的老会话：没有 meta.cwd 的历史会话必须继续用 DEFAULT_CWD（不迁移工作区）
  const existed = sessionStore.exists(id)
  // 先占位空日志 + 读到旧 meta：这样"新建后刷新/重启"仍然是一个存在的会话
  sessionStore.ensureLogFile(id)
  const meta = sessionStore.readMeta(id)
  const log = new SessionLog(sessionStore.logPath(id))
  const sse = new SseWriter()
  const mode = meta.mode ?? (meta.parentId || opts.parentId ? 'subagent' : 'root')
  const parentId = meta.parentId ?? opts.parentId
  const agentName = meta.agentName ?? opts.agentName
  const description = meta.description ?? opts.description
  // 画布归属：durable 值优先；新子代理用自己的 id 作为独立画布；
  // 只对"已存在但没有 canvasId"的老会话保留沿父链回溯的兼容逻辑（不改写旧数据）
  const canvasId = meta.canvasId ?? opts.canvasId
    ?? (mode === 'root' ? id : (existed ? canvas.idOf(parentId ?? id) : id))
  canvas.adopt(id, canvasId)
  // 画布集合：新会话登记自己的画布；老会话只有磁盘上已有 canvasIds 时才沿用（缺字段不回填）
  const canvasIds = Array.isArray(meta.canvasIds) && meta.canvasIds.length
    ? meta.canvasIds
    : (existed ? undefined : [canvasId])
  // 工作目录：durable 值优先 → 创建参数 → 父会话继承 → 新会话独立工作区（老会话保持 DEFAULT_CWD）
  const parentCwd = parentId ? (sessions.get(parentId)?.cwd ?? sessionStore.readMeta(parentId).cwd) : undefined
  const cwd = meta.cwd ?? opts.cwd ?? parentCwd
    ?? (existed ? DEFAULT_CWD : (mode === 'root' ? sessionWorkspace(id) : DEFAULT_CWD))

  // —— 协作状态恢复：meta 优先；老日志里可能只有 plan/mode、todo/write 事件 ——
  const lastEvent = (t: string) => {
    const all = log.all()
    for (let i = all.length - 1; i >= 0; i--) if (all[i].t === t) return all[i]
    return undefined
  }
  const loggedPlan = lastEvent('plan/mode')?.active
  const loggedTodos = lastEvent('todo/write')?.todos
  const coop: CoopState = {
    // 计划模式：meta 优先；老日志只有 plan/mode 事件；都没有时 root 会话默认开启
    // （子代理要写画布，默认关闭；MOCK 离线演示是脚本化流程、没有计划评审环节，也不默认开启）
    planMode: typeof meta.planMode === 'boolean' ? meta.planMode : (loggedPlan ?? (mode === 'root' && !MOCK)),
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
      // 普通文件只把落盘路径交给模型，由它按需 read / bash，不把字节塞进上下文
      resolveFile: ref => {
        const path = attachments.filePath(ref)
        return path ? { path, name: ref?.name, bytes: ref?.bytes, mediaType: ref?.mediaType } : undefined
      },
      defaultModelId: settingsStore.defaultModelId(),
      // 每步现读：用户在输入框切换思考强度后，下一步立即使用
      getReasoningEffort: () => coop.reasoningEffort,
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
    { tools, skillProviders, systemSections, profiles: profileRegistry.records, beforeStepHooks, overflowHooks },
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
    canvasIds,
    cwd,
    agentName,
    description,
    profile: (() => {
      // 新 root 会话按绑定目录判断：MC 工程默认 mcmod，普通目录默认 lead；
      // 子代理仍默认 modeling。显式 meta.profile 永远优先。
      const fallback = mode === 'root'
        ? (bootFeatures.mc !== false && profileRegistry.has('mcmod') && looksLikeMcProject(cwd) ? 'mcmod' : 'lead')
        : 'modeling'
      const wanted = meta.profile ?? fallback
      // 角色可能已被功能开关禁用（如 mcmod/modeling）：会话恢复时回落 lead
      return profileRegistry.has(wanted) ? wanted : 'lead'
    })(),
    status: meta.lastStatus ?? 'idle',
    lastError: meta.lastError,
    lastText: meta.lastText,
    durationMs: meta.durationMs,
    outputTokens: meta.outputTokens,
    waiting: new Set<string>(),
    settlements: [],
    autoTurn: false,
    autoContinues: 0,
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

/**
 * 磁盘会话树归属：沿 parentId 链判断 id 是否落在 rootId 这棵树下。
 * 统计接口走磁盘列表（重启后内存 sessions 不完整），按链判断比"直属子代理"更稳。
 */
function inSessionTree(id: string, rootId: string, parentById: Map<string, string | undefined>): boolean {
  let cursor: string | undefined = id
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    if (cursor === rootId) return true
    seen.add(cursor)
    cursor = parentById.get(cursor) ?? sessionStore.readMeta(cursor).parentId
  }
  return false
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
    if (used.has(requested)) throw new Error(`子代理名 "${requested}" 已被同级使用（要给已完成的同名子代理继续派活，请用 resume_subagent）`)
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

/** 结算回合的独立步数预算：只做汇报与验收，别把执行回合的 40 步额度烧在核对上 */
const SETTLEMENT_MAX_STEPS = 12

/**
 * 自动汇总回合：dsh "the next result starts a new turn" 的落点。
 *
 * 结算消息在 dsh 里是一条 `source: subagent-settled` 的 user 消息，父会话 idle 时
 * 走 `queue` 唤醒新一轮。openmods 没有 steer 通道，所以父会话忙时先把结果留在
 * `settlements` 里，由回合收尾（runSessionTurn 末尾）再来一次。
 *
 * 角色必须与会话当前角色一致：提示词、toolFilter、handoff 校验都按 `parent.profile` 走，
 * 否则会出现「提示词是 lead、会话角色是 mcmod」的错位（71d031db）。
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
      text: formatSettlementPrompt(batch, parent.profile),
      profile: parent.profile,
      maxSteps: SETTLEMENT_MAX_STEPS,
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

/** 该角色是否真的拥有某个工具（toolFilter 缺省 = 全部）：结算指令只引用真实存在的工具 */
function profileHasTool(profileId: string, toolName: string): boolean {
  const filter = profileRegistry.get(profileId)?.toolFilter
  return !filter || filter.includes(toolName)
}

/**
 * 结算消息正文：对齐 dsh `createSettlementMessage()` 的措辞，再接一段「有界验收」要求。
 * 按 profile 生成，只引用该角色真实拥有的工具：不点名 list_outline / list_animations，
 * 也不要求在同一回合里逐画布修补或导出（验收交给用户）。
 */
function formatSettlementPrompt(batch: SettledChild[], profile: string): string {
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
  const readStep = profileHasTool(profile, 'list_subagents')
    ? '1) 用 list_subagents 读取每个子代理的收尾汇报（做了什么、各自的画布、没把握的点）；不要逐个画布去读结构。'
    : '1) 读取每个子代理的收尾汇报（做了什么、各自的画布、没把握的点）；不要逐个画布去读结构。'
  const resumeStep = profileHasTool(profile, 'resume_subagent')
    ? '用户指出要改时，用 resume_subagent 把修改任务发给同一个子代理（复用原画布），不要用同名重新 spawn。'
    : '用户指出要改时，按用户的修改要求重新派发任务。'
  const verifyStep = profileHasTool(profile, 'ask_user_question')
    ? '3) 用 ask_user_question **请用户验收**：选项至少含「验收通过，继续下一步 / 要改（用户说明哪里）/ 重做某部分」。用户通过之前不要进入下一阶段。'
    : '3) **请用户验收**（说清要看的画布与未把握的点）：验收通过 / 要改哪里 / 重做某部分。用户通过之前不要进入下一阶段。'
  parts.push(
    '',
    `[runtime] 子代理已全部结算，这一轮是自动开启的汇总回合（角色：${profile}，步数预算有限）。这一轮只做汇报与验收：`,
    readStep,
    '2) 需要看画布时，让用户在右侧拓展的画布页签里确认（提问里写清看哪个子代理/画布），不要自己逐个画布核对、修补或导出。',
    verifyStep,
    `4) 不要在结算回合批量修补、导出、构建或重跑验收；${resumeStep}`,
    '5) 汇报里写清：每个子代理做了什么、各自的画布页签、你没把握的点（有就直接在提问里一并问，不要自己猜）。',
  )
  if (profileHasTool(profile, 'canvas_export')) {
    parts.push('用户验收通过后的下一轮如需导出子代理画布，调用 canvas_export 并传 canvas="<子代理名>" 即可直接导出该子代理画布，本结算回合暂不导出。')
  }
  return parts.join('\n')
}

/**
 * 启动子代理：立即返回，后台并发执行。
 * 子代理是**同一会话树**里的一个 agent（复刻 dsh startActivation 的 parent/child 关系）：
 * 有自己的对话日志、上下文与**独立画布**（用自己的 id 作为活跃画布），
 * 只有 cwd 继承父会话；它改的是自己那块画布，不会占用父会话正在看的画布。
 * 不占用父会话的 busy gate，但会登记到父会话的 `waiting`：主会话从此进入等待态
 * （用户不能插话），最后一只结算时自动开一轮汇总（dsh 的 settlement → 新回合）。
 */
function startSubagent(parent: SessionEntry, input: { description: string; prompt: string; name?: string }): SessionEntry {
  if (parent.mode === 'subagent') throw new Error('子代理不能再派发子代理（深度上限 1）')
  if (isArchivedLineage(parent.id)) throw new Error('会话已归档，不能再派发子代理')
  if (!input.prompt.trim()) throw new Error('prompt 不能为空')
  // 控件已经随 canvas 开关隐藏，这里再兜一层：别让旧客户端/模型把不存在的角色跑起来
  if (!profileRegistry.has('modeling')) throw new Error('建模功能已关闭（设置 → 功能），不能派发建模子代理')
  if (liveSubagentCount(parent.id) >= maxActiveSubagents()) {
    throw new Error(`同时运行的子代理已达上限 ${maxActiveSubagents()} 个，等一个完成后再派发`)
  }
  const name = pickAgentName(parent.id, input.name)
  const id = randomUUID().slice(0, 8)
  const child = createSession(id, {
    parentId: parent.id,
    // 画布独立（createSession 用自己的 id）；只有工作目录继承父会话（dsh：childSessionMeta 带上 parentHeader.cwd）
    cwd: parent.cwd,
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

/**
 * 续作子代理：复用原子会话与原画布，把新任务发给它（不新建、不改名）。
 * 只接受已结算（done/stopped）的直属子代理——运行中要等结算，出错的不能复用坏上下文。
 */
async function resumeSubagent(
  parent: SessionEntry,
  input: { id?: string; name?: string; prompt: string },
): Promise<SessionEntry> {
  if (parent.mode === 'subagent') throw new Error('只有主会话可以续作子代理')
  if (isArchivedLineage(parent.id)) throw new Error('会话已归档，不能再续作子代理')
  if (!input.prompt.trim()) throw new Error('prompt 不能为空')
  if (!profileRegistry.has('modeling')) throw new Error('建模功能已关闭（设置 → 功能），不能续作建模子代理')
  const key = (input.id ?? input.name ?? '').trim()
  if (!key) throw new Error('id 或 name 至少传一个')
  const row = subagentRows(parent.id).find(r => r.id === key || r.agentName === key)
  if (!row) throw new Error(`本会话没有子代理 ${key}（用 list_subagents 看现有子代理）`)
  const child = sessions.get(row.id) ?? await ensureSession(row.id)
  if (child.parentId !== parent.id) throw new Error('该会话不是当前会话的子代理')
  if (child.busy || child.status === 'running') {
    throw new Error(`子代理 ${child.agentName ?? child.id} 还在运行，等它结算后再续作`)
  }
  if (child.status === 'error') {
    throw new Error(`子代理 ${child.agentName ?? child.id} 上次运行出错（${child.lastError ?? '未知错误'}），不能续作；请派发新的子代理`)
  }
  if (child.status !== 'done' && child.status !== 'stopped') {
    throw new Error(`子代理 ${child.agentName ?? child.id} 还没有完成过回合（${child.status}），不能续作`)
  }
  // 复用原会话与原画布：状态回到 running，并重新登记到父会话的等待集合（结算仍走 settleChild）
  child.status = 'running'
  child.lastError = undefined
  persistMeta(child)
  parent.waiting.add(child.id)
  parent.sse.send('subagent/updated', {
    childId: child.id, name: child.agentName, description: child.description, status: 'running',
  })
  parent.sse.send('session/waiting', { sessionId: parent.id, waiting: waitingRows(parent) })
  const resumePrompt = `${input.prompt.trim()}\n\n[系统提醒：你在原画布上继续修改，完成后请调用 canvas_export 重新导出最新模型 JSON 到工作目录，以确保落盘文件同步更新。]`
  void runSessionTurn(child, { text: resumePrompt, profile: 'modeling', modelId: child.runtime.currentModelId })
    .catch(e => {
      console.warn('[subagent] 续作运行异常:', e?.message ?? e)
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
    /** 本轮步数预算（缺省 40）；结算回合传更小的值，避免占满执行回合额度 */
    maxSteps?: number
  },
) {
  const startedAt = Date.now()
  const aborter = new AbortController()
  s.busy = true
  s.abortController = aborter
  // 新回合：插件据此重置会话级节流（连续构建失败计数 / runClient 次数）
  bus.emit('session/turn', { sessionId: s.id })
  s.sse.beginTurn()
  const isSubagent = s.mode === 'subagent'
  if (isSubagent) {
    s.status = 'running'
    s.lastError = undefined
    notifySubagentUpdate(s)
  }

  let result: import('@openmods/agent-core').TurnResult | undefined
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
    s.sse.send('stats', statsFrame(s))
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
    s.sse.send('stats', statsFrame(s))
    s.sse.send('done', { text: result?.text ?? '', aborted: result?.aborted ?? false })
  }
  s.sse.endTurn()
  afterRootTurn(s, result)
}

/** 同一用户请求最多自动续跑 2 次（mcmod 触发 step-limit 时） */
const AUTO_CONTINUE_LIMIT = 2

/**
 * 主会话回合收尾：决定"继续等 / 立刻汇总 / 自动续跑 / 真正空闲"。
 * 这是 dsh 里 `parent.status === 'idle' ? queue : steer` 那段分派在 openmods 的落点——
 * 没有 steer 通道，所以忙时结算先留在收件箱，由这里再启动。
 */
function afterRootTurn(s: SessionEntry, result?: import('@openmods/agent-core').TurnResult) {
  // lead → mcmod 移交：优先用本回合的用户需求自动续跑一轮（不需要用户重发）。
  // 先清空标记，避免续跑回合收尾时再次触发。
  const handoff = s.pendingHandoff
  if (handoff) {
    s.pendingHandoff = undefined
    if (isArchivedLineage(s.id)) return
    void runSessionTurn(s, { text: handoff.text, profile: 'mcmod' })
      .catch(e => console.warn('[handoff] mcmod 续跑失败:', e?.message ?? e))
    return
  }
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
  if (maybeAutoContinueAfterStepLimit(s, result)) return
  s.sse.send('session/waiting', { sessionId: s.id, waiting: [] })
}

/**
 * 执行型角色（mcmod）触发 step-limit 时自动续跑：用户不需要反复输入「继续」。
 * 结算回合（autoTurn）不续跑；同一用户请求最多 2 次，超过后停下并给出进度提示。
 */
function maybeAutoContinueAfterStepLimit(
  s: SessionEntry,
  result?: import('@openmods/agent-core').TurnResult,
): boolean {
  if (result?.reason !== 'step-limit') return false
  if (s.profile !== 'mcmod') return false
  // 结算回合与自动续跑互斥：自动汇总本身不触发续跑
  if (s.autoTurn) return false
  if (isArchivedLineage(s.id)) return false
  if (s.autoContinues >= AUTO_CONTINUE_LIMIT) {
    s.sse.send('session/progress', {
      sessionId: s.id,
      kind: 'auto-continue',
      done: true,
      text: `已自动续跑 ${s.autoContinues} 次仍未完成，先停下；未完成的部分见待办与最后一轮汇报。`,
    })
    return false
  }
  s.autoContinues += 1
  const attempt = s.autoContinues
  s.sse.send('session/progress', {
    sessionId: s.id,
    kind: 'auto-continue',
    attempt,
    limit: AUTO_CONTINUE_LIMIT,
    text: `mcmod 单轮步数已用尽，正在自动续跑（第 ${attempt}/${AUTO_CONTINUE_LIMIT} 次）…`,
  })
  void runSessionTurn(s, {
    text: '继续执行上一条请求中未完成的部分；不要重复已完成的工作。',
    profile: s.profile,
    // 归属标记：前端按 notice 渲染，不显示成用户自己发的消息
    source: { kind: 'auto-continue', form: 'notice', attempt, limit: AUTO_CONTINUE_LIMIT },
  }).catch(e => console.warn('[auto-continue] 续跑失败:', e?.message ?? e))
  return true
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

/** stats + context 三件套，并把 tokenSplit 三段从 contextBreakdown 回填。
 *  REST /stats 与所有 SSE stats 帧都必须走这里：日志投影里 system/tools/message
 *  恒为 0（日志没有拆分），只带旁路 contextBreakdown 的话，前端 SSE 帧一覆盖就把
 *  「系统提示词/工具定义/对话内容」打回 0k。 */
function statsFrame(s: SessionEntry) {
  const stats = projectStats(s.log.all())
  const figures = contextFigures(s)
  if (figures.contextBreakdown) {
    stats.context.tokenSplit.system = figures.contextBreakdown.systemTokens
    stats.context.tokenSplit.tools = figures.contextBreakdown.toolsTokens
    stats.context.tokenSplit.message = figures.contextBreakdown.messageTokens
  }
  return { stats, ...figures }
}

// ---- 内部事件 → SSE 桥 ----
// 画布变更不再由 server 手动 fan-out：CanvasService 是唯一权威，一次 commit 广播一次，
// 每条 SSE 连接自己按 canvasId 过滤（与 dsh 的事件总线 + 会话投影同构）。
bus.on('compaction/done', (data: any) => {
  const s = sessions.get(data.sessionId)
  if (!s) return
  s.sse.send('compaction', data)
  s.sse.send('stats', statsFrame(s))
})

// ---- Fastify ----
const app = Fastify({ logger: false, bodyLimit: 15 * 1024 * 1024 })

// 素材上传走原始字节（不引入 multipart）：前端 fetch body=File，content-type 按扩展名
app.addContentTypeParser(
  ['application/octet-stream', 'application/java-archive', 'application/zip', 'image/png', 'image/jpeg', 'image/webp'],
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
)

// ---- 插件路由挂载（apply 阶段收集，此时 Fastify 才存在） ----
for (const r of pluginHttpRoutes) {
  app.route({
    method: r.method,
    url: r.path,
    ...(r.opts?.bodyLimit ? { bodyLimit: r.opts.bodyLimit } : {}),
    handler: async (req, reply) => {
      // 插件 handler 与宿主路由同一语义：返回值直接回给客户端，显式 reply.send 也算
      const out = await r.handler(req, reply)
      // 已经 send 过（含流式下载）就不要再把 Reply 当 payload 回传
      if (out === undefined || out === reply) return reply.sent ? undefined : null
      return out
    },
  })
}

app.get('/api/health', async () => ({ ok: true, mock: MOCK, plugins: loadedPlugins.map(p => p.name) }))

// 系统日志：after 为上次拿到的 seq，增量返回；file 是当天落盘日志路径
app.get('/api/logs', async (req) => {
  const after = Number((req.query as any)?.after ?? 0)
  const limit = Number((req.query as any)?.limit ?? 300)
  const result = getLogs(Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 300)
  return { ...result, file: logFilePath() }
})

// ---- Java / Gradle 后台进程（前端浮窗自动检测 + 手动结束） ----
app.get('/api/procs/java', async () => listJavaProcesses())

app.post('/api/procs/java/kill', async (req, reply) => {
  const body = (req.body ?? {}) as { pid?: number }
  const r = killJavaProcess(Number(body.pid))
  if (!r.ok) return reply.code(400).send({ error: r.error })
  return { ok: true }
})

app.post('/api/procs/java/kill-all', async (req) => {
  const body = (req.body ?? {}) as { includeClient?: boolean }
  return killJavaProcesses({ includeClient: !!body.includeClient })
})

// 自更新：只检查 GitHub main；apply 由用户手动触发（git pull + 前端重建，支持 autoStash 暂存本地改动）
app.get('/api/update/status', async () => getUpdateStatus())
app.post('/api/update/apply', async (req, reply) => {
  try {
    const body = (req.body ?? {}) as { autoStash?: boolean }
    return await applyUpdate({ autoStash: !!body.autoStash })
  } catch (e: any) {
    return reply.code(500).send({ ok: false, error: e?.message ?? String(e) })
  }
})

// 功能关闭时相关接口统一 404（前端入口也会按 /api/features 隐藏；
// 服务端也要拦，避免首屏 features 还没回来时前端把入口/按钮渲染出来）。
// 插件自带路由（如 /api/mc）不需要前缀拦截：插件未 apply 时路由根本没注册。
app.addHook('onRequest', async (req, reply) => {
  if (bootFeatures.library === false && req.url.startsWith('/api/library')) {
    return reply.code(404).send({ error: '素材库已关闭（设置 → 功能）' })
  }
})

// 可选代理角色：只列当前功能开关下可用的（内部子代理角色 + requires 不满足的角色都不出现）
app.get('/api/profiles', async () => ({
  profiles: profileRegistry.visible(bootFeatures).map(p => ({ id: p.id, name: p.name, description: p.description ?? '' })),
}))

/**
 * 功能开关（单一事实源）：
 * enabled = 本次进程启动时实际加载的状态；pendingRestart = settings 已改但还没重启。
 * 前端据此隐藏画布/MC/素材库入口，设置页据此渲染开关。
 */
app.get('/api/features', async () => {
  // 与启动态同一套声明表，插件自带的开关才能正确计算 enabled / pendingRestart
  const desired = resolveFeatureStates(settingsStore.getPrefs().features, declaredFeatures)
  return {
    features: declaredFeatures.map(f => ({
      id: f.id,
      name: f.name,
      description: f.description ?? '',
      enabled: bootFeatures[f.id] !== false,
      default: f.default !== false,
      pendingRestart: (desired[f.id] !== false) !== (bootFeatures[f.id] !== false),
    })),
    profiles: profileRegistry.visible(bootFeatures).map(p => ({ id: p.id, name: p.name, description: p.description ?? '' })),
    plugins: {
      loaded: loadedPlugins.map(p => p.name),
      skipped: skippedPlugins.map(s => ({ name: s.name, reason: s.reason })),
      failed: failedPlugins.map(f => ({ name: f.name, phase: f.phase, error: f.error })),
    },
  }
})

// ---- 设置 → 代理与技能 ----

/** 按角色解析生效工具（与 runtime 的 selectTools 同一语义：白名单 ∩ 非排除） */
function resolveProfileTools(profileId: string): {
  name: string
  description: string
  parameters: unknown
  mutates: boolean
  returns: string
}[] {
  const p = profileRegistry.get(profileId)
  if (!p) return []
  let list = tools
  if (p.toolFilter) list = list.filter(t => p.toolFilter!.includes(t.name))
  if (p.toolExclude) list = list.filter(t => !p.toolExclude!.includes(t.name))
  return list.map(t => ({
    name: t.name,
    // 全量描述：首行当摘要，其余正文在设置页展开后看
    description: t.description,
    parameters: t.parameters ?? null,
    mutates: !!t.mutates,
    // 所有工具统一走 ToolResult：给模型看的文本 + 可选错误标记
    returns: '{ forModel: string; isError?: boolean }',
  }))
}

/** 设置页看全三个角色（含 modeling 子代理）：工具清单 + 技能分配 */
app.get('/api/agents/detail', async () => ({
  agents: profileRegistry.list().map(p => ({
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
  if (!profileRegistry.has(id)) return reply.code(404).send({ error: `角色不存在: ${id}` })
  const { skills } = req.body as { skills?: unknown }
  if (!Array.isArray(skills) || skills.some(s => typeof s !== 'string')) {
    return reply.code(400).send({ error: 'skills 必须是字符串数组' })
  }
  const known = new Set(skillProviders.flatMap(p => p.list().map(m => m.name)))
  profileSkillsOverrides[id] = [...new Set(skills.map(String))].filter(s => known.has(s))
  profileRegistry.setSkills(id, profileSkillsOverrides[id])
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
  for (const id of Object.keys(profileRegistry.records)) {
    if (profileSkillsOverrides[id]) {
      profileSkillsOverrides[id] = profileSkillsOverrides[id].filter(s => s !== name)
      profileRegistry.setSkills(id, profileSkillsOverrides[id])
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
  // providers / bridge / prefs / environment 都是可选的：设置页按分区保存，不会互相覆盖
  const body = (req.body ?? {}) as { providers?: any; bridge?: any; prefs?: any; environment?: any; expectedRevision?: number }
  try {
    // 环境配置与专门的 /api/env/apply 走同一套校验，避免非法路径被写进 settings.json
    if (body.environment !== undefined) {
      const e = body.environment ?? {}
      validateEnvironmentPatch({
        javaHome: e.javaHome !== undefined ? String(e.javaHome ?? '') : undefined,
        gradleHome: e.gradleHome !== undefined ? String(e.gradleHome ?? '') : undefined,
        gitPath: e.gitPath !== undefined ? String(e.gitPath ?? '') : undefined,
      })
    }
    const newRevision = settingsStore.save(
      { providers: body.providers, bridge: body.bridge, prefs: body.prefs, environment: body.environment },
      body.expectedRevision,
    )
    // 环境配置随设置一起保存时，立刻应用到进程环境（下一轮构建/测试/更新生效）
    if (body.environment !== undefined) applyEnvironment(settingsStore.getEnvironment())
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

// ---- 环境检测（设置 → 环境 / 首次运行向导） ----
/** 当前四项检测结果（Java / Gradle 缓存 / Git / 测试客户端），不写任何文件 */
app.get('/api/env/status', async () => {
  const prefs = settingsStore.getPrefs()
  return checkEnvStatus(settingsStore.getEnvironment(), {
    testClientDir: prefs.testClientDir,
    testMdkDir: prefs.testMdkDir,
  })
})

/**
 * 保存环境配置并立即生效：
 * - fixVendorLayout=true 时先把 plugins/mcdev 下错位的 gradle-8.8 / fg-maven 移到 vendor/
 * - 只校验/保存请求里出现的字段；校验失败返回 400 中文消息
 * 返回最新 EnvStatus，前端可直接刷新卡片与候选列表。
 */
app.post('/api/env/apply', async (req, reply) => {
  const body = (req.body ?? {}) as {
    javaHome?: unknown; gradleHome?: unknown; gitPath?: unknown; setupDone?: unknown
    fixVendorLayout?: unknown; expectedRevision?: unknown
    testClientDir?: unknown; testMdkDir?: unknown
  }
  try {
    if (body.fixVendorLayout === true) {
      const fixed = fixVendorLayout()
      if (!fixed.ok) return reply.code(400).send({ error: fixed.error ?? '整理 vendor 失败' })
    }
    const patch: { javaHome?: string; gradleHome?: string; gitPath?: string; setupDone?: boolean } = {}
    if (body.javaHome !== undefined) patch.javaHome = String(body.javaHome ?? '').trim()
    if (body.gradleHome !== undefined) patch.gradleHome = String(body.gradleHome ?? '').trim()
    if (body.gitPath !== undefined) patch.gitPath = String(body.gitPath ?? '').trim()
    if (typeof body.setupDone === 'boolean') patch.setupDone = body.setupDone
    validateEnvironmentPatch(patch)
    // 测试客户端 / MDK 路径属于 prefs；非空路径必须真实存在，避免把死路径存进去
    const prefsPatch: { testClientDir?: string; testMdkDir?: string } = {}
    if (body.testClientDir !== undefined) {
      const dir = String(body.testClientDir ?? '').trim()
      if (dir && !existsSync(dir)) return reply.code(400).send({ error: `测试客户端目录不存在：${dir}` })
      prefsPatch.testClientDir = dir
    }
    if (body.testMdkDir !== undefined) {
      const dir = String(body.testMdkDir ?? '').trim()
      if (dir && !existsSync(dir)) return reply.code(400).send({ error: `MDK 目录不存在：${dir}` })
      prefsPatch.testMdkDir = dir
    }
    const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
    if (Object.keys(prefsPatch).length > 0) {
      settingsStore.save({ environment: patch, prefs: prefsPatch }, expected)
    } else {
      settingsStore.saveEnvironment(patch, expected)
    }
    applyEnvironment(settingsStore.getEnvironment())
    for (const s of sessions.values()) {
      s.sse.send('settings/updated', { revision: settingsStore.revision, prefs: settingsStore.getPrefs() })
    }
    const prefs = settingsStore.getPrefs()
    return checkEnvStatus(settingsStore.getEnvironment(), {
      testClientDir: prefs.testClientDir,
      testMdkDir: prefs.testMdkDir,
    })
  } catch (e: any) {
    if (e.name === 'SettingsConflictError') return reply.code(409).send({ error: e.message })
    return reply.code(400).send({ error: e?.message ?? String(e) })
  }
})

// ---- 在线下载离线构建包（进度 / 速度 / 取消） ----
/** 当前下载状态；前端在 downloading / extracting 期间轮询 */
app.get('/api/env/vendor/download', async () => vendorDownloadStatus())

app.post('/api/env/vendor/download', async (req, reply) => {
  const source = (req.body as { source?: unknown } | null)?.source
  const r = startVendorDownload(isVendorSource(source) ? source : 'official')
  if (!r.ok) return reply.code(409).send({ error: r.error })
  return { ok: true }
})

app.post('/api/env/vendor/cancel', async (_req, reply) => {
  if (!cancelVendorDownload()) return reply.code(409).send({ error: '当前没有进行中的下载' })
  return { ok: true }
})

// ---- 在线下载测试客户端离线包（解压到 data/mc-test-client/.minecraft） ----
app.get('/api/env/test-client/download', async () => testClientDownloadStatus())

app.post('/api/env/test-client/download', async (req, reply) => {
  const source = (req.body as { source?: unknown } | null)?.source
  const r = startTestClientDownload(isTestClientSource(source) ? source : 'official')
  if (!r.ok) return reply.code(409).send({ error: r.error })
  return { ok: true }
})

app.post('/api/env/test-client/cancel', async (_req, reply) => {
  if (!cancelTestClientDownload()) return reply.code(409).send({ error: '当前没有进行中的下载' })
  return { ok: true }
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

// 模型发现：OpenAI 兼容端点探测 /models，Gemini 探测 /v1beta/models（复刻 dsh llm.discoverModels）
/** 解析 /models 里的一条能力声明（上下文、模态、思考档位） */
function normalizeListedModel(entry: any): { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number; inputModalities?: string[]; reasoningEfforts?: string[]; reasoningDefault?: string } | undefined {
  if (typeof entry === 'string') entry = { id: entry }
  if (!entry || typeof entry !== 'object') return undefined
  const rawId = entry.id ?? entry.name ?? entry.model
  if (typeof rawId !== 'string' || !rawId.trim()) return undefined
  // Gemini /v1beta/models 的 name 是 "models/gemini-..."，统一去掉前缀，复合 id 才是 route/modelId
  const id = rawId.trim().replace(/^models\//, '')
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
    entry.inputTokenLimit,
    top.context_length, entry.limits?.context_window,
  )
  const maxOutputTokens = num(
    entry.max_output_tokens, entry.max_tokens, entry.maxOutputTokens,
    entry.outputTokenLimit,
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
  // 思考强度：优先读端点自己的 effort 声明（DeepSeek 用 {supported_levels, default_level}），
  // 其余网关可能是 reasoning_efforts / capabilities.reasoning_efforts / reasoning.efforts。
  // 档位不写死白名单：每个模型可以有自己的档位（low/high/max…）。
  const normalizeLevel = (v: any): string | undefined => {
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      return /^[a-z][a-z0-9_-]{0,15}$/.test(s) ? s : undefined
    }
    if (v && typeof v === 'object') return normalizeLevel(v.level ?? v.name ?? v.id)
    return undefined
  }
  const rawEfforts = (typeof entry.effort === 'object' ? entry.effort : undefined)?.supported_levels
    ?? (typeof entry.effort === 'object' ? entry.effort : undefined)?.levels
    ?? (typeof entry.effort === 'object' ? entry.effort : undefined)?.supported
    ?? entry.reasoning_efforts ?? entry.reasoningEfforts
    ?? entry.supported_reasoning_efforts ?? entry.capabilities?.reasoning_efforts
    ?? entry.reasoning?.efforts
  let reasoningEfforts: string[] | undefined
  if (Array.isArray(rawEfforts)) {
    reasoningEfforts = [...new Set(rawEfforts.map(normalizeLevel).filter((x: string | undefined): x is string => !!x))]
  } else {
    const one = normalizeLevel(rawEfforts)
    if (one) reasoningEfforts = [one]
  }
  if (!reasoningEfforts?.length) {
    const supported = Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters.map((p: any) => String(p).toLowerCase())
      : []
    const flag = entry.supports_reasoning ?? entry.capabilities?.reasoning
      ?? (typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined)
      ?? (supported.includes('reasoning') ? true : undefined)
    if (flag === true) reasoningEfforts = ['low', 'medium', 'high']
  }
  const reasoningDefault = normalizeLevel(
    entry.effort?.default_level ?? entry.effort?.default ?? entry.reasoning?.default ?? entry.default_reasoning_effort,
  )

  const inferred = inferModelCapabilities(id)
  return {
    id,
    name: typeof entry.display_name === 'string' ? entry.display_name
      : typeof entry.displayName === 'string' && entry.displayName !== id ? entry.displayName
        : typeof entry.name === 'string' && entry.name !== id && !/^models\//.test(entry.name) ? entry.name : undefined,
    // 端点声明优先，缺什么补什么；都缺就留空让用户手填
    contextWindow: contextWindow ?? inferred.contextWindow,
    maxOutputTokens,
    inputModalities: inputModalities?.length
      ? inputModalities
      : inferred.vision === true ? ['text', 'image'] : inferred.vision === false ? ['text'] : undefined,
    reasoningEfforts: reasoningEfforts?.length ? reasoningEfforts : inferReasoningEfforts(id),
    reasoningDefault,
  }
}

app.post('/api/settings/discover-models', async (req, reply) => {
  const body = (req.body ?? {}) as { baseURL?: string; route?: string; apiKey?: string; format?: string }
  const baseURL = String(body.baseURL ?? '').trim()
  if (!baseURL) return reply.code(400).send({ error: 'baseURL 不能为空' })
  const format = body.format === 'gemini' ? 'gemini' : 'openai'
  const apiKey = body.apiKey?.trim() || (body.route ? settingsStore.getCredential(body.route) : undefined)
  try {
    const url = format === 'gemini' ? geminiModelsUrl(baseURL) : `${baseURL.replace(/\/+$/, '')}/models`
    const res = await fetch(url, {
      headers: apiKey
        ? (format === 'gemini' ? { 'x-goog-api-key': apiKey } : { authorization: `Bearer ${apiKey}` })
        : {},
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      const hint = res.status === 401 || res.status === 403 ? '（API key 缺失或无效）' : ''
      return reply.code(400).send({ error: `端点返回 HTTP ${res.status}${hint} ${detail}` })
    }
    const json: any = await res.json()
    // dsh：标准 `data` 数组、富化的 `models` map、Gemini `models` 数组都接受
    const raw: any[] = Array.isArray(json) ? json
      : Array.isArray(json?.data) ? json.data
        : Array.isArray(json?.models) ? json.models
          : json?.models && typeof json.models === 'object' ? Object.entries(json.models).map(([k, v]) => ({ id: k, ...(v ?? {}) }))
            : []
    const models = raw.map(normalizeListedModel).filter((m): m is NonNullable<typeof m> => !!m)
    const seen = new Set<string>()
    const unique = models.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    if (!unique.length) return reply.code(400).send({ error: `端点响应中没有可识别的模型列表（期望 OpenAI {data:[{id}]} 或 Gemini {models:[{name}]}）` })
    return { models: unique }
  } catch (e: any) {
    const msg = e.name === 'TimeoutError' ? '端点连接超时（15s）' : `无法访问端点：${e.message}`
    return reply.code(400).send({ error: msg })
  }
})

// ---- 视觉能力实测：给每个模型发一张极小图片，按响应判断是否真的支持图片输入 ----
/** 16×16 纯色 PNG：部分网关拒绝 1×1（要求宽高 > 10） */
const VISION_PROBE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAdSURBVDhPYzghJ/efEsyALkAqHjVg1IBRAwaLAQAG2gMfuJdtFgAAAABJRU5ErkJggg=='

app.post('/api/settings/probe-vision', async (req, reply) => {
  const body = (req.body ?? {}) as { baseURL?: string; route?: string; apiKey?: string; models?: unknown; format?: string }
  const base = String(body.baseURL ?? '').trim().replace(/\/+$/, '')
  if (!base) return reply.code(400).send({ error: 'baseURL 不能为空' })
  const format = body.format === 'gemini' ? 'gemini' : 'openai'
  const apiKey = body.apiKey?.trim() || (body.route ? settingsStore.getCredential(body.route) : undefined)
  const ids = Array.isArray(body.models)
    ? [...new Set(body.models.map(v => String(v ?? '').trim()).filter(Boolean))]
    : []
  if (!ids.length) return reply.code(400).send({ error: 'models 不能为空' })

  const results: { id: string; vision: boolean | null; error?: string }[] = []
  const queue = [...ids]
  const probeOne = async (id: string) => {
    try {
      const url = format === 'gemini' ? geminiInteractionsUrl(base) : `${base}/chat/completions`
      const headers = {
        'content-type': 'application/json',
        ...(apiKey
          ? (format === 'gemini' ? { 'x-goog-api-key': apiKey } : { authorization: `Bearer ${apiKey}` })
          : {}),
      }
      const payload = format === 'gemini'
        ? {
            model: id.replace(/^models\//, ''),
            store: false,
            input: [{
              type: 'user_input',
              content: [
                { type: 'text', text: '只回复 OK' },
                { type: 'image', data: VISION_PROBE_IMAGE.split(',')[1], mime_type: 'image/png' },
              ],
            }],
            generation_config: { max_output_tokens: 4 },
          }
        : {
            model: id,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: '只回复 OK' },
                { type: 'image_url', image_url: { url: VISION_PROBE_IMAGE } },
              ],
            }],
            max_tokens: 4,
          }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) { results.push({ id, vision: true }); return }
      const detail = (await res.text().catch(() => '')).slice(0, 500)
      const lower = detail.toLowerCase()
      // 鉴权 / 余额 / 服务不可用：能力未知，不当作不支持
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 404 || res.status >= 500) {
        results.push({ id, vision: null, error: `HTTP ${res.status}${/balance|余额/.test(lower) ? '（余额不足）' : ''}` })
        return
      }
      // 明确拒绝图片输入
      if (/(only supports? text|does not support|not support|unsupported).{0,40}(image|vision|multimodal|image_url|modality)|仅支持文本|不支持(图片|图像|视觉)/i.test(detail)) {
        results.push({ id, vision: false })
        return
      }
      // 图片被接收但尺寸/格式不合规，说明链路本身支持图片输入
      if (/image/i.test(lower) && /(length and width|dimension|width|height|resolution|format|size|尺寸|分辨率)/i.test(lower)) {
        results.push({ id, vision: true })
        return
      }
      results.push({ id, vision: null, error: `HTTP ${res.status} ${detail.slice(0, 160)}` })
    } catch (e: any) {
      results.push({ id, vision: null, error: e?.name === 'TimeoutError' ? '超时（30s）' : (e?.message ?? String(e)) })
    }
  }
  const worker = async () => { while (queue.length) await probeOne(queue.shift()!) }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
  // 按请求顺序返回，前端逐行对齐
  const byId = new Map(results.map(r => [r.id, r]))
  return { results: ids.map(id => byId.get(id) ?? { id, vision: null, error: '未探测' }) }
})

// ---- 会话 ----
app.post('/api/sessions', async (req, reply) => {
  // 先清一遍历史空会话：点「新对话」不再立即建会话（前端惰性），但旧客户端/残留还是会产生
  pruneEmptySessions()
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

/**
 * 清理「只建没聊」的空会话：日志里没有任何用户消息、画布没模型、没绑素材的 root 会话，
 * 直接从磁盘删掉（jsonl + meta + bbdoc）——用户点 N 次「新对话」不该留下 N 条「新对话」。
 * 只删磁盘：内存里本次运行打开/新建的会话一律跳过（正在用），子代理会话不归这里管。
 */
function pruneEmptySessions(): number {
  let n = 0
  for (const row of sessionStore.list()) {
    if (row.mode === 'subagent') continue
    if (sessions.has(row.id)) continue // 本次运行已打开/创建 = 活跃，不碰
    if (row.title) continue // 有用户消息 = 有对话
    if (row.hasModel) continue // 画布上有模型
    if (sessionStore.readMeta(row.id).libraryId) continue // 素材编辑会话
    try {
      rmSync(sessionStore.logPath(row.id), { force: true })
      rmSync(sessionStore.metaPath(row.id), { force: true })
      rmSync(sessionStore.docPath(row.id), { force: true })
      n++
    } catch { /* 单个失败不阻塞 */ }
  }
  if (n) console.log(`[cleanup] 已清理 ${n} 个未产生对话的空会话`)
  return n
}

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

/**
 * 打开下载区的默认落点目录（资源管理器）。目录可能还没建过，先递归创建再打开：
 * - vendor → plugins/mcdev/vendor（解压后应直接是 gradle-8.8/、fg-maven/）
 * - test-client → data/mc-test-client（解压后应直接是 .minecraft/）
 */
app.post('/api/fs/open-dir', async (req, reply) => {
  const body = (req.body ?? {}) as { kind?: string }
  const kind = String(body.kind ?? '').trim()
  const target = kind === 'vendor'
    ? join(ROOT, 'plugins', 'mcdev', 'vendor')
    : kind === 'test-client'
      ? join(ROOT, 'data', 'mc-test-client')
      : ''
  if (!target) return reply.code(400).send({ error: 'kind 需为 vendor 或 test-client' })
  if (process.platform !== 'win32') return reply.code(400).send({ error: '仅支持 Windows 资源管理器' })
  mkdirSync(target, { recursive: true })
  const { spawn } = await import('node:child_process')
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true, path: target }
})

/**
 * 系统原生「选择文件夹」对话框（资源管理器风格，IFileOpenDialog + FOS_PICKFOLDERS）。
 * 服务跑在本机，弹窗由服务端拉起；前端只拿选中的绝对路径，取消返回 path: null。
 */
const PICK_DIR_PS = [
  'param([string]$Out, [string]$Title, [string]$Initial)',
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  '',
  'public static class OpenModsFolderPicker',
  '{',
  '    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '    private interface IFileDialog',
  '    {',
  '        [PreserveSig] int Show(IntPtr parent);',
  '        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);',
  '        void SetFileTypeIndex(uint iFileType);',
  '        void GetFileTypeIndex(out uint piFileType);',
  '        void Advise(IntPtr pfde, out uint pdwCookie);',
  '        void Unadvise(uint dwCookie);',
  '        void SetOptions(uint fos);',
  '        void GetOptions(out uint pfos);',
  '        void SetDefaultFolder(IShellItem psi);',
  '        void SetFolder(IShellItem psi);',
  '        void GetFolder(out IShellItem ppsi);',
  '        void GetCurrentSelection(out IShellItem ppsi);',
  '        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);',
  '        void GetFileName(out IntPtr pszName);',
  '        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);',
  '        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);',
  '        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);',
  '        void GetResult(out IShellItem ppsi);',
  '        void AddPlace(IShellItem psi, int fdap);',
  '        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);',
  '        void Close(int hr);',
  '        void SetClientGuid(ref Guid guid);',
  '        void ClearClientData();',
  '        void SetFilter(IntPtr pFilter);',
  '    }',
  '',
  '    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '    private interface IShellItem',
  '    {',
  '        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);',
  '        void GetParent(out IShellItem ppsi);',
  '        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);',
  '        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);',
  '        void Compare(IShellItem psi, uint hint, out int piOrder);',
  '    }',
  '',
  '    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]',
  '    private class FileOpenDialog { }',
  '',
  '    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]',
  '    private static extern void SHCreateItemFromParsingName(',
  '        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,',
  '        IntPtr pbc,',
  '        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,',
  '        [MarshalAs(UnmanagedType.Interface)] out object ppv);',
  '',
  '    public static string Pick(string title, string initialDir)',
  '    {',
  '        IFileDialog dialog = (IFileDialog)new FileOpenDialog();',
  '        uint options;',
  '        dialog.GetOptions(out options);',
  '        dialog.SetOptions(options | 0x20u | 0x40u);',
  '        if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);',
  '        if (!String.IsNullOrEmpty(initialDir))',
  '        {',
  '            try',
  '            {',
  '                object item;',
  '                SHCreateItemFromParsingName(initialDir, IntPtr.Zero, typeof(IShellItem).GUID, out item);',
  '                dialog.SetFolder((IShellItem)item);',
  '            }',
  '            catch { }',
  '        }',
  '        if (dialog.Show(IntPtr.Zero) != 0) return null;',
  '        IShellItem result;',
  '        dialog.GetResult(out result);',
  '        string path;',
  '        result.GetDisplayName(0x80058000u, out path);',
  '        return path;',
  '    }',
  '}',
  "'@",
  '$picked = [OpenModsFolderPicker]::Pick($Title, $Initial)',
  'if ($picked) { [IO.File]::WriteAllText($Out, $picked, [Text.Encoding]::UTF8) }',
].join('\r\n')

app.post('/api/fs/pick-dir', async (req, reply) => {
  const body = (req.body ?? {}) as { path?: string; title?: string }
  if (process.platform !== 'win32') return reply.code(400).send({ error: '仅支持 Windows 系统文件夹对话框' })
  const start = resolveDir(String(body.path ?? '').trim()) ?? DEFAULT_CWD
  const title = String(body.title ?? '').trim() || '选择文件夹'
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmods-pick-'))
  const script = path.join(tmp, 'pick.ps1')
  const outFile = path.join(tmp, 'picked.txt')
  try {
    fs.writeFileSync(script, PICK_DIR_PS, 'utf8')
    const ok = await new Promise<boolean>(resolve => {
      const p = spawn('powershell.exe', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, outFile, title, start,
      ], { windowsHide: true, stdio: 'ignore' })
      p.on('exit', code => resolve(code === 0))
      p.on('error', () => resolve(false))
    })
    if (!ok) return reply.code(500).send({ error: '打开系统文件夹对话框失败' })
    let picked = ''
    try { picked = fs.readFileSync(outFile, 'utf8').trim() } catch { /* 用户取消或直接关闭 */ }
    return { path: picked || null }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
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
  bus.emit('session/interaction-answered', { sessionId: s.id })
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

// 关闭终端（前端标签的 × / 全部清空）：运行中的先收进程树，条目立即移除
app.delete('/api/terminals/:tid', async (req, reply) => {
  const sid = String((req.query as any)?.sessionId ?? '').trim()
  const t = terminals.get(String((req.params as any).tid))
  if (!t || t.sessionId !== sid) return reply.code(404).send({ error: '终端不存在' })
  return { ok: terminals.close(t.id) }
})

app.post('/api/terminals/:tid/close', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string }
  const sid = String(body.sessionId ?? '').trim()
  const t = terminals.get(String((req.params as any).tid))
  if (!t || t.sessionId !== sid) return reply.code(404).send({ error: '终端不存在' })
  return { ok: terminals.close(t.id) }
})

// 清空某会话的全部终端（对应「全部清空」）
app.delete('/api/terminals', async (req, reply) => {
  const sid = String((req.query as any)?.sessionId ?? '').trim()
  if (!sid) return reply.code(400).send({ error: 'sessionId 不能为空' })
  return { ok: true, closed: terminals.closeSession(sid) }
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
      /** 当前已发送的 SSE 帧序号：前端重连/打开运行中会话时可用它避免重放已包含在 events 里的历史帧 */
      streamSeq: s.sse.currentSeq(),
      /** 上下文环的分子/分母 + 图形化面板的三段构成（与 stats 帧同源） */
      ...contextFigures(s),
      modelId: s.runtime.currentModelId,
      mode: s.mode,
      parentId: s.parentId,
      /** 画布归属：canvasId 是活跃画布（durable，等价 dsh 会话的 cwd） */
      canvasId: s.canvasId,
      /** 会话拥有的画布集合（活跃画布在第一项） */
      canvasIds: canvas.listOf(s.id),
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

// ---- 会话多画布（活跃画布）----
/** 画布接口的公共载荷：会话树画布列表 + 当前活跃画布 */
function canvasTreePayload(s: SessionEntry) {
  return { sessionId: s.id, activeCanvasId: canvas.idOf(s.id), canvases: canvas.listTree(s.id) }
}

/** 画布集合/活跃画布变化：向本会话与父会话 SSE 广播（父会话的面板要同步子代理画布） */
function broadcastCanvases(s: SessionEntry, data: ReturnType<typeof canvasTreePayload>) {
  s.sse.send('canvases/update', data)
  const parent = s.parentId ? sessions.get(s.parentId) : undefined
  parent?.sse.send('canvases/update', data)
}

/** 活跃画布变更后同步内存会话并落盘（CanvasService 已写 meta，这里补齐 entry 字段） */
function syncCanvasEntry(s: SessionEntry) {
  s.canvasId = canvas.idOf(s.id)
  s.canvasIds = canvas.listOf(s.id)
  persistMeta(s)
}

app.get('/api/sessions/:id/canvases', async (req, reply) => {
  try {
    const s = await ensureSession((req.params as any).id)
    return canvasTreePayload(s)
  } catch (e: any) { return reply.code(404).send({ error: e.message }) }
})

app.post('/api/sessions/:id/canvases', async (req, reply) => {
  let s: SessionEntry
  try { s = await ensureSession((req.params as any).id) } catch (e: any) { return reply.code(404).send({ error: e.message }) }
  try {
    const body = (req.body ?? {}) as { name?: string; activate?: boolean }
    const canvasId = canvas.createCanvas(s.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      activate: body.activate !== false,
    })
    syncCanvasEntry(s)
    const payload = canvasTreePayload(s)
    broadcastCanvases(s, payload)
    return { ...payload, canvasId }
  } catch (e: any) { return reply.code(400).send({ error: e.message }) }
})

app.post('/api/sessions/:id/canvases/:canvasId/activate', async (req, reply) => {
  let s: SessionEntry
  try { s = await ensureSession((req.params as any).id) } catch (e: any) { return reply.code(404).send({ error: e.message }) }
  try {
    canvas.activateCanvas(s.id, String((req.params as any).canvasId))
    syncCanvasEntry(s)
    const payload = canvasTreePayload(s)
    broadcastCanvases(s, payload)
    return payload
  } catch (e: any) { return reply.code(400).send({ error: e.message }) }
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
  // 会话树画布列表：open 帧带上，客户端据此渲染多画布页签
  const tree = canvas.listTree(s.id)
  write(`data: ${JSON.stringify({ topic: 'open', sessionId: s.id, busy: s.busy, status: s.status, mode: s.mode, canvasId: s.canvasId, canvases: tree, waiting: waitingRows(s) })}\n\n`)

  // 晚连/断线重连：补发当前进行中回合的帧（EventSource 会自动带 Last-Event-ID）
  const headerSince = (req.headers['last-event-id'] as string | undefined) ?? (req.query as any)?.since
  const since = Number(headerSince)
  for (const frame of s.sse.replay(Number.isFinite(since) ? since : -1)) write(frame)

  // 画布快照随流下发（dsh 会话投影的 snapshot 语义）：连上即拿到当前文档，无需再额外 GET
  const sendCanvas = (topic: string, data: Record<string, any>) => {
    write(`id: ${s.sse.nextId()}\ndata: ${JSON.stringify({ topic, ...data })}\n\n`)
  }
  // 树里每块有模型的画布各下发一次快照（主会话与子代理的独立画布都能直接看到）
  for (const entry of tree) {
    if (!entry.hasModel) continue
    // 多画布时不能走 canvas.model(sessionId)——它解析的是会话的活跃画布
    const bbmodel = canvas.modelOf(entry.canvasId)
    if (!bbmodel) continue
    const doc = canvas.readCanvas(entry.canvasId)
    sendCanvas('model_update', {
      sessionId: entry.canvasId,
      originId: entry.ownerSessionId,
      bbmodel,
      elements: doc?.elements?.length ?? 0,
      textures: doc?.textures?.length ?? 0,
      view: doc?.view ?? '3d',
      animations: (doc?.animations ?? []).map((a: any) => ({ name: a.name, length: a.length, loop: a.loop })),
    })
  }

  const unsub = s.sse.subscribe(write)
  // 画布订阅：会话树里任意画布的改动都推给这条连接（子代理的独立画布实时可见）
  let treeIds = new Set(tree.map(c => c.canvasId))
  const unsubCanvas = canvas.onChange(change => {
    if (!treeIds.has(change.canvasId)) {
      // 新画布（刚创建）还没进缓存：重算一次树再判断
      treeIds = new Set(canvas.listTree(s.id).map(c => c.canvasId))
      if (!treeIds.has(change.canvasId)) return
    }
    if (change.kind === 'view') {
      sendCanvas('view_update', { sessionId: change.canvasId, view: change.view, originId: change.originId })
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
    text?: string; modelId?: string; mode?: 'build' | 'refine'; attachments?: any[]; profile?: string; reasoningEffort?: string
  }
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0
  if (!body.text?.trim() && !hasAttachments) return reply.code(400).send({ error: 'text 不能为空' })
  const textInput = body.text?.trim() ? body.text : '（请看附图）'
  // 代理角色：未知 id 直接回落当前角色（不 400——老客户端不会带这个字段）
  const wantedProfile = typeof body.profile === 'string' && profileRegistry.has(body.profile) ? body.profile : undefined
  if (wantedProfile && wantedProfile !== s.profile) {
    s.profile = wantedProfile
    persistMeta(s)
  }
  // 新的用户请求：自动续跑计数重新开始（上一请求的续跑额度不延续）
  s.autoContinues = 0
  // 思考强度：只接受短英文档位；空串表示回到模型默认
  if (typeof body.reasoningEffort === 'string') {
    const effort = body.reasoningEffort.trim().toLowerCase()
    s.coop.reasoningEffort = /^[a-z]{3,12}$/.test(effort) ? effort : undefined
  }

  // 图片准入（dsh PromptContentPart → AdmittedPromptContentPart）：
  // 客户端发来的是 data URL，这里换成内容寻址引用；日志与事件里不再出现 base64。
  let admitted: any[] | undefined
  if (body.attachments?.length) {
    if (body.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return reply.code(400).send({ error: `一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件` })
    }
    try {
      admitted = body.attachments.map(part => attachments.admit(part))
    } catch (e: any) {
      return reply.code(400).send({ error: `附件不可用：${e.message}` })
    }
  }

  // 异步启动：事件全部走 GET /api/sessions/:id/stream（子代理也是这样后台跑）
  void runSessionTurn(s, {
    text: textInput,
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
  // 用户主动停止时丢弃待执行的移交，避免停止后又被自动拉起一轮 mcmod
  s.pendingHandoff = undefined
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
    const frame = statsFrame(s)
    const stats = frame.stats
    const figures = { contextTokens: frame.contextTokens, modelWindow: frame.modelWindow, contextBreakdown: frame.contextBreakdown }
    // 编队：同一会话树（按 parentId）下的子代理累计输出（面板「主 / 子代理」那一行）
    // 走磁盘列表而不是内存 sessions：重启后子代理的执行态已丢失，但它们的 token 账还在日志里
    const rows = sessionStore.list()
    const parentById = new Map(rows.map(r => [r.id, r.parentId]))
    let subagentTokens = 0
    let subagentCount = 0
    for (const row of rows) {
      if (row.mode !== 'subagent' || !row.parentId) continue
      if (!inSessionTree(row.id, s.id, parentById)) continue
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
  const profile = live?.profile ?? meta.profile
  return {
    cwd: live?.cwd ?? meta.cwd ?? DEFAULT_CWD,
    // 素材可能来自子代理（modeling）或已关闭功能的角色（mc 关闭后的 mcmod）：
    // 未注册的角色不能继承，否则新开的编辑会话会拿到一个不存在的角色（运行时只会静默回落）。
    profile: profile && profileRegistry.has(profile) ? profile : undefined,
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

/** Jar 扫描根：当前会话 cwd + 默认 MC 工作区 */
function jarScanRoots(sessionId?: string): string[] {
  const roots: string[] = []
  const sid = String(sessionId ?? '').trim()
  if (sid && sessionStore.exists(sid)) {
    const cwd = sessionStore.readMeta(sid).cwd
    if (cwd) roots.push(cwd)
  }
  if (!roots.some(r => resolve(r).toLowerCase() === resolve(DEFAULT_CWD).toLowerCase())) roots.push(DEFAULT_CWD)
  return roots
}

// Jar 构建列表：素材库已归档 jar + 工程 build/libs 自动扫描
app.get('/api/library/jars', async (req) => {
  const sessionId = String((req.query as any)?.sessionId ?? '').trim()
  const archived: any[] = []
  for (const a of library.list()) {
    if (a.kind !== 'jar') continue
    const jars = a.files.filter(f => f.kind === 'jar')
    if (!jars.length && a.jar) {
      archived.push({
        source: 'library', assetId: a.id, fileId: a.jar.fileId, name: a.jar.name,
        size: a.jar.size, updatedAt: a.updatedAt, project: a.name,
      })
      continue
    }
    for (const f of jars) {
      archived.push({
        source: 'library', assetId: a.id, fileId: f.id, name: f.name,
        size: f.size, updatedAt: a.updatedAt, project: a.name,
      })
    }
  }
  const seen = new Set<string>()
  const builds: any[] = []
  for (const root of jarScanRoots(sessionId)) {
    for (const j of findAllJars(root)) {
      const key = resolve(j.path).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const archivedSame = archived.some(a => a.name === j.name && a.size === j.size)
      // 已归档的同名同大小构建不再重复列出，避免用户同时勾选两份
      if (archivedSame) continue
      builds.push({
        source: 'build', path: j.path, name: j.name, size: j.size,
        mtime: j.mtime, project: j.project, archived: false,
      })
    }
  }
  return { jars: [...archived, ...builds.slice(0, 100)] }
})

// 把工程构建 jar 归档到素材库
app.post('/api/library/jars/archive', async (req, reply) => {
  const body = (req.body ?? {}) as { path?: string; sessionId?: string }
  const sessionId = String(body.sessionId ?? '').trim() || undefined
  const abs = resolve(String(body.path ?? '').trim())
  if (!abs.toLowerCase().endsWith('.jar')) return reply.code(400).send({ error: '只支持 .jar' })
  if (!abs.toLowerCase().includes(`${sep}build${sep}libs${sep}`)) {
    return reply.code(400).send({ error: '只能归档工程 build/libs 下的 jar' })
  }
  const roots = jarScanRoots(sessionId)
  if (!roots.some(r => abs.toLowerCase().startsWith(resolve(r).toLowerCase() + sep))) {
    return reply.code(400).send({ error: 'jar 不在当前工作区/工程目录内' })
  }
  try {
    const st = statSync(abs)
    if (!st.isFile()) throw new Error('不是普通文件')
    const asset = library.createJar({
      name: abs.split(/[\\/]/).pop() ?? 'mod.jar',
      data: readFileSync(abs),
      sessionId,
      sourcePath: abs,
      provider: 'build',
    })
    return { asset }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

/** 把 UI 传来的 jar 选择解析成真实字节；library 走素材库，build 走工程 build/libs */
function prepareTestJars(body: any): TestClientJar[] {
  const rows = Array.isArray(body?.jars) ? body.jars : []
  if (!rows.length) throw new Error('至少选择一个 jar')
  if (rows.length > 20) throw new Error('一次最多选择 20 个 jar')
  const sessionId = String(body?.sessionId ?? '').trim()
  const roots = jarScanRoots(sessionId)
  const out: TestClientJar[] = []
  let total = 0
  for (const row of rows) {
    const source = String(row?.source ?? '')
    if (source === 'library') {
      const assetId = String(row?.assetId ?? '')
      const fileId = String(row?.fileId ?? '')
      const found = fileId
        ? library.readFile(assetId, fileId)
        : (() => {
            const asset = library.get(assetId)
            const id = asset?.jar?.fileId
            return id ? library.readFile(assetId, id) : undefined
          })()
      if (!found) throw new Error(`素材 jar 不存在：${assetId}`)
      if (found.file.kind !== 'jar') throw new Error(`不是 jar：${found.file.name}`)
      total += found.data.length
      out.push({ name: found.file.name, data: found.data, source: 'library' })
      continue
    }
    if (source === 'build') {
      const abs = resolve(String(row?.path ?? ''))
      const lower = abs.toLowerCase()
      if (!lower.endsWith('.jar')) throw new Error('只支持 .jar')
      if (!lower.includes(`${sep}build${sep}libs${sep}`)) throw new Error('只能启动工程 build/libs 下的 jar')
      if (!roots.some(r => lower.startsWith(resolve(r).toLowerCase() + sep))) {
        throw new Error('jar 不在当前工作区/工程目录内')
      }
      const st = statSync(abs)
      if (!st.isFile()) throw new Error('不是普通文件')
      total += st.size
      out.push({ name: basename(abs), data: readFileSync(abs), source: 'build' })
      continue
    }
    throw new Error('未知的 jar 来源')
  }
  if (total > 256 * 1024 * 1024) throw new Error('选中的 jar 总大小超过 256MB')
  return out
}

// 构建日志：mc_gradle build 的完整 stdout+stderr 落盘在 data/build-logs
app.get('/api/build-logs', async (req) => ({
  logs: listBuildLogs(Number((req.query as any)?.limit ?? 30)),
}))

app.get('/api/build-logs/:id', async (req, reply) => {
  const log = readBuildLog(String((req.params as any)?.id ?? ''))
  if (!log) return reply.code(404).send({ error: '构建日志不存在' })
  return log
})

// 统一测试启动器：状态 / 启动 / 停止
app.get('/api/mc/test', async (req) => getTestClientStatus(Number((req.query as any)?.tail ?? 120)))

app.post('/api/mc/test/run', async (req, reply) => {
  try {
    if (testClientBusy()) return reply.code(409).send({ error: '测试客户端正在安装或启动，请稍候' })
    const jars = prepareTestJars(req.body)
    const prefs = settingsStore.getPrefs()
    void startTestClient(jars, {
      testClientDir: prefs.testClientDir,
      testClientMode: prefs.testClientMode,
      testMdkDir: prefs.testMdkDir,
    })
      .catch(() => { /* 失败由状态接口的 phase=error/logTail 反馈 */ })
    return { ok: true }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

app.post('/api/mc/test/stop', async () => ({ ok: true, stopped: stopTestClient() }))

// 上传一个文件（原始字节体）：首个文件建资产，多选/拖拽的其余文件走 /:id/files 追加
app.post('/api/library/upload', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
  const q = (req.query ?? {}) as { name?: string; title?: string; sessionId?: string }
  const fileName = String(q.name ?? '').trim()
  if (!fileName) return reply.code(400).send({ error: '缺少文件名（?name=）' })
  const data = req.body
  if (!Buffer.isBuffer(data) || data.length === 0) return reply.code(400).send({ error: '请求体为空（请传文件字节）' })
  try {
    const asset = library.create({
      name: String(q.title ?? '').trim(),
      fileName,
      data,
      sessionId: String(q.sessionId ?? '').trim() || undefined,
      provider: 'upload',
    })
    return { asset: library.get(asset.id) ?? asset }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 给已有资产追加文件（同一请求一个文件）
app.post('/api/library/:id/files', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
  const id = String((req.params as any).id)
  const q = (req.query ?? {}) as { name?: string }
  const fileName = String(q.name ?? '').trim()
  if (!fileName) return reply.code(400).send({ error: '缺少文件名（?name=）' })
  const data = req.body
  if (!Buffer.isBuffer(data) || data.length === 0) return reply.code(400).send({ error: '请求体为空（请传文件字节）' })
  try {
    const asset = library.addFile(id, { fileName, data })
    return { asset }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 从会话工作目录导入（填相对 cwd 的路径；服务端校验 realpath 不越界）
app.post('/api/library/import', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; paths?: string[]; name?: string }
  const sessionId = String(body.sessionId ?? '').trim()
  if (!sessionId) return reply.code(400).send({ error: 'sessionId 不能为空' })
  // 会话不存在时不能回落到应用根目录导入（否则「工作目录导入」会悄悄变成「仓库根导入」）
  if (!sessionStore.exists(sessionId)) return reply.code(400).send({ error: '会话不存在' })
  const cwd = sessionStore.readMeta(sessionId).cwd ?? DEFAULT_CWD
  try {
    const result = library.importFiles({
      root: cwd,
      paths: Array.isArray(body.paths) ? body.paths.map(String) : [],
      name: String(body.name ?? '').trim() || undefined,
      sessionId,
    })
    return result
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 资产内文件：图片与文本可内联预览，jar/压缩包/HTML 一律下载
app.get('/api/library/:id/files/:fileId', async (req, reply) => {
  const { id, fileId } = req.params as { id: string; fileId: string }
  const found = library.readFile(id, fileId)
  if (!found) return reply.code(404).send({ error: '文件不存在' })
  const { file, data } = found
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  const disposition = `${(req.query as any)?.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`
  reply.header('content-disposition', disposition)
  reply.header('cache-control', 'private, max-age=3600')
  if (file.kind === 'image') return reply.header('content-type', file.mime).send(data)
  if (file.kind === 'text' && !(req.query as any)?.download) {
    const ext = file.name.split('.').pop()?.toLowerCase()
    // HTML/SVG 能执行脚本：只允许下载，不做内联
    if (ext !== 'html' && ext !== 'svg') {
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .send(data.subarray(0, 512 * 1024))
    }
  }
  return reply.header('content-type', 'application/octet-stream').send(data)
})

app.post('/api/library/capture', async (req, reply) => {
  const body = (req.body ?? {}) as { sessionId?: string; name?: string }
  const sessionId = String(body.sessionId ?? '').trim()
  if (!sessionId) return reply.code(400).send({ error: 'sessionId 不能为空' })
  try {
    const s = await ensureSession(sessionId)
    const doc = canvas.read(sessionId)
    const result = library.capture({
      sessionId,
      canvasId: s.canvasId ?? canvas.idOf(sessionId),
      name: String(body.name ?? ''),
      doc,
      // 素材归档时顺带收当前会话工作区里的最新构建产物（build/libs/*.jar）
      cwd: s.cwd,
    })
    return result
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 素材模型：编译成 Blockbench 可加载的 bbmodel（画布「新标签打开」用，不覆盖会话画布）
app.get('/api/library/:id/model', async (req, reply) => {
  const id = String((req.params as any).id)
  if (!library.get(id)) return reply.code(404).send({ error: '素材不存在' })
  const doc = library.readDoc(id)
  if (!doc) return reply.code(404).send({ error: '素材快照已损坏' })
  try {
    return compileBb(doc as any)
  } catch (e: any) {
    return reply.code(400).send({ error: `素材编译失败：${e.message}` })
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

// 下载归档的构建产物（没有 jar 的素材 404；文件名沿用构建产物名）
app.get('/api/library/:id/jar', async (req, reply) => {
  const id = String((req.params as any).id)
  const asset = library.get(id)
  const buf = library.readJar(id)
  if (!asset?.jar || !buf) return reply.code(404).send({ error: '该素材没有归档 jar' })
  const name = asset.jar.name || `${asset.name || id}.jar`
  // Content-Disposition 的 ASCII 回退 + RFC 5987 的 UTF-8 文件名（中文名不丢）
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  return reply
    .header('content-type', 'application/java-archive')
    .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
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
// 自动入库防抖（非编辑会话的画布：按 canvasId upsert auto 素材，保证模型永不丢）
const autoLibTimers = new Map<string, ReturnType<typeof setTimeout>>()
canvas.onChange(change => {
  if (change.kind !== 'model') return
  const libId = libraryOfSession(change.originId)
  if (libId) {
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
      const doc = canvas.readCanvas(change.canvasId)
      if (!doc) return
      const meta = library.updateDoc(libId, doc)
      if (!meta) console.warn(`[library] 素材 ${libId} 已不存在，跳过回写`)
    }, 700))
    return
  }
  // 自动入库：普通会话的画布模型只要非空就 upsert 进素材库（编辑会话走上面的回写，不重复入）
  // 素材库功能关闭时不入库：否则会持续产生用户在界面上看不到、也无法删除的资产。
  if (bootFeatures.library === false) return
  if ((change.elements ?? 0) <= 0) return
  const prevAuto = autoLibTimers.get(change.canvasId)
  if (prevAuto) clearTimeout(prevAuto)
  autoLibTimers.set(change.canvasId, setTimeout(() => {
    autoLibTimers.delete(change.canvasId)
    const doc = canvas.readCanvas(change.canvasId)
    if (!doc) return
    try {
      const meta = library.upsertByCanvas({ canvasId: change.canvasId, sessionId: change.originId, doc })
      if (meta) console.log(`[library] 自动入库「${meta.name}」（${meta.elementCount} 元素，v${meta.version}）`)
    } catch (e: any) {
      console.warn('[library] 自动入库失败:', e?.message ?? e)
    }
  }, 900))
})

// 输入框附件上传：原始字节体（不走 base64/JSON），返回可直接放进 chat.attachments 的引用 part。
// 图片按魔数识别后仍走视觉链路；其他文件保存为文件引用，聊天日志里只留引用。
app.post('/api/attachments', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
  const q = (req.query ?? {}) as { name?: string; mediaType?: string }
  const data = req.body
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return reply.code(400).send({ error: '请求体为空（请传文件字节）' })
  }
  try {
    return { part: attachments.admitBytes(data, { name: q.name, mediaType: q.mediaType }) }
  } catch (e: any) {
    return reply.code(400).send({ error: e.message })
  }
})

// 附件字节出口（右侧「图片」标签、历史回看、灯箱、文件下载都用它）
// 内容寻址 → 永久缓存；id 形如 sha256:<digest>（与日志里的引用一致）
app.get('/api/attachments/:id', async (req, reply) => {
  const id = String((req.params as any).id)
  const found = attachments.read(id)
  if (!found) return reply.code(404).send({ error: '附件不存在或已被删除' })
  if (String((req.query as any)?.download ?? '') === '1') {
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.name ?? id)}`)
  }
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
  // 启动即清「只建没聊」的历史空会话（内存热缓存为空 = 一定没有活跃会话，删了绝对安全）
  pruneEmptySessions()
  console.log(`[openmods] server ready → http://127.0.0.1:${PORT}`)
  console.log(`[openmods] 插件: ${loadedPlugins.map(p => p.name).join(', ') || '无'}`)
  console.log(`[openmods] 技能: ${skillProviders.flatMap(p => p.list().map(s => s.name)).join(', ') || '无'}`)
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
