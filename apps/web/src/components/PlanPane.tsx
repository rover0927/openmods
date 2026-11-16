// 「计划」面板：计划模式开关 + 当前待办 + 授权策略。
// 对应 dsh plan-mode / todo 投影 / approval policy 三块的会话级状态。
import type { TodoItemDto } from '../types.js'

const STATUS_LABEL: Record<TodoItemDto['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
}

export function PlanPane(props: {
  planMode: boolean
  busy: boolean
  todos: TodoItemDto[] | null
  permission: 'ask' | 'auto'
  allowedTools: string[]
  onTogglePlan: (active: boolean) => void
  onPermission: (policy: 'ask' | 'auto') => void
  onResetAllowed: () => void
}) {
  const todos = props.todos ?? []
  const done = todos.filter(t => t.status === 'completed').length

  return (
    <div className="plan-pane">
      <div className="plan-block">
        <div className="plan-block-head">
          <span className="plan-block-title">计划模式</span>
          <button
            className={`plan-switch ${props.planMode ? 'on' : ''}`}
            role="switch"
            aria-checked={props.planMode}
            onClick={() => props.onTogglePlan(!props.planMode)}
            title={props.planMode ? '退出计划模式，恢复正常读写' : '进入计划模式：AI 只调研并出方案，改文件/画布/命令会被拦截'}
          >
            <span className="plan-switch-knob" />
            {props.planMode ? '已开启' : '关闭'}
          </button>
        </div>
        <p className="plan-hint">
          {props.planMode
            ? '只读：AI 会先调研、列步骤，然后用 exit_plan_mode 把方案交给你批准；批准后才开始动手。'
            : '复杂任务可以先开启：AI 先出方案，你批准后再执行，避免改错文件。'}
        </p>
      </div>

      <div className="plan-block">
        <div className="plan-block-head">
          <span className="plan-block-title">任务清单</span>
          {todos.length > 0 && <span className="plan-count dim">{done}/{todos.length}</span>}
        </div>
        {todos.length === 0 ? (
          <div className="ds-empty">还没有待办。AI 开始多步任务时会用 todo_write 建立清单。</div>
        ) : (
          <div className="todo-list">
            {todos.map(t => (
              <div key={t.content} className={`todo-row ${t.status}`}>
                <span className={`todo-dot ${t.status}`} aria-hidden="true">
                  {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◔' : '○'}
                </span>
                <span className="todo-text">{t.content}</span>
                <span className="todo-status dim">{STATUS_LABEL[t.status]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="plan-block">
        <div className="plan-block-head">
          <span className="plan-block-title">授权</span>
          <span className="plan-count dim">{props.permission === 'auto' ? '自动放行' : '询问'}</span>
        </div>
        <div className="seg plan-seg">
          <button className={`seg-btn ${props.permission === 'ask' ? 'active' : ''}`} onClick={() => props.onPermission('ask')}>
            询问
          </button>
          <button className={`seg-btn ${props.permission === 'auto' ? 'active' : ''}`} onClick={() => props.onPermission('auto')}>
            自动放行
          </button>
        </div>
        <p className="plan-hint">
          “询问”时，写工作目录外的文件、执行命令、开关终端会弹窗确认；“自动放行”只影响本会话。
        </p>
        {props.allowedTools.length > 0 && (
          <div className="allowed-tools">
            <span className="dim">本会话已总是允许：</span>
            {props.allowedTools.map(t => <code key={t} className="allowed-tool">{t}</code>)}
            <button className="link-btn" onClick={props.onResetAllowed}>清除</button>
          </div>
        )}
      </div>
    </div>
  )
}
