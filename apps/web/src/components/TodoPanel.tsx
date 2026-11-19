import { useEffect, useState } from 'react'
import type { TodoItemDto } from '../types.js'
import { McIcon } from './McIcon.js'

/**
 * AI 任务清单（dsh 式实时投影）：todo_write 整表更新，执行中固定在输入框上方。
 * 全部完成且停下后自动收起成一行，避免长期占位；用户可手动展开/收起。
 */
export function TodoPanel({ todos, busy }: {
  todos: TodoItemDto[] | null
  busy: boolean
}) {
  const list = todos ?? []
  const total = list.length
  const done = list.filter(t => t.status === 'completed').length
  const allDone = total > 0 && done === total
  const [collapsed, setCollapsed] = useState(false)

  // 开始执行时展开；全部完成且已停下时收起（用户手动展开后不会被再次收起）
  useEffect(() => {
    if (busy) setCollapsed(false)
  }, [busy])
  useEffect(() => {
    if (allDone && !busy) setCollapsed(true)
  }, [allDone, busy])

  if (total === 0) return null
  const pct = Math.round((done / total) * 100)

  return (
    <div className={`todo-panel ${busy ? 'running' : ''} ${allDone ? 'done' : ''}`}>
      <button
        type="button"
        className="todo-panel-head"
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? '展开任务清单' : '收起任务清单'}
      >
        <McIcon name="plan" size={16} />
        <span className="todo-panel-title">{allDone ? '任务完成' : '任务清单'}</span>
        <span className="todo-panel-count">{done}/{total}</span>
        <span className="todo-panel-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
        <span className="todo-panel-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="todo-panel-list">
          {list.map((t, i) => (
            <div key={`${i}-${t.content}`} className={`todo-panel-row ${t.status}`}>
              <span className={`todo-panel-check ${t.status}`} aria-hidden="true">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : ''}
              </span>
              <span className="todo-panel-text">{t.content}</span>
              {t.status === 'in_progress' && <span className="todo-panel-now">进行中</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
