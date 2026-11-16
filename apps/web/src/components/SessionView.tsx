import { useRef, useState } from 'react'
import type {
  AgentProfileDto, ContextBreakdownDto, ModelInfoDto, SessionSummaryDto, StatsDto, SubagentWaitDto, TurnEntry,
} from '../types.js'
import { stepLabel } from '../types.js'
import { Lightbox } from './Lightbox.js'
import { MessageText } from '../markdown.js'
import { ModelPicker } from './ModelPicker.js'
import { SubagentActivity } from './SubagentActivity.js'
import { ContextMeter } from './ContextMeter.js'

// composer dock 状态条 —— 复刻 dsh InputBar 的 dock：ActivityPill / UsagePill / StatusPill / ContextMeter
function fmtTok(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}k` : String(n)
}

function ComposerDock(props: {
  stats: StatsDto | null
  ctxTokens: number | null
  modelWindow: number | null
  ctxBreakdown: ContextBreakdownDto | null
  iframeReady: boolean
  busy: boolean
  waiting: number
  mock?: boolean
}) {
  const { stats, ctxTokens, modelWindow, ctxBreakdown, iframeReady, busy, waiting, mock } = props
  const t = stats?.totals
  const tps = t && t.modelMs > 0 ? Math.round((t.outputTokens / t.modelMs) * 1000) : null
  const status = waiting > 0
    ? `等待 ${waiting} 个子代理…`
    : busy ? '建模中…' : !iframeReady ? '画布启动中' : '画布就绪'

  return (
    <div className="composer-dock">
      {t && (t.turns > 0 || tps) && (
        <span className="pill"><span className="pill-icon">◎</span> {t.turns} 轮 {t.steps} 步{tps ? ` · ${tps} tok/s` : ''}</span>
      )}
      {t && t.contextTokens > 0 && (
        <span className="pill"><span className="pill-icon">◔</span> {fmtTok(t.contextTokens)} tok{t.cacheHit ? ` · 缓存 ${Math.round(t.cacheHit * 100)}%` : ''}</span>
      )}
      <span className="pill">
        <span className={`state-dot ${waiting > 0 ? 'ongoing' : busy ? 'ongoing' : iframeReady ? 'done' : 'idle'}`} /> {status}
      </span>
      <ContextMeter usedTokens={ctxTokens} contextWindow={modelWindow} breakdown={ctxBreakdown} />
      {mock && <span className="pill mock-pill" title="MOCK 离线模式：模型响应是脚本化的">MOCK 离线演示</span>}
    </div>
  )
}

// 中央主区的「对话」视图 —— 消息流 + composer + dock 状态条（建模元素在右侧拓展）
/** 目录名：欢迎区只显示最后一段，完整路径放 title */
function baseName(p: string): string {
  const s = String(p ?? '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

export function SessionView(props: {
  turns: TurnEntry[]
  busy: boolean
  /** 等待中的子代理：非空 = 会话没结束但输入锁定（结算后自动汇总） */
  waiting: SubagentWaitDto[]
  streamChars: number
  elapsedSec: number
  /** 思考流末尾片段（运行横幅里滚动显示） */
  thinkTail: string
  models: ModelInfoDto[]
  currentModelId: string
  refineMode: boolean
  stats: StatsDto | null
  ctxTokens: number | null
  modelWindow: number | null
  /** 上下文三段构成（点击环展开的图） */
  ctxBreakdown: ContextBreakdownDto | null
  /** 代理角色目录（lead / mcmod）+ 当前选择 */
  profiles: AgentProfileDto[]
  agentProfile: string
  onPickProfile: (id: string) => void
  iframeReady: boolean
  pendingAtts: { name: string; dataUrl: string }[]
  onAddFiles: (files: FileList | null) => void
  onRemoveAtt: (idx: number) => void
  onPickModel: (id: string) => void
  onSend: (text: string, mode: 'build' | 'refine', attachments?: any[]) => void
  onStop: () => void
  onOpenSubagent: (id: string) => void
  onStopSubagent: (id: string) => void
  isSubagent: boolean
  subagentName?: string
  subagents: SessionSummaryDto[]
  /** 在对话里显示运行中的子代理（设置 → 子代理） */
  inlineSubagents: boolean
  /** Enter 发送 / ⌘Enter 发送（设置 → 通用） */
  enterToSend: boolean
  /** MOCK 离线模式标记（并进 dock 状态行） */
  mock?: boolean
  /** 计划模式：只读出方案（写操作被运行时拦截） */
  planMode: boolean
  /** 授权策略：ask=写/命令工具弹窗；auto=自动放行 */
  permission: 'ask' | 'auto'
  /** 还没回答的提问/授权数量（>0 时输入框锁住，等弹窗处理） */
  pendingAsks: number
  onTogglePlan: () => void
  onTogglePermission: () => void
  /** 切换「完善想法」模式（原画布下方按钮迁入输入区） */
  onToggleRefine: () => void
  /** 会话绑定的工作目录（root 会话欢迎区显示/更换） */
  sessionCwd?: string
  onPickCwd: () => void
}) {
  const {
    turns, busy, waiting, streamChars, elapsedSec, thinkTail, models, currentModelId, refineMode, pendingAtts,
    onAddFiles, onRemoveAtt, stats, ctxTokens, modelWindow, ctxBreakdown, profiles, agentProfile, onPickProfile,
    iframeReady, onPickModel, onSend, onStop,
    onOpenSubagent, onStopSubagent, isSubagent, subagentName, subagents, inlineSubagents, enterToSend,
    planMode, permission, pendingAsks, onTogglePlan, onTogglePermission, onToggleRefine,
    sessionCwd, onPickCwd,
  } = props
  const empty = turns.length === 0
  const currentModel = models.find(m => m.id === currentModelId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [text, setText] = useState('')
  const [slashIdx, setSlashIdx] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  /** 等待子代理时锁输入：会话还在跑这一轮，用户不能插话（服务端同样 409） */
  const waitingLocked = waiting.length > 0

  const askLocked = pendingAsks > 0
  /** 「/」命令：原输入区并排的「完善想法」「三视图」两个按钮收进斜杠菜单 */
  const slashCommands = [
    {
      id: 'refine', name: '完善想法', keys: ['refine', 'wanshan'], on: refineMode,
      hint: '描述想法，AI 先打磨成建模描述再上画布',
      run: onToggleRefine,
    },
    {
      id: 'views', name: '三视图', keys: ['views', 'image', 'sanshitu'], on: false,
      hint: '附参考图（三视图等），随下一条消息发给 AI',
      run: () => fileRef.current?.click(),
    },
  ]
  const slashQuery = text.startsWith('/') ? text.slice(1) : null
  const slashItems = slashQuery === null || /\s/.test(slashQuery)
    ? []
    : slashCommands.filter(c =>
        !slashQuery
        || c.name.includes(slashQuery)
        || c.keys.some(k => k.includes(slashQuery.toLowerCase())))
  const slashOpen = slashItems.length > 0
  const slashActive = Math.min(slashIdx, Math.max(slashItems.length - 1, 0))
  const runSlash = (cmd: typeof slashCommands[number]) => {
    setText('')
    setSlashIdx(0)
    cmd.run()
  }
  const submit = () => {
    const t = text.trim()
    if (!t || busy || waitingLocked || askLocked) return
    onSend(t, refineMode ? 'refine' : 'build')
    setText('')
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(new File([f], f.name || `粘贴图片${Date.now()}.png`, { type: f.type }))
      }
    }
    if (files.length) {
      e.preventDefault()
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      onAddFiles(dt.files)
    }
  }

  return (
    <div className="chat-tab">
      <div className="chat-scroll">
        <div className="chat-column">
          {busy && (
            <div className="run-banner">
              <div className="run-banner-head">
                <span className="streaming-dot">●</span>
                <span>AI 正在思考 · 已想 {streamChars.toLocaleString()} 字</span>
                <span className="dim">已进行 {elapsedSec} 秒</span>
              </div>
              {/* 推理模型的思考流：显示末尾一段，让人看得出它真的在想什么 */}
              {thinkTail && <div className="run-think">{thinkTail}</div>}
            </div>
          )}
          {/* 等待态：会话没有结束（这一轮还挂着子代理），但输入被锁住 */}
          {waitingLocked && !busy && (
            <div className="run-banner waiting">
              <span className="waiting-dot">◔</span>
              <span>等待 {waiting.length} 个子代理完成</span>
              <span className="dim">{waiting.map(w => w.name).join('、')} · 全部结算后自动汇总验收</span>
            </div>
          )}
          {empty && (
            <div className="welcome">
              <span className="chip">{isSubagent ? `子代理 · ${subagentName ?? ''}` : '准备好了'}</span>
              <h2>{isSubagent ? '子代理的对话' : '开始建模'}</h2>
              <p className="dim">
                {isSubagent
                  ? '这个子代理属于当前会话：它和主代理、其它子代理在同一块画布上工作，右侧画布随改动实时更新。这里是它的对话记录，可以继续给它派活，或回到主会话查看整体。'
                  : '描述你想要的模型，AI 会派子代理在当前会话里并行完成，改动实时出现在右侧画布上。'}
              </p>
              {!isSubagent && (
                <button
                  className="welcome-cwd"
                  title={sessionCwd ? `工作目录：${sessionCwd}\n点击更换` : '选择一个本地文件夹作为会话的工作目录'}
                  onClick={onPickCwd}
                >
                  <span className="welcome-cwd-icon" aria-hidden="true">▣</span>
                  <span className="welcome-cwd-name">{sessionCwd ? baseName(sessionCwd) : '绑定工作目录'}</span>
                  <span className="welcome-cwd-action">{sessionCwd ? '更换' : '选择'}</span>
                </button>
              )}
            </div>
          )}
          {turns.map((t, i) => (
            t.notice
              ? <SubagentNoticeRow key={`${t.turnId}-${i}`} notice={t.notice} onOpen={() => onOpenSubagent(t.notice!.childId)} />
              : <TurnCard key={`${t.turnId}-${i}`} turn={t} onOpenSubagent={onOpenSubagent} />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        {askLocked && (
          <div className="run-banner ask">
            <span className="waiting-dot">?</span>
            <span>等你回答 {pendingAsks} 个问题/授权请求</span>
            <span className="dim">在弹窗里处理完，这一轮会自动继续</span>
          </div>
        )}
        {planMode && (
          <div className="run-banner plan">
            <span className="plan-badge-icon" aria-hidden="true">☰</span>
            <span>计划模式：只读出方案</span>
            <span className="dim">改文件/画布/命令会被拦截；AI 用 exit_plan_mode 提交方案，你批准后自动退出</span>
          </div>
        )}
        {inlineSubagents && (
          <SubagentActivity
            subagents={subagents}
            waiting={waiting}
            activeId={props.currentModelId}
            onOpen={onOpenSubagent}
            onStop={onStopSubagent}
          />
        )}
        <div className="input-card">
          {refineMode && <div className="refine-hint">✦ 完善想法模式：描述你的想法，AI 会先打磨成建模描述再上画布</div>}
          {pendingAtts.length > 0 && (
            <div className="attach-row">
              {pendingAtts.map((a, i) => (
                <span key={i} className="attach-thumb" title={a.name}>
                  <img src={a.dataUrl} alt={a.name} />
                  <button className="attach-remove" onClick={() => onRemoveAtt(i)} title="移除">✕</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            className={`input-text ${waitingLocked ? 'locked' : ''}`}
            readOnly={waitingLocked}
            rows={1}
            placeholder={waitingLocked
              ? `等待 ${waiting.length} 个子代理完成中…（结算后会自动汇总，不能插话）`
              : isSubagent
                ? '给这个子代理继续下达指令（画布与主会话共用）'
                : refineMode ? '描述你的想法，AI 帮你完善…' : '输入消息，可粘贴图片 · 输入 / 调用命令'}
            value={text}
            onChange={e => { setText(e.target.value); setSlashIdx(0) }}
            onPaste={onPaste}
            onKeyDown={e => {
              // 「/」命令菜单优先：↑↓ 选择，Enter/Tab 执行，Esc 取消（不发送消息）
              if (slashOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashIdx(i => (i + 1) % slashItems.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIdx(i => (i - 1 + slashItems.length) % slashItems.length)
                  return
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault()
                  runSlash(slashItems[slashActive])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setText('')
                  setSlashIdx(0)
                  return
                }
              }
              const withMod = e.metaKey || e.ctrlKey
              const shouldSend = enterToSend
                ? e.key === 'Enter' && !e.shiftKey && !withMod
                : e.key === 'Enter' && withMod
              if (shouldSend) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {slashOpen && (
            <div className="slash-menu" role="listbox">
              <div className="slash-menu-title">命令 · ↑↓ 选择 · Enter 执行 · Esc 取消</div>
              {slashItems.map((c, i) => (
                <button
                  key={c.id}
                  className={`slash-item ${i === slashActive ? 'on' : ''}`}
                  onMouseEnter={() => setSlashIdx(i)}
                  onClick={() => runSlash(c)}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-hint">{c.hint}</span>
                  {c.on && <span className="slash-state">已开启</span>}
                </button>
              ))}
            </div>
          )}
          <div className="input-row">
            <button className="icon-btn" title="附图（支持 Ctrl+V 粘贴）" onClick={() => fileRef.current?.click()}>＋</button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { onAddFiles(e.target.files); e.target.value = '' }} />
            <button
              className={`model-chip coop-chip ${planMode ? 'on' : ''}`}
              onClick={onTogglePlan}
              title={planMode ? '退出计划模式（恢复正常读写）' : '进入计划模式：AI 先出方案，你批准后再执行'}
            >
              ☰ {planMode ? '计划·只读' : '计划'}
            </button>
            <button
              className={`model-chip coop-chip ${permission === 'auto' ? 'auto' : ''}`}
              onClick={onTogglePermission}
              title={permission === 'auto'
                ? '当前自动放行写文件/命令/终端；点击改为每次询问'
                : '当前写文件/命令/终端会弹窗询问；点击改为本会话自动放行'}
            >
              {permission === 'auto' ? '授权·自动' : '授权·询问'}
            </button>
            <select
              className="model-chip agent-chip"
              value={agentProfile}
              onChange={e => onPickProfile(e.target.value)}
              title="代理角色：主代理负责建模委派，MC 模组负责 1.20.1 Forge 开发"
            >
              {(profiles.length ? profiles : [{ id: 'lead', name: '主代理（lead）' }]).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              className="model-chip"
              onClick={() => setPickerOpen(true)}
              title={currentModel ? `${currentModel.displayName}（${currentModel.providerRoute ?? 'builtin'}）` : '选择模型'}
            >
              {currentModel?.displayName ?? '选择模型'} <span className="dim">▾</span>
            </button>
            {waitingLocked
              ? <button className="btn stop" onClick={onStop} title="取消等待：中止这些子代理并解锁输入">取消等待</button>
              : busy
                ? <button className="btn stop" onClick={onStop}>停止</button>
                : <button className="send-btn" onClick={submit} disabled={!text.trim() && pendingAtts.length === 0} title={enterToSend ? '发送（Enter）' : '发送（⌘/Ctrl+Enter）'}>↑</button>}
          </div>
        </div>
      </div>

      <ComposerDock
        stats={stats}
        ctxTokens={ctxTokens}
        modelWindow={modelWindow}
        ctxBreakdown={ctxBreakdown}
        iframeReady={iframeReady}
        busy={busy}
        waiting={waiting.length}
        mock={props.mock}
      />
      {pickerOpen && (
        <ModelPicker models={models} currentModelId={currentModelId} onPick={(id) => { onPickModel(id); setPickerOpen(false) }} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}

function noticeLabel(status: string): string {
  return status === 'done' ? '已完成'
    : status === 'error' ? '出错'
      : status === 'stopped' ? '已中止' : '运行中'
}

function noticeDot(status: string): string {
  return status === 'done' ? 'done' : status === 'error' ? 'err' : status === 'running' ? 'ongoing' : 'idle'
}

/** 子代理完成通知：紧凑系统行（不是聊天气泡），点击打开子代理会话 */
export function SubagentNoticeRow({ notice, onOpen }: { notice: NonNullable<TurnEntry['notice']>; onOpen: () => void }) {
  return (
    <div className={`subagent-notice ${notice.status}`}>
      <span className={`state-dot ${noticeDot(notice.status)}`} />
      <span className="notice-main">
        <span className="notice-line">
          <b>{notice.name}</b> {noticeLabel(notice.status)}
          {notice.description ? ` · ${notice.description}` : ''}
        </span>
        {notice.summary && <span className="notice-summary">{notice.summary}</span>}
      </span>
      <button className="notice-open" onClick={onOpen} title="查看这个子代理的对话（画布共用一个）">对话</button>
    </div>
  )
}

export function TurnCard({ turn, onOpenSubagent }: { turn: TurnEntry; onOpenSubagent?: (id: string) => void }) {
  const [openSteps, setOpenSteps] = useState(true)
  // 思考块：默认跟随流式状态（跑的时候展开，结束后收起）
  const [openThink, setOpenThink] = useState<boolean | null>(null)
  const [lightboxAt, setLightboxAt] = useState<number | null>(null)
  const thinkOpen = openThink ?? (turn.streaming && !turn.assistantText)
  const think = turn.reasoning ?? ''
  const images = turn.images ?? []

  return (
    <div className="turn">
      {/* 自动汇总回合：开头是 runtime 投递的结算行（dsh form:'notice'），不是用户气泡 */}
      {turn.notices?.length ? (
        <div className="turn-notices">
          {turn.notices.map(n => (
            <SubagentNoticeRow key={n.childId} notice={n} onOpen={() => onOpenSubagent?.(n.childId)} />
          ))}
        </div>
      ) : turn.userText || images.length ? (
        <div className="msg user">
          <div className="msg-bubble user-bubble">
            {turn.userText && <div className="msg-text">{turn.userText}</div>}
            {/* 参考图：直接铺缩略图（原来只有一行"附带参考图 N 张"），点击开灯箱 */}
            {images.length > 0 ? (
              <div
                className={`msg-images ${images.length === 1 ? 'single' : ''}`}
                title={turn.imagesOmitted ? '本轮模型不接受图像输入，这些图没有发给模型' : undefined}
              >
                {images.map((img, i) => (
                  <button
                    key={`${img.id}-${i}`}
                    className="msg-img"
                    onClick={() => setLightboxAt(i)}
                    title={img.name ?? img.id}
                  >
                    <img src={img.src} alt={img.name ?? '参考图'} loading="lazy" />
                  </button>
                ))}
              </div>
            ) : turn.attachments > 0 ? (
              <div className="msg-attach">附带参考图 {turn.attachments} 张</div>
            ) : null}
            {images.length > 0 && turn.imagesOmitted && (
              <div className="msg-attach">本轮模型不接受图像输入，图片未发送</div>
            )}
          </div>
          <Lightbox images={images} at={lightboxAt} onAt={setLightboxAt} />
        </div>
      ) : null}

      {/* 思考过程：推理模型的 reasoning_content（以前整段被丢掉，界面上只剩"已想 0 字"） */}
      {think && (
        <div className="think">
          <button className="think-toggle" onClick={() => setOpenThink(o => !(o ?? (turn.streaming && !turn.assistantText)))}>
            <span className="think-caret">{thinkOpen ? '▾' : '▸'}</span>
            思考过程
            <span className="think-meta">{think.length.toLocaleString()} 字</span>
          </button>
          {thinkOpen && <div className="think-body">{think}</div>}
        </div>
      )}

      {(turn.steps.length > 0 || turn.error) && (
        <div className="process">
          <button className="process-toggle" onClick={() => setOpenSteps(o => !o)}>
            {openSteps ? '▾' : '▸'} 制作过程 · {turn.steps.length} 步
          </button>
          {openSteps && (
            <div className="process-steps">
              {turn.steps.map(s => (
                <div key={s.callId} className={`step ${s.done ? (s.isError ? 'err' : 'ok') : 'running'}`}>
                  {s.done ? (s.isError ? '✕' : '✓') : '◌'} {stepLabel(s.name)}
                </div>
              ))}
              {turn.error && <div className="step err">✕ {turn.error}</div>}
            </div>
          )}
        </div>
      )}
      {turn.assistantText && (
        <div className="msg assistant">
          <div className="msg-bubble assistant-bubble">
            {/* 助手正文按 Markdown 渲染（以前 **加粗** 会原样露出来） */}
            <MessageText text={turn.assistantText} />
          </div>
        </div>
      )}
    </div>
  )
}
