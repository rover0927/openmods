import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { LogEntryDto, LogLevel } from '../types.js'

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

/** 系统日志抽屉：增量轮询 /api/logs，显示服务端 console 输出与落盘路径 */
export function LogDrawer({ open, onClose, onToast }: {
  open: boolean
  onClose: () => void
  onToast: (msg: string) => void
}) {
  const [logs, setLogs] = useState<LogEntryDto[]>([])
  const [file, setFile] = useState('')
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const seqRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!open) return
    seqRef.current = 0
    setLogs([])
    void load(true)
    const timer = setInterval(() => void load(false), 2000)
    return () => clearInterval(timer)
  }, [open, load])

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [logs, autoScroll])

  if (!open) return null
  const visible = logs.filter(e => level === 'all' || e.level === level)

  const copyPath = async () => {
    if (!file) return
    try {
      await navigator.clipboard.writeText(file)
      onToast('日志文件路径已复制')
    } catch {
      onToast('复制失败')
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer lib-drawer log-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="drawer-title">系统日志</span>
          <button className="sb-icon-btn" title="关闭" onClick={onClose}>✕</button>
        </div>

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
          <button className="lib-chip" disabled={!file} onClick={() => void copyPath()}>复制路径</button>
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
      </aside>
    </>
  )
}
