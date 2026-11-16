// 终端服务：主代理「拉起终端 / 结束终端」的落点，也是右侧「终端」标签的数据源。
//
// 与 dsh 的关系：dsh 有 PTY 服务（terminal-bash）+ jobs 工具；openmods 用
// child_process 的管道实现同一件可用的事——保留输出环形缓冲、状态、退出码，
// 支持 stdin 写入与整棵进程树终止。没有 PTY 那套光标/尺寸协议，够跑构建与 dev server。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const MAX_OUTPUT = 240_000
/** 前台一次性命令（bash 非 background）退出后，输出缓冲的保留时间：前端标签已移除，仅供 bash 工具回读 */
const EPHEMERAL_TTL_MS = 120_000

export interface TerminalSummary {
  id: string
  sessionId: string
  title: string
  command: string
  cwd: string
  status: 'running' | 'exited'
  exitCode: number | null
  signal?: string
  startedAt: number
  endedAt?: number
  /** 输出被截断过的字节数（环形缓冲丢掉的旧内容） */
  truncatedChars: number
  /** 前台一次性命令：进程退出后立即从 list() 隐藏（输出缓冲保留到 TTL，供 bash 工具读取） */
  ephemeral: boolean
}

interface TerminalEntry extends TerminalSummary {
  proc: ChildProcessWithoutNullStreams
  output: string
  waiters: Set<(ev: { exitCode: number | null; signal?: string }) => void>
  /** ephemeral 条目退出后的清理定时器 */
  cleanupTimer?: NodeJS.Timeout
}

interface ShellSpec {
  cmd: string
  /** 一次性命令 */
  commandArgs(command: string): string[]
  /** 交互式（拉起一个空终端给用户用） */
  interactiveArgs(): string[]
  label: string
}

/** 选 shell：优先 env 覆盖，其次 Git Bash（Windows 上用 bash 语法），最后系统默认 */
function detectShell(): ShellSpec {
  const override = process.env.OPENMODS_SHELL
  if (override) {
    const parts = override.trim().split(/\s+/)
    const cmd = parts[0]
    const base = parts.slice(1)
    return {
      cmd,
      label: override,
      commandArgs: command => [...base, command],
      interactiveArgs: () => [...base],
    }
  }
  if (process.platform === 'win32') {
    for (const candidate of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]) {
      if (existsSync(candidate)) {
        return {
          cmd: candidate,
          label: 'bash (Git for Windows)',
          commandArgs: command => ['-lc', command],
          interactiveArgs: () => ['-l'],
        }
      }
    }
    const comspec = process.env.ComSpec || 'cmd.exe'
    return {
      cmd: comspec,
      label: 'cmd',
      // cmd 默认代码页是 GBK：先切 UTF-8，否则 javac/gradle 的中文告警是乱码
      commandArgs: command => ['/d', '/s', '/c', `chcp 65001>nul && ${command}`],
      interactiveArgs: () => ['/d', '/s', '/k', 'chcp 65001>nul'],
    }
  }
  const bash = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return {
    cmd: bash,
    label: bash,
    commandArgs: command => ['-lc', command],
    interactiveArgs: () => ['-l'],
  }
}

export interface TerminalManager {
  shellLabel: string
  /** ephemeral=true：前台一次性命令，进程退出后自动从 list() 隐藏（输出缓冲保留 TTL） */
  open(opts: { sessionId: string; command: string; cwd: string; title?: string; ephemeral?: boolean }): TerminalSummary
  /** 拉起一个空交互终端（用户点「新建终端」用；模型也能用） */
  openShell(opts: { sessionId: string; cwd: string; title?: string }): TerminalSummary
  list(sessionId: string): TerminalSummary[]
  get(id: string): TerminalSummary | undefined
  output(id: string, tailChars?: number): string | undefined
  write(id: string, text: string): boolean
  kill(id: string, signal?: NodeJS.Signals): boolean
  /** 关闭（移除）一个终端；运行中的先结束进程树。前端标签的关闭按钮 / 全部清空都走它 */
  close(id: string): boolean
  closeSession(sessionId: string): number
  wait(id: string, timeoutMs: number): Promise<{ exitCode: number | null; signal?: string; timedOut: boolean }>
  killSession(sessionId: string): number
  killAll(): void
}

