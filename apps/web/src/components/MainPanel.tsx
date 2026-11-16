import { useState } from 'react'
import type {
  AgentProfileDto, ContextBreakdownDto, McProjectUiDto, ModelInfoDto, SessionInfoDto, SessionSummaryDto, StatsDto, SubagentWaitDto, TurnEntry,
} from '../types.js'
import { SessionView } from './SessionView.js'

function childStatusClass(info: SessionInfoDto | null, busy: boolean): string {
  if (busy) return 'ongoing'
  if (info?.status === 'done') return 'done'
  if (info?.status === 'error') return 'err'
  return 'idle'
}

function childStatusLabel(info: SessionInfoDto | null, busy: boolean): string {
  if (busy) return '运行中'
  if (info?.status === 'done') return '已完成'
  if (info?.status === 'error') return '出错'
  if (info?.status === 'stopped') return '已中止'
  return '空闲'
}

// 中央 keyed main —— 复刻 dsh 的 conversation 列：56px 页头（标题 + 会话 id）+ 消息流。
// 看板与子代理目录都搬进右侧拓展的标签页，主区只剩对话。
export function MainPanel(props: {
  sessionId: string
  sessionInfo: SessionInfoDto | null
  isSubagent: boolean
  subagents: SessionSummaryDto[]
  onOpenSubagent: (id: string) => void
  onStopSubagent: (id: string) => void
  onBackToRoot: () => void
  turns: TurnEntry[]
  busy: boolean
  /** 等待中的子代理（非空 = 等待态：会话没结束，输入锁定） */
  waiting: SubagentWaitDto[]
  streamChars: number
  elapsedSec: number
  /** 思考流末尾片段（运行横幅用） */
  thinkTail: string
  models: ModelInfoDto[]
  currentModelId: string
  refineMode: boolean
  onToggleRefine: () => void
  stats: StatsDto | null
  ctxTokens: number | null
  modelWindow: number | null
  /** 上下文三段构成（点击环展开的图） */
  ctxBreakdown: ContextBreakdownDto | null
  /** 代理角色目录 + 当前选择（lead / mcmod） */
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
  contextHint: string | null
  /** 设置 → 子代理：在对话里显示运行中的子代理 */
  inlineSubagents: boolean
  /** 设置 → 通用：Enter 发送 */
  enterToSend: boolean
  /** MOCK 离线模式标记 */
  mock: boolean
  /** 计划模式 / 授权 / 待处理交互（传给输入区与右侧拓展） */
  planMode: boolean
  permission: 'ask' | 'auto'
  pendingAsks: number
  onTogglePlan: () => void
  onTogglePermission: () => void
  /** MC 工程（mcdev）：标题栏的「▶ 测试 Mod / jar」按钮组（mod-output 已配置时 jar= 导出到目录） */
  mcProjects: McProjectUiDto[]
  modOutput: string
  onMcRun: (project: string) => void
  onMcStop: (project: string) => void
  onMcExport: (project: string) => void
  /** 「编辑配置…」：打开设置窗口（mod-output 等运行配置） */
  onOpenSettings: () => void
  /** 会话绑定的工作目录 + 欢迎区绑定/更换入口 */
  sessionCwd?: string
  onPickCwd: () => void
}) {
  const name = props.isSubagent
    ? (props.sessionInfo?.agentName ?? '子代理')
    : (props.sessionInfo?.title || '新会话')
  // IDE 风格运行配置：下拉选工程（记忆选择），单按钮运行/停止，⋮ 菜单里编辑配置
  const [mcMenuOpen, setMcMenuOpen] = useState(false)
  const [mcSelected, setMcSelected] = useState<string>(() => localStorage.getItem('openmods.mcProject') ?? '')
  const mcProjects = props.mcProjects
  const mcSel = mcProjects.find(p => p.name === mcSelected) ?? mcProjects[0]
  const mcSelOk = mcSel ? (mcSel.lastBuild?.ok === true || mcSel.jars.length > 0) : false
  const mcSelJar = mcSel?.jars[0]
  const pickMc = (name: string) => {
    setMcSelected(name)
    setMcMenuOpen(false)
    localStorage.setItem('openmods.mcProject', name)
  }
  return (
    <section className="main-panel">
      <header className="chat-head">
        <div className="chat-head-main">
          {props.isSubagent && (
            <button className="back-btn" onClick={props.onBackToRoot} title="回到主会话">← 主会话</button>
          )}
          <div className="chat-title-wrap">
            <h1 className="chat-title" title={name}>{name}</h1>
            <span className="chat-sub">
              {props.isSubagent
                ? `${props.sessionInfo?.description ?? '子代理'} · ${props.sessionInfo?.parentId ?? props.sessionId}`
                : (props.sessionId || '未创建会话')}
            </span>
          </div>
          {/* 素材编辑会话：明确告诉用户"这里的改动会写回哪个素材" */}
          {!props.isSubagent && props.sessionInfo?.libraryName && (
            <span
              className="lib-bind"
              title={`这个会话是素材「${props.sessionInfo.libraryName}」的编辑会话：画布改动会自动保存回素材`}
            >
              <span className="lib-bind-icon" aria-hidden="true">▤</span>
              {props.sessionInfo.libraryName}
              <span className="lib-bind-sub">自动保存</span>
            </span>
          )}
        </div>
        <div className="chat-head-actions">
          {/* MC 运行配置（IDE 风格）：状态点 + 工程下拉 + 运行/停止 + jar 导出 + ⋮ 配置菜单 */}
          {mcProjects.length > 0 && mcSel && (
            <span className="mc-actions mc-config" title={`${mcSel.name} · ${mcSel.dir}`}>
              <span
                className={`mc-dot ${mcSel.runClientRunning ? 'running' : mcSelOk ? 'ok' : mcSel.lastBuild ? 'fail' : 'none'}`}
                title={mcSel.runClientRunning ? 'runClient 运行中'
                  : mcSelOk ? `可测试${mcSel.lastBuild ? ` · 构建通过 ${new Date(mcSel.lastBuild.time).toLocaleTimeString()}` : ' · 已有构建产物 jar'}`
                    : mcSel.lastBuild ? '最近一次构建失败' : '还没有构建过'}
              />
              <select
                className="mc-select"
                value={mcSel.name}
                onChange={e => pickMc(e.target.value)}
                title="选择要测试的 Mod 工程"
              >
                {mcProjects.map(p => (
                  <option key={p.dir} value={p.name}>
                    {p.name}{p.jars.length ? ` · jar` : ''}{p.runClientRunning ? ' · 运行中' : ''}
                  </option>
                ))}
              </select>
              {mcSel.runClientRunning
                ? <button className="dock-act mc-stop" onClick={() => props.onMcStop(mcSel.name)} title="停掉正在运行的 Minecraft 客户端">■</button>
                : <button
                    className={`dock-act mc-run ${mcSelOk ? '' : 'disabled'}`}
                    disabled={!mcSelOk}
                    onClick={() => props.onMcRun(mcSel.name)}
                    title={mcSelOk ? `启动 gradlew runClient，把「${mcSel.name}」装进 Minecraft 1.20.1 测试` : '先 mc_gradle build 通过后才能测试'}
                  >▶</button>}
              {mcSelJar && (
                props.modOutput
                  ? <button
                      className="dock-act mc-jar"
                      onClick={() => props.onMcExport(mcSel.name)}
                      title={`把 ${mcSelJar.name}（${(mcSelJar.size / 1024).toFixed(0)} KB）复制到 mod-output：${props.modOutput}`}
                    >jar ⤓</button>
                  : <a className="dock-act mc-jar" href={`/api/mc/jar?path=${encodeURIComponent(mcSelJar.path)}`} download={mcSelJar.name}
                      title={`下载构建产物（${(mcSelJar.size / 1024).toFixed(0)} KB）；在设置里配置 mod-output 可一键导出到目录`}>jar ⤓</a>
              )}
              <span className="mc-menu-wrap">
                <button className="dock-act mc-more" onClick={() => setMcMenuOpen(o => !o)} title="运行配置">⋮</button>
                {mcMenuOpen && (
                  <>
                    <div className="menu-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 69 }} onClick={() => setMcMenuOpen(false)} />
                    <div className="mc-menu" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 71 }}>
                      <button className="dock-menu-item" onClick={() => { setMcMenuOpen(false); props.onOpenSettings() }}>编辑配置…（mod-output / 自动化）</button>
                      {mcProjects.map(p => (
                        <button key={p.dir} className="dock-menu-item" onClick={() => pickMc(p.name)}>
                          {p.name}{p.lastBuild?.ok ? ' ✓' : ''}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </span>
            </span>
          )}
          {props.isSubagent && (
            <span className={`child-badge ${props.busy ? 'running' : ''}`}>
              <span className={`state-dot ${childStatusClass(props.sessionInfo, props.busy)}`} />
              <span className="child-name">{childStatusLabel(props.sessionInfo, props.busy)}</span>
            </span>
          )}
        </div>
      </header>
      <SessionView
        turns={props.turns}
        busy={props.busy}
        waiting={props.waiting}
        streamChars={props.streamChars}
        elapsedSec={props.elapsedSec}
        thinkTail={props.thinkTail}
        models={props.models}
        currentModelId={props.currentModelId}
        refineMode={props.refineMode}
        onToggleRefine={props.onToggleRefine}
        stats={props.stats}
        ctxTokens={props.ctxTokens}
        modelWindow={props.modelWindow}
        ctxBreakdown={props.ctxBreakdown}
        profiles={props.profiles}
        agentProfile={props.agentProfile}
        onPickProfile={props.onPickProfile}
        iframeReady={props.iframeReady}
        pendingAtts={props.pendingAtts}
        onAddFiles={props.onAddFiles}
        onRemoveAtt={props.onRemoveAtt}
        onPickModel={props.onPickModel}
        onSend={props.onSend}
        onStop={props.onStop}
        onOpenSubagent={props.onOpenSubagent}
        onStopSubagent={props.onStopSubagent}
        isSubagent={props.isSubagent}
        subagentName={props.sessionInfo?.agentName}
        subagents={props.subagents}
        inlineSubagents={props.inlineSubagents}
        enterToSend={props.enterToSend}
        mock={props.mock}
        planMode={props.planMode}
        permission={props.permission}
        pendingAsks={props.pendingAsks}
        onTogglePlan={props.onTogglePlan}
        onTogglePermission={props.onTogglePermission}
        sessionCwd={props.sessionCwd}
        onPickCwd={props.onPickCwd}
      />
    </section>
  )
}
