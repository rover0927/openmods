// 人机交互弹窗：提问 / 方案评审 / 执行授权。
//
// dsh 的 user-questions 面板 + approval 确认框在这里合成一个组件：
// 工具在服务端阻塞等待，提交后答案作为普通工具结果回到模型。
import { useState } from 'react'
import type { PendingInteractionDto } from '../types.js'
import { MessageText } from '../markdown.js'

export interface InteractionReplyBody {
  answers?: { id: string; selected: string[]; custom?: string }[]
  approved?: boolean
  feedback?: string
  decision?: 'allow' | 'deny'
  remember?: boolean
}

export function AskDialog(props: {
  ask: PendingInteractionDto
  /** 提交答案；失败时抛错（弹窗保留，用户可重试） */
  onSubmit: (reply: InteractionReplyBody) => Promise<void> | void
  onCancel?: () => void
}) {
  const { ask } = props
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [remember, setRemember] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (qid: string, label: string, multi: boolean) => {
    setPicked(prev => {
      const cur = prev[qid] ?? []
      if (multi) {
        return { ...prev, [qid]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] }
      }
      return { ...prev, [qid]: [label] }
    })
  }

  const questions = ask.questions ?? []
  const ready = questions.every(q => (picked[q.id]?.length ?? 0) > 0 || (custom[q.id] ?? '').trim().length > 0)

  const submitQuestions = async () => {
    setBusy(true); setError(null)
    try {
      await props.onSubmit({
        answers: questions.map(q => ({
          id: q.id,
          selected: picked[q.id] ?? [],
          ...(custom[q.id]?.trim() ? { custom: custom[q.id].trim() } : {}),
        })),
      })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitPlan = async (approved: boolean) => {
    setBusy(true); setError(null)
    try {
      await props.onSubmit({ approved, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitApproval = async (allow: boolean) => {
    setBusy(true); setError(null)
    try {
      await props.onSubmit({ decision: allow ? 'allow' : 'deny', remember: allow && remember })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ask-backdrop" role="dialog" aria-modal="false" aria-label="需要你的确认">
      <div className="ask-card">
        <div className="ask-head">
          <span className={`ask-kind ${ask.kind}`}>
            {ask.kind === 'approval' ? '授权请求' : ask.kind === 'plan' ? '计划评审' : '需要你回答'}
          </span>
          {ask.sessionId && <span className="ask-session dim">{ask.sessionId}</span>}
        </div>

        {ask.kind === 'approval' && (
          <>
            <div className="ask-title">允许执行 <code>{ask.toolName}</code> 吗？</div>
            {ask.reason && <div className="ask-reason">{ask.reason}</div>}
            <label className="ask-remember">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
              本会话内总是允许 <code>{ask.toolName}</code>（之后不再询问）
            </label>
            <div className="ask-actions">
              <button className="dialog-btn" disabled={busy} onClick={() => submitApproval(false)}>拒绝</button>
              <button className="dialog-btn primary" disabled={busy} onClick={() => submitApproval(true)}>允许一次</button>
            </div>
          </>
        )}

        {ask.kind === 'plan' && (
          <>
            <div className="ask-title">批准计划并开始执行吗？</div>
            <div className="ask-plan">
              <MessageText text={ask.plan ?? '（计划为空）'} />
            </div>
            <textarea
              className="ask-input"
              rows={2}
              placeholder="要继续完善的话，把反馈写在这里（可留空）"
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
            />
            <div className="ask-actions">
              <button className="dialog-btn" disabled={busy} onClick={() => submitPlan(false)}>继续完善</button>
              <button className="dialog-btn primary" disabled={busy} onClick={() => submitPlan(true)}>批准并执行</button>
            </div>
          </>
        )}

        {ask.kind === 'question' && (
          <>
            <div className="ask-questions">
              {questions.map(q => (
                <div key={q.id} className="ask-q">
                  {q.header && <div className="ask-q-header">{q.header}</div>}
                  <div className="ask-q-text">{q.question}</div>
                  {q.options?.length ? (
                    <div className="ask-options">
                      {q.options.map(o => {
                        const on = (picked[q.id] ?? []).includes(o.label)
                        return (
                          <button
                            key={o.label}
                            className={`ask-option ${on ? 'on' : ''}`}
                            onClick={() => toggle(q.id, o.label, !!q.multiSelect)}
                            title={o.description}
                          >
                            <span className="ask-option-label">{o.label}</span>
                            {o.description && <span className="ask-option-desc">{o.description}</span>}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                  <input
                    className="ask-input"
                    placeholder={q.options?.length ? '或直接输入你的答案' : '输入你的答案'}
                    value={custom[q.id] ?? ''}
                    onChange={e => setCustom(prev => ({ ...prev, [q.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="ask-actions">
              {props.onCancel && <button className="dialog-btn" disabled={busy} onClick={props.onCancel}>关闭</button>}
              <button className="dialog-btn primary" disabled={busy || !ready} onClick={submitQuestions}>提交</button>
            </div>
          </>
        )}

        {error && <div className="ask-error">{error}</div>}
      </div>
    </div>
  )
}
