import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SseFrame } from './api.js'
import type {
  AgentProfileDto, AnimationMetaDto, CanvasPageDto, CanvasRefDto, CanvasState, ContextBreakdownDto, FeaturesDto, McProjectUiDto, ModelInfoDto, PendingInteractionDto, PrefsDto, SessionInfoDto,
  SessionSummaryDto, StatsDto, SubagentNoticeDto, SubagentWaitDto, TerminalDto, TodoItemDto, TurnEntry, WakeEntry,
  McTestStatusDto,
} from './types.js'
import { EMPTY_CONTEXT_STATS } from './types.js'
import { LeftSidebar } from './components/LeftSidebar.js'
import { LibraryDrawer } from './components/LibraryDrawer.js'
import { LogDrawer } from './components/LogDrawer.js'
import { AboutDialog } from './components/AboutDialog.js'
import { MainPanel } from './components/MainPanel.js'
import { DOCK_TABS, RightDock, useDockDrag, type DockTabId } from './components/RightDock.js'
import { SettingsWindow } from './components/SettingsWindow.js'
import { EnvSetupDialog } from './components/EnvSetupDialog.js'
import { AskDialog, type InteractionReplyBody } from './components/AskDialog.js'
import { McIcon } from './components/McIcon.js'
import { playLevelUpSound, playToastSound, setUiSoundEnabled } from './ui-sound.js'


const MODELING_SUGGESTIONS = [
  '做一对层叠羽毛的白色翅膀，带自然扇动的动画',
  '一只方块风格的小狼伙伴，灰白色毛发，带走路动画',
  '一把冰晶法杖，银色握柄，顶部悬浮着蓝色水晶',
  '一个可以拿在手里的像素风宝箱钥匙',
]

function emptyCanvas(): CanvasState {
  return { hasModel: false, modelName: '', elements: 0, textures: 0, view: '3d', animations: [] }
}

/** bbmodel 的 animations → 动画条数据（会话画布与素材标签共用） */
function toAnims(model: any): AnimationMetaDto[] {
  return (model?.animations ?? []).map((a: any) => ({
    name: String(a.name ?? '').split('.').pop() ?? '',
    length: a.length ?? 1,
    loop: a.loop ?? 'loop',
  }))
}

/** bbmodel → 画布状态（非活跃画布的缓存与直连接口共用） */
function modelToCanvasState(model: any): CanvasState {
  return {
    hasModel: (model?.elements?.length ?? 0) > 0,
    modelName: model?.name ?? '',
    elements: model?.elements?.length ?? 0,
    textures: model?.textures?.length ?? 0,
    view: model?.view ?? '3d',
    animations: toAnims(model),
  }
}

/** 结算消息的 source → 通知行（dsh `form:'notice'`：不展开成用户气泡） */
function settledToNotices(source: any): SubagentNoticeDto[] {
  const rows = Array.isArray(source?.settled) ? source.settled : []
  const reasons = ['completed', 'aborted', 'error'] as const
  return rows.map((r: any) => ({
    childId: r.childId,
    name: r.name,
    description: r.description,
    status: r.status ?? 'done',
    stopReason: reasons.includes(r.stopReason) ? r.stopReason : undefined,
    summary: r.summary ?? '',
    kind: 'subagent-settled' as const,
    form: 'notice' as const,
  }))
}

/** 附件 part → 可渲染的图片（新格式是引用走 /api/attachments，旧格式直接是 data URL） */
function toImages(parts: any[] | undefined): { id: string; name?: string; src: string }[] {
  if (!parts?.length) return []
  const out: { id: string; name?: string; src: string }[] = []
  parts.forEach((p: any, i: number) => {
    if (p?.type === 'image' && p?.attachment?.attachmentId) {
      out.push({
        id: p.attachment.attachmentId,
        ...(p.attachment.name ? { name: p.attachment.name } : {}),
        src: `/api/attachments/${encodeURIComponent(p.attachment.attachmentId)}`,
      })
    } else if (p?.type === 'image_url' && p?.image_url?.url) {
      // 迁移前的会话：日志里存的是 data URL
      out.push({ id: `legacy-${i}-${String(p.image_url.url).length}`, src: p.image_url.url })
    }
  })
  return out
}

/** 日志回放：用户/助手/工具 + 子代理完成通知（通知是紧凑系统行，不是聊天轮次） */
function replayEvents(events: any[]): TurnEntry[] {
  const out: TurnEntry[] = []
  for (const ev of events) {
    if (ev.t === 'user/message') {
      out.push({
        // 优先用日志里的 turnId（= turn/start 的 t<seq>）：SSE 回放的 turn/start 也带同一个 id，
        // 两边一致才能按 turnId 去重；老日志没有 turnId 才退回自己的 seq。
        turnId: ev.turnId ?? `t${ev.seq}`, userText: ev.source ? '' : (ev.text ?? ''), attachments: ev.attachments?.length ?? 0,
        // 图片始终显示（即使是纯文本模型没发出去的那几张，用户自己也该看到）
        ...(toImages(ev.attachments).length ? { images: toImages(ev.attachments) } : {}),
        ...(ev.imagesOmitted ? { imagesOmitted: true } : {}),
        steps: [], assistantText: '', streaming: false,
        // runtime 投递的结算消息（source: subagent-settled）渲染成通知行，不是用户气泡
        ...(ev.source?.kind === 'subagent-settled' ? { notices: settledToNotices(ev.source) } : {}),
      })
    } else if (ev.t === 'assistant/message' && out.length && !out[out.length - 1].notice) {
      const cur = out[out.length - 1]
      // 多步回合：每步的正文/思考按顺序拼起来（以前正文是覆盖，只有最后一步留着）
      if (ev.text) cur.assistantText = cur.assistantText ? `${cur.assistantText}\n\n${ev.text}` : ev.text
      if (ev.reasoning) cur.reasoning = cur.reasoning ? `${cur.reasoning}\n\n${ev.reasoning}` : ev.reasoning
    } else if (ev.t === 'tool/call' && out.length && !out[out.length - 1].notice) {
      out[out.length - 1].steps.push({ callId: ev.callId, name: ev.name, done: true })
    } else if (ev.t === 'turn/end' && out.length && !out[out.length - 1].notice) {
      // 重开会话也要能看到系统收尾（如「已达单轮步数上限」）：只在模型没有正文时补
      const cur = out[out.length - 1]
      if (ev.text && !cur.assistantText) cur.assistantText = ev.text
    } else if (ev.t === 'subagent/notice') {
      out.push({
        turnId: `notice-${ev.seq}`, userText: '', attachments: 0, steps: [], assistantText: '', streaming: false,
        notice: {
          childId: ev.childId, name: ev.name, description: ev.description,
          status: ev.status ?? 'done', summary: ev.summary ?? '',
        },
      })
    }
  }
  return out
}

