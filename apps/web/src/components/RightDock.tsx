import { useCallback, useRef, useState, type RefObject } from 'react'
import type { CanvasState, SessionImageDto, SessionSummaryDto, StatsDto, TerminalDto, TodoItemDto } from '../types.js'
import { CanvasPane } from './CanvasPane.js'
import { StatsTab } from './StatsTab.js'
import { FilesPane, ImagesPane, WebPane } from './DockPreview.js'
import { TerminalPane } from './TerminalPane.js'
import { PlanPane } from './PlanPane.js'

export type DockTabId = 'canvas' | 'subagents' | 'stats' | 'images' | 'files' | 'web' | 'terminal' | 'plan'

/** 可开的所有标签（顺序即 ＋ 菜单顺序） */
export const DOCK_TABS: DockTabId[] = ['canvas', 'images', 'files', 'web', 'terminal', 'plan', 'subagents', 'stats']

const TAB_META: Record<DockTabId, { label: string; icon: string }> = {
  canvas: { label: '建模', icon: '◧' },
  images: { label: '图片', icon: '▦' },
  files: { label: '文件', icon: '▣' },
  web: { label: '网页', icon: '◫' },
  terminal: { label: '终端', icon: '▻' },
  plan: { label: '计划', icon: '☰' },
  subagents: { label: '子代理', icon: '◉' },
  stats: { label: '上下文', icon: '▤' },
}

function statusLabel(status: string): string {
  return status === 'running' ? '运行中'
    : status === 'error' ? '出错'
      : status === 'stopped' ? '已中止'
        : status === 'idle' ? '未运行' : '已完成'
}

function statusDot(status: string): string {
  return status === 'running' ? 'ongoing' : status === 'error' ? 'err' : status === 'done' ? 'done' : 'idle'
}

