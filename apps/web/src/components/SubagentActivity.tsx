import { useState } from 'react'
import type { SessionSummaryDto, SubagentWaitDto } from '../types.js'

function statusText(status: string): string {
  return status === 'running' ? '正在建模'
    : status === 'error' ? '出错'
      : status === 'stopped' ? '已中止'
        : status === 'idle' ? '未运行' : '已完成'
}

function fmtTok(n?: number): string {
  if (!n) return ''
  return n >= 1024 ? `${(n / 1024).toFixed(1)}k tok` : `${n} tok`
}

/**
 * 当前对话里的子代理活动条（dsh 的 activity 行落在对话内，而不是右上角浮层）。
 * 运行中显示加载环 + shimmer；已完成只是暗淡的勾，点「对话」可进子会话。
 */
export function SubagentActivity(props: {
  subagents: SessionSummaryDto[]
  waiting: SubagentWaitDto[]
  activeId: string
  onOpen: (id: string) => void
  onStop: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  // 合并两个数据源：waiting 是"这一批还没回来"的权威集合，目录里的 running 可能更早
  const byId = new Map<string, { id: string; name: string; description: string; status: string; outputTokens?: number; lastError?: string }>()
  for (const s of props.subagents) {
    byId.set(s.id, {
      id: s.id,
      name: s.agentName ?? s.id,
      description: s.description ?? '',
      status: s.status,
      outputTokens: s.outputTokens,
      lastError: s.lastError,
    })
  }
  for (const w of props.waiting) {
    byId.set(w.id, {
      id: w.id,
      name: w.name,
      description: w.description,
      status: w.status === 'idle' ? 'running' : w.status,
    })
  }
  const all = [...byId.values()]
  if (all.length === 0) return null
  // 只在"有子代理在跑"时出现在对话里：全部结束后，历史由通知行承载，
  // 完整目录在右侧「子代理」标签页（dsh activity 行同样只在运行时占位）
  if (!all.some(s => s.status === 'running')) return null

  const rank = (s: string) => (s === 'running' ? 0 : s === 'error' ? 1 : 2)
  all.sort((a, b) => rank(a.status) - rank(b.status))
  const running = all.filter(s => s.status === 'running').length
  const shown = expanded ? all.slice(0, 6) : all.filter(s => s.status === 'running').slice(0, 3)
  if (shown.length === 0) return null

  return (
    <div className="subagent-activity">
      <div className="sa-head">
        <b>子代理</b>
        <span>
          {running > 0 ? `${running} 个运行中` : `${all.length} 个`}
          {running > 0 && all.length > running ? ` · 共 ${all.length} 个` : ''}
        </span>
        <span className="sa-head-spacer" />
        <button className="sa-toggle" onClick={() => setExpanded(e => !e)}>
          {expanded ? '收起' : '全部'}
        </button>
      </div>
      <div className="sa-list">
        {shown.map(s => (
          <div className={`sa-row ${s.status}`} key={s.id}>
            <span className={`sa-spinner ${s.status === 'running' ? '' : s.status === 'error' ? 'err' : 'done'}`} />
            <span className="sa-main">
              <span className="sa-line">
                <span className="sa-name">{s.name}</span>
                <span className={s.status === 'running' ? 'sa-running' : 'sa-desc'}>
                  {s.status === 'running' ? `${statusText(s.status)}…` : statusText(s.status)}
                  {s.description ? ` · ${s.description}` : ''}
                </span>
              </span>
              {(s.lastError || s.outputTokens) && (
                <span className="sa-desc">{s.lastError ?? fmtTok(s.outputTokens)}</span>
              )}
            </span>
            <span className="sa-meta">{s.id}</span>
            {s.status === 'running' && (
              <button className="sa-open" onClick={() => props.onStop(s.id)} title="中止这个子代理">停止</button>
            )}
            <button className="sa-open" onClick={() => props.onOpen(s.id)} title="打开这个子代理的对话（独立画布）">对话</button>
          </div>
        ))}
      </div>
    </div>
  )
}
