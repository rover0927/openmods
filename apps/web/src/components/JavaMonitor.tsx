import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { JavaProcDto } from '../types.js'
import { McIcon } from './McIcon.js'

const KIND_LABEL: Record<JavaProcDto['kind'], string> = {
  'gradle-daemon': 'Gradle Daemon',
  'gradle-launcher': 'Gradle 启动器',
  'minecraft-client': 'MC 客户端',
}

/** 运行时长：60s 内按秒，1h 内按分，再长按 h:mm */
function fmtUptime(startedAt: number): string {
  if (!startedAt) return ''
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/**
 * Java 后台进程浮窗：自动检测 Gradle daemon / gradlew 启动器 / Minecraft 客户端，
 * 显示内存、CPU、运行时长，可单个结束或批量结束（默认不动 MC 客户端）。
 */
export function JavaMonitor({ onToast }: { onToast: (msg: string) => void }) {
  const [open, setOpen] = useState(false)
  const [procs, setProcs] = useState<JavaProcDto[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [includeClient, setIncludeClient] = useState(false)
  const [busy, setBusy] = useState(false)
  const openRef = useRef(open)
  openRef.current = open

  const refresh = useCallback(async (loud = false) => {
    if (loud) setLoading(true)
    try {
      const r = await api.javaProcs()
      setProcs(r.processes ?? [])
      setError(r.ok ? '' : (r.error ?? '检测失败'))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      if (loud) setLoading(false)
    }
  }, [])

  // 自动检测：展开时 5 秒一次，收起时 15 秒一次（只维护角标）
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refresh()
    }, open ? 5000 : 15_000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const kill = async (p: JavaProcDto) => {
    setBusy(true)
    try {
      await api.killJavaProc(p.pid)
      onToast(`已结束 ${KIND_LABEL[p.kind]}（PID ${p.pid}）`)
      await refresh()
    } catch (e: any) {
      onToast(`结束失败：${e?.message ?? e}`)
    } finally {
      setBusy(false)
    }
  }

  const killAll = async () => {
    setBusy(true)
    try {
      const r = await api.killAllJavaProcs(includeClient)
      const failed = r.failed?.length ?? 0
      onToast(r.killed.length
        ? `已结束 ${r.killed.length} 个 Java 进程${failed ? `（${failed} 个失败）` : ''}`
        : '没有可结束的 Java 进程')
      await refresh()
    } catch (e: any) {
      onToast(`批量结束失败：${e?.message ?? e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="java-monitor">
      {open && (
        <div className="jm-panel">
          <div className="jm-head">
            <McIcon name="terminal" size={16} />
            <span className="jm-title">Java 后台进程</span>
            <span className="jm-count">{procs.length}</span>
            <button className="lib-chip" disabled={loading || busy} onClick={() => void refresh(true)}>刷新</button>
            <button className="jm-close" onClick={() => setOpen(false)} title="关闭">✕</button>
          </div>

          {error && <div className="jm-error">{error}</div>}

          <div className="jm-list">
            {procs.length === 0 ? (
              <div className="jm-empty">未检测到 Gradle / Minecraft 的 Java 进程。</div>
            ) : procs.map(p => (
              <div className="jm-row" key={p.pid}>
                <div className="jm-row-main">
                  <span className={`jm-kind ${p.kind}`}>{KIND_LABEL[p.kind]}</span>
                  <span className="jm-pid">PID {p.pid}</span>
                  <span className="jm-stat">{p.memoryMB} MB</span>
                  {p.cpuSec > 0 && <span className="jm-stat">CPU {p.cpuSec}s</span>}
                  {p.startedAt > 0 && <span className="jm-stat">{fmtUptime(p.startedAt)}</span>}
                  <button className="lib-chip jm-kill" disabled={busy} onClick={() => void kill(p)}>结束</button>
                </div>
                <div className="jm-cmd" title={p.cmd}>{p.cmd}</div>
              </div>
            ))}
          </div>

          <div className="jm-foot">
            <label className="log-auto">
              <input type="checkbox" checked={includeClient} onChange={e => setIncludeClient(e.target.checked)} />
              包含 MC 客户端
            </label>
            <span className="jm-gap" />
            <button
              className="lib-chip"
              disabled={busy || procs.length === 0}
              title="Gradle daemon 可能同时服务 IDE 或其它工程，确认后再结束"
              onClick={() => void killAll()}
            >
              全部结束
            </button>
          </div>
        </div>
      )}

      <button
        className={`jm-toggle ${procs.length ? 'has' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="监听 Gradle / Minecraft 的 Java 后台进程"
      >
        <McIcon name="terminal" size={18} />
        {procs.length > 0 && <span className="jm-badge">{procs.length}</span>}
      </button>
    </div>
  )
}