export default function App() {
  // 布局
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 首次运行环境向导（environment.setupDone 为 false 时自动弹出） */
  const [envOpen, setEnvOpen] = useState(false)
  /** 文档素材库抽屉 */
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [dockCollapsed, setDockCollapsed] = useState(false)
  // 右侧拓展的标签页（可多开、可切换、可关闭）；顺序即标签顺序
  const [dockTabs, setDockTabs] = useState<DockTabId[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('openmods.dockTabs') || 'null')
      if (Array.isArray(raw)) {
        const valid = raw.filter((t: any): t is DockTabId => DOCK_TABS.includes(t))
        if (valid.length) return valid
      }
    } catch { /* 忽略损坏的本地值 */ }
    return ['canvas']
  })
  const [dockTab, setDockTab] = useState<DockTabId | null>(() => {
    const stored = localStorage.getItem('openmods.dockTab')
    return DOCK_TABS.includes(stored as DockTabId) ? (stored as DockTabId) : 'canvas'
  })
  const [dockWidth, setDockWidth] = useState(() => {
    const w = Number(localStorage.getItem('openmods.dockw'))
    return Number.isFinite(w) && w >= 280 && w <= 760 ? w : 420
  })
  const [refineMode, setRefineMode] = useState(false)
  // 画布多开（多画布页签）：画布页 key=canvasId，素材页 key=asset:<assetId>，空白页 key=blank:<n>
  // 启动时先拿本地会话 id 占位一页（openSession 拿到真实活跃画布后会重置）
  const bootSid = localStorage.getItem('openmods.sid') ?? ''
  const [canvasPages, setCanvasPages] = useState<CanvasPageDto[]>(
    () => (bootSid ? [{ key: bootSid, kind: 'canvas' }] : []),
  )
  const [activeCanvasPage, setActiveCanvasPage] = useState(bootSid)
  const activeCanvasPageRef = useRef('')
  const canvasPagesRef = useRef<CanvasPageDto[]>([])
  /** 画布页 key → 未查看的改动（●）；素材页签是只读预览，不参与 */
  const [canvasDirty, setCanvasDirty] = useState<Record<string, boolean>>({})
  /** 会话树里的全部画布（页签名称/来源/活跃徽标 + 空白页选择列表） */
  const [canvases, setCanvases] = useState<CanvasRefDto[]>([])
  /** canvasId → ownerSessionId：SSE 画布事件带 originId，切页时不必等列表刷新就能确定统计口径 */
  const canvasOwnerRef = useRef<Map<string, string>>(new Map())
  const canvasesRef = useRef<CanvasRefDto[]>([])
  /** 当前会话的活跃画布：下载与「重新加载」只对它走直连接口 */
  const [activeSessionCanvasId, setActiveSessionCanvasId] = useState('')
  /** canvasId → 最近一次 model_update 的状态与 bbmodel（切页签时直接用缓存，不等网络） */
  const canvasStatesRef = useRef<Map<string, CanvasState>>(new Map())
  const canvasModelsRef = useRef<Map<string, any>>(new Map())
  /** 素材标签的动画列表（assetId → animations）：打开/切换时从 bbmodel 记下，关闭时清理 */
  const [assetAnims, setAssetAnims] = useState<Record<string, AnimationMetaDto[]>>({})
  /** 当前画布是否正在加载（动画条据此禁用播放按钮，而不是因为会话 busy） */
  const [canvasLoading, setCanvasLoading] = useState(false)
  activeCanvasPageRef.current = activeCanvasPage
  canvasPagesRef.current = canvasPages
  canvasesRef.current = canvases
  /** 动画播放失败自动重载后要重试的动画名（bb_loaded 后消费） */
  const pendingAnimRef = useRef<string | null>(null)
  /** 发起播放时所在的画布页 key：重载完成后只在同一页上重试 */
  const pendingAnimTabRef = useRef<string>('')
  /** 最近一次请求播放的动画名：自动重载重试仍失败时用它识别二次失败 */
  const animNameRef = useRef<string | null>(null)
  /** 自动重载重试次数：第二次仍失败就 toast 提示，不再循环 */
  const animRetryRef = useRef(0)
  // 会话：sessionId=当前打开的（可能是子代理），rootSessionId=所属主会话
  const [sessionId, setSessionId] = useState<string>(() => localStorage.getItem('openmods.sid') ?? '')
  const [rootSessionId, setRootSessionId] = useState('')
  const [sessionInfo, setSessionInfo] = useState<SessionInfoDto | null>(null)
  const [subagents, setSubagents] = useState<SessionSummaryDto[]>([])
  const [streamSince, setStreamSince] = useState(-1)
  const [sessionsVersion, setSessionsVersion] = useState(0)
  const [turns, setTurns] = useState<TurnEntry[]>([])
  const [busy, setBusy] = useState(false)
  /** 等待中的子代理：非空 = 等待态（会话没结束，但用户不能插话） */
  const [waiting, setWaiting] = useState<SubagentWaitDto[]>([])
  const [streamChars, setStreamChars] = useState(0)
  const [elapsedSec, setElapsedSec] = useState(0)
  /** 思考流末尾片段：运行横幅里滚动显示，让"正在想"真的有内容可看 */
  const [thinkTail, setThinkTail] = useState('')
  // 偏好（设置 → 通用/子代理/自动化）
  const [prefs, setPrefs] = useState<PrefsDto | null>(null)
  /** AI 自己唤醒右侧拓展的记录（设置 → 自动化） */
  const [wakeLog, setWakeLog] = useState<WakeEntry[]>([])
  // 模型
  const [models, setModels] = useState<ModelInfoDto[]>([])
  const [currentModelId, setCurrentModelId] = useState<string | null>(null)
  /** 思考强度：空 = 模型默认；仅当前模型声明了档位时由输入框展示 */
  const [reasoningEffort, setReasoningEffort] = useState<string>(() => localStorage.getItem('openmods.reasoningEffort') ?? '')
  // 画布
  const [canvas, setCanvas] = useState<CanvasState>(emptyCanvas)
  const [playingAnim, setPlayingAnim] = useState<string | null>(null)
  const [pendingAtts, setPendingAtts] = useState<{ name: string; dataUrl: string }[]>([])
  // 看板
  const [stats, setStats] = useState<StatsDto | null>(null)
  // 「图片」标签的数据源：本会话所有回合的参考图（按 id 去重，保留出现顺序）
  const sessionImages = useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name?: string; src: string }[] = []
    for (const t of turns) {
      for (const img of t.images ?? []) {
        if (seen.has(img.id)) continue
        seen.add(img.id)
        out.push(img)
      }
    }
    return out
  }, [turns])
  const [ctxTokens, setCtxTokens] = useState<number | null>(null)
  const [modelWindow, setModelWindow] = useState<number | null>(null)
  /** 上下文构成（点击上下文环展开的图）：需要服务端按当前 surface 现算 */
  const [ctxBreakdown, setCtxBreakdown] = useState<ContextBreakdownDto | null>(null)
  /**
   * 当前画布页 owner 会话的统计快照：底部状态条与「上下文」面板按页取数。
   * 页 owner 就是当前会话时直接用 stats/ctx*（SSE 实时更新）；只有切到别的会话的画布才走这份快照。
   */
  const [pageStats, setPageStats] = useState<{
    sessionId: string
    stats: StatsDto
    ctxTokens: number | null
    modelWindow: number | null
    contextBreakdown: ContextBreakdownDto | null
  } | null>(null)
  /** MC 工程（mcdev）状态：dock 顶部的「测试 Mod」/ jar 下载按钮数据源 */
  const [mcProjects, setMcProjects] = useState<McProjectUiDto[]>([])
  /** 代理角色（dsh agentPreset）：lead=主代理、mcmod=1.20.1 Forge 模组开发 */
  const [agentProfile, setAgentProfile] = useState<string>(() => localStorage.getItem('openmods.profile') ?? 'lead')
  const [profiles, setProfiles] = useState<AgentProfileDto[]>([])
  /** 功能开关（/api/features）：画布 / MC / 素材库入口按它隐藏；未加载时默认全开 */
  const [features, setFeatures] = useState<FeaturesDto | null>(null)
  const featuresRef = useRef<Record<string, boolean>>({})
  const [iframeReady, setIframeReady] = useState(false)
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null)
  /** MC 构建/启动的进度提示（1.75s 进度条，走完弹升级成就） */
  const [mcBoot, setMcBoot] = useState<{ label: string } | null>(null)
  /** 统一测试启动器状态：底部悬浮实时进度条 / 失败直报 */
  const [mcTestStatus, setMcTestStatus] = useState<McTestStatusDto | null>(null)
  /** MC 升级成就弹窗（右上角，levelup 音效） */
  const [achievement, setAchievement] = useState<{ title: string; sub: string } | null>(null)
  const [health, setHealth] = useState<{ mock: boolean } | null>(null)
  // 计划模式 / 待办 / 授权（会话级，服务端 durable）
  /** 计划模式默认开启：新会话先出方案，批准后再动手 */
  const [planMode, setPlanMode] = useState(true)
  const [todos, setTodos] = useState<TodoItemDto[] | null>(null)
  const [permission, setPermission] = useState<'ask' | 'auto'>('ask')
  const [allowedTools, setAllowedTools] = useState<string[]>([])
  /** 待处理的提问/授权（弹窗队列；同一时刻只显示第一个） */
  const [interactions, setInteractions] = useState<PendingInteractionDto[]>([])
  // 终端（模型 bash/terminal_open 拉起的与用户手动开的都在这里）
  const [terminals, setTerminals] = useState<TerminalDto[]>([])
  const [terminalOutput, setTerminalOutput] = useState<Record<string, string>>({})
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [terminalShell, setTerminalShell] = useState<string | undefined>(undefined)

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastModelRef = useRef<any>(null)
  const openSeqRef = useRef(0)
  /** 空白页序号（＋ 新建空白页用的本地 key，不建后端画布） */
  const blankSeqRef = useRef(0)
  /** 草稿会话：点「新对话」不立即建（服务端不落盘），发首条消息时才真正创建；记着在哪个分组下建的 */
  const draftProjectRef = useRef<string | undefined>(undefined)
  /** 草稿会话里先选好的工作目录（首条消息创建会话时带过去） */
  const draftCwdRef = useRef('')
  const [draftCwd, setDraftCwd] = useState('')
  /** handleEvent 里要读最新的偏好，但不希望它进依赖（否则每次改设置都重连 SSE） */
  const prefsRef = useRef<PrefsDto | null>(null)
  prefsRef.current = prefs
  const wakeRef = useRef<(reason: string) => void>(() => {})

  /** 提示条：可带一个操作按钮（dsh 的「会话已归档，可 撤销」同款） */
  const showToast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    playToastSound()
    setToast({ text: msg, action })
    setTimeout(() => setToast(null), action ? 8000 : 5000)
  }, [])

  // ---- MC 构建/启动的升级动画：进度条 1.75s → 成就弹窗 + levelup 音效 ----
  const celebrateTimers = useRef<{ progress?: number; achievement?: number }>({})
  const cancelCelebrate = useCallback(() => {
    window.clearTimeout(celebrateTimers.current.progress)
    window.clearTimeout(celebrateTimers.current.achievement)
    celebrateTimers.current = {}
    setMcBoot(null)
    setAchievement(null)
  }, [])
  const celebrate = useCallback((label: string, sub: string) => {
    cancelCelebrate()
    setMcBoot({ label })
    celebrateTimers.current.progress = window.setTimeout(() => {
      setMcBoot(null)
      setAchievement({ title: '升级！', sub })
      playLevelUpSound()
      celebrateTimers.current.achievement = window.setTimeout(() => setAchievement(null), 4000)
    }, 1750)
  }, [cancelCelebrate])
  useEffect(() => () => {
    window.clearTimeout(celebrateTimers.current.progress)
    window.clearTimeout(celebrateTimers.current.achievement)
  }, [])

  // ---- 统一测试启动器：底部悬浮实时进度条（安装/启动/运行/失败） ----
  /** 本页是否真的启动过测试：用来区分「本次失败」和上次进程留在 state.json 里的旧错误 */
  const mcTestRunSeen = useRef(false)
  const applyMcTestStatus = useCallback((s: McTestStatusDto) => {
    if (['installing', 'starting', 'running'].includes(s.phase)) mcTestRunSeen.current = true
    // 刷新/重开页面时恢复状态：本页还没启动过测试，上次残留的失败不弹窗（环境可能已经修好）
    if (s.phase === 'error' && !mcTestRunSeen.current) return
    setMcTestStatus(s)
  }, [])
  const refreshMcTestStatus = useCallback(() => {
    api.mcTestStatus(120).then(applyMcTestStatus).catch(() => { /* 服务未起 */ })
  }, [applyMcTestStatus])
  useEffect(() => { refreshMcTestStatus() }, [refreshMcTestStatus])
  useEffect(() => {
    if (libraryOpen) refreshMcTestStatus()
  }, [libraryOpen, refreshMcTestStatus])
  const mcTestActive = !!mcTestStatus && ['installing', 'starting', 'running'].includes(mcTestStatus.phase)
  useEffect(() => {
    if (!mcTestActive) return
    const timer = window.setInterval(refreshMcTestStatus, 2000)
    return () => window.clearInterval(timer)
  }, [mcTestActive, refreshMcTestStatus])
  // 空闲/已退出不占底部提示；失败保留到用户关闭
  useEffect(() => {
    if (mcTestStatus && (mcTestStatus.phase === 'idle' || mcTestStatus.phase === 'exited')) setMcTestStatus(null)
  }, [mcTestStatus])
  const lastTestErrorRef = useRef('')
  useEffect(() => {
    if (mcTestStatus?.phase !== 'error') return
    const msg = mcTestStatus.error || mcTestStatus.logTail.split(/\r?\n/).filter(Boolean).pop() || '未知错误'
    if (lastTestErrorRef.current === msg) return
    lastTestErrorRef.current = msg
    showToast(`测试客户端失败：${msg.slice(0, 240)}`)
  }, [mcTestStatus, showToast])

  // ---- 右侧拓展的标签页 ----
  const openDockTab = useCallback((tab: DockTabId) => {
    setDockTabs(prev => (prev.includes(tab) ? prev : [...prev, tab]))
    setDockTab(tab)
    setDockCollapsed(false)
  }, [])

  const closeDockTab = useCallback((tab: DockTabId) => {
    setDockTabs(prev => prev.filter(t => t !== tab))
    setDockTab(cur => (cur === tab ? null : cur))
  }, [])

  useEffect(() => { localStorage.setItem('openmods.dockTabs', JSON.stringify(dockTabs)) }, [dockTabs])
  useEffect(() => { if (dockTab) localStorage.setItem('openmods.dockTab', dockTab) }, [dockTab])
  // 当前标签被关掉后，自动落到还剩的第一个标签
  useEffect(() => {
    if (dockTab && dockTabs.includes(dockTab)) return
    setDockTab(dockTabs[0] ?? null)
  }, [dockTabs, dockTab])

  /**
   * 画布自动唤醒：AI 改画布 / 子代理结算时，把右侧拓展展开并切到「建模」标签。
   * 关闭（设置 → 自动化）后只记录，不动布局。
   */
  const wakeCanvas = useCallback((reason: string) => {
    if (prefsRef.current && prefsRef.current.canvasAutoWake === false) return
    setDockTabs(prev => (prev.includes('canvas') ? prev : ['canvas', ...prev]))
    setDockTab('canvas')
    setDockCollapsed(false)
    setWakeLog(prev => {
      const last = prev[0]
      if (last && Date.now() - last.at < 1500) return prev
      return [{ at: Date.now(), reason }, ...prev].slice(0, 20)
    })
  }, [])
  wakeRef.current = wakeCanvas

  const sendToBridge = useCallback((msg: any) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  /** 拉一次会话树的画布列表（页签名称/来源/活跃徽标、空白页选择列表都靠它） */
  const refreshCanvases = useCallback((sid?: string) => {
    const id = sid ?? sessionId
    if (!id) return
    api.canvases(id).then(r => {
      for (const c of r.canvases) canvasOwnerRef.current.set(c.canvasId, c.ownerSessionId)
      canvasesRef.current = r.canvases
      setCanvases(r.canvases)
      setActiveSessionCanvasId(r.activeCanvasId)
    }).catch(() => { /* 服务未起：保持空列表 */ })
  }, [sessionId])

  // 事件只作用于"当前对话轮"，跳过插在末尾的子代理通知行
  const updateLastTurn = useCallback((patch: (t: TurnEntry) => TurnEntry) => {
    setTurns(prev => {
      let idx = -1
      for (let i = prev.length - 1; i >= 0; i--) {
        if (!prev[i].notice) { idx = i; break }
      }
      if (idx < 0) return prev
      return prev.map((t, i) => (i === idx ? patch(t) : t))
    })
  }, [])


  // 功能开关 + 代理角色目录（同一接口）：角色由插件注册，关掉功能后角色一并消失
  useEffect(() => {
    api.features().then(r => {
      setFeatures(r)
      featuresRef.current = Object.fromEntries(r.features.map(f => [f.id, f.enabled]))
      setProfiles(r.profiles)
    }).catch(() => { /* 服务未起时默认全开 */ })
  }, [])

  /** 当前功能是否开启（未加载时默认开启，避免首屏闪动） */
  const featureOn = useCallback((id: string) => featuresRef.current[id] !== false, [])

  // 画布关闭：把画布标签从右侧拓展里摘掉（用户之前存过 canvas 也不显示）
  useEffect(() => {
    if (!features || featureOn('canvas')) return
    setDockTabs(prev => {
      const next = prev.filter(t => t !== 'canvas')
      return next.length || prev.length === 0 ? next : ['images']
    })
    setDockTab(prev => (prev === 'canvas' ? 'images' : prev))
  }, [features, featureOn])

  // 素材库关闭：抽屉不能停在打开状态（接口也已 404）
  useEffect(() => {
    if (!features || featureOn('library')) return
    setLibraryOpen(false)
  }, [features, featureOn])

  // 当前角色被关掉（如关闭 MC 后 mcmod 不存在）：回落到主代理
  useEffect(() => {
    if (!features || profiles.length === 0) return
    if (profiles.some(p => p.id === agentProfile)) return
    setAgentProfile('lead')
    localStorage.setItem('openmods.profile', 'lead')
  }, [features, profiles, agentProfile])

  const refreshModels = useCallback(() => {
    api.models().then(m => {
      setModels(m.models)
      setCurrentModelId(prev => {
        if (prev && m.models.some(x => x.id === prev)) return prev
        return m.defaultModelId
      })
    }).catch(() => {})
  }, [])

  /** 偏好落地：字号写进 CSS 变量（dsh 的 FontSizeRow 语义），其余项由使用处读取 */
  const applyPrefs = useCallback((p: PrefsDto) => {
    setPrefs(p)
    document.documentElement.style.setProperty('--content-font', `${p.fontSize}px`)
    // MC 主题：写 documentElement[data-theme]，mc-theme.css 按主题覆盖 --mc-* 令牌（画布/终端保持深色）
    document.documentElement.dataset.theme = p.theme
    // 界面音效：点击 / 切换到提示音的总开关
    setUiSoundEnabled(p.uiSound !== false)
  }, [])

  useEffect(() => {
    api.settings().then(({ settings }) => {
      if (settings.prefs) applyPrefs(settings.prefs)
    }).catch(() => { /* 服务未起时用默认值 */ })
  }, [applyPrefs])

  // 首次运行环境向导：environment.setupDone 未处理过就弹出；服务不可用时静默忽略
  useEffect(() => {
    api.envStatus().then(s => {
      if (!s.configured) setEnvOpen(true)
    }).catch(() => { /* 服务未起：不打扰用户 */ })
  }, [])

  // 参数语义：子代理列表按「根会话（画布 owner）」聚合，不是当前会话
  const refreshSubagents = useCallback((rootSessionId: string) => {
    if (!rootSessionId) return
    api.subagents(rootSessionId).then(r => setSubagents(r.subagents)).catch(() => {})
  }, [])

  // dock 拖拽调宽 + 持久化
  useEffect(() => { localStorage.setItem('openmods.dockw', String(dockWidth)) }, [dockWidth])
  const dockDrag = useDockDrag(
    useCallback(delta => setDockWidth(w => Math.min(760, Math.max(280, w + delta))), []),
    useCallback(() => {}, []),
  )

  const handleEvent = useCallback((f: SseFrame) => {
    switch (f.topic) {
      case 'turn/start':
        setBusy(true)
        // 回放/重连会重新补发同一轮的开头帧：按 turnId 去重，避免和磁盘回放的用户气泡叠加
        setTurns(prev => {
          if (prev.some(t => !t.notice && t.turnId === f.turnId)) return prev
          let pending = -1
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].notice) continue
            if (prev[i].turnId === 'pending') pending = i
            break
          }
          if (pending >= 0) {
            return prev.map((t, i) => (i === pending ? { ...t, turnId: f.turnId, profile: f.profile } : t))
          }
          return [...prev, {
            turnId: f.turnId, userText: '', attachments: f.attachments?.length ?? 0,
            steps: [], assistantText: '', streaming: true, profile: f.profile,
          }]
        })
        break
      case 'user/message':
        if (f.source?.kind === 'subagent-settled') {
          // 自动汇总回合的输入是 runtime 投递的结算：显示成通知行，不是用户气泡
          const notices = settledToNotices(f.source)
          updateLastTurn(t => ({ ...t, notices, userText: '' }))
        } else {
          updateLastTurn(t => (t.userText
            ? t
            : {
              ...t, userText: f.text ?? '',
              ...(toImages(f.attachments).length ? { images: toImages(f.attachments) } : {}),
              ...(f.imagesOmitted ? { imagesOmitted: true } : {}),
            }))
        }
        break
      case 'assistant/reasoning':
        // 思考过程单独计数：工具调用步骤只有 reasoning，没有正文，否则界面上一直是"已想 0 字"
        setStreamChars(c => c + (f.delta?.length ?? 0))
        setThinkTail(prev => (prev + (f.delta ?? '')).slice(-120))
        updateLastTurn(t => ({ ...t, reasoning: (t.reasoning ?? '') + f.delta }))
        break
      case 'assistant/delta':
        setStreamChars(c => c + f.delta.length)
        setThinkTail('')
        updateLastTurn(t => ({ ...t, assistantText: t.assistantText + f.delta }))
        break
      case 'tool/call':
        updateLastTurn(t => ({
          ...t,
          steps: [...t.steps, { callId: f.callId, name: f.name, args: f.args, done: false }],
        }))
        break
      case 'tool/result':
        updateLastTurn(t => ({
          ...t,
          steps: t.steps.map(s => (s.callId === f.callId ? { ...s, done: true, isError: !!f.isError } : s)),
        }))
        break
      case 'llm/usage':
        break
      case 'model_update': {
        // sessionId 现在是 canvasId（不再是会话 id）：按画布分流，只有当前页才送进 iframe
        const canvasId = String(f.sessionId ?? '')
        if (!canvasId) break
        if (f.originId) canvasOwnerRef.current.set(canvasId, String(f.originId))
        const next: CanvasState = {
          hasModel: (f.elements ?? 0) > 0,
          modelName: f.bbmodel?.name ?? '',
          elements: f.elements ?? 0,
          textures: f.textures ?? 0,
          view: f.view ?? '3d',
          animations: f.animations ?? [],
        }
        canvasStatesRef.current.set(canvasId, next)
        if (f.bbmodel) canvasModelsRef.current.set(canvasId, f.bbmodel)
        // 未知画布（子代理刚建 / 拆分工具自动建画布）：补拉一次画布列表
        if (!canvasesRef.current.some(c => c.canvasId === canvasId)) refreshCanvases()
        if (activeCanvasPageRef.current === canvasId) {
          lastModelRef.current = f.bbmodel
          setCanvas(next)
          setCanvasDirty(d => (d[canvasId] ? { ...d, [canvasId]: false } : d))
          sendToBridge({ type: 'load_bbmodel', model: f.bbmodel })
        } else if (canvasPagesRef.current.some(p => p.key === canvasId)) {
          // 页签开着但没在看：只更新缓存并标脏，切回去再重载（素材预览不被覆盖）
          setCanvasDirty(d => (d[canvasId] ? d : { ...d, [canvasId]: true }))
        }
        // AI 改了画布：自己把右侧拓展唤醒（设置 → 自动化可关）
        wakeRef.current(f.agentName ? `${f.agentName} 更新了画布` : '画布已更新')
        break
      }
      case 'view_update': {
        // 同样按 canvasId 分流：只更新对应画布的缓存，当前页才应用视角
        const canvasId = String(f.sessionId ?? '')
        if (!canvasId) break
        if (f.originId) canvasOwnerRef.current.set(canvasId, String(f.originId))
        const st = canvasStatesRef.current.get(canvasId)
        if (st) canvasStatesRef.current.set(canvasId, { ...st, view: f.view })
        if (activeCanvasPageRef.current === canvasId) {
          setCanvas(c => ({ ...c, view: f.view }))
          sendToBridge({ type: 'set_view', view: f.view })
        }
        break
      }
      case 'canvases/update': {
        // 画布集合变化：本会话或父会话里新建/切换画布时广播
        const list: CanvasRefDto[] = Array.isArray(f.canvases) ? f.canvases : []
        const fromSelf = String(f.sessionId ?? '') === sessionId
        let merged = list
        if (!fromSelf) {
          // 子代理广播的列表只是它自己视角的画布：合并进来，再补拉一次自己这边的完整树
          const byId = new Map(canvasesRef.current.map(c => [c.canvasId, c]))
          for (const c of list) byId.set(c.canvasId, c)
          merged = [...byId.values()]
        }
        canvasesRef.current = merged
        for (const c of merged) canvasOwnerRef.current.set(c.canvasId, c.ownerSessionId)
        setCanvases(merged)
        if (!fromSelf) refreshCanvases()
        // 只认当前会话自己那块活跃画布（活跃徽标按各自 owner 计算，不受视角影响）
        const mine = merged.find(c => c.ownerSessionId === sessionId && c.active)
        if (mine) setActiveSessionCanvasId(mine.canvasId)
        break
      }
      case 'compaction':
        showToast(`上下文已压缩：影子 ${f.shadowedTokens} → 摘要 ${f.summaryTokens} tokens（省下 ${f.saved}）`)
        break
      case 'settings/updated':
        if (f.prefs) applyPrefs(f.prefs)
        showToast('设置已更新（下一轮对话生效）')
        break
      case 'models/updated':
        refreshModels()
        break
      case 'stats':
        setStats({
          turns: f.turns ?? [],
          compactions: f.compactions ?? [],
          totals: f.totals ?? ({} as StatsDto['totals']),
          context: f.context ?? EMPTY_CONTEXT_STATS,
        })
        setCtxTokens(f.contextTokens ?? null)
        setModelWindow(f.modelWindow ?? null)
        setCtxBreakdown(f.contextBreakdown ?? null)
        break
      case 'turn/end':
        updateLastTurn(t => ({
          ...t,
          steps: t.steps.map(s => ({ ...s, done: true })),
          // 步数上限等系统收尾：模型没有正文时才把 turn/end 的文字补上，避免和正常回复重复
          ...(f.text && !t.assistantText ? { assistantText: f.text } : {}),
        }))
        break
      // 子代理：完成通知作为紧凑系统行插入主对话（不触发模型回合）
      case 'subagent/notice':
        setTurns(prev => {
          const turnId = `notice-${f.seq ?? Date.now()}`
          // 回放/重连补发：同一条通知不重复插入
          if (prev.some(t => t.turnId === turnId)) return prev
          return [...prev, {
            turnId, userText: '', attachments: 0,
            steps: [], assistantText: '', streaming: false,
            notice: {
              childId: f.childId, name: f.name, description: f.description,
              status: f.status ?? 'done', summary: f.summary ?? '',
            },
          }]
        })
        setSessionsVersion(v => v + 1)
        if (rootSessionId) refreshSubagents(rootSessionId)
        // 子任务结算：唤醒画布，让用户看到最终形态
        wakeRef.current(`${f.name ?? '子代理'} 已完成`)
        break
      case 'subagent/updated':
        if (f.status === 'running') wakeRef.current(`${f.name ?? '子代理'} 开始建模`)
        if (rootSessionId) refreshSubagents(rootSessionId)
        break
      // 人机交互：工具在服务端阻塞等答案，弹窗提交后同一轮自动继续
      case 'interaction/ask':
        setInteractions(prev => (prev.some(x => x.id === f.id) ? prev : [...prev, f as unknown as PendingInteractionDto]))
        break
      case 'interaction/answered':
        setInteractions(prev => prev.filter(x => x.id !== f.id))
        break
      case 'plan/mode':
        setPlanMode(!!f.active)
        break
      case 'todo/update':
        setTodos(Array.isArray(f.todos) ? f.todos : null)
        break
      case 'session/permissions':
        if (f.policy === 'ask' || f.policy === 'auto') setPermission(f.policy)
        if (Array.isArray(f.allowedTools)) setAllowedTools(f.allowedTools)
        break
      // 角色移交（lead → mcmod）：服务端已持久化角色，界面下拉立即跟随
      case 'session/profile':
        if (typeof f.profile === 'string') {
          setAgentProfile(f.profile)
          localStorage.setItem('openmods.profile', f.profile)
        }
        break
      // 终端：与右侧「终端」标签同源（open 建条目、data 追加输出、exit 结算）
      case 'terminal/open': {
        const t = f as unknown as TerminalDto
        setTerminals(prev => (prev.some(x => x.id === t.id) ? prev.map(x => (x.id === t.id ? t : x)) : [...prev, t]))
        setActiveTerminalId(cur => cur ?? t.id)
        break
      }
      case 'terminal/data':
        setTerminalOutput(prev => {
          const next = ((prev[f.terminalId] ?? '') + (f.chunk ?? '')).slice(-160_000)
          return { ...prev, [f.terminalId]: next }
        })
        break
      case 'terminal/exit':
        // 已退出的终端保留在列表里（状态改为已退出，输出可回看），由服务端按最近 6 个淘汰
        setTerminals(prev => prev.map(t => (t.id === f.terminalId
          ? { ...t, status: 'exited' as const, exitCode: f.exitCode ?? null, signal: f.signal, endedAt: f.endedAt ?? Date.now() }
          : t)))
        break
      case 'terminal/close':
        // 手动关闭或服务端超出保留数量淘汰：标签与输出一起移除
        setTerminals(prev => prev.filter(t => t.id !== f.terminalId))
        setTerminalOutput(prev => {
          if (!(f.terminalId in prev)) return prev
          const next = { ...prev }
          delete next[f.terminalId]
          return next
        })
        setActiveTerminalId(cur => (cur === f.terminalId ? null : cur))
        break
      // 等待态：会话没有结束（不是 idle），但用户不能插话，直到结算后自动汇总
      case 'session/waiting':
        setWaiting(Array.isArray(f.waiting) ? f.waiting : [])
        if (rootSessionId) refreshSubagents(rootSessionId)
        break
      // MC 构建完成（mc_gradle build）：刷新工程状态；成功时走进度条 → 升级成就
      case 'mc/build': {
        const project = String(f.project ?? 'mod')
        if (f.ok === true) celebrate(`「${project}」构建完成，正在收尾…`, `构建成功 · ${project}`)
        else showToast(`「${project}」构建失败（退出码 ${f.code ?? '?'}），查看会话里的编译日志`)
        if (sessionId) api.mcState(sessionId).then(x => setMcProjects(x.projects ?? [])).catch(() => {})
        break
      }
      case 'done':
        setBusy(false)
        if (lastModelRef.current) sendToBridge({ type: 'load_bbmodel', model: lastModelRef.current })
        setSessionInfo(info => (info?.mode === 'subagent'
          ? { ...info, status: f.aborted ? 'stopped' : 'done' }
          : info))
        setSessionsVersion(v => v + 1)
        if (rootSessionId) refreshSubagents(rootSessionId)
        break
      case 'error':
        updateLastTurn(t => ({ ...t, error: f.message }))
        setBusy(false)
        setSessionInfo(info => (info?.mode === 'subagent' ? { ...info, status: 'error' } : info))
        setSessionsVersion(v => v + 1)
        if (rootSessionId) refreshSubagents(rootSessionId)
        break
    }
  }, [sendToBridge, updateLastTurn, showToast, refreshModels, refreshSubagents, rootSessionId, refreshCanvases, sessionId, celebrate])

  // 统一事件流：当前打开的会话（主会话或子代理）都订阅同一条 SSE
  useEffect(() => {
    if (!sessionId) return
    const es = new EventSource(api.streamUrl(sessionId, streamSince))
    let lastId = -1
    es.onmessage = ev => {
      const id = Number(ev.lastEventId || 0)
      if (id && id <= lastId) return
      if (id) lastId = id
      let frame: SseFrame
      try { frame = JSON.parse(ev.data) } catch { return }
      if (frame.topic === 'open') {
        setBusy(!!frame.busy)
        setWaiting(Array.isArray(frame.waiting) ? frame.waiting : [])
        // 画布集合随 open 帧下发（快照也随之而来：每块有模型的画布各一条 model_update）
        if (Array.isArray(frame.canvases)) {
          canvasesRef.current = frame.canvases
          setCanvases(frame.canvases)
        }
        if (frame.canvasId) setActiveSessionCanvasId(String(frame.canvasId))
        return
      }
      handleEvent(frame)
    }
    return () => es.close()
  }, [sessionId, streamSince, handleEvent])

  // 子代理目录轮询：面板与状态点保持新鲜（运行中会自己变完成）
  useEffect(() => {
    if (!rootSessionId) return
    refreshSubagents(rootSessionId)
    const timer = setInterval(() => refreshSubagents(rootSessionId), 2500)
    return () => clearInterval(timer)
  }, [rootSessionId, refreshSubagents])

  /** 打开会话时把终端列表与已有输出取回来（SSE 只负责之后的增量） */
  const loadTerminals = useCallback(async (id: string) => {
    try {
      const r = await api.terminals(id)
      // 已退出终端也保留（服务端最多给最近 6 个），方便回看刚结束的构建输出
      setTerminals(r.terminals)
      setTerminalShell(r.shell)
      setActiveTerminalId(prev => (r.terminals.some(t => t.id === prev)
        ? prev
        : (r.terminals[r.terminals.length - 1]?.id ?? null)))
      const recent = r.terminals.slice(-4)
      const outs = await Promise.all(recent.map(async t => {
        const o = await api.terminalOutput(id, t.id, 20_000).catch(() => null)
        return [t.id, o?.output ?? ''] as const
      }))
      setTerminalOutput(Object.fromEntries(outs))
    } catch { /* 服务未起：保持空列表 */ }
  }, [])

  /** 切换会话：画布页重置成该会话的活跃画布，缓存（状态/bbmodel/脏标）全部作废 */
  const resetCanvasPages = useCallback((canvasId: string) => {
    canvasStatesRef.current.clear()
    canvasModelsRef.current.clear()
    const def: CanvasPageDto = { key: canvasId, kind: 'canvas' }
    canvasPagesRef.current = [def]
    setCanvasPages([def])
    setCanvasDirty({})
    setAssetAnims({})
    setActiveCanvasPage(canvasId)
    activeCanvasPageRef.current = canvasId
  }, [])

  /** 打开会话时拉一次它的活跃画布（SSE 快照之外的第一帧兜底） */
  const loadCanvas = useCallback((ownerSessionId: string, canvasId: string) => {
    canvasModelsRef.current.delete(canvasId)
    canvasStatesRef.current.delete(canvasId)
    setCanvas(emptyCanvas())
    setPlayingAnim(null)
    pendingAnimRef.current = null
    lastModelRef.current = null
    setCanvasLoading(true)
    sendToBridge({ type: 'load_bbmodel', model: null })
    api.bbmodel(ownerSessionId).then(model => {
      const state = modelToCanvasState(model)
      canvasStatesRef.current.set(canvasId, state)
      canvasModelsRef.current.set(canvasId, model)
      if (activeCanvasPageRef.current !== canvasId) return
      lastModelRef.current = model
      setCanvas(state)
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model })
    }).catch(() => { if (activeCanvasPageRef.current === canvasId) setCanvasLoading(false) })
  }, [sendToBridge])

  /** 动画播放/停止（chips 统一入口）：记下意图，模型失同步时 bb_animation_error 能自动重载重试 */
  const playAnim = useCallback((name: string | null) => {
    pendingAnimRef.current = name
    pendingAnimTabRef.current = activeCanvasPageRef.current
    animNameRef.current = name
    animRetryRef.current = 0
    iframeRef.current?.contentWindow?.postMessage(name ? { type: 'play_animation', name } : { type: 'stop_animation' }, '*')
  }, [])

  /**
   * 换页：画布页直接用缓存（有 bbmodel 就灌进 iframe，没有就空态等「重新加载」），
   * 素材页重新取只读模型，空白页展示可选画布列表。
   */
  const showCanvasPage = useCallback((page: CanvasPageDto) => {
    setActiveCanvasPage(page.key)
    activeCanvasPageRef.current = page.key
    setPlayingAnim(null)
    pendingAnimRef.current = null
    if (page.kind === 'canvas') {
      setCanvasDirty(d => (d[page.key] ? { ...d, [page.key]: false } : d))
      const model = canvasModelsRef.current.get(page.key) ?? null
      const state = canvasStatesRef.current.get(page.key)
        ?? { ...emptyCanvas(), modelName: canvasesRef.current.find(c => c.canvasId === page.key)?.name ?? '' }
      lastModelRef.current = model
      setCanvas(state)
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model })
      return
    }
    if (page.kind === 'asset' && page.assetId) {
      const assetId = page.assetId
      lastModelRef.current = null // 素材页签不影响画布页的缓存
      setCanvasLoading(true)
      // 素材页按素材自身的数据显示状态条（不写画布缓存，切回画布页会还原）
      setCanvas({ ...emptyCanvas(), modelName: page.assetName ?? '' })
      sendToBridge({ type: 'load_bbmodel', model: null })
      api.libraryModel(assetId).then(model => {
        if (activeCanvasPageRef.current !== page.key) return
        setAssetAnims(prev => ({ ...prev, [assetId]: toAnims(model) }))
        setCanvas(modelToCanvasState(model))
        setCanvasLoading(false)
        sendToBridge({ type: 'load_bbmodel', model })
      }).catch(e => { setCanvasLoading(false); showToast(`打开素材失败：${e.message}`) })
      return
    }
    // 空白页：列出可选画布（顺手刷新，部件数/活跃标记才是最新的）
    lastModelRef.current = null
    setCanvas(emptyCanvas())
    setCanvasLoading(false)
    sendToBridge({ type: 'load_bbmodel', model: null })
    refreshCanvases()
  }, [sendToBridge, showToast, refreshCanvases])

  const switchCanvasPage = useCallback((key: string) => {
    if (key === activeCanvasPageRef.current) return
    const page = canvasPagesRef.current.find(p => p.key === key)
    if (page) showCanvasPage(page)
  }, [showCanvasPage])

  /** ＋：新建一个空白页（不建后端画布，也不抢占活跃画布） */
  const newBlankPage = useCallback(() => {
    blankSeqRef.current += 1
    const page: CanvasPageDto = { key: `blank:${blankSeqRef.current}`, kind: 'blank' }
    const next = [...canvasPagesRef.current, page]
    canvasPagesRef.current = next
    setCanvasPages(next)
    showCanvasPage(page)
  }, [showCanvasPage])

  const closeCanvasPage = useCallback((key: string) => {
    const pages = canvasPagesRef.current
    const idx = pages.findIndex(p => p.key === key)
    if (idx < 0) return
    const page = pages[idx]
    const next = pages.filter(p => p.key !== key)
    canvasPagesRef.current = next
    setCanvasPages(next)
    // 关掉的素材页不再保留动画列表
    if (page.kind === 'asset' && page.assetId) {
      const assetId = page.assetId
      setAssetAnims(prev => {
        if (!(assetId in prev)) return prev
        const copied = { ...prev }
        delete copied[assetId]
        return copied
      })
    }
    setCanvasDirty(d => {
      if (!(key in d)) return d
      const copied = { ...d }
      delete copied[key]
      return copied
    })
    if (key !== activeCanvasPageRef.current) return
    // 关到最后一页：落到空态（页签区为空，主体是可选画布列表）
    const fallback = next[idx] ?? next[idx - 1] ?? next[0]
    if (fallback) {
      showCanvasPage(fallback)
    } else {
      activeCanvasPageRef.current = ''
      setActiveCanvasPage('')
      lastModelRef.current = null
      setCanvas(emptyCanvas())
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model: null })
    }
  }, [showCanvasPage, sendToBridge])

  /** 素材库模型开一个只读页签（已开过就直接切过去），绝不覆盖画布页 */
  const openLibModel = useCallback((asset: { id: string; name: string }) => {
    const key = `asset:${asset.id}`
    const existing = canvasPagesRef.current.find(p => p.key === key)
    if (existing) { showCanvasPage(existing); return }
    const page: CanvasPageDto = { key, kind: 'asset', assetId: asset.id, assetName: asset.name }
    const next = [...canvasPagesRef.current, page]
    canvasPagesRef.current = next
    setCanvasPages(next)
    showCanvasPage(page)
  }, [showCanvasPage])

  /** 空白页里点选一块画布：已开过就切过去，否则把当前空白页原位换成画布页 */
  const pickCanvas = useCallback((canvasId: string) => {
    if (canvasPagesRef.current.some(p => p.key === canvasId)) {
      switchCanvasPage(canvasId)
      return
    }
    const key = activeCanvasPageRef.current
    const page = canvasPagesRef.current.find(p => p.key === key)
    if (!page || page.kind !== 'blank') return
    const next = canvasPagesRef.current.map(p => (p.key === key ? { key: canvasId, kind: 'canvas' as const } : p))
    canvasPagesRef.current = next
    setCanvasPages(next)
    showCanvasPage({ key: canvasId, kind: 'canvas' })
  }, [switchCanvasPage, showCanvasPage])

  /** 空白页底部：新建空白画布（当前会话下创建并设为活跃），随后在原空白页打开 */
  const createCanvas = useCallback(async () => {
    if (!sessionId) {
      showToast('先发送一条消息创建会话，再新建画布')
      return
    }
    try {
      const r = await api.createCanvas(sessionId)
      canvasesRef.current = r.canvases
      setCanvases(r.canvases)
      setActiveSessionCanvasId(r.activeCanvasId)
      const key = activeCanvasPageRef.current
      const page = canvasPagesRef.current.find(p => p.key === key)
      const def: CanvasPageDto = { key: r.canvasId, kind: 'canvas' }
      const next = page?.kind === 'blank'
        ? canvasPagesRef.current.map(p => (p.key === key ? def : p))
        : [...canvasPagesRef.current, def]
      canvasPagesRef.current = next
      setCanvasPages(next)
      canvasStatesRef.current.set(r.canvasId, { ...emptyCanvas(), modelName: '未命名模型' })
      showCanvasPage(def)
    } catch (e: any) {
      showToast(`新建画布失败：${e.message}`)
    }
  }, [sessionId, showToast, showCanvasPage])

  /** 当前页画布「设为活跃」：调它 owner 会话的激活接口，成功后刷新列表与徽标 */
  const activateCurrentCanvas = useCallback(async () => {
    const canvasId = activeCanvasPageRef.current
    const ref = canvasesRef.current.find(c => c.canvasId === canvasId)
    if (!ref) return
    try {
      const r = await api.activateCanvas(ref.ownerSessionId, canvasId)
      let merged = r.canvases
      if (ref.ownerSessionId !== sessionId) {
        // 子代理视角的列表不含父会话的画布：合并后补拉自己的完整树
        const byId = new Map(canvasesRef.current.map(c => [c.canvasId, c]))
        for (const c of r.canvases) byId.set(c.canvasId, c)
        merged = [...byId.values()]
        refreshCanvases()
      }
      canvasesRef.current = merged
      setCanvases(merged)
      const mine = merged.find(c => c.ownerSessionId === sessionId && c.active)
      if (mine) setActiveSessionCanvasId(mine.canvasId)
      showToast(`已把「${ref.name || '未命名模型'}」设为 ${ref.ownerName} 的活跃画布`)
    } catch (e: any) {
      showToast(`设为活跃失败：${e.message}`)
    }
  }, [sessionId, refreshCanvases, showToast])

  /** 重新加载某页的模型：缓存没有时用直连（owner 活跃画布）或一条临时 SSE 取快照，不阻塞界面 */
  const reloadCanvasPage = useCallback((key: string) => {
    const page = canvasPagesRef.current.find(p => p.key === key)
    if (!page) return
    if (page.kind === 'asset' && page.assetId) {
      const assetId = page.assetId
      setCanvasLoading(true)
      api.libraryModel(assetId).then(model => {
        if (activeCanvasPageRef.current !== key) return
        setAssetAnims(prev => ({ ...prev, [assetId]: toAnims(model) }))
        setCanvasLoading(false)
        sendToBridge({ type: 'load_bbmodel', model })
      }).catch(() => setCanvasLoading(false))
      return
    }
    if (page.kind !== 'canvas') return
    const canvasId = key
    const ref = canvasesRef.current.find(c => c.canvasId === canvasId)
    const apply = (model: any) => {
      const state = modelToCanvasState(model)
      canvasStatesRef.current.set(canvasId, state)
      canvasModelsRef.current.set(canvasId, model)
      if (activeCanvasPageRef.current !== canvasId) return
      lastModelRef.current = model
      setCanvas(state)
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model })
    }
    if (ref?.active) {
      // 它正是 owner 会话的活跃画布：有直连接口
      setCanvasLoading(true)
      api.bbmodel(ref.ownerSessionId).then(apply).catch(() => setCanvasLoading(false))
      return
    }
    if (!ref) return
    // 非活跃画布没有模型接口：开一条临时 SSE 只取快照帧（聊天帧全部忽略）
    setCanvasLoading(true)
    const es = new EventSource(api.streamUrl(ref.ownerSessionId, 0))
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = () => {
      if (closed) return
      closed = true
      es.close()
      if (timer) clearTimeout(timer)
    }
    timer = setTimeout(() => { setCanvasLoading(false); done() }, 3000)
    es.onmessage = ev => {
      let f: SseFrame
      try { f = JSON.parse(ev.data) } catch { return }
      if (f.topic !== 'model_update' || String(f.sessionId) !== canvasId || !f.bbmodel) return
      apply(f.bbmodel)
      done()
    }
  }, [sendToBridge])

  // 打开会话（主会话或子代理）：先读 meta，再一起更新 sessionId + 流起点，避免双连接
  // silent=true：启动恢复时静默失败（存储的 sid 可能是被清理的空会话，不该开局弹错）
  const openSession = useCallback(async (id: string, silent = false) => {
    const seq = ++openSeqRef.current
    try {
      const res = await api.getSession(id)
      if (seq !== openSeqRef.current) return
      draftCwdRef.current = ''
      setDraftCwd('')
      const root = res.parentId ?? res.id
      setSessionInfo(res)
      setRootSessionId(root)
      setStreamSince(res.events.length === 0 ? 0 : -1)
      setSessionId(id)
      localStorage.setItem('openmods.sid', id)
      setTurns(replayEvents(res.events))
      setStats(null)
      // 上下文环的初值：从磁盘打开会话时不会先有 stats 帧，必须在这里就填上，
      // 否则要等下一轮对话结束才出现（dsh 的 ContextMeter 是常驻的）。
      setCtxTokens(typeof res.contextTokens === 'number' ? res.contextTokens : null)
      setModelWindow(typeof res.modelWindow === 'number' ? res.modelWindow : null)
      setCtxBreakdown(res.contextBreakdown ?? null)
      // 子代理会话（如 modeling）不占用全局角色选择：它只代表那个子代理，不应把用户选好的角色顶掉
      if (!res.parentId && res.profile) setAgentProfile(res.profile)
      setBusy(!!res.busy)
      setWaiting(res.waiting ?? [])
      // 会话级协作状态：计划模式 / 待办 / 授权 / 未答问题（刷新后也要恢复）
      setPlanMode(!!res.planMode)
      setTodos(res.todos ?? null)
      setPermission(res.permission === 'auto' ? 'auto' : 'ask')
      setAllowedTools(Array.isArray(res.allowedTools) ? res.allowedTools : [])
      setInteractions(res.pendingInteractions ?? [])
      setStreamChars(0)
      setThinkTail('')
      if (res.modelId) setCurrentModelId(res.modelId)
      // 画布：默认打开该会话的活跃画布页（子代理各有自己的独立画布）
      const activeCanvasId = res.canvasId ?? id
      resetCanvasPages(activeCanvasId)
      loadCanvas(id, activeCanvasId)
      refreshCanvases(id)
      // MC 工程状态（dock 顶部「测试 Mod」按钮）：有会话就拉，服务端扫 cwd 下的工程
      setMcProjects([])
      if (featureOn('mc')) api.mcState(id).then(r => setMcProjects(r.projects ?? [])).catch(() => {})
      api.stats(id).then(r => {
        if (seq !== openSeqRef.current) return
        setStats(r.stats)
        if (typeof r.contextTokens === 'number') setCtxTokens(r.contextTokens)
        if (typeof r.modelWindow === 'number' && r.modelWindow > 0) setModelWindow(r.modelWindow)
        setCtxBreakdown(r.contextBreakdown ?? null)
      }).catch(() => {})
      refreshSubagents(root)
      void loadTerminals(id)
    } catch (e: any) {
      if (seq !== openSeqRef.current) return
      if (!silent) showToast(e.message)
      localStorage.removeItem('openmods.sid')
      setSessionId('')
      setRootSessionId('')
    }
  }, [loadCanvas, loadTerminals, refreshSubagents, showToast, featureOn, refreshCanvases, resetCanvasPages])

  // MC 工程：标题栏的「▶ 测试 Mod」= 后台 gradlew runClient（Minecraft 客户端窗口直接弹出来）
  // 点击即走进度条 → 升级成就（1.75s），启动失败则撤销动画并提示
  const mcRun = useCallback((project: string) => {
    if (!sessionId) return
    celebrate(`正在启动「${project}」…`, `「${project}」已装进 Minecraft 1.20.1`)
    api.mcRun(sessionId, project).then(() => {
      // 启动成功后刷新工程状态，按钮从「▶」切成「■」
      window.setTimeout(() => {
        api.mcState(sessionId).then(x => setMcProjects(x.projects ?? [])).catch(() => {})
      }, 1200)
    }).catch(e => {
      cancelCelebrate()
      showToast(`启动失败：${e.message}`)
    })
  }, [sessionId, celebrate, cancelCelebrate, showToast])

  const mcStop = useCallback((project: string) => {
    if (!sessionId) return
    api.mcStop(sessionId, project).then(r => {
      showToast(r.stopped ? '已停止 Minecraft 客户端' : '客户端已不在运行')
      api.mcState(sessionId).then(x => setMcProjects(x.projects ?? [])).catch(() => {})
    }).catch(e => showToast(`停止失败：${e.message}`))
  }, [sessionId, showToast])

  // jar 导出：复制到设置里的 mod-output 目录（未配置时标题栏回退为浏览器下载链接）
  const mcExport = useCallback((project: string) => {
    if (!sessionId) return
    api.mcExport(sessionId, project).then(r => {
      showToast(`已导出 ${r.name} → ${r.dest}（${(r.size / 1024).toFixed(0)} KB）`)
    }).catch(e => showToast(`导出失败：${e.message}`))
  }, [sessionId, showToast])

  // 初始化：健康检查 + 模型目录 + 会话恢复
  useEffect(() => {
    api.health().then(setHealth).catch(() => {})
    refreshModels()
    const stored = localStorage.getItem('openmods.sid')
    if (stored) openSession(stored, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // MOCK 离线演示是脚本化流程（没有计划评审环节）：不默认开启计划模式，与服务端 createSession 一致
  useEffect(() => {
    if (health?.mock) setPlanMode(false)
  }, [health?.mock])

  const onIframeReady = useCallback(() => {
    setIframeReady(true)
    if (lastModelRef.current) sendToBridge({ type: 'load_bbmodel', model: lastModelRef.current })
  }, [sendToBridge])

  /** 动画失同步时重载"当前正在看的画布页"（画布页或素材页签） */
  const reloadActiveCanvas = useCallback((key: string) => {
    if (key) reloadCanvasPage(key)
  }, [reloadCanvasPage])

  // 画布动画播放状态（bridge 回传）
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const t = ev.data?.type
      if (t === 'animation_state') {
        animRetryRef.current = 0
        animNameRef.current = null
        setPlayingAnim(ev.data.playing ?? null)
        return
      }
      // chips 与 iframe 模型失同步（画布刚被覆盖/切换会话竞态）：提示 + 自动重载 + 重试一次，
      // 二次仍失败则明确提示，绝不静默无反应也不无限重载。
      if (t === 'bb_animation_error') {
        const name = pendingAnimRef.current ?? animNameRef.current
        if (!name) return
        if (animRetryRef.current >= 1) {
          pendingAnimRef.current = null
          animNameRef.current = null
          animRetryRef.current = 0
          showToast(`动画播放失败：${ev.data.message ?? '未知原因'}（已自动重载仍失败，请重试或切换画布）`)
          return
        }
        animRetryRef.current += 1
        showToast(`动画播放失败：${ev.data.message ?? '未知原因'}，正在重载画布模型并重试…`)
        reloadActiveCanvas(pendingAnimTabRef.current)
        return
      }
      if (t === 'bb_loaded' && pendingAnimRef.current) {
        const name = pendingAnimRef.current
        const tab = pendingAnimTabRef.current
        pendingAnimRef.current = null
        // 模型刚灌进去，动画注册完成后再播（只在发起播放的同一标签上重试）
        setTimeout(() => {
          if (activeCanvasPageRef.current === tab) {
            iframeRef.current?.contentWindow?.postMessage({ type: 'play_animation', name }, '*')
          }
        }, 300)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [reloadActiveCanvas, showToast])

  useEffect(() => {
    if (!busy) return
    setElapsedSec(0)
    const started = Date.now()
    const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const addPendingFiles = useCallback((files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files).slice(0, 3)) {
      const reader = new FileReader()
      reader.onload = () => setPendingAtts(prev => [...prev, { name: file.name, dataUrl: String(reader.result) }])
      reader.readAsDataURL(file)
    }
  }, [])

  const send = useCallback(async (text: string, mode: 'build' | 'refine', attachments?: any[]) => {
    // 等待子代理期间不接新指令：这一轮还没结束（服务端同样会 409）
    if (waiting.length > 0) {
      showToast(`还在等 ${waiting.length} 个子代理完成，结算后会自动汇总；要打断请先点停止`)
      return
    }
    let sid = sessionId
    if (!sid) {
      try {
        // 惰性创建：到这里才有真对话，服务端此刻才落盘（点「新对话」只是草稿，不留空会话）
        const created = await api.createSession(draftProjectRef.current, draftCwdRef.current || undefined)
        draftProjectRef.current = undefined
        if (created.cwd) setDraftCwd(created.cwd)
        sid = created.id
        openSeqRef.current++
        setSessionId(sid)
        setRootSessionId(sid)
        setSessionInfo(null)
        setStreamSince(0)
        localStorage.setItem('openmods.sid', sid)
        setSessionsVersion(v => v + 1)
        // 草稿里改过计划模式：会话刚建好，把当前状态同步到服务端（真实模式默认本就是开启）
        await api.setPlanMode(sid, planMode).catch(() => {})
        // 新会话的活跃画布：拿到列表后把草稿里的空白页换成画布页
        const newSid = sid
        void api.canvases(newSid).then(r => {
          canvasesRef.current = r.canvases
          setCanvases(r.canvases)
          setActiveSessionCanvasId(r.activeCanvasId)
          resetCanvasPages(r.activeCanvasId)
          loadCanvas(newSid, r.activeCanvasId)
        }).catch(() => { /* 拉不到就等 SSE 的 open 帧补上 */ })
      } catch (e: any) {
        showToast(`无法创建会话：${e.message}（检查 server 是否运行）`)
        return
      }
    }
    setTurns(prev => [...prev, {
      turnId: 'pending', userText: text, attachments: pendingAtts.length,
      images: pendingAtts.map((a, i) => ({ id: `pending-${i}-${Date.now()}`, name: a.name, src: a.dataUrl })),
      steps: [], assistantText: '', streaming: true,
    }])
    setBusy(true)
    setStreamChars(0)
    setThinkTail('')
    // 客户端只送 data URL；准入/落盘/引用化在服务端完成（复刻 dsh PromptContentPart）
    const attParts = pendingAtts.map(a => ({ type: 'image', dataUrl: a.dataUrl, name: a.name }))
    const allAtts = [...(attachments ?? []), ...attParts]
    setPendingAtts([])
    try {
      await api.chat(sid, {
        text, modelId: currentModelId ?? undefined, mode,
        reasoningEffort: reasoningEffort || undefined,
        attachments: allAtts.length ? allAtts : undefined,
        profile: agentProfile,
      })
    } catch (e: any) {
      updateLastTurn(t => ({ ...t, error: e.message }))
      setBusy(false)
    }
  }, [sessionId, currentModelId, reasoningEffort, updateLastTurn, showToast, pendingAtts, waiting.length, agentProfile, planMode, resetCanvasPages, loadCanvas])

  const stop = useCallback(async () => {
    if (!sessionId) return
    // 等待态下停止 = 取消这批子代理并解锁（服务端会清空等待集合并中止它们）
    if (waiting.length > 0) setWaiting([])
    await api.stop(sessionId).catch(() => {})
    if (rootSessionId) refreshSubagents(rootSessionId)
  }, [sessionId, waiting.length, rootSessionId, refreshSubagents])

  // ---- 计划模式 / 授权策略 / 人机交互 ----
  const togglePlan = useCallback(async () => {
    const next = !planMode
    setPlanMode(next) // 乐观更新；失败回滚
    // 草稿会话还没落盘：只改本地，发送首条消息创建会话时再同步（见 send）
    if (!sessionId) return
    try {
      await api.setPlanMode(sessionId, next)
      showToast(next ? '已进入计划模式：AI 先出方案，批准后才动手' : '已退出计划模式')
    } catch (e: any) {
      setPlanMode(!next)
      showToast(`切换计划模式失败：${e.message}`)
    }
  }, [sessionId, planMode, showToast])

  const togglePermission = useCallback(async () => {
    if (!sessionId) return
    const next = permission === 'auto' ? 'ask' : 'auto'
    setPermission(next)
    try {
      const r = await api.setPermissions(sessionId, { policy: next })
      setAllowedTools(r.allowedTools)
      showToast(next === 'auto' ? '本会话授权已改为自动放行' : '本会话授权已改为询问')
    } catch (e: any) {
      setPermission(permission)
      showToast(`切换授权策略失败：${e.message}`)
    }
  }, [sessionId, permission, showToast])

  const resetAllowed = useCallback(async () => {
    if (!sessionId) return
    try {
      const r = await api.setPermissions(sessionId, { resetAllowed: true })
      setAllowedTools(r.allowedTools)
      showToast('已清空「总是允许」的工具')
    } catch (e: any) {
      showToast(e.message)
    }
  }, [sessionId, showToast])

  /** 弹窗提交：工具在服务端阻塞等待，答案一到这一轮就继续 */
  const submitInteraction = useCallback(async (reply: InteractionReplyBody) => {
    const ask = interactions[0]
    if (!ask) return
    await api.answerInteraction(ask.sessionId || sessionId, ask.id, reply)
    setInteractions(prev => prev.filter(x => x.id !== ask.id))
  }, [interactions, sessionId])

  // ---- 终端 ----
  const openTerminal = useCallback(async (command: string) => {
    if (!sessionId) return
    try {
      const r = await api.openTerminal(sessionId, { command: command || undefined })
      setTerminals(prev => (prev.some(t => t.id === r.terminal.id) ? prev : [...prev, r.terminal]))
      setActiveTerminalId(r.terminal.id)
      openDockTab('terminal')
    } catch (e: any) {
      showToast(`打开终端失败：${e.message}`)
    }
  }, [sessionId, openDockTab, showToast])

  const killTerminal = useCallback(async (id: string) => {
    if (!sessionId) return
    try {
      await api.killTerminal(sessionId, id)
    } catch (e: any) {
      showToast(e.message)
    }
  }, [sessionId, showToast])

  const terminalInput = useCallback(async (id: string, text: string) => {
    if (!sessionId) return
    try {
      await api.terminalInput(sessionId, id, text)
    } catch (e: any) {
      showToast(e.message)
    }
  }, [sessionId, showToast])

  /** 切换终端标签：输出不在缓存里（切会话后只预取了最近几个）就补拉一次，已退出的也能回看 */
  const selectTerminal = useCallback((id: string) => {
    setActiveTerminalId(id)
    if (!sessionId || id in terminalOutput) return
    void api.terminalOutput(sessionId, id, 20_000)
      .then(r => setTerminalOutput(prev => (id in prev ? prev : { ...prev, [id]: r.output })))
      .catch(() => {})
  }, [sessionId, terminalOutput])

  /** 关闭单个终端：通知服务端移除条目（运行中的先收进程树），再从标签里移除 */
  const closeTerminal = useCallback(async (id: string) => {
    if (!sessionId) return
    try {
      await api.closeTerminal(sessionId, id)
    } catch (e: any) {
      showToast(e.message)
      return
    }
    setTerminals(prev => prev.filter(x => x.id !== id))
    setTerminalOutput(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setActiveTerminalId(cur => (cur === id ? null : cur))
  }, [sessionId, showToast])

  /** 全部清空：服务端移除全部条目（运行中的先结束），前端清空列表与输出 */
  const closeAllTerminals = useCallback(async () => {
    if (sessionId) {
      try { await api.closeAllTerminals(sessionId) } catch (e: any) { showToast(e.message) }
    }
    setTerminals([])
    setTerminalOutput({})
    setActiveTerminalId(null)
  }, [sessionId, showToast])

  /** 欢迎区「绑定工作目录」：系统原生选择器 → setSessionCwd → 同步 sessionInfo 并 toast */
  const pickSessionCwd = useCallback(async () => {
    try {
      // 草稿会话还没落盘：先记下，首条消息创建会话时一起带上
      const r = await api.pickDir(sessionInfo?.cwd ?? draftCwdRef.current, '绑定工作目录')
      if (!r.path) return
      const path = r.path
      if (!sessionId) {
        draftCwdRef.current = path
        setDraftCwd(path)
        showToast(`已选择工作目录：${path}（发送首条消息时生效）`)
        return
      }
      await api.setSessionCwd(sessionId, path)
      setSessionInfo(info => (info ? { ...info, cwd: path } : info))
      setSessionsVersion(v => v + 1)
      showToast(`已绑定工作目录：${path}`)
    } catch (e: any) {
      showToast(`选择目录失败：${e.message}`)
    }
  }, [sessionId, sessionInfo?.cwd, showToast])

  // 新对话 = 草稿态：不请求服务端、不落盘，列表里不出现「新对话」；
  // 真正发出第一条消息时 send() 才创建会话（分组归属由 draftProjectRef 带过去）
  const newSession = useCallback((projectId?: string) => {
    draftProjectRef.current = projectId
    draftCwdRef.current = ''
    setDraftCwd('')
    openSeqRef.current++
    localStorage.removeItem('openmods.sid')
    setSessionId('')
    setRootSessionId('')
    setSessionInfo(null)
    setStreamSince(0)
    setTurns([])
    setStats(null)
    // 草稿会话还没有画布：先给一个空白页（列表为空，首条消息创建会话后换成活跃画布）
    blankSeqRef.current += 1
    const blankPage: CanvasPageDto = { key: `blank:${blankSeqRef.current}`, kind: 'blank' }
    canvasPagesRef.current = [blankPage]
    setCanvasPages([blankPage])
    setActiveCanvasPage(blankPage.key)
    activeCanvasPageRef.current = blankPage.key
    canvasStatesRef.current.clear()
    canvasModelsRef.current.clear()
    setCanvasDirty({})
    setAssetAnims({})
    setCanvases([])
    setActiveSessionCanvasId('')
    setCanvas(emptyCanvas())
    setPlayingAnim(null)
    setBusy(false)
    setWaiting([])
    // 新会话默认进入计划模式（与服务端 createSession 的 root 默认一致；MOCK 演示除外）
    setPlanMode(!health?.mock)
    setTodos(null)
    setPermission('ask')
    setAllowedTools([])
    setInteractions([])
    setTerminals([])
    setTerminalOutput({})
    setActiveTerminalId(null)
    lastModelRef.current = null
    sendToBridge({ type: 'load_bbmodel', model: null })
  }, [sendToBridge, health?.mock])

  const openSubagent = useCallback((childId: string) => {
    if (childId) openSession(childId)
  }, [openSession])

  const backToRoot = useCallback(() => {
    if (rootSessionId && rootSessionId !== sessionId) openSession(rootSessionId)
  }, [rootSessionId, sessionId, openSession])

  const stopSubagent = useCallback(async (childId: string) => {
    await api.stop(childId).catch(() => {})
    setTimeout(() => { if (rootSessionId) refreshSubagents(rootSessionId) }, 400)
  }, [rootSessionId, refreshSubagents])

  const download = useCallback(async () => {
    try {
      const blob = await fetch(`/api/sessions/${sessionId}/bbmodel`).then(r => {
        if (!r.ok) throw new Error('画布还没有模型')
        return r.blob()
      })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${canvas.modelName || 'model'}.bbmodel`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e: any) {
      showToast(e.message)
    }
  }, [sessionId, canvas.modelName, showToast])

  // 模型选择：本地立即生效 + 服务端落盘（刷新/重启后仍保持）
  const pickModel = useCallback(async (id: string) => {
    setCurrentModelId(id)
    if (!sessionId) return
    try {
      await api.setSessionModel(sessionId, id)
    } catch (e: any) {
      showToast(`模型选择未能持久化：${e.message}`)
    }
  }, [sessionId, showToast])

  const currentModel = models.find(m => m.id === currentModelId)
  // 换到不支持该档位的模型时回到默认，避免把无效 effort 发给端点
  useEffect(() => {
    if (!reasoningEffort || !currentModel) return
    if (!(currentModel.reasoningEfforts ?? []).includes(reasoningEffort)) {
      setReasoningEffort('')
      localStorage.setItem('openmods.reasoningEffort', '')
    }
  }, [currentModel, reasoningEffort])
  const activeIsChild = !!sessionInfo?.parentId
  /** 当前选中的画布页（页签名/来源/活跃/动画条/下载可用性都从它推导） */
  const activeCanvasPageData = canvasPages.find(p => p.key === activeCanvasPage)
  /** 当前页画布的归属：主会话或某个子代理（每块画布各有一个 owner） */
  const activeCanvasOwnerName = activeCanvasPageData?.kind === 'canvas'
    ? canvases.find(c => c.canvasId === activeCanvasPageData.key)?.ownerName
      ?? (activeIsChild ? sessionInfo?.agentName ?? '子代理' : '主会话')
    : undefined
  /** 当前页画布 owner 的会话 id：底部统计与「上下文」面板按它取数（空白/素材页回落到当前会话） */
  const activeCanvasOwnerSessionId = activeCanvasPageData?.kind === 'canvas'
    ? canvases.find(c => c.canvasId === activeCanvasPageData.key)?.ownerSessionId
      ?? canvasOwnerRef.current.get(activeCanvasPageData.key)
    : undefined
  const pageSessionId = activeCanvasOwnerSessionId || sessionId
  const pageSessionIsOther = !!pageSessionId && pageSessionId !== sessionId
  const pageSessionRunning = pageSessionIsOther && subagents.some(s => s.id === pageSessionId && s.status === 'running')

  // 切到列表里还没有的画布（子代理刚建 / 画布列表未刷新）时补拉一次，
  // 否则 owner 解析不出来，底部状态条与「上下文」会静默退回当前会话的统计
  const canvasOwnerMissRef = useRef('')
  useEffect(() => {
    if (activeCanvasPageData?.kind !== 'canvas') return
    const key = activeCanvasPageData.key
    if (!key || canvases.some(c => c.canvasId === key) || canvasOwnerMissRef.current === key) return
    canvasOwnerMissRef.current = key
    refreshCanvases()
  }, [activeCanvasPageData, canvases, refreshCanvases])

  // 切画布页 = 切统计口径：不再等左侧点会话才刷新
  useEffect(() => {
    if (!pageSessionIsOther) { setPageStats(null); return }
    let cancelled = false
    const load = () => {
      api.stats(pageSessionId).then(r => {
        if (cancelled) return
        setPageStats({
          sessionId: pageSessionId,
          stats: r.stats,
          ctxTokens: typeof r.contextTokens === 'number' ? r.contextTokens : null,
          modelWindow: typeof r.modelWindow === 'number' ? r.modelWindow : null,
          contextBreakdown: r.contextBreakdown ?? null,
        })
      }).catch(() => { /* 拉不到统计就保持空态，不阻塞画布 */ })
    }
    load()
    // 正在跑的子代理：轻量轮询，页面上的数字跟着涨
    if (!pageSessionRunning) return () => { cancelled = true }
    const timer = window.setInterval(load, 2500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [pageSessionId, pageSessionIsOther, pageSessionRunning])

  const pageSnapshot = pageSessionIsOther && pageStats?.sessionId === pageSessionId ? pageStats : null
  const viewStats = pageSessionIsOther ? (pageSnapshot?.stats ?? null) : stats
  const viewCtxTokens = pageSessionIsOther ? (pageSnapshot?.ctxTokens ?? null) : ctxTokens
  const viewModelWindow = pageSessionIsOther ? (pageSnapshot?.modelWindow ?? null) : modelWindow
  const viewCtxBreakdown = pageSessionIsOther ? (pageSnapshot?.contextBreakdown ?? null) : ctxBreakdown

  // 统一测试启动器：底部悬浮进度条文案
  const mcTestPhase = mcTestStatus?.phase ?? 'idle'
  const mcTestSelected = mcTestStatus?.selected.length ?? 0
  const mcTestLabel = mcTestPhase === 'installing'
    ? '正在准备 Forge 测试客户端…'
    : mcTestPhase === 'starting'
      ? `正在启动测试客户端（${mcTestSelected} 个 jar）…`
      : mcTestPhase === 'running'
        ? `测试客户端已启动（${mcTestSelected} 个 jar）`
        : mcTestPhase === 'error' ? '测试客户端启动失败' : ''
  const mcTestLogLine = mcTestStatus ? (mcTestStatus.logTail.split(/\r?\n/).filter(Boolean).pop() ?? '') : ''
  const mcTestLogText = mcTestPhase === 'error'
    ? (mcTestStatus?.error || mcTestLogLine || '未知错误')
    : (mcTestLogLine || (mcTestPhase === 'installing' ? '检查本地 MDK 缓存…' : '等待客户端输出…'))
  /** 当前功能开关下可用的右侧标签（关闭画布后 canvas 不出现） */
  const dockAvailable = useMemo(
    () => (featureOn('canvas') ? DOCK_TABS : DOCK_TABS.filter(t => t !== 'canvas')),
    [features, featureOn],
  )
  const dockVisibleTabs = useMemo(
    () => dockTabs.filter(t => dockAvailable.includes(t)),
    [dockTabs, dockAvailable],
  )

  return (
    <div
      className="frame"
      style={{ gridTemplateColumns: `var(--rail-w) minmax(0, 1fr) ${dockCollapsed ? 44 : dockWidth}px` }}
    >
      <LeftSidebar
        sessionId={rootSessionId || sessionId}
        version={sessionsVersion}
        onOpenSession={openSession}
        onNewSession={newSession}
        onOpenLibrary={() => { setLogsOpen(false); setAboutOpen(false); setLibraryOpen(true) }}
        onOpenLogs={() => { setLibraryOpen(false); setAboutOpen(false); setLogsOpen(true) }}
        onOpenAbout={() => { setLibraryOpen(false); setLogsOpen(false); setAboutOpen(true) }}
        libraryEnabled={featureOn('library')}
        onOpenSettings={() => { setLogsOpen(false); setAboutOpen(false); setSettingsOpen(true) }}
        onToast={showToast}
      />
      <MainPanel
        sessionId={sessionId}
        sessionInfo={sessionInfo}
        isSubagent={activeIsChild}
        subagents={subagents}
        onOpenSubagent={openSubagent}
        onStopSubagent={stopSubagent}
        onBackToRoot={backToRoot}
        turns={turns}
        busy={busy}
        waiting={waiting}
        streamChars={streamChars}
        elapsedSec={elapsedSec}
        thinkTail={thinkTail}
        models={models}
        currentModelId={currentModelId ?? ''}
        refineMode={refineMode}
        onToggleRefine={() => setRefineMode(r => !r)}
        stats={viewStats}
        ctxTokens={viewCtxTokens}
        modelWindow={viewModelWindow}
        ctxBreakdown={viewCtxBreakdown}
        profiles={profiles}
        agentProfile={agentProfile}
        onPickProfile={(id) => { setAgentProfile(id); localStorage.setItem('openmods.profile', id) }}
        iframeReady={iframeReady}
        pendingAtts={pendingAtts}
        onAddFiles={addPendingFiles}
        onRemoveAtt={(i) => setPendingAtts(prev => prev.filter((_, idx) => idx !== i))}
        onPickModel={pickModel}
        reasoningEffort={reasoningEffort}
        onPickReasoningEffort={v => {
          setReasoningEffort(v)
          localStorage.setItem('openmods.reasoningEffort', v)
        }}
        onSend={send}
        onStop={stop}
        contextHint={toast?.text ?? null}
        inlineSubagents={prefs?.inlineSubagents ?? true}
        enterToSend={prefs?.enterToSend ?? true}
        mock={!!health?.mock}
        planMode={planMode}
        permission={permission}
        pendingAsks={interactions.length}
        onTogglePlan={togglePlan}
        onTogglePermission={togglePermission}
        mcProjects={mcProjects}
        modOutput={prefs?.modOutput ?? ''}
        onMcRun={mcRun}
        onMcStop={mcStop}
        onMcExport={mcExport}
        onOpenSettings={() => setSettingsOpen(true)}
        sessionCwd={sessionInfo?.cwd ?? draftCwd}
        onPickCwd={pickSessionCwd}
      />
      <RightDock
        width={dockWidth}
        collapsed={dockCollapsed}
        onResizeStart={dockDrag.start}
        onToggle={() => {
          // 折叠后再展开：若标签全关了，顺手把第一个可用标签打开
          setDockCollapsed(c => {
            if (c && dockVisibleTabs.length === 0) openDockTab(dockAvailable[0] ?? 'images')
            return !c
          })
        }}
        tabs={dockVisibleTabs}
        availableTabs={dockAvailable}
        active={dockTab}
        onSelect={setDockTab}
        onClose={closeDockTab}
        onOpen={openDockTab}
        canvas={canvas}
        canvasOwner={activeCanvasOwnerName ? `独立画布 · ${activeCanvasOwnerName}` : undefined}
        iframeRef={iframeRef}
        onIframeReady={onIframeReady}
        busy={busy}
        suggestions={MODELING_SUGGESTIONS}
        onSuggestion={(t) => send(t, 'build')}
        onDownload={download}
        playingAnim={playingAnim}
        onPlayAnim={playAnim}
        activeAnimations={
          activeCanvasPageData?.kind === 'asset' && activeCanvasPageData.assetId
            ? (assetAnims[activeCanvasPageData.assetId] ?? [])
            : canvas.animations
        }
        canvasLoading={canvasLoading}
        canvasPages={canvasPages}
        activeCanvasPage={activeCanvasPage}
        canvasDirty={canvasDirty}
        canvases={canvases}
        activeSessionCanvasId={activeSessionCanvasId}
        onSwitchCanvasPage={switchCanvasPage}
        onCloseCanvasPage={closeCanvasPage}
        onNewBlankPage={newBlankPage}
        onPickCanvas={pickCanvas}
        onCreateCanvas={createCanvas}
        onActivateCanvas={activateCurrentCanvas}
        onReloadCanvas={() => reloadCanvasPage(activeCanvasPage)}
        onOpenLibrary={() => { setLogsOpen(false); setAboutOpen(false); setLibraryOpen(true) }}
        pendingAtts={pendingAtts}
        onAddFiles={addPendingFiles}
        onRemoveDockAtt={(i) => setPendingAtts(prev => prev.filter((_, idx) => idx !== i))}
        modelTagline={currentModel?.desc ?? '建模顶尖特效拉满'}
        subagents={subagents}
        activeSessionId={sessionId}
        onOpenSubagent={openSubagent}
        onStopSubagent={stopSubagent}
        stats={viewStats}
        sessionId={sessionId}
        statsSessionId={pageSessionId}
        contextHint={toast?.text ?? null}
        ctxTokens={viewCtxTokens}
        modelWindow={viewModelWindow}
        ctxBreakdown={viewCtxBreakdown}
        images={sessionImages}
        terminals={terminals}
        terminalOutput={terminalOutput}
        activeTerminalId={activeTerminalId}
        terminalShell={terminalShell}
        onSelectTerminal={selectTerminal}
        onKillTerminal={killTerminal}
        onCloseTerminal={closeTerminal}
        onCloseAllTerminals={closeAllTerminals}
        onOpenTerminal={openTerminal}
        onTerminalInput={terminalInput}
        planMode={planMode}
        todos={todos}
        permission={permission}
        allowedTools={allowedTools}
        onTogglePlan={togglePlan}
        onPermission={(p) => { if (p !== permission) void togglePermission() }}
        onResetAllowed={resetAllowed}
      />
      <LibraryDrawer
        open={libraryOpen}
        sessionId={sessionId}
        testStatus={mcTestStatus}
        onRefreshTestStatus={refreshMcTestStatus}
        onClose={() => setLibraryOpen(false)}
        onToast={showToast}
        onOpenInCanvas={openLibModel}
        canvasEnabled={featureOn('canvas')}
        onOpenSession={id => {
          // 素材库可能刚建了会话（引用新会话 / 接着改）：先关抽屉再切，随后刷新左栏
          setLibraryOpen(false)
          setSessionsVersion(v => v + 1)
          void openSession(id)
        }}
      />
      <LogDrawer
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        onToast={showToast}
        sessionId={sessionId}
        mcEnabled={featureOn('mc')}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} onToast={showToast} />
      {interactions[0] && (
        <AskDialog key={interactions[0].id} ask={interactions[0]} onSubmit={submitInteraction} />
      )}
      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => { toast.action!.run(); setToast(null) }}
            >{toast.action.label}</button>
          )}
        </div>
      )}
      {mcBoot && (
        <div className="toast mc-boot">
          <span className="mc-boot-label">{mcBoot.label}</span>
          <span className="mc-boot-bar" aria-hidden="true"><i /></span>
        </div>
      )}
      {mcTestStatus && mcTestPhase !== 'idle' && mcTestPhase !== 'exited' && (
        <div className={`toast mc-boot mc-test-boot ${mcTestPhase}`}>
          <div className="mc-test-row">
            <span className="mc-boot-label">{mcTestLabel}</span>
            <span className="mc-boot-bar" aria-hidden="true"><i /></span>
            <button className="mc-test-close" title="关闭提示" onClick={() => setMcTestStatus(null)}>✕</button>
          </div>
          <div className={`mc-test-log ${mcTestPhase === 'error' ? 'err' : ''}`}>{mcTestLogText}</div>
        </div>
      )}
      {achievement && (
        <div className="mc-achievement" role="status" aria-live="polite">
          <span className="mc-achievement-icon"><McIcon name="model" size={28} /></span>
          <span className="mc-achievement-text">
            <span className="mc-achievement-title">{achievement.title}</span>
            <span className="mc-achievement-sub">{achievement.sub}</span>
          </span>
        </div>
      )}
      <EnvSetupDialog
        open={envOpen}
        onClose={() => setEnvOpen(false)}
        onToast={showToast}
      />
      <SettingsWindow
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onToast={showToast}
        onModelsChanged={refreshModels}
        prefs={prefs}
        onPrefs={applyPrefs}
        wakeLog={wakeLog}
      />
    </div>
  )
}
