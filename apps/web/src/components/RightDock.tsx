import { useCallback, useRef, useState, type RefObject } from 'react'
import type {
  CanvasPageDto, CanvasRefDto, CanvasState, SessionImageDto, SessionSummaryDto, StatsDto, TerminalDto, TodoItemDto,
} from '../types.js'
import { CanvasPane } from './CanvasPane.js'
import { StatsTab } from './StatsTab.js'
import { FilesPane, ImagesPane, WebPane } from './DockPreview.js'
import { TerminalPane } from './TerminalPane.js'
import { PlanPane } from './PlanPane.js'
import { McIcon, type McIconName } from './McIcon.js'

export type DockTabId = 'canvas' | 'subagents' | 'stats' | 'images' | 'files' | 'web' | 'terminal' | 'plan'

/** 可开的所有标签（顺序即 ＋ 菜单顺序） */
export const DOCK_TABS: DockTabId[] = ['canvas', 'images', 'files', 'web', 'terminal', 'plan', 'subagents', 'stats']

const TAB_META: Record<DockTabId, { label: string; icon: McIconName }> = {
  canvas: { label: '建模', icon: 'canvas' },
  images: { label: '图片', icon: 'images' },
  files: { label: '文件', icon: 'files' },
  web: { label: '网页', icon: 'web' },
  terminal: { label: '终端', icon: 'terminal' },
  plan: { label: '计划', icon: 'plan' },
  subagents: { label: '子代理', icon: 'subagents' },
  stats: { label: '上下文', icon: 'stats' },
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
  /** 当前功能开关下可用的标签页（关闭画布后 canvas 不出现） */
  availableTabs?: DockTabId[]
  active: DockTabId | null
  onSelect: (tab: DockTabId) => void
  onClose: (tab: DockTabId) => void
  onOpen: (tab: DockTabId) => void
  canvas: CanvasState
  /** 当前页画布的归属（「独立画布 · 子代理名」） */
  canvasOwner?: string
  /** 建模页签：画布页（key=canvasId）/ 素材只读预览 / 空白页 */
  canvasPages: CanvasPageDto[]
  /** 当前选中的页签 key */
  activeCanvasPage: string
  /** 画布页 key → 有未查看的改动（素材页签不参与） */
  canvasDirty: Record<string, boolean>
  /** 会话树里的全部画布（页签名称/活跃徽标 + 空白页的选择列表） */
  canvases: CanvasRefDto[]
  /** 当前会话的活跃画布：下载按钮只对它可用 */
  activeSessionCanvasId: string
  onSwitchCanvasPage: (key: string) => void
  onCloseCanvasPage: (key: string) => void
  /** ＋：新建一个空白页（不建后端画布） */
  onNewBlankPage: () => void
  /** 空白页里点选一块画布：在原页打开并开始监听 */
  onPickCanvas: (canvasId: string) => void
  /** 空白页底部：调用接口新建一块空白画布 */
  onCreateCanvas: () => void
  /** 把当前页画布设为其 owner 会话的活跃画布 */
  onActivateCanvas: () => void
  /** 重新拉一次当前画布页的模型（没有缓存时用） */
  onReloadCanvas: () => void
  onOpenLibrary: () => void
  iframeRef: RefObject<HTMLIFrameElement>
  onIframeReady: () => void
  busy: boolean
  suggestions: string[]
  onSuggestion: (text: string) => void
  onDownload: () => void
  playingAnim: string | null
  /** 播放/停止动画（统一入口：App 记意图，失同步可自动重载重试） */
  onPlayAnim: (name: string | null) => void
  /** 当前画布标签的动画列表（会话画布 = canvas.animations，素材标签 = App 记录的列表） */
  activeAnimations: CanvasState['animations']
  /** 画布模型还在加载：只在这种情况下禁用动画按钮（不因会话 busy 整体禁用） */
  canvasLoading: boolean
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
  /** 统计数据对应的会话：当前画布页 owner（可能不是中间对话的 sessionId） */
  statsSessionId: string
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
  /** 关闭单个终端标签（运行中会先结束进程） */
  onCloseTerminal: (id: string) => void
  /** 全部清空终端标签（运行中的先结束） */
  onCloseAllTerminals: () => void
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
  const [menuOpen, setMenuOpen] = useState(false)

  if (props.collapsed) {
    return (
      <aside className="dock collapsed">
        <button className="dock-expand" onClick={props.onToggle} title="展开右侧拓展"><McIcon name="canvas" size={16} /> 拓展</button>
      </aside>
    )
  }

  const available = props.availableTabs ?? DOCK_TABS
  const active = props.active && props.tabs.includes(props.active) ? props.active : (props.tabs[0] ?? null)
  const closedTabs = available.filter(t => !props.tabs.includes(t))

  /** 建模页签：当前页 & 当前页对应的画布引用（页签名/活跃徽标/下载可用性都看它） */
  const activePage = props.canvasPages.find(p => p.key === props.activeCanvasPage) ?? null
  const activeCanvasRef = activePage?.kind === 'canvas'
    ? props.canvases.find(c => c.canvasId === activePage.key) ?? null
    : null
  const canDownload = activePage?.kind === 'canvas' && !!props.activeSessionCanvasId
    && activePage.key === props.activeSessionCanvasId
  const pageLabel = (p: CanvasPageDto) => {
    if (p.kind === 'asset') return p.assetName || '素材预览'
    if (p.kind === 'blank') return '空白页'
    const ref = props.canvases.find(c => c.canvasId === p.key)
    return ref?.name || '未命名模型'
  }
  const pageSource = (p: CanvasPageDto) => {
    if (p.kind === 'asset') return '素材预览'
    if (p.kind === 'blank') return ''
    return props.canvases.find(c => c.canvasId === p.key)?.ownerName ?? ''
  }
  const showPicker = !activePage || activePage.kind === 'blank'

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
                <McIcon name={TAB_META[t].icon} size={16} />
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
            <span className="dock-owner" title="每个子代理在自己的独立画布上建模，这里只是查看其中一块">{props.canvasOwner}</span>
          )}
          {active === 'canvas' && activeCanvasRef && !activeCanvasRef.active && (
            <button className="dock-act" onClick={props.onActivateCanvas} title="把这块画布设为它所属会话的活跃画布">设为活跃</button>
          )}
          {active === 'canvas' && (
            <button
              className="dock-act"
              onClick={props.onDownload}
              disabled={!canDownload}
              title={canDownload ? '下载当前模型' : '只有当前会话的活跃画布可以下载；先在页头把这块画布「设为活跃」'}
            >下载</button>
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
                <McIcon name={TAB_META[t].icon} size={16} /> {TAB_META[t].label}
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
            {available[0] && (
              <button onClick={() => props.onOpen(available[0])}>打开{TAB_META[available[0]].label}</button>
            )}
          </div>
        )}

        {active === 'canvas' && (
          <div className="dock-pane">
            {/* 多画布页签：主会话/子代理各自一块画布 + 素材只读预览 + 空白页 */}
            <div className="canvas-tabs">
              {props.canvasPages.map(p => {
                const ref = p.kind === 'canvas' ? props.canvases.find(c => c.canvasId === p.key) : null
                const src = pageSource(p)
                return (
                  <button
                    key={p.key}
                    className={`canvas-tab ${props.activeCanvasPage === p.key ? 'active' : ''}`}
                    onClick={() => props.onSwitchCanvasPage(p.key)}
                    title={p.kind === 'asset'
                      ? `素材：${pageLabel(p)}（只读预览；要修改请用素材库的「接着改」）`
                      : p.kind === 'blank' ? '空白页：从列表里选一块画布' : `${pageLabel(p)}${src ? ` · ${src}` : ''}${ref?.active ? ' · 活跃画布' : ''}`}
                  >
                    {props.canvasDirty[p.key] && props.activeCanvasPage !== p.key && (
                      <span className="canvas-tab-dirty" title="这块画布有新改动">●</span>
                    )}
                    <span className="canvas-tab-label">{pageLabel(p)}</span>
                    {src && <span className="canvas-tab-src">{src}</span>}
                    {ref?.active && <span className="canvas-tab-badge" title="这是它所属会话的活跃画布">活跃</span>}
                    <span
                      className="canvas-tab-close"
                      onClick={e => { e.stopPropagation(); props.onCloseCanvasPage(p.key) }}
                      title="关闭页签"
                    >✕</span>
                  </button>
                )
              })}
              <button className="canvas-tab add" onClick={props.onNewBlankPage} title="新建一个空白画布页">＋</button>
              <button className="canvas-tab add" onClick={props.onOpenLibrary} title="从素材库打开模型（只读预览，不影响会话画布）">▤</button>
            </div>
            {showPicker ? (
              <div className="canvas-picker">
                <div className="canvas-picker-head">选择要查看的画布（主会话与每个子代理各有一块）</div>
                {props.canvases.length === 0 && (
                  <div className="canvas-picker-empty">还没有可用画布。发送第一条消息后，主会话会创建画布；子代理也会各自建一块。</div>
                )}
                {props.canvases.map(c => (
                  <button key={c.canvasId} className="canvas-pick-row" onClick={() => props.onPickCanvas(c.canvasId)}>
                    <span className="canvas-pick-main">
                      <span className="canvas-pick-name">
                        {c.name || '未命名模型'}
                        {c.active && <span className="canvas-tab-badge">活跃</span>}
                      </span>
                      <span className="canvas-pick-sub">{c.ownerName} · {c.elements} 个部件 · {c.textures} 张贴图</span>
                    </span>
                  </button>
                ))}
                <button className="canvas-pick-new" disabled={!props.sessionId} onClick={props.onCreateCanvas} title="在当前会话下新建一块空白画布并设为活跃">
                  ＋ 新建空白画布
                </button>
              </div>
            ) : (
              <div className="dock-canvas">
                <CanvasPane
                  canvas={props.canvas}
                  iframeRef={props.iframeRef}
                  onIframeReady={props.onIframeReady}
                  onReload={props.onReloadCanvas}
                  reloadEnabled={activePage?.kind === 'canvas' && !props.canvas.hasModel}
                  emptyHint={activePage?.kind === 'canvas' && !props.canvasLoading}
                />
              </div>
            )}
            {!showPicker && props.activeAnimations.length > 0 && (
              <div className="anim-strip">
                <span className="anim-label dim">动画</span>
                <div className="anim-chips">
                  {props.activeAnimations.map(a => (
                    <button
                      key={a.name}
                      className={`anim-chip ${props.playingAnim === a.name ? 'playing' : ''}`}
                      disabled={props.canvasLoading}
                      title={`${a.length}s · ${a.loop}${props.playingAnim === a.name ? '（点击停止）' : ''}`}
                      onClick={() => props.onPlayAnim(props.playingAnim === a.name ? null : a.name)}
                    >
                      {props.playingAnim === a.name ? '▶ ' : ''}{a.name}
                    </button>
                  ))}
                  {props.playingAnim && (
                    <button className="anim-chip stop" onClick={() => props.onPlayAnim(null)}>■ 停止</button>
                  )}
                </div>
              </div>
            )}
            {!showPicker && (
              <div className="dock-composer">
                {!props.canvas.hasModel && activePage?.kind === 'canvas' && (
                  <div className="suggestions">
                    {props.suggestions.map(s => (
                      <button key={s} className="suggestion" disabled={props.busy} onClick={() => props.onSuggestion(s)}>{s}</button>
                    ))}
                  </div>
                )}
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
                  在中间输入框输入并回车发送。{props.modelTagline}
                </div>
              </div>
            )}
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
            sessionId={props.statsSessionId}
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
            onClose={props.onCloseTerminal}
            onCloseAll={props.onCloseAllTerminals}
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
