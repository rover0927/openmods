import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { BuildLogMetaDto, LogEntryDto, LogLevel, McProjectUiDto, McRunLogDto } from '../types.js'

type LogTab = 'system' | 'build' | 'run'

const FILTERS: { id: 'all' | LogLevel; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'info', label: 'INFO' },
  { id: 'warn', label: 'WARN' },
  { id: 'error', label: 'ERROR' },
]

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 构建日志用：带上日期，跨天也分得清 */
function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtDuration(startedAt: number, finishedAt?: number): string {
  if (!finishedAt || finishedAt < startedAt) return ''
  const sec = (finishedAt - startedAt) / 1000
  return sec >= 60 ? `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s` : `${sec.toFixed(1)}s`
}

type BuildLogDetail = BuildLogMetaDto & { text: string }

/** 日志抽屉：系统日志（增量轮询 /api/logs）+ 构建日志（历史列表 + 单条完整文本）+ 运行日志（runClient 控制台） */
export function LogDrawer({ open, onClose, onToast, sessionId, mcEnabled = false }: {
  open: boolean
  onClose: () => void
  onToast: (msg: string) => void
  /** 当前会话：运行日志按会话 cwd 找 MC 工程 */
  sessionId?: string | null
  /** mc 插件启用时才显示「运行日志」标签 */
  mcEnabled?: boolean
}) {
  const [tab, setTab] = useState<LogTab>('system')

  // ---- 系统日志 ----
  const [logs, setLogs] = useState<LogEntryDto[]>([])
  const [file, setFile] = useState('')
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const seqRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // ---- 构建日志 ----
  const [buildLogs, setBuildLogs] = useState<BuildLogMetaDto[]>([])
  const [buildError, setBuildError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<BuildLogDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const selectedRef = useRef<string | null>(null)
  /** 已加载详情的结束时间：未结束（undefined）时每轮轮询都会刷新，结束后只补拉一次 */
  const detailEndRef = useRef<number | null>(null)
  const buildTextRef = useRef<HTMLPreElement>(null)

  // ---- 运行日志（runClient 控制台） ----
  const [runProjects, setRunProjects] = useState<McProjectUiDto[]>([])
  const [runProject, setRunProject] = useState<string | null>(null)
  const [runLog, setRunLog] = useState<McRunLogDto | null>(null)
  const [runError, setRunError] = useState('')
  const [runAutoScroll, setRunAutoScroll] = useState(true)
  const runSelRef = useRef<string | null>(null)
  const runTextRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async (initial = false) => {
    try {
      const r = await api.logs(initial ? 0 : seqRef.current, initial ? 300 : 200)
      if (initial || r.seq < seqRef.current) {
        // 首次打开，或服务端重启后 seq 归零
        setLogs(r.logs)
        seqRef.current = r.seq
      } else if (r.logs.length) {
        setLogs(prev => [...prev, ...r.logs].slice(-1500))
        seqRef.current = r.seq
      }
      setFile(r.file)
    } catch (e: any) {
      if (initial) onToast(`读取日志失败：${e.message}`)
    }
  }, [onToast])

  const loadBuildLogs = useCallback(async (silent = false): Promise<BuildLogMetaDto[] | null> => {
    try {
      const r = await api.buildLogs(30)
      setBuildLogs(r.logs)
      setBuildError('')
      return r.logs
    } catch (e: any) {
      if (!silent) setBuildError(e.message)
      return null
    }
  }, [])

  const loadBuildDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true)
    try {
      const d = await api.buildLog(id)
      if (selectedRef.current !== id) return
      setDetail(d)
      detailEndRef.current = d.finishedAt ?? null
    } catch (e: any) {
      if (!silent) onToast(`读取构建日志失败：${e.message}`)
    } finally {
      if (selectedRef.current === id) setDetailLoading(false)
    }
  }, [onToast])

  const selectBuild = useCallback((id: string) => {
    selectedRef.current = id
    setSelectedId(id)
    setDetail(null)
    detailEndRef.current = null
    void loadBuildDetail(id)
  }, [loadBuildDetail])

  /** 运行日志：切换工程后立即拉一次，轮询时保持当前选择 */
  const selectRun = useCallback((name: string) => {
    if (runSelRef.current === name) return
    runSelRef.current = name
    setRunProject(name)
    setRunLog(null)
    if (!sessionId) return
    api.mcRunLog(sessionId, name)
      .then(d => { if (runSelRef.current === name) setRunLog(d) })
      .catch((e: any) => { if (runSelRef.current === name) setRunError(e.message) })
  }, [sessionId])

  // mc 插件被关闭时，运行日志标签会消失，切回系统日志
  useEffect(() => {
    if (!mcEnabled && tab === 'run') setTab('system')
  }, [mcEnabled, tab])

  useEffect(() => {
    if (!open || tab !== 'system') return
    seqRef.current = 0
    setLogs([])
    void load(true)
    const timer = setInterval(() => void load(false), 2000)
    return () => clearInterval(timer)
  }, [open, tab, load])

  useEffect(() => {
    if (!open || tab !== 'build') return
    const tick = async () => {
      const list = await loadBuildLogs(true)
      if (!list) return
      const id = selectedRef.current
      if (!id) {
        // 首次打开自动选中最新一条，少点一次
        if (list[0]) selectBuild(list[0].id)
        return
      }
      const sel = list.find(x => x.id === id)
      // 构建中（没有 finishedAt）持续刷新；刚结束的那一次再补拉一遍完整文本
      if (sel && (sel.finishedAt == null || sel.finishedAt !== detailEndRef.current)) {
        void loadBuildDetail(id, true)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => clearInterval(timer)
  }, [open, tab, loadBuildLogs, loadBuildDetail, selectBuild])

  useEffect(() => {
    if (!open || tab !== 'run') return
    if (!sessionId) {
      runSelRef.current = null
      setRunProjects([])
      setRunProject(null)
      setRunLog(null)
      return
    }
    let stopped = false
    const tick = async () => {
      try {
        const st = await api.mcState(sessionId)
        if (stopped) return
        setRunProjects(st.projects)
        setRunError('')
        // 保持原选择；没有就优先运行中的工程，其次第一个
        const sel = runSelRef.current
        const next = st.projects.find(p => p.name === sel)
          ?? st.projects.find(p => p.runClientRunning)
          ?? st.projects[0]
        if (!next) {
          runSelRef.current = null
          setRunProject(null)
          setRunLog(null)
          return
        }
        if (next.name !== runSelRef.current) {
          runSelRef.current = next.name
          setRunProject(next.name)
        }
        const d = await api.mcRunLog(sessionId, next.name)
        if (!stopped) setRunLog(d)
      } catch (e: any) {
        if (!stopped) setRunError(e.message)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [open, tab, sessionId])

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [logs, autoScroll])

  // 构建中日志贴底（用户手动上翻后不再强制跟随）
  useEffect(() => {
    const el = buildTextRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [detail?.text, detail?.finishedAt])

  // 运行日志同样贴底
  useEffect(() => {
    if (!runAutoScroll) return
    const el = runTextRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [runLog?.text, runAutoScroll])

  if (!open) return null
  const visible = logs.filter(e => level === 'all' || e.level === level)

  const copy = async (text: string, label: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      onToast(`${label}已复制`)
    } catch {
      onToast('复制失败')
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer lib-drawer log-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="log-tabs" role="tablist">
            <button
              className={`log-tab ${tab === 'system' ? 'on' : ''}`}
              role="tab"
              aria-selected={tab === 'system'}
              onClick={() => setTab('system')}
            >系统日志</button>
            <button
              className={`log-tab ${tab === 'build' ? 'on' : ''}`}
              role="tab"
              aria-selected={tab === 'build'}
              onClick={() => setTab('build')}
            >构建日志</button>
            {mcEnabled && (
              <button
                className={`log-tab ${tab === 'run' ? 'on' : ''}`}
                role="tab"
                aria-selected={tab === 'run'}
                onClick={() => setTab('run')}
              >运行日志</button>
            )}
          </div>
          <button className="sb-icon-btn" title="关闭" onClick={onClose}>✕</button>
        </div>

        {tab === 'system' ? (
          <>
            <div className="log-toolbar">
              {FILTERS.map(f => (
                <button
                  key={f.id}
                  className={`lib-chip ${level === f.id ? 'on' : ''}`}
                  onClick={() => setLevel(f.id)}
                >{f.label}</button>
              ))}
              <span className="lib-filters-gap" />
              <label className="log-auto" title="新日志到达时自动滚到底部">
                <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                自动滚动
              </label>
              <button className="lib-chip" onClick={() => setLogs([])}>清空显示</button>
            </div>

            <div className="log-file" title={file || '日志只保存在内存中'}>
              <span>{file || '（仅内存缓冲）'}</span>
              <button className="lib-chip" disabled={!file} onClick={() => void copy(file, '日志文件路径')}>复制路径</button>
            </div>

            <div className="log-list" ref={listRef}>
              {visible.length === 0 ? (
                <div className="lib-hint">暂无日志。服务端的启动、插件加载、构建与错误输出会出现在这里。</div>
              ) : visible.map(e => (
                <div className={`log-row ${e.level}`} key={e.seq}>
                  <span className="log-time">{fmtTime(e.ts)}</span>
                  <span className={`log-level ${e.level}`}>{e.level.toUpperCase()}</span>
                  <span className="log-text">{e.text}</span>
                </div>
              ))}
            </div>
          </>
        ) : tab === 'build' ? (
          <div className="log-build">
            <div className="log-toolbar">
              <span className="log-build-count">最近 {buildLogs.length} 次构建 · 每 2 秒刷新</span>
              <span className="lib-filters-gap" />
              <button className="lib-chip" onClick={() => void loadBuildLogs()}>刷新</button>
            </div>

            {buildError && <div className="log-build-error">读取构建日志失败：{buildError}</div>}

            <div className="log-build-body">
              <div className="build-log-list">
                {buildLogs.length === 0 ? (
                  <div className="lib-hint">暂无构建记录。执行一次构建（mc_gradle build）后，完整日志会出现在这里。</div>
                ) : buildLogs.map(m => (
                  <div
                    key={m.id}
                    className={`build-log-row ${selectedId === m.id ? 'on' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectBuild(m.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        selectBuild(m.id)
                      }
                    }}
                  >
                    <div className="build-log-row-main">
                      <span className="build-log-project" title={m.project}>{m.project}</span>
                      <span className={`build-log-state ${m.ok ? 'ok' : 'fail'}`}>
                        {m.finishedAt == null ? '构建中' : m.ok ? '成功' : '失败'}
                        {m.exitCode != null && m.exitCode !== 0 ? ` (${m.exitCode})` : ''}
                      </span>
                    </div>
                    <div className="build-log-row-sub">
                      <span className="build-log-task" title={m.task}>{m.task}</span>
                      <span className="build-log-time">{fmtDateTime(m.startedAt)}</span>
                    </div>
                    {m.jarPath && (
                      <div className="build-log-jar" title={m.jarPath}>
                        <span className="build-log-jar-path">{m.jarPath}</span>
                        <button
                          className="lib-chip"
                          onClick={e => { e.stopPropagation(); void copy(m.jarPath!, 'jar 路径') }}
                        >复制</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="build-log-detail">
                {!detail ? (
                  <div className="lib-hint">
                    {detailLoading ? '正在读取构建日志…' : '点击左侧一条构建记录，查看完整日志。'}
                  </div>
                ) : (
                  <>
                    <div className="build-log-detail-head">
                      <span className={`build-log-state ${detail.ok ? 'ok' : 'fail'}`}>
                        {detail.finishedAt == null ? '构建中' : detail.ok ? '成功' : '失败'}
                      </span>
                      <span className="build-log-detail-title" title={detail.id}>{detail.project} · {detail.task}</span>
                      <span className="build-log-time">
                        {fmtDateTime(detail.startedAt)}
                        {detail.finishedAt ? ` · ${fmtDuration(detail.startedAt, detail.finishedAt)}` : ''}
                      </span>
                    </div>
                    <div className="build-log-paths">
                      <span className="build-log-path" title={detail.logPath}>{detail.logPath}</span>
                      <button className="lib-chip" onClick={() => void copy(detail.logPath, '日志路径')}>复制日志路径</button>
                      {detail.jarPath && (
                        <button className="lib-chip" onClick={() => void copy(detail.jarPath!, 'jar 路径')}>复制 jar 路径</button>
                      )}
                    </div>
                    <pre className="build-log-text" ref={buildTextRef}>{detail.text || '（日志为空）'}</pre>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="log-build">
            <div className="log-toolbar">
              <span className="log-build-count">runClient 控制台 · 每 2 秒刷新</span>
              <span className="lib-filters-gap" />
              <label className="log-auto" title="新输出到达时自动滚到底部">
                <input type="checkbox" checked={runAutoScroll} onChange={e => setRunAutoScroll(e.target.checked)} />
                自动滚动
              </label>
            </div>

            {runError && <div className="log-build-error">读取运行日志失败：{runError}</div>}

            <div className="log-build-body">
              <div className="build-log-list">
                {runProjects.length === 0 ? (
                  <div className="lib-hint">当前会话目录下没有 MC 工程。建一个工程或把工作目录切到模组工程后，这里会列出它的 runClient 日志。</div>
                ) : runProjects.map(p => (
                  <div
                    key={p.dir}
                    className={`build-log-row ${runProject === p.name ? 'on' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectRun(p.name)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        selectRun(p.name)
                      }
                    }}
                  >
                    <div className="build-log-row-main">
                      <span className="build-log-project" title={p.dir}>{p.name}</span>
                      <span className={`build-log-state ${p.runClientRunning ? 'ok' : 'fail'}`}>
                        {p.runClientRunning ? '运行中' : '未运行'}
                      </span>
                    </div>
                    <div className="build-log-row-sub">
                      <span className="build-log-task">{p.jars.length ? `${p.jars.length} 个 jar` : '无构建产物'}</span>
                      <span className="build-log-time">
                        {p.runClientStartedAt ? fmtDateTime(p.runClientStartedAt) : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="build-log-detail">
                {!runLog ? (
                  <div className="lib-hint">
                    {runProject ? '正在读取运行日志…' : '选择左侧一个工程，查看 runClient 的控制台输出。'}
                  </div>
                ) : (
                  <>
                    <div className="build-log-detail-head">
                      <span className={`build-log-state ${runLog.running ? 'ok' : 'fail'}`}>
                        {runLog.running ? '运行中' : '已结束'}
                      </span>
                      <span className="build-log-detail-title" title={runLog.dir}>{runLog.project}</span>
                      <span className="build-log-time">
                        {runLog.updatedAt ? `更新于 ${fmtDateTime(runLog.updatedAt)}` : ''}
                      </span>
                    </div>
                    <div className="build-log-paths">
                      <span className="build-log-path" title={runLog.path}>{runLog.path}</span>
                      <button className="lib-chip" onClick={() => void copy(runLog.path, '日志路径')}>复制日志路径</button>
                    </div>
                    <pre className="build-log-text" ref={runTextRef}>{runLog.text || '（还没有运行日志：在标题栏点「▶」运行后，控制台输出会出现在这里）'}</pre>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
