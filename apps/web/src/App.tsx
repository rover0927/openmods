import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SseFrame } from './api.js'
import type {
  AgentProfileDto, AnimationMetaDto, CanvasState, ContextBreakdownDto, McProjectUiDto, ModelInfoDto, PendingInteractionDto, PrefsDto, SessionInfoDto,
  SessionSummaryDto, StatsDto, SubagentNoticeDto, SubagentWaitDto, TerminalDto, TodoItemDto, TurnEntry, WakeEntry,
} from './types.js'
import { EMPTY_CONTEXT_STATS } from './types.js'
import { LeftSidebar } from './components/LeftSidebar.js'
import { LibraryDrawer } from './components/LibraryDrawer.js'
import { MainPanel } from './components/MainPanel.js'
import { DOCK_TABS, RightDock, useDockDrag, type DockTabId } from './components/RightDock.js'
import { SettingsWindow } from './components/SettingsWindow.js'
import { AskDialog, type InteractionReplyBody } from './components/AskDialog.js'


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
  /** 文档素材库抽屉 */
  const [libraryOpen, setLibraryOpen] = useState(false)
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
  // 画布多开：'session' = 会话画布（AI 工具的工作区），其余 = 从素材库打开的只读标签（互不覆盖）
  const [canvasTabs, setCanvasTabs] = useState<{ assetId: string; name: string }[]>([])
  const [activeCanvasTab, setActiveCanvasTab] = useState<'session' | string>('session')
  const [sessionCanvasDirty, setSessionCanvasDirty] = useState(false)
  const activeCanvasTabRef = useRef<'session' | string>('session')
  /** 素材标签的动画列表（assetId → animations）：打开/切换时从 bbmodel 记下，关闭时清理 */
  const [assetAnims, setAssetAnims] = useState<Record<string, AnimationMetaDto[]>>({})
  /** 当前画布是否正在加载（动画条据此禁用播放按钮，而不是因为会话 busy） */
  const [canvasLoading, setCanvasLoading] = useState(false)
  useEffect(() => { activeCanvasTabRef.current = activeCanvasTab }, [activeCanvasTab])
  /** 动画播放失败自动重载后要重试的动画名（bb_loaded 后消费） */
  const pendingAnimRef = useRef<string | null>(null)
  /** 发起播放时所在的画布标签：重载完成后只在同一标签上重试 */
  const pendingAnimTabRef = useRef<'session' | string>('session')
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
  // 画布
  const [canvas, setCanvas] = useState<CanvasState>(emptyCanvas)
  /** 最近改动画布的 agent（子代理共享画布时显示「共享画布 · staff-1」） */
  const [canvasOrigin, setCanvasOrigin] = useState<string | null>(null)
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
  /** MC 工程（mcdev）状态：dock 顶部的「测试 Mod」/ jar 下载按钮数据源 */
  const [mcProjects, setMcProjects] = useState<McProjectUiDto[]>([])
  /** 代理角色（dsh agentPreset）：lead=主代理、mcmod=1.20.1 Forge 模组开发 */
  const [agentProfile, setAgentProfile] = useState<string>(() => localStorage.getItem('openmods.profile') ?? 'lead')
  const [profiles, setProfiles] = useState<AgentProfileDto[]>([])
  const [iframeReady, setIframeReady] = useState(false)
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null)
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
  const canvasSessionRef = useRef('')
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
    setToast({ text: msg, action })
    setTimeout(() => setToast(null), action ? 8000 : 5000)
  }, [])

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


  // 代理角色目录（lead / mcmod）：一次拉取，选择存 localStorage，切换会话时按服务端回显恢复
  useEffect(() => {
    api.profiles().then(r => setProfiles(r.profiles)).catch(() => {})
  }, [])

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
    // 主题切换：styles.css 的 [data-theme='light'] 分支整体换 token（画布/终端保持深色）
    document.documentElement.dataset.theme = p.theme
  }, [])

  useEffect(() => {
    api.settings().then(({ settings }) => {
      if (settings.prefs) applyPrefs(settings.prefs)
    }).catch(() => { /* 服务未起时用默认值 */ })
  }, [applyPrefs])

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
      case 'model_update':
        setCanvas({
          hasModel: (f.elements ?? 0) > 0,
          modelName: f.bbmodel?.name ?? '',
          elements: f.elements ?? 0,
          textures: f.textures ?? 0,
          view: f.view ?? '3d',
          animations: f.animations ?? [],
        })
        // 子代理共享画布：标明这次改动来自哪个 agent（主会话画布也能看到）
        setCanvasOrigin(f.agentName ?? null)
        lastModelRef.current = f.bbmodel
        // 用户正看着素材标签时不打扰 iframe：会话画布标脏，切回去再重载（素材视图不被覆盖）
        if (activeCanvasTabRef.current !== 'session') {
          setSessionCanvasDirty(true)
        } else {
          sendToBridge({ type: 'load_bbmodel', model: f.bbmodel })
        }
        // AI 改了画布：自己把右侧拓展唤醒（设置 → 自动化可关）
        wakeRef.current(f.agentName ? `${f.agentName} 更新了画布` : '画布已更新')
        break
      case 'view_update':
        setCanvas(c => ({ ...c, view: f.view }))
        if (activeCanvasTabRef.current === 'session') sendToBridge({ type: 'set_view', view: f.view })
        break
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
        // 已退出的终端不再占标签：直接从列表移除，避免越积越多
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
  }, [sendToBridge, updateLastTurn, showToast, refreshModels, refreshSubagents, rootSessionId])

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
      // 已退出的终端不再占标签（列表刷新时也不堆积）
      const live = r.terminals.filter(t => t.status !== 'exited')
      setTerminals(live)
      setTerminalShell(r.shell)
      setActiveTerminalId(prev => (live.some(t => t.id === prev)
        ? prev
        : (live[live.length - 1]?.id ?? null)))
      const recent = live.slice(-4)
      const outs = await Promise.all(recent.map(async t => {
        const o = await api.terminalOutput(id, t.id, 20_000).catch(() => null)
        return [t.id, o?.output ?? ''] as const
      }))
      setTerminalOutput(Object.fromEntries(outs))
    } catch { /* 服务未起：保持空列表 */ }
  }, [])

  const loadCanvas = useCallback((id: string, opts?: { force?: boolean }) => {
    // 子代理与主会话共享同一块画布：切换会话时不必清空重载，避免画布闪空
    if (!opts?.force && canvasSessionRef.current === id && lastModelRef.current) return
    canvasSessionRef.current = id
    setCanvasOrigin(null)
    setCanvas(emptyCanvas())
    setPlayingAnim(null)
    pendingAnimRef.current = null
    lastModelRef.current = null
    setCanvasLoading(true)
    sendToBridge({ type: 'load_bbmodel', model: null })
    api.bbmodel(id).then(model => {
      if (canvasSessionRef.current !== id) return
      lastModelRef.current = model
      setCanvas({
        hasModel: (model.elements?.length ?? 0) > 0,
        modelName: model.name ?? '',
        elements: model.elements?.length ?? 0,
        textures: model.textures?.length ?? 0,
        view: model.view ?? '3d',
        animations: toAnims(model),
      })
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model })
    }).catch(() => { setCanvasLoading(false) /* 该会话还没有模型 */ })
  }, [sendToBridge])

  /** 动画播放/停止（chips 统一入口）：记下意图，模型失同步时 bb_animation_error 能自动重载重试 */
  const playAnim = useCallback((name: string | null) => {
    pendingAnimRef.current = name
    pendingAnimTabRef.current = activeCanvasTabRef.current
    animNameRef.current = name
    animRetryRef.current = 0
    iframeRef.current?.contentWindow?.postMessage(name ? { type: 'play_animation', name } : { type: 'stop_animation' }, '*')
  }, [])

  // ---- 画布多开：素材库模型开新标签，绝不覆盖会话画布 ----
  const openLibModel = useCallback((asset: { id: string; name: string }) => {
    setCanvasTabs(tabs => (tabs.some(t => t.assetId === asset.id) ? tabs : [...tabs, { assetId: asset.id, name: asset.name }]))
    setActiveCanvasTab(asset.id)
    setSessionCanvasDirty(dirty => (activeCanvasTabRef.current === 'session' ? dirty : true))
    activeCanvasTabRef.current = asset.id
    setPlayingAnim(null)
    pendingAnimRef.current = null
    setCanvasLoading(true)
    api.libraryModel(asset.id).then(model => {
      if (activeCanvasTabRef.current !== asset.id) return
      lastModelRef.current = null // 素材标签不影响会话画布的重载缓存
      setAssetAnims(prev => ({ ...prev, [asset.id]: toAnims(model) }))
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model })
    }).catch(e => { setCanvasLoading(false); showToast(`打开素材失败：${e.message}`) })
  }, [sendToBridge, showToast])

  const switchCanvasTab = useCallback((tab: 'session' | string) => {
    if (tab === activeCanvasTabRef.current) return
    setActiveCanvasTab(tab)
    activeCanvasTabRef.current = tab
    setPlayingAnim(null)
    pendingAnimRef.current = null
    if (tab === 'session') {
      // 回到会话画布：吃掉期间的 AI 改动（素材标签期间 model_update 只标脏不加载）
      setSessionCanvasDirty(false)
      if (sessionId) loadCanvas(sessionId, { force: true })
    } else {
      const t = canvasTabs.find(x => x.assetId === tab)
      if (t) {
        setCanvasLoading(true)
        api.libraryModel(tab).then(model => {
          if (activeCanvasTabRef.current !== tab) return
          setAssetAnims(prev => ({ ...prev, [tab]: toAnims(model) }))
          setCanvasLoading(false)
          sendToBridge({ type: 'load_bbmodel', model })
        }).catch(() => setCanvasLoading(false))
      }
    }
  }, [canvasTabs, loadCanvas, sendToBridge, sessionId])

  const closeCanvasTab = useCallback((assetId: string) => {
    setCanvasTabs(tabs => {
      const next = tabs.filter(t => t.assetId !== assetId)
      if (activeCanvasTabRef.current === assetId) {
        activeCanvasTabRef.current = 'session'
        setActiveCanvasTab('session')
        setSessionCanvasDirty(false)
        setPlayingAnim(null)
        pendingAnimRef.current = null
        if (sessionId) loadCanvas(sessionId, { force: true })
      }
      return next
    })
    // 关掉的素材标签不再保留动画列表
    setAssetAnims(prev => {
      if (!(assetId in prev)) return prev
      const next = { ...prev }
      delete next[assetId]
      return next
    })
  }, [loadCanvas, sessionId])

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
      if (res.profile) setAgentProfile(res.profile)
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
      // 画布归属由服务端给出（子代理 → 主会话的画布）
      // 新会话重置素材标签（auto 素材都在库里，不会丢）
      setCanvasTabs([])
      setAssetAnims({})
      setActiveCanvasTab('session')
      activeCanvasTabRef.current = 'session'
      setSessionCanvasDirty(false)
      loadCanvas(res.canvasId ?? id)
      // MC 工程状态（dock 顶部「测试 Mod」按钮）：有会话就拉，服务端扫 cwd 下的工程
      setMcProjects([])
      api.mcState(id).then(r => setMcProjects(r.projects ?? [])).catch(() => {})
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
  }, [loadCanvas, loadTerminals, refreshSubagents, showToast])

  // MC 工程：标题栏的「▶ 测试 Mod」= 后台 gradlew runClient（Minecraft 客户端窗口直接弹出来）
  const mcRun = useCallback((project: string) => {
    if (!sessionId) return
    api.mcRun(sessionId, project).then(r => {
      showToast(`已启动 runClient（pid ${r.pid}）：客户端窗口弹出后即可测试 mod；控制台日志在工程的 run-console.log`)
    }).catch(e => showToast(`启动失败：${e.message}`))
  }, [sessionId, showToast])

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

  /** 动画失同步时重载"当前正在看的画布"（会话画布或素材标签） */
  const reloadActiveCanvas = useCallback((tab: 'session' | string) => {
    if (tab === 'session') {
      if (sessionId) loadCanvas(sessionId, { force: true })
      return
    }
    setCanvasLoading(true)
    api.libraryModel(tab).then(model => {
      if (activeCanvasTabRef.current !== tab) return
      setAssetAnims(prev => ({ ...prev, [tab]: toAnims(model) }))
      setCanvasLoading(false)
      sendToBridge({ type: 'load_bbmodel', model })
    }).catch(() => setCanvasLoading(false))
  }, [sessionId, loadCanvas, sendToBridge])

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
          if (activeCanvasTabRef.current === tab) {
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
        canvasSessionRef.current = ''
        setSessionId(sid)
        setRootSessionId(sid)
        setSessionInfo(null)
        setStreamSince(0)
        localStorage.setItem('openmods.sid', sid)
        setSessionsVersion(v => v + 1)
        // 草稿里改过计划模式：会话刚建好，把当前状态同步到服务端（真实模式默认本就是开启）
        await api.setPlanMode(sid, planMode).catch(() => {})
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
        attachments: allAtts.length ? allAtts : undefined,
        profile: agentProfile,
      })
    } catch (e: any) {
      updateLastTurn(t => ({ ...t, error: e.message }))
      setBusy(false)
    }
  }, [sessionId, currentModelId, updateLastTurn, showToast, pendingAtts, waiting.length, agentProfile, planMode])

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

  /** 关闭单个终端：运行中先调 kill API，再从标签里移除 */
  const closeTerminal = useCallback(async (id: string) => {
    const t = terminals.find(x => x.id === id)
    if (t?.status === 'running') {
      try { await api.killTerminal(sessionId, id) } catch (e: any) { showToast(e.message); return }
    }
    setTerminals(prev => prev.filter(x => x.id !== id))
    setTerminalOutput(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setActiveTerminalId(cur => (cur === id ? null : cur))
  }, [sessionId, terminals, showToast])

  /** 全部清空：运行中的先 kill，然后清空列表与输出 */
  const closeAllTerminals = useCallback(async () => {
    if (sessionId) {
      await Promise.all(terminals
        .filter(t => t.status === 'running')
        .map(t => api.killTerminal(sessionId, t.id).catch(() => {})))
    }
    setTerminals([])
    setTerminalOutput({})
    setActiveTerminalId(null)
  }, [sessionId, terminals])

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
    canvasSessionRef.current = ''
    localStorage.removeItem('openmods.sid')
    setSessionId('')
    setRootSessionId('')
    setSessionInfo(null)
    setStreamSince(0)
    setTurns([])
    setStats(null)
    setCanvas(emptyCanvas())
    setCanvasOrigin(null)
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
  const activeIsChild = !!sessionInfo?.parentId

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
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
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
        stats={stats}
        ctxTokens={ctxTokens}
        modelWindow={modelWindow}
        ctxBreakdown={ctxBreakdown}
        profiles={profiles}
        agentProfile={agentProfile}
        onPickProfile={(id) => { setAgentProfile(id); localStorage.setItem('openmods.profile', id) }}
        iframeReady={iframeReady}
        pendingAtts={pendingAtts}
        onAddFiles={addPendingFiles}
        onRemoveAtt={(i) => setPendingAtts(prev => prev.filter((_, idx) => idx !== i))}
        onPickModel={pickModel}
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
          // 折叠后再展开：若标签全关了，顺手把建模打开
          setDockCollapsed(c => {
            if (c && dockTabs.length === 0) openDockTab('canvas')
            return !c
          })
        }}
        tabs={dockTabs}
        active={dockTab}
        onSelect={setDockTab}
        onClose={closeDockTab}
        onOpen={openDockTab}
        canvas={canvas}
        canvasOwner={
          activeIsChild || canvasOrigin
            ? `共享画布${canvasOrigin ? ` · ${canvasOrigin}` : ''}`
            : undefined
        }
        iframeRef={iframeRef}
        onIframeReady={onIframeReady}
        busy={busy}
        suggestions={MODELING_SUGGESTIONS}
        onSuggestion={(t) => send(t, 'build')}
        onDownload={download}
        playingAnim={playingAnim}
        onPlayAnim={playAnim}
        activeAnimations={activeCanvasTab === 'session' ? canvas.animations : (assetAnims[activeCanvasTab] ?? [])}
        canvasLoading={canvasLoading}
        canvasTabs={canvasTabs}
        activeCanvasTab={activeCanvasTab}
        sessionCanvasDirty={sessionCanvasDirty}
        onSwitchCanvasTab={switchCanvasTab}
        onCloseCanvasTab={closeCanvasTab}
        onOpenLibrary={() => setLibraryOpen(true)}
        pendingAtts={pendingAtts}
        onAddFiles={addPendingFiles}
        onRemoveDockAtt={(i) => setPendingAtts(prev => prev.filter((_, idx) => idx !== i))}
        modelTagline={currentModel?.desc ?? '建模顶尖特效拉满'}
        subagents={subagents}
        activeSessionId={sessionId}
        onOpenSubagent={openSubagent}
        onStopSubagent={stopSubagent}
        stats={stats}
        sessionId={sessionId}
        contextHint={toast?.text ?? null}
        ctxTokens={ctxTokens}
        modelWindow={modelWindow}
        ctxBreakdown={ctxBreakdown}
        images={sessionImages}
        terminals={terminals}
        terminalOutput={terminalOutput}
        activeTerminalId={activeTerminalId}
        terminalShell={terminalShell}
        onSelectTerminal={setActiveTerminalId}
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
        onClose={() => setLibraryOpen(false)}
        onToast={showToast}
        onOpenInCanvas={openLibModel}
        onOpenSession={id => {
          // 素材库可能刚建了会话（引用新会话 / 接着改）：先关抽屉再切，随后刷新左栏
          setLibraryOpen(false)
          setSessionsVersion(v => v + 1)
          void openSession(id)
        }}
      />
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
