// 极简 Markdown 渲染（不引依赖）：助手正文里常见的标题/加粗/行内代码/列表/围栏代码块。
// 安全策略：先整体 HTML 转义，再只放行我们自己生成的标签 —— 原文里的任何 HTML 都当纯文本。
import type { ReactNode } from 'react'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内样式：`code` → **bold** → *em* → [text](url) */
function inline(raw: string): string {
  let s = esc(raw)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  // 只放行 http(s) 链接，避免 javascript: 之类的伪协议
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return s
}

const BLOCK_START = /^(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/

export function MessageText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) buf.push(lines[i++])
      i++ // 跳过收尾围栏
      out.push(
        <pre className="md-pre" key={`c${i}`}>
          {lang && <span className="md-lang">{lang}</span>}
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      out.push(
        <div className={`md-h md-h${level}`} key={`h${i}`} dangerouslySetInnerHTML={{ __html: inline(h[2]) }} />,
      )
      i++
      continue
    }

    // 无序 / 有序列表（连续行成一组）
    const bullet = /^[-*+]\s+(.*)$/
    const ordered = /^(\d+)[.)]\s+(.*)$/
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line)
      const items: ReactNode[] = []
      while (i < lines.length) {
        const b = bullet.exec(lines[i])
        const o = ordered.exec(lines[i])
        if (!b && !o) break
        const body = b ? b[1] : o![2]
        items.push(
          <li key={`i${i}`} dangerouslySetInnerHTML={{ __html: inline(body) }} />,
        )
        i++
      }
      out.push(isOrdered
        ? <ol className="md-list" key={`l${i}`}>{items}</ol>
        : <ul className="md-list" key={`l${i}`}>{items}</ul>)
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      out.push(
        <blockquote className="md-quote" key={`q${i}`} dangerouslySetInnerHTML={{ __html: inline(buf.join('\n')) }} />,
      )
      continue
    }

    // 段落：连续的非空、非块起始行合并
    if (line.trim() === '') { i++; continue }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && (buf.length === 0 || !BLOCK_START.test(lines[i]))) {
      buf.push(lines[i++])
    }
    out.push(
      <p className="md-p" key={`p${i}`} dangerouslySetInnerHTML={{ __html: inline(buf.join('\n')) }} />,
    )
  }

  return <div className="md">{out}</div>
}
