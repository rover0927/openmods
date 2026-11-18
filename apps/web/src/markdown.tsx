// 极简 Markdown 渲染（不引依赖）：标题 / 加粗 / 行内代码 / 嵌套列表 / 任务列表 /
// 表格 / 引用 / 分隔线 / 围栏代码块 / 图片。
// 安全策略：先整体 HTML 转义，再只放行我们自己生成的标签 —— 原文里的任何 HTML 都当纯文本。
import type { ReactNode } from 'react'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内样式：code 先占位，避免 code 里的星号被继续解析 */
function inline(raw: string): string {
  const codes: string[] = []
  let s = esc(raw)
  s = s.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy" />')
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`)
  return s
}

interface ListItem {
  text: string
  checked?: boolean
  ordered: boolean
  children: ListItem[]
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TASK_RE = /^\[([ xX])\]\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const BLOCK_START = /^(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.*\||\s*([-*_])(?:\s*\1){2,}\s*$)/

function indentOf(s: string): number {
  return s.replace(/\t/g, '  ').length
}

/** 递归解析缩进列表；子列表挂到上一项的 children */
function parseList(lines: string[], start: number, indent: number): { items: ListItem[]; next: number; ordered: boolean } {
  const items: ListItem[] = []
  const first = LIST_RE.exec(lines[start])
  const ordered = !!first && /\d/.test(first[2])
  let i = start
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i])
    if (!m) break
    const cur = indentOf(m[1])
    if (cur < indent) break
    if (cur > indent) {
      if (!items.length) break
      const child = parseList(lines, i, cur)
      items[items.length - 1].children.push(...child.items)
      i = child.next
      continue
    }
    let body = m[3]
    let checked: boolean | undefined
    const task = TASK_RE.exec(body)
    if (task) {
      checked = task[1].toLowerCase() === 'x'
      body = task[2]
    }
    items.push({ text: body, checked, ordered: /\d/.test(m[2]), children: [] })
    i++
  }
  return { items, next: i, ordered }
}

function renderList(items: ListItem[], key: string): ReactNode {
  const ordered = items[0]?.ordered
  const lis = items.map((it, idx) => (
    <li key={idx} className={it.checked !== undefined ? 'md-task' : undefined}>
      {it.checked !== undefined && <span className={`md-check ${it.checked ? 'on' : ''}`} />}
      <span dangerouslySetInnerHTML={{ __html: inline(it.text) }} />
      {it.children.length > 0 && renderList(it.children, `${key}-${idx}`)}
    </li>
  ))
  return ordered
    ? <ol className="md-list md-ol" key={key}>{lis}</ol>
    : <ul className="md-list md-ul" key={key}>{lis}</ul>
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
}

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
      i++
      out.push(
        <pre className="md-pre" key={`c${i}`}>
          {lang && <span className="md-lang">{lang}</span>}
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // 分隔线（要在列表之前判断，避免 --- 被当成列表）
    if (HR_RE.test(line)) {
      out.push(<hr className="md-hr" key={`r${i}`} />)
      i++
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

    // 表格：当前行含 |，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = tableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i++]))
      }
      out.push(
        <table className="md-table" key={`t${i}`}>
          <thead>
            <tr>{head.map((c, ci) => <th key={ci} dangerouslySetInnerHTML={{ __html: inline(c) }} />)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci} dangerouslySetInnerHTML={{ __html: inline(c) }} />)}</tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    // 无序 / 有序列表（递归支持缩进子列表）
    if (LIST_RE.test(line)) {
      const parsed = parseList(lines, i, indentOf(LIST_RE.exec(line)![1]))
      out.push(renderList(parsed.items, `l${i}`))
      i = parsed.next
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
