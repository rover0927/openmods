// 终端面板：会话里所有终端（模型用 bash/terminal_open 拉起的、用户手动开的）都在这里。
// 输出通过会话 SSE 的 terminal/data 帧实时追加；结束后保留最后输出。
import { useEffect, useRef, useState } from 'react'
import type { TerminalDto } from '../types.js'

function statusText(t: TerminalDto): string {
  if (t.status === 'running') return '运行中'
  return `已退出 ${t.exitCode ?? '?'}${t.signal ? ` · ${t.signal}` : ''}`
}

export function TerminalPane(props: {
  terminals: TerminalDto[]
  /** terminalId → 已累积的输出 */
  output: Record<string, string>
  activeId: string | null
  shell?: string
  onSelect: (id: string) => void
  onKill: (id: string) => void
  /** command 为空 = 开交互 shell */
  onOpen: (command: string) => void
  onInput: (id: string, text: string) => void
}) {
  const { terminals, output, activeId } = props
  const active = terminals.find(t => t.id === activeId) ?? terminals[terminals.length - 1]
  const [command, setCommand] = useState('')
  const [line, setLine] = useState('')
  const preRef = useRef<HTMLPreElement>(null)
  const text = active ? (output[active.id] ?? '') : ''

  // 输出追加时贴底（用户往上翻会被打断这一点先不做，终端场景贴底更重要）
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  if (!terminals.length) {
    return (
      <div className="term-empty">
        <div className="ds-empty">
          还没有终端。<br />
          AI 用 bash / terminal_open 拉起的命令、或你在下面手动开的 shell 都会出现在这里。
        </div>
        <div className="term-new-row">
          <input
            className="term-new-input"
            placeholder="输入要常驻运行的命令（留空 = 开一个 shell）"
            value={command}
            onChange={e => setCommand(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && command.trim() !== '') { props.onOpen(command.trim()); setCommand('') } }}
          />
          <button className="dialog-btn" onClick={() => props.onOpen(command.trim())}>新建终端</button>
        </div>
      </div>
    )
  }

  return (
    <div className="term-pane">
      <div className="term-tabs">
        {terminals.map(t => (
          <button
            key={t.id}
            className={`term-tab ${active?.id === t.id ? 'active' : ''}`}
            onClick={() => props.onSelect(t.id)}
            title={`${t.command || 'shell'} · ${t.cwd}`}
          >
            <span className={`state-dot ${t.status === 'running' ? 'ongoing' : 'idle'}`} />
            <span className="term-tab-id">{t.id}</span>
            <span className="term-tab-title">{t.title || t.command || 'shell'}</span>
          </button>
        ))}
        <button
          className="term-tab-add"
          title="新建一个 shell 终端"
          onClick={() => props.onOpen('')}
        >＋</button>
      </div>

      {active && (
        <>
          <div className="term-meta">
            <span className="term-state">{statusText(active)}</span>
            <span className="dim term-cwd" title={active.cwd}>{active.cwd}</span>
            {active.status === 'running' && (
              <button className="term-kill" onClick={() => props.onKill(active.id)} title="结束这个终端（整棵进程树）">■ 结束</button>
            )}
          </div>
          <pre className="term-out" ref={preRef}>{text || '（还没有输出）'}</pre>
          {active.status === 'running' && (
            <div className="term-input-row">
              <input
                className="term-input"
                placeholder="向这个终端写入一行（回车提交）"
                value={line}
                onChange={e => setLine(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && line) {
                    props.onInput(active.id, line)
                    setLine('')
                  }
                }}
              />
              <button
                className="dialog-btn"
                disabled={!line}
                onClick={() => { props.onInput(active.id, line); setLine('') }}
              >提交</button>
            </div>
          )}
          <div className="term-foot dim">
            {props.shell ? `shell: ${props.shell} · ` : ''}非 PTY 管道：交互式命令的提示符可能被缓冲，适合构建 / dev server / 日志跟随。
          </div>
        </>
      )}
    </div>
  )
}
