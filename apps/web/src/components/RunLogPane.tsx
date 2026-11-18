import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { McProjectUiDto, McRunLogDto } from '../types.js'

/**
 * 右侧拓展的「运行」标签：实时显示工程 runClient 的控制台输出（run-console.log）。
 * 与日志抽屉里的「运行日志」共用同一套接口，这里做成窄栏：工程下拉 + 状态 + 自动滚动。
 */
export function RunLogPane({ sessionId }: { sessionId?: string | null }) {
  const [projects, setProjects] = useState<McProjectUiDto[]>([])
  const [project, setProject] = useState('')
  const [log, setLog] = useState<McRunLogDto | null>(null)
  const [error, setError] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const selRef = useRef('')
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!sessionId) {
      selRef.current = ''
      setProjects([])
      setProject('')
      setLog(null)
      return
    }
    let stopped = false
    const tick = async () => {
      try {
        const st = await api.mcState(sessionId)
        if (stopped) return
        setProjects(st.projects)
        setError('')
        // 保持原选择；没有就优先运行中的工程，其次第一个
        const sel = selRef.current
        const next = st.projects.find(p => p.name === sel)
          ?? st.projects.find(p => p.runClientRunning)
          ?? st.projects[0]
        if (!next) {
          selRef.current = ''
          setProject('')
          setLog(null)
          return
        }
        if (next.name !== selRef.current) {
          selRef.current = next.name
          setProject(next.name)
        }
        const d = await api.mcRunLog(sessionId, next.name)
        if (!stopped) setLog(d)
      } catch (e: any) {
        if (!stopped) setError(e.message)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [sessionId])

  // 新输出到达时贴底（用户手动上翻后可关掉「自动滚动」）
  useEffect(() => {
    if (!autoScroll) return
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log?.text, autoScroll])

  const pick = (name: string) => {
    selRef.current = name
    setProject(name)
    setLog(null)
    if (!sessionId) return
    api.mcRunLog(sessionId, name)
      .then(d => { if (selRef.current === name) setLog(d) })
      .catch((e: any) => { if (selRef.current === name) setError(e.message) })
  }

  return (
    <div className="dock-pane run-pane">
      <div className="run-pane-bar">
        <span className={`state-dot ${log?.running ? 'ongoing' : log ? 'done' : 'idle'}`} />
        {projects.length > 1 ? (
          <select className="run-pane-select" value={project} onChange={e => pick(e.target.value)} title="选择 MC 工程">
            {projects.map(p => (
              <option key={p.dir} value={p.name}>{p.name}{p.runClientRunning ? '（运行中）' : ''}</option>
            ))}
          </select>
        ) : (
          <span className="run-pane-name" title={log?.dir}>{project || '未选择工程'}</span>
        )}
        <span className="run-pane-state">{log ? (log.running ? '运行中' : '已结束') : ''}</span>
        <label className="log-auto">
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
      </div>

      {error ? (
        <div className="lib-hint">读取运行日志失败：{error}</div>
      ) : projects.length === 0 ? (
        <div className="lib-hint">当前会话目录下没有 MC 工程。运行一次模组工程后，runClient 的控制台输出会实时显示在这里。</div>
      ) : (
        <pre className="run-pane-log" ref={preRef} title={log?.path}>
          {log?.text || '（还没有运行日志：点标题栏的「▶」运行后，输出会出现在这里）'}
        </pre>
      )}
    </div>
  )
}
