// 协作工具：问用户（ask_user_question）、待办（todo_write）、计划评审（exit_plan_mode）。
//
// 三个都对应 dsh 的独立包：
//   interaction/tool-ask-user  -> ask_user_question
//   todo/tool-todo             -> todo_write（整表替换）
//   plan/plan-mode             -> exit_plan_mode（只在计划模式下出现，批准后退出）
import type { Plugin, QuestionSpec, TodoItem } from '@openmods/plugin-kit'

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export const plugin: Plugin = {
  name: 'interaction-tools',
  apply(ctx) {
    ctx.tools.register({
      name: 'ask_user_question',
      description: '需要用户确认、在几个方案间选择、或缺少关键信息时，向用户提问并等待回答。一次可以把要问的全问完（questions 数组）；有推荐项就放第一个并在 label 后加「(Recommended)」。不要用它问自己能查到的事。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '要问用户的问题列表',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '稳定 id，答案里会回显' },
                question: { type: 'string', description: '具体问题' },
                header: { type: 'string', description: '短标题（如「确认」「选择方案」）' },
                options: {
                  type: 'array',
                  description: '可选答案；不传则让用户自由输入',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: '选项文字' },
                      description: { type: 'string', description: '一句话说明影响/取舍' },
                    },
                    required: ['label'],
                  },
                },
                multi_select: { type: 'boolean', description: '是否允许多选，默认 false' },
              },
              required: ['id', 'question'],
            },
          },
        },
        required: ['questions'],
      },
      async execute(args, exec) {
        const raw = Array.isArray(args.questions) ? args.questions : []
        const questions: QuestionSpec[] = raw
          .map((q: any) => ({
            id: String(q?.id ?? '').trim(),
            question: String(q?.question ?? '').trim(),
            ...(q?.header ? { header: String(q.header) } : {}),
            ...(Array.isArray(q?.options) && q.options.length
              ? {
                options: q.options.map((o: any) => ({
                  label: String(o?.label ?? '').trim(),
                  ...(o?.description ? { description: String(o.description) } : {}),
                })).filter((o: any) => o.label),
              }
              : {}),
            ...(q?.multi_select === true ? { multiSelect: true } : {}),
          }))
          .filter((q: QuestionSpec) => q.id && q.question)
        if (!questions.length) return { forModel: '至少需要一个带 id 和 question 的问题', isError: true }

        exec.session.appendEvent('question/asked', { callId: exec.callId, questions })
        const res = await ctx.interaction.ask(exec.sessionId, {
          questions,
          callId: exec.callId,
          signal: exec.signal,
        })
        if (res.cancelled) {
          return { forModel: '用户没有回答（提问已取消或本轮被停止）。不要假设答案：可以先做不依赖它的部分，或换个更具体的问题再问一次。' }
        }
        exec.session.appendEvent('question/answered', { callId: exec.callId, answers: res.answers })
        return {
          forModel: `用户已回答：\n${JSON.stringify({ answers: res.answers }, null, 2)}`,
        }
      },
    })

    ctx.tools.register({
      name: 'todo_write',
      description: '写入/更新任务清单（整表替换）：多步工作开始前列出具体步骤，做到哪步就把哪步标成 in_progress，完成后立刻标 completed。跳过一句话就能做完的小事。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整任务列表（整表替换，不是增量）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '一步具体工作' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      async execute(args, exec) {
        const raw = Array.isArray(args.todos) ? args.todos : []
        const seen = new Set<string>()
        const todos: TodoItem[] = []
        let active = 0
        for (const t of raw) {
          const content = String(t?.content ?? '').trim()
          const status = String(t?.status ?? '')
          if (!content) return { forModel: '待办内容不能为空', isError: true }
          if (seen.has(content)) return { forModel: `待办重复：${content}`, isError: true }
          if (!STATUSES.has(status)) return { forModel: `非法状态：${status}（pending / in_progress / completed）`, isError: true }
          seen.add(content)
          if (status === 'in_progress') active++
          todos.push({ content, status: status as TodoItem['status'] })
        }
        if (active > 1) return { forModel: `同时最多一个 in_progress（当前 ${active} 个）`, isError: true }
        exec.session.setTodos(todos)
        const done = todos.filter(t => t.status === 'completed').length
        return { forModel: `已更新任务清单：${todos.length} 项（完成 ${done}，进行中 ${active}）。` }
      },
    })

    ctx.tools.register({
      name: 'exit_plan_mode',
      description: '只在计划模式可用：把完整方案（markdown，第一行必须是 # 标题）交给用户评审。用户批准后自动退出计划模式、从下一步开始执行；用户选择继续完善时，反馈会回到这里，改完再提交一次。',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string', description: '完整计划 markdown，以 # 标题开头' } },
        required: ['plan'],
      },
      gate: session => session.planMode,
      async execute(args, exec) {
        if (!exec.session.planMode) return { forModel: '当前不在计划模式，不需要提交计划。', isError: true }
        const plan = String(args.plan ?? '').trim()
        if (!/^#\s+\S/.test(plan)) return { forModel: 'plan 必须是非空 markdown，并以 "# 标题" 开头', isError: true }
        const res = await ctx.interaction.ask(exec.sessionId, {
          // 方案评审走同一套提问通道：UI 会用 plan 字段渲染评审视图
          questions: [{
            id: 'plan-review',
            header: '计划评审',
            question: '批准这个计划并开始执行吗？',
            options: [
              { label: '批准并执行', description: '退出计划模式，从下一步开始按计划动手' },
              { label: '继续完善', description: '留在计划模式；你的反馈会回到模型' },
            ],
          }],
          plan,
          callId: exec.callId,
          signal: exec.signal,
        })
        if (res.cancelled) {
          return { forModel: '用户没有评审（已取消），计划模式仍然开启。可以继续完善方案后再提交。' }
        }
        const answer = res.answers.find(a => a.id === 'plan-review')
        const approved = !!answer?.selected?.some(s => s.includes('批准'))
        if (approved) {
          exec.session.setPlanMode(false)
          return { forModel: 'Plan approved — 计划模式已退出。从下一步开始按计划执行：先 todo_write 建清单，再逐项落地。' }
        }
        const feedback = answer?.custom?.trim()
        return {
          forModel: `用户没有批准，要求继续完善计划。${feedback ? `\n用户反馈：${feedback}` : ''}\n按反馈修改方案后，再次调用 exit_plan_mode 提交。`,
        }
      },
    })
  },
}

export default plugin