/** Windows 下统一 UTF-8 环境：Python 与 JVM（javac/gradle）默认不吃代码页，必须显式指定 */
function utf8Env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return base
  const jvm = '-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8'
  return {
    ...base,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    JAVA_TOOL_OPTIONS: base.JAVA_TOOL_OPTIONS ? `${base.JAVA_TOOL_OPTIONS} ${jvm}` : jvm,
  }
}


export function createTerminalManager(opts: {
  emit: (sessionId: string, topic: string, data: any) => void
}): TerminalManager {
  const shell = detectShell()
  const entries = new Map<string, TerminalEntry>()
  let counter = 0

  function summarize(t: TerminalEntry): TerminalSummary {
    const { proc: _proc, output: _output, waiters: _waiters, cleanupTimer: _timer, ...rest } = t
    return rest
  }

  function append(t: TerminalEntry, stream: 'stdout' | 'stderr', chunk: string) {
    if (!chunk) return
    t.output += chunk
    if (t.output.length > MAX_OUTPUT) {
      const excess = t.output.length - MAX_OUTPUT
      t.output = t.output.slice(excess)
      t.truncatedChars += excess
    }
    opts.emit(t.sessionId, 'terminal/data', {
      terminalId: t.id, stream, chunk, at: Date.now(),
    })
  }

  function finish(t: TerminalEntry, exitCode: number | null, signal?: string) {
    if (t.status === 'exited') return
    t.status = 'exited'
    t.exitCode = exitCode
    t.endedAt = Date.now()
    if (signal) t.signal = signal
    opts.emit(t.sessionId, 'terminal/exit', {
      terminalId: t.id, exitCode, signal, endedAt: t.endedAt, ephemeral: t.ephemeral,
    })
    for (const w of t.waiters) w({ exitCode, signal })
    t.waiters.clear()
    // 前台一次性命令：标签立即消失（list 过滤掉已退出的 ephemeral），输出留一小段时间给 bash 工具回读
    if (t.ephemeral) {
      t.cleanupTimer = setTimeout(() => {
        if (entries.get(t.id) === t) entries.delete(t.id)
      }, EPHEMERAL_TTL_MS)
      t.cleanupTimer.unref?.()
    }
  }

  function start(
    sessionId: string,
    cwd: string,
    command: string,
    title: string,
    interactive: boolean,
    ephemeral: boolean,
  ): TerminalEntry {
    counter++
    const id = `tty-${counter}`
    const args = interactive ? shell.interactiveArgs() : shell.commandArgs(command)
    const proc = spawn(shell.cmd, args, {
      cwd,
      env: utf8Env({ ...process.env, TERM: 'xterm-256color', OPENMODS_TERMINAL: id }),
      windowsHide: true,
      stdio: 'pipe',
    })
    const entry: TerminalEntry = {
      id,
      sessionId,
      title: title || (interactive ? 'shell' : command.slice(0, 60)),
      command: interactive ? '' : command,
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      truncatedChars: 0,
      ephemeral,
      proc,
      output: '',
      waiters: new Set(),
    }
    entries.set(id, entry)
    // utf8 解码走 StringDecoder：非法字节替换成 U+FFFD，不会抛错（cmd/java 输出混编码也不会炸）
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => append(entry, 'stdout', d))
    proc.stderr.on('data', (d: string) => append(entry, 'stderr', d))
    proc.on('error', err => {
      append(entry, 'stderr', `\n[terminal error] ${err.message}\n`)
      finish(entry, null, 'spawn-error')
    })
    proc.on('close', (code, sig) => finish(entry, code, sig ?? undefined))
    opts.emit(sessionId, 'terminal/open', summarize(entry))
    return entry
  }

  return {
    shellLabel: shell.label,

    open({ sessionId, command, cwd, title, ephemeral }) {
      return summarize(start(sessionId, cwd, command, title ?? '', false, !!ephemeral))
    },

    openShell({ sessionId, cwd, title }) {
      return summarize(start(sessionId, cwd, '', title ?? 'shell', true, false))
    },

    list(sessionId) {
      return [...entries.values()]
        .filter(t => t.sessionId === sessionId)
        // 前台一次性命令退出即从列表消失（前端标签随 terminal/exit 移除）；输出缓冲仍在，供 bash 回读
        .filter(t => !(t.ephemeral && t.status === 'exited'))
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(summarize)
    },

    get(id) {
      const t = entries.get(id)
      return t ? summarize(t) : undefined
    },

    output(id, tailChars = 8000) {
      const t = entries.get(id)
      if (!t) return undefined
      return t.output.length > tailChars ? `…（已截断）\n${t.output.slice(-tailChars)}` : t.output
    },

    write(id, text) {
      const t = entries.get(id)
      if (!t || t.status !== 'running' || !t.proc.stdin.writable) return false
      t.proc.stdin.write(text)
      return true
    },

    kill(id, signal) {
      const t = entries.get(id)
      if (!t || t.status !== 'running') return false
      const pid = t.proc.pid
      if (!pid) return false
      if (process.platform === 'win32') {
        // 进程树：cmd/bash 会再 fork 出 gradle 之类的子进程，只杀父进程会留孤儿
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        try { t.proc.kill(signal ?? 'SIGTERM') } catch { /* 已退出 */ }
        setTimeout(() => { try { if (t.status === 'running') t.proc.kill('SIGKILL') } catch { /* 已退出 */ } }, 2000)
      }
      return true
    },

    close(id) {
      const t = entries.get(id)
      if (!t) return false
      if (t.cleanupTimer) clearTimeout(t.cleanupTimer)
      // 运行中的先收进程树，再移除条目：前端标签立刻消失，不会再收到"已退出"的残留条目
      if (t.status === 'running') this.kill(id)
      entries.delete(id)
      opts.emit(t.sessionId, 'terminal/close', { terminalId: id })
      return true
    },

    closeSession(sessionId) {
      let n = 0
      for (const id of [...entries.keys()]) {
        const t = entries.get(id)
        if (!t || t.sessionId !== sessionId) continue
        n++
        this.close(id)
      }
      return n
    },

    wait(id, timeoutMs) {
      const t = entries.get(id)
      if (!t) return Promise.resolve({ exitCode: null, timedOut: false })
      if (t.status === 'exited') return Promise.resolve({ exitCode: t.exitCode, signal: t.signal, timedOut: false })
      return new Promise(resolve => {
        let done = false
        const timer = setTimeout(() => {
          if (done) return
          done = true
          t.waiters.delete(onExit)
          resolve({ exitCode: null, timedOut: true })
        }, Math.max(100, timeoutMs))
        const onExit = (ev: { exitCode: number | null; signal?: string }) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({ ...ev, timedOut: false })
        }
        t.waiters.add(onExit)
      })
    },

    killSession(sessionId) {
      let n = 0
      for (const id of [...entries.keys()]) {
        const t = entries.get(id)
        if (!t || t.sessionId !== sessionId) continue
        if (t.status === 'running') { n++; this.kill(id) }
        if (t.cleanupTimer) clearTimeout(t.cleanupTimer)
        // 会话结束（删除/归档）：条目全部回收，不留任何残留
        entries.delete(id)
      }
      return n
    },

    killAll() {
      for (const id of [...entries.keys()]) {
        const t = entries.get(id)
        if (!t) continue
        if (t.status === 'running') this.kill(id)
        if (t.cleanupTimer) clearTimeout(t.cleanupTimer)
        entries.delete(id)
      }
    },
  }
}
