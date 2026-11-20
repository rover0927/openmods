// 命令与终端工具：bash / terminal_open / terminal_list / terminal_read / terminal_send / terminal_kill。
//
// 与 dsh 的对应：
//   bash                = shell/tool-bash（前台 + run_in_background）
//   terminal_*          = jobs/tool-jobs 的 job_output / job_kill 的终端形态
// 所有进程都由服务端 TerminalManager 持有：输出进了环形缓冲，面板能看到同一份，
// 结束会话/归档时服务端会统一收掉（不会留孤儿进程）。
import { isAbsolute, resolve } from 'node:path'
import type { Plugin, ToolExecContext } from '@openmods/plugin-kit'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const TAIL_CHARS = 20_000

function workdir(args: any, exec: ToolExecContext): string {
  const cwd = exec.session.cwd || process.cwd()
  const raw = typeof args?.workdir === 'string' ? args.workdir.trim() : ''
  if (!raw) return cwd
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function fmtExit(r: { exitCode: number | null; signal?: string; timedOut: boolean }): string {
  if (r.timedOut) return '（命令超时，仍在后台运行）'
  if (r.exitCode === 0) return '（退出码 0）'
  if (r.exitCode !== null) return `（退出码 ${r.exitCode}${r.signal ? ` · ${r.signal}` : ''}）`
  return `（被信号结束${r.signal ? `：${r.signal}` : ''}）`
}

/** 计划模式只放行能明确判定为只读的 bash（cd/grep/cat/find/git status 等） */
const READONLY_COMMANDS = new Set([
  'cd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sed', 'awk', 'echo', 'pwd',
  'which', 'where', 'stat', 'file', 'tree', 'git', 'diff', 'sort', 'uniq', 'cut', 'tr', 'nl', 'du', 'df', 'printenv', 'type',
])
const GIT_READONLY = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch'])

/**
 * 计划模式只读判定：返回 undefined = 只读放行；返回字符串 = 第一个不允许的地方（给模型的具体原因）。
 * `cd dir && sed -n ...` 这类「无副作用前缀 + 只读命令」的组合按只读放行。
 */
export function bashReadOnlyReason(command: string): string | undefined {
  const cmd = String(command ?? '').trim()
  if (!cmd) return '空命令'
  // 允许 2>/dev/null、2>&1 这类不影响文件的丢弃；其它 > / >> 一律视为写操作
  const cleaned = cmd.replace(/\d?>\s*\/dev\/null/g, '').replace(/2>&1/g, '')
  if (cleaned.includes('>')) return '命令包含输出重定向「>」，会写入文件'
  // 命令替换/反引号里可能藏写操作，计划模式一律不猜
  if (cleaned.includes('$(') || cleaned.includes('`')) return '命令包含命令替换 $() 或反引号，无法判定是否只读'
  const segments = cleaned.split(/\s*(?:;|&&|\|\||\|)\s*/).map(s => s.trim()).filter(Boolean)
  if (!segments.length) return '空命令'
  for (const seg of segments) {
    const tokens = seg.split(/\s+/)
    const head = tokens[0]
    if (!READONLY_COMMANDS.has(head)) return `第一个不允许的命令「${head}」（分段：${clip(seg)}）`
    if (head === 'git') {
      const sub = tokens[1] ?? ''
      if (!GIT_READONLY.has(sub)) return `git 子命令「${sub || '(空)'}」不是只读（分段：${clip(seg)}）`
      if (sub === 'branch' && !tokens.some(t => t === '--show-current' || t === '-a' || t === '-v' || t === '-vv')) {
        return `git branch 只允许查看（--show-current/-a/-v）（分段：${clip(seg)}）`
      }
    }
    if (head === 'sed' && tokens.some(t => t === '-i' || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t))) {
      return `sed -i 会原地改文件（分段：${clip(seg)}）`
    }
    if (head === 'find' && tokens.some(t => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(t))) {
      return `find 的删除/执行参数会改文件（分段：${clip(seg)}）`
    }
  }
  return undefined
}

export function isReadOnlyBash(command: string): boolean {
  return bashReadOnlyReason(command) === undefined
}

/** 平台/shell 提示：Windows 上的 bash 工具跑在 Git Bash 里，不能用 cmd 专属语法 */
function platformSection(): string {
  if (process.platform === 'win32') {
    return '[环境] 平台：Windows。bash 工具由 Git Bash（POSIX shell）执行：用 ls/cat/grep/sed 等 POSIX 语法，'
      + '不要用 dir /b 这类 cmd 专属命令；路径用正斜杠（如 F:/Project/x）或加引号，注意反斜杠会被当作转义符。'
  }
  return `[环境] 平台：${process.platform === 'darwin' ? 'macOS' : 'Linux'}。bash 工具直接执行 POSIX shell 命令。`
}

