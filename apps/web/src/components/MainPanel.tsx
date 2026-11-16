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
}) {
  const name = props.isSubagent
    ? (props.sessionInfo?.agentName ?? '子代理')
    : (props.sessionInfo?.title || '新会话')
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
          {/* MC 工程：构建成功 → 一键 runClient 测试；有 jar → 导出到 mod-output / 浏览器下载 */}
          {props.mcProjects.map(p => {
            // 可测试 = 最近 build 通过，或已有构建产物 jar（旧会话没有状态登记也能直接测）
            const ok = p.lastBuild?.ok === true || p.jars.length > 0
            const jar = p.jars[0]
            return (
              <span key={p.dir} className="mc-actions" title={`${p.name} · ${p.dir}`}>
                <span
                  className={`mc-dot ${p.runClientRunning ? 'running' : ok ? 'ok' : p.lastBuild ? 'fail' : 'none'}`}
                  title={p.runClientRunning ? 'runClient 运行中'
                    : ok ? `可测试${p.lastBuild ? ` · 构建通过 ${new Date(p.lastBuild.time).toLocaleTimeString()}` : ' · 已有构建产物 jar'}`
                      : p.lastBuild ? '最近一次构建失败' : '还没有构建过'}
                />
                {p.runClientRunning
                  ? <button className="dock-act mc-stop" onClick={() => props.onMcStop(p.name)} title="停掉正在运行的 Minecraft 客户端">■ 停止</button>
                  : <button
                      className={`dock-act mc-run ${ok ? '' : 'disabled'}`}
                      disabled={!ok}
                      onClick={() => props.onMcRun(p.name)}
                      title={ok ? `启动 gradlew runClient，把「${p.name}」装进 Minecraft 1.20.1 测试` : '先 mc_gradle build 通过后才能测试'}
                    >▶ 测试 Mod</button>}
                {jar && (
                  props.modOutput
                    ? <button
                        className="dock-act mc-jar"
                        onClick={() => props.onMcExport(p.name)}
                        title={`把 ${jar.name}（${(jar.size / 1024).toFixed(0)} KB）复制到 mod-output：${props.modOutput}`}
                      >jar ⤓</button>
                    : <a className="dock-act mc-jar" href={`/api/mc/jar?path=${encodeURIComponent(jar.path)}`} download={jar.name}
                        title={`下载构建产物（${(jar.size / 1024).toFixed(0)} KB）；在设置里配置 mod-output 可一键导出到目录`}>jar ⤓</a>
                )}
              </span>
            )
          })}
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
      />
    </section>
  )
}