// 右侧 dock —— 可开多个标签页（建模 / 子代理 / 看板），可切换、可关闭、可拖宽。
// 画布内容与原来一致；标签条是 dsh ui-sidebar-right 的 dock tab 形态。
export function RightDock(props: {
  width: number
  collapsed: boolean
  onResizeStart: (e: React.MouseEvent) => void
  onToggle: () => void
  tabs: DockTabId[]
  active: DockTabId | null
  onSelect: (tab: DockTabId) => void
  onClose: (tab: DockTabId) => void
  onOpen: (tab: DockTabId) => void
  canvas: CanvasState
  /** 当前画布所属会话（查看子代理时显示其名称） */
  canvasOwner?: string
  iframeRef: RefObject<HTMLIFrameElement>
  onIframeReady: () => void
  busy: boolean
  suggestions: string[]
  refineMode: boolean
  onRefineToggle: () => void
  onSuggestion: (text: string) => void
  onDownload: () => void
  playingAnim: string | null
  pendingAtts: { name: string; dataUrl: string }[]
  onAddFiles: (files: FileList | null) => void
  onRemoveDockAtt: (idx: number) => void
  modelTagline: string
  subagents: SessionSummaryDto[]
  activeSessionId: string
  onOpenSubagent: (id: string) => void
  onStopSubagent: (id: string) => void
  stats: StatsDto | null
  sessionId: string
  contextHint: string | null
  /** 当前占用 / 模型窗口（StatsTab 头部主卡用） */
  ctxTokens: number | null
  modelWindow: number | null
  ctxBreakdown: import('../types.js').ContextBreakdownDto | null
  /** 当前会话的参考图（「图片」标签与灯箱） */
  images: SessionImageDto[]
  /** 终端面板 */
  terminals: TerminalDto[]
  terminalOutput: Record<string, string>
  activeTerminalId: string | null
  terminalShell?: string
  onSelectTerminal: (id: string) => void
  onKillTerminal: (id: string) => void
  onOpenTerminal: (command: string) => void
  onTerminalInput: (id: string, text: string) => void
  /** 计划面板 */
  planMode: boolean
  todos: TodoItemDto[] | null
  permission: 'ask' | 'auto'
  allowedTools: string[]
  onTogglePlan: (active: boolean) => void
  onPermission: (policy: 'ask' | 'auto') => void
  onResetAllowed: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  if (props.collapsed) {
    return (
      <aside className="dock collapsed">
        <button className="dock-expand" onClick={props.onToggle} title="展开右侧拓展">◧ 拓展</button>
      </aside>
    )
  }

  const active = props.active && props.tabs.includes(props.active) ? props.active : (props.tabs[0] ?? null)
  const closedTabs = DOCK_TABS.filter(t => !props.tabs.includes(t))

  return (
    <aside className="dock" style={{ width: props.width }}>
      <div className="dock-drag-handle" onMouseDown={props.onResizeStart} title="拖拽调宽" />

      <div className="dock-head">
        <div className="dock-tabs" role="tablist">
          {props.tabs.map(t => (
            <div key={t} className={`dock-tab ${active === t ? 'active' : ''}`}>
              <button
                className="dock-tab-btn"
                role="tab"
                aria-selected={active === t}
                onClick={() => props.onSelect(t)}
                title={`切换到${TAB_META[t].label}`}
              >
                <span aria-hidden="true">{TAB_META[t].icon}</span>
                {TAB_META[t].label}
                {t === 'subagents' && props.subagents.length > 0 ? ` ${props.subagents.length}` : ''}
                {t === 'terminal' && props.terminals.length > 0 ? ` ${props.terminals.length}` : ''}
              </button>
              <button className="dock-tab-close" onClick={() => props.onClose(t)} title={`关闭${TAB_META[t].label}`}>✕</button>
            </div>
          ))}
          <button className="dock-add" onClick={() => setMenuOpen(o => !o)} title="打开标签页">＋</button>
        </div>
        <div className="dock-head-actions">
          {active === 'canvas' && props.canvasOwner && (
            <span className="dock-owner" title="子代理与主会话共用同一块画布">{props.canvasOwner}</span>
          )}
          {active === 'canvas' && (
            <button className="dock-act" onClick={props.onDownload} title="下载当前模型">下载</button>
          )}
          <button className="dock-act" onClick={props.onToggle} title="折叠右侧拓展">»</button>
        </div>
      </div>

      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="dock-menu">
            {closedTabs.length === 0 && <div className="menu-empty">所有标签页都已打开</div>}
            {closedTabs.map(t => (
              <button
                key={t}
                className="dock-menu-item"
                onClick={() => { props.onOpen(t); setMenuOpen(false) }}
              >
                <span aria-hidden="true">{TAB_META[t].icon}</span> {TAB_META[t].label}
              </button>
            ))}
            {props.tabs.length > 0 && (
              <>
                <div className="dock-menu-sep" />
                <button className="dock-menu-item" onClick={() => { props.tabs.forEach(t => props.onClose(t)); setMenuOpen(false) }}>
                  关闭全部标签
                </button>
              </>
            )}
          </div>
        </>
      )}

      <div className="dock-body">
        {!active && (
          <div className="dock-empty">
            <span>右侧拓展已全部关闭</span>
            <button onClick={() => props.onOpen('canvas')}>重新打开建模</button>
          </div>
        )}

        {active === 'canvas' && (
          <div className="dock-pane">
            <div className="dock-canvas">
              <CanvasPane canvas={props.canvas} iframeRef={props.iframeRef} onIframeReady={props.onIframeReady} />
            </div>
            {(props.canvas.animations?.length ?? 0) > 0 && (
              <div className="anim-strip">
                <span className="anim-label dim">动画</span>
                <div className="anim-chips">
                  {props.canvas.animations.map(a => (
                    <button
                      key={a.name}
                      className={`anim-chip ${props.playingAnim === a.name ? 'playing' : ''}`}
                      disabled={props.busy}
                      title={`${a.length}s · ${a.loop}${props.playingAnim === a.name ? '（点击停止）' : ''}`}
                      onClick={() => {
                        const w = props.iframeRef.current?.contentWindow
                        if (props.playingAnim === a.name) w?.postMessage({ type: 'stop_animation' }, '*')
                        else w?.postMessage({ type: 'play_animation', name: a.name }, '*')
                      }}
                    >
                      {props.playingAnim === a.name ? '▶ ' : ''}{a.name}
                    </button>
                  ))}
                  {props.playingAnim && (
                    <button className="anim-chip stop" onClick={() => props.iframeRef.current?.contentWindow?.postMessage({ type: 'stop_animation' }, '*')}>■ 停止</button>
                  )}
                </div>
              </div>
            )}
            <div className="dock-composer">
              {!props.canvas.hasModel && (
                <div className="suggestions">
                  {props.suggestions.map(s => (
                    <button key={s} className="suggestion" disabled={props.busy} onClick={() => props.onSuggestion(s)}>{s}</button>
                  ))}
                </div>
              )}
              <div className="quick-actions">
                <button
                  className={`mode ${props.refineMode ? 'active' : ''}`}
                  onClick={props.onRefineToggle}
                  title="开启后在中间输入框描述想法，AI 会先帮你打磨成建模描述"
                >
                  ✦ 帮我完善想法{props.refineMode ? '（已开启）' : ''}
                </button>
                <button className="icon-btn wide" title="附参考图（三视图），随下一条消息发送" onClick={() => fileRef.current?.click()}>三视图</button>
                <input
                  ref={fileRef} type="file" accept="image/*" multiple hidden
                  onChange={e => { props.onAddFiles(e.target.files); e.target.value = '' }}
                />
              </div>
              {props.pendingAtts.length > 0 && (
                <div className="attach-row" style={{ padding: 0 }}>
                  {props.pendingAtts.map((a, i) => (
                    <span key={i} className="attach-thumb" title={a.name}>
                      <img src={a.dataUrl} alt={a.name} />
                      <button className="attach-remove" onClick={() => props.onRemoveDockAtt(i)} title="移除">✕</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="input-foot dim">
                在中间输入框输入并回车发送{props.refineMode ? '；完善想法模式开启中' : ''}。{props.modelTagline}
              </div>
            </div>
          </div>
        )}

        {active === 'subagents' && (
          <div className="dock-subagents">
            {props.subagents.length === 0 && (
              <div className="ds-empty">
                还没有子代理。<br />
                让主代理派发建模任务后，这里会出现所有子代理与它们的最终汇报。
              </div>
            )}
            {props.subagents.map(s => (
              <div
                key={s.id}
                className={`ds-row ${s.id === props.activeSessionId ? 'active' : ''}`}
                onClick={() => props.onOpenSubagent(s.id)}
                title={`${s.agentName ?? s.id} · ${s.description ?? ''}`}
              >
                <span className={`state-dot ${statusDot(s.status)}`} />
                <span className="ds-main">
                  <span className="ds-title">
                    <span>{s.agentName ?? s.id}</span>
                    <span className="dim" style={{ fontSize: 11 }}>{statusLabel(s.status)}</span>
                  </span>
                  <span className="ds-sub">{s.lastError || s.description || s.lastText || '（无描述）'}</span>
                </span>
                <span className="ds-meta">{s.outputTokens ? `${(s.outputTokens / 1000).toFixed(1)}k tok` : s.id}</span>
                {s.status === 'running' && (
                  <button className="ds-stop" onClick={e => { e.stopPropagation(); props.onStopSubagent(s.id) }}>停止</button>
                )}
              </div>
            ))}
          </div>
        )}

        {active === 'stats' && (
          <StatsTab
            stats={props.stats}
            sessionId={props.sessionId}
            contextHint={props.contextHint}
            usedTokens={props.ctxTokens}
            contextWindow={props.modelWindow}
            breakdown={props.ctxBreakdown}
          />
        )}

        {active === 'terminal' && (
          <TerminalPane
            terminals={props.terminals}
            output={props.terminalOutput}
            activeId={props.activeTerminalId}
            shell={props.terminalShell}
            onSelect={props.onSelectTerminal}
            onKill={props.onKillTerminal}
            onOpen={props.onOpenTerminal}
            onInput={props.onTerminalInput}
          />
        )}

        {active === 'plan' && (
          <PlanPane
            planMode={props.planMode}
            busy={props.busy}
            todos={props.todos}
            permission={props.permission}
            allowedTools={props.allowedTools}
            onTogglePlan={props.onTogglePlan}
            onPermission={props.onPermission}
            onResetAllowed={props.onResetAllowed}
          />
        )}

        {active === 'images' && <ImagesPane images={props.images} />}

        {active === 'files' && <FilesPane />}

        {/* 网页标签保活：切到别的标签只隐藏，iframe 的页面与历史都留着（dsh keepMounted） */}
        {props.tabs.includes('web') && (
          <div className="dock-keep" style={{ display: active === 'web' ? 'flex' : 'none' }}>
            <WebPane />
          </div>
        )}
      </div>
    </aside>
  )
}

// 拖拽把手行为：mousedown 记录起点，mousemove 更新宽度（由 App 提供回调）
export function useDockDrag(onResize: (deltaX: number) => void, onEnd: () => void) {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const onMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return
    const dx = lastX.current - e.clientX
    lastX.current = e.clientX
    onResize(dx)
  }, [onResize])

  const onUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    onEnd()
  }, [onEnd, onMove])

  const start = useCallback((e: React.MouseEvent) => {
    dragging.current = true
    lastX.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [onMove, onUp])

  return { start }
}