export const plugin: Plugin = {
  name: 'shell-tools',
  apply(ctx) {
    // 平台/shell 提示注入系统提示：避免模型在 Windows 上用 cmd 专属语法（如 dir /b）
    ctx.hooks.registerSystemSection(() => platformSection())
    ctx.tools.register({
      name: 'bash',
      description: '在会话工作目录执行一条 shell 命令，返回退出码与输出尾部。构建、测试、git 等短命令用前台（默认等 120 秒）；dev server / 客户端这类长跑命令用 run_in_background:true，立即拿 terminalId，再用 terminal_read / terminal_kill 管它。执行前会请求用户授权。命令按 POSIX shell 语法写：Windows 上由 Git Bash 执行（不要用 dir /b 这类 cmd 专属命令）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令（POSIX/bash 语法；Windows 上由 Git Bash 执行，无 Git Bash 时才退化为 cmd）' },
          description: { type: 'string', description: '一句话说明这条命令干什么（面板展示用）' },
          workdir: { type: 'string', description: '工作目录，默认会话工作目录' },
          timeoutMs: { type: 'number', description: `前台等待上限（毫秒），默认 ${DEFAULT_TIMEOUT}，最大 ${MAX_TIMEOUT}；超时后命令转入后台继续跑` },
          run_in_background: { type: 'boolean', description: '后台运行并立即返回 terminalId' },
        },
        required: ['command', 'description'],
      },
      mutates: true,
      planSafe: args => isReadOnlyBash(String(args?.command ?? '')),
      planDeniedReason: args => bashReadOnlyReason(String(args?.command ?? '')),
      requiresApproval: args => `执行命令：${clip(String(args?.command ?? ''))}`,
      async execute(args, exec) {
        const command = String(args.command ?? '').trim()
        if (!command) return { forModel: 'command 不能为空', isError: true }
        const cwd = workdir(args, exec)
        const sid = exec.sessionId
        if (args.run_in_background) {
          const t = ctx.terminals.open({ sessionId: sid, command, cwd, title: clip(String(args.description ?? command), 40) })
          return {
            forModel: `已在后台终端 ${t.id} 启动（cwd: ${t.cwd}）。用 terminal_read 读输出、terminal_kill 结束；右侧「终端」标签能实时看到。`,
          }
        }
        // 前台一次性命令：退出后不进终端列表（前端标签不堆积），输出仍可直接读到
        const t = ctx.terminals.open({ sessionId: sid, command, cwd, title: clip(String(args.description ?? command), 40), ephemeral: true })
        const timeout = Math.min(MAX_TIMEOUT, Math.max(1000, Number(args.timeoutMs) || DEFAULT_TIMEOUT))
        const r = await ctx.terminals.wait(sid, t.id, timeout)
        const out = ctx.terminals.output(sid, t.id, TAIL_CHARS) ?? ''
        // 前台 ephemeral 命令结束后不保留终端，不要把临时 tty id 暴露给模型去 terminal_read
        const head = r.timedOut
          ? `${t.id} ${fmtExit(r)}，用 terminal_read ${t.id} 继续看输出、terminal_kill 结束`
          : fmtExit(r)
        return { forModel: `${head}\n${out || '（没有输出）'}`, isError: r.exitCode != null && r.exitCode !== 0 }
      },
    })

    ctx.tools.register({
      name: 'terminal_open',
      description: '拉起一个终端：给命令就在里面跑（dev server、日志跟随、长时间任务），不传命令则开一个交互 shell（输出可在右侧「终端」标签查看，用户也能接手输入）。立即返回 terminalId。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要常驻运行的命令；省略则开交互 shell' },
          title: { type: 'string', description: '终端标题（面板展示）' },
          workdir: { type: 'string', description: '工作目录，默认会话工作目录' },
        },
        required: [],
      },
      mutates: true,
      requiresApproval: args => `拉起终端${args?.command ? `并执行：${clip(String(args.command))}` : '（交互 shell）'}`,
      async execute(args, exec) {
        const cwd = workdir(args, exec)
        const command = String(args.command ?? '').trim()
        const title = clip(String(args.title ?? ''), 40)
        const t = command
          ? ctx.terminals.open({ sessionId: exec.sessionId, command, cwd, title })
          : ctx.terminals.openShell({ sessionId: exec.sessionId, cwd, title })
        const tail = ctx.terminals.output(exec.sessionId, t.id, 1500) ?? ''
        return {
          forModel: `终端 ${t.id} 已${command ? '启动' : '打开'}（cwd: ${t.cwd}${command ? `，命令：${clip(command)}` : ''}）。`
            + `${tail ? `\n当前输出：\n${tail}` : ''}\n可用 terminal_read / terminal_send / terminal_kill 管理。`,
        }
      },
    })

    ctx.tools.register({
      name: 'terminal_list',
      description: '列出本会话拉起过的终端：id、状态（运行中/已退出）、退出码、命令、工作目录。',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) {
        const rows = ctx.terminals.list(exec.sessionId)
        if (!rows.length) return { forModel: '本会话还没有终端。' }
        return {
          forModel: rows.map(t => {
            const state = t.status === 'running' ? '运行中' : `已退出（${t.exitCode ?? '?'}${t.signal ? ` · ${t.signal}` : ''}）`
            return `- ${t.id} · ${state} · ${t.title || t.command || 'shell'} · ${t.cwd}`
          }).join('\n'),
        }
      },
    })

    ctx.tools.register({
      name: 'terminal_read',
      description: '读某个终端最近的输出（默认末尾 8000 字符）。后台命令、dev server 都用它看进展，不要反复 terminal_open。',
      parameters: {
        type: 'object',
        properties: {
          terminal_id: { type: 'string', description: '终端 id（terminal_open / bash 返回）' },
          tail_chars: { type: 'number', description: '读末尾多少字符，默认 8000，最大 60000' },
        },
        required: ['terminal_id'],
      },
      async execute(args, exec) {
        const id = String(args.terminal_id ?? '')
        const info = ctx.terminals.list(exec.sessionId).find(t => t.id === id)
        if (!info) return { forModel: `本会话没有终端 ${id}（用 terminal_list 看有哪些）`, isError: true }
        const n = Math.max(200, Math.min(60_000, Number(args.tail_chars) || 8000))
        const out = ctx.terminals.output(exec.sessionId, id, n) ?? ''
        const state = info.status === 'running' ? '运行中' : `已退出（${info.exitCode ?? '?'}）`
        return { forModel: `${id} · ${state}\n${out || '（没有输出）'}` }
      },
    })

    ctx.tools.register({
      name: 'terminal_send',
      description: '向运行中的终端写入文本（交互式命令的输入）。submit 默认 true 会补一个换行（相当于回车）。',
      parameters: {
        type: 'object',
        properties: {
          terminal_id: { type: 'string', description: '终端 id' },
          text: { type: 'string', description: '要写入的内容' },
          submit: { type: 'boolean', description: '是否自动补换行，默认 true' },
        },
        required: ['terminal_id', 'text'],
      },
      mutates: true,
      requiresApproval: args => `向终端 ${args?.terminal_id ?? ''} 发送输入`,
      async execute(args, exec) {
        const id = String(args.terminal_id ?? '')
        const text = String(args.text ?? '')
        const ok = ctx.terminals.write(exec.sessionId, id, args.submit === false ? text : `${text}\n`)
        if (!ok) return { forModel: `终端 ${id} 不在运行或不可写（用 terminal_list 确认）`, isError: true }
        return { forModel: `已写入 ${id}。稍后用 terminal_read 看结果。` }
      },
    })

    ctx.tools.register({
      name: 'terminal_kill',
      description: '结束一个终端（整棵进程树）。长时间运行的 dev server / gradle runClient 不想留后台时用它。',
      parameters: {
        type: 'object',
        properties: { terminal_id: { type: 'string', description: '终端 id' } },
        required: ['terminal_id'],
      },
      mutates: true,
      requiresApproval: args => `结束终端 ${args?.terminal_id ?? ''}`,
      async execute(args, exec) {
        const id = String(args.terminal_id ?? '')
        const info = ctx.terminals.list(exec.sessionId).find(t => t.id === id)
        if (!info) return { forModel: `本会话没有终端 ${id}（用 terminal_list 看有哪些）`, isError: true }
        if (info.status !== 'running') return { forModel: `终端 ${id} 已经退出（${info.exitCode ?? '?'}），无需结束。` }
        ctx.terminals.kill(exec.sessionId, id)
        return { forModel: `已发送结束信号给 ${id}。` }
      },
    })
  },
}

export default plugin
