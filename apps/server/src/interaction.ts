// 人机交互：把「问用户」「方案评审」「执行授权」做成一个可阻塞的会话能力。
//
// 对应 dsh 的两个 seam：
//   ctx.userQuestions  —— ask_user_question / exit_plan_mode，工具阻塞到用户作答；
//   ctx.approval       —— 写/命令类工具的授权请求，结果是一次性放行或拒绝。
//
// 这里只负责「谁在等、答案回给谁」；UI 与传输在 SSE + 前端弹窗里，
// 插件拿到的只是 plugin-kit 的 InteractionPort。
import { randomUUID } from 'node:crypto'
import type { QuestionSpec, QuestionAnswer, InteractionPort } from '@openmods/plugin-kit'
import type { ApprovalDecision } from '@openmods/agent-core'

export type InteractionKind = 'question' | 'plan' | 'approval'

/** 待处理交互（SSE / GET 会话详情 / 刷新恢复都用这个形状） */
export interface PendingInteraction {
  id: string
  sessionId: string
  kind: InteractionKind
  createdAt: number
  callId?: string
  /** 授权：被询问的工具名 */
  toolName?: string
  /** 授权：为什么需要（给人看的一句话） */
  reason?: string
  /** 普通提问 / 计划评审的问题列表 */
  questions?: QuestionSpec[]
  /** 计划评审：完整计划 markdown */
  plan?: string
}

/** 前端提交的答案（按 kind 取不同字段） */
export interface InteractionReply {
  /** question / plan：逐题答案 */
  answers?: QuestionAnswer[]
  /** plan：批准与否 + 反馈 */
  approved?: boolean
  feedback?: string
  /** approval：放行 / 拒绝 + 是否记住 */
  decision?: 'allow' | 'deny'
  remember?: boolean
}

interface Waiter {
  req: PendingInteraction
  resolve: (value: any) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface InteractionHub {
  /** 插件端口：ask_user_question / exit_plan_mode 用 */
  port: InteractionPort
  /** 运行时授权端口：工具执行前的许可 */
  approval: {
    request(req: {
      sessionId: string
      toolName: string
      callId: string
      reason: string
      signal?: AbortSignal
    }): Promise<ApprovalDecision>
  }
  list(sessionId: string): PendingInteraction[]
  answer(sessionId: string, id: string, reply: InteractionReply): { ok: true } | { ok: false; error: string }
  /** 停止/归档会话时：所有等待中的交互按取消结算（工具不会卡死） */
  cancelSession(sessionId: string, reason?: string): number
  cancelAll(): void
}

export function createInteractionHub(opts: {
  emit: (sessionId: string, topic: string, data: any) => void
}): InteractionHub {
  const waiters = new Map<string, Waiter>()

  function list(sessionId: string): PendingInteraction[] {
    return [...waiters.values()]
      .filter(w => w.req.sessionId === sessionId)
      .map(w => w.req)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  function cleanup(id: string) {
    const w = waiters.get(id)
    if (!w) return
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
    waiters.delete(id)
  }

  function settle(id: string, value: any) {
    const w = waiters.get(id)
    if (!w) return false
    cleanup(id)
    w.resolve(value)
    opts.emit(w.req.sessionId, 'interaction/answered', { id, sessionId: w.req.sessionId })
    return true
  }

  /** 挂一个待处理请求：发 SSE、登记等待者，signal 中止时按取消结算 */
  function park(req: PendingInteraction, signal: AbortSignal | undefined, onCancel: () => any): Promise<any> {
    return new Promise(resolve => {
      const waiter: Waiter = { req, resolve, signal }
      if (signal) {
        waiter.onAbort = () => {
          cleanup(req.id)
          resolve(onCancel())
          opts.emit(req.sessionId, 'interaction/answered', { id: req.id, sessionId: req.sessionId, cancelled: true })
        }
        if (signal.aborted) { resolve(onCancel()); return }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiters.set(req.id, waiter)
      opts.emit(req.sessionId, 'interaction/ask', req)
    })
  }

  const port: InteractionPort = {
    async ask(sessionId, req) {
      const id = randomUUID().slice(0, 8)
      const pending: PendingInteraction = {
        id,
        sessionId,
        kind: req.plan ? 'plan' : 'question',
        createdAt: Date.now(),
        ...(req.callId ? { callId: req.callId } : {}),
        questions: req.questions,
        ...(req.plan ? { plan: req.plan } : {}),
      }
      return park(pending, req.signal, () => ({ answers: [], cancelled: true }))
    },
  }

  return {
    port,
    approval: {
      async request({ sessionId, toolName, callId, reason, signal }) {
        const id = randomUUID().slice(0, 8)
        const pending: PendingInteraction = {
          id, sessionId, kind: 'approval', createdAt: Date.now(), toolName, reason,
          ...(callId ? { callId } : {}),
        }
        return park(pending, signal, () => ({ decision: 'deny', cancelled: true }))
      },
    },
    list,
    answer(sessionId, id, reply) {
      const w = waiters.get(id)
      if (!w) return { ok: false, error: '这个交互已经结束或不存在' }
      if (w.req.sessionId !== sessionId) return { ok: false, error: '会话不匹配' }
      if (w.req.kind === 'approval') {
        const decision = reply.decision === 'allow' ? 'allow' : 'deny'
        settle(id, { decision, remember: !!reply.remember })
        return { ok: true }
      }
      // question / plan：统一折成 answers（plan 用 approved/feedback 也行）
      let answers = Array.isArray(reply.answers) ? reply.answers : []
      if (w.req.kind === 'plan' && answers.length === 0) {
        answers = [{
          id: 'plan-review',
          selected: [reply.approved ? '批准并执行' : '继续完善'],
          ...(reply.feedback ? { custom: String(reply.feedback) } : {}),
        }]
      }
      settle(id, { answers })
      return { ok: true }
    },
    cancelSession(sessionId, reason = 'cancelled') {
      let n = 0
      for (const w of [...waiters.values()]) {
        if (w.req.sessionId !== sessionId) continue
        n++
        settle(w.req.id, w.req.kind === 'approval'
          ? { decision: 'deny', cancelled: true, reason }
          : { answers: [], cancelled: true })
      }
      return n
    },
    cancelAll() {
      for (const w of [...waiters.values()]) {
        settle(w.req.id, w.req.kind === 'approval'
          ? { decision: 'deny', cancelled: true }
          : { answers: [], cancelled: true })
      }
    },
  }
}
