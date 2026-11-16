// 工作区文件工具：read / write / edit / list_dir / glob / grep。
//
// 与 dsh packages/fs 的对应关系：
//   read  = 行号化文本读取（offset/limit）
//   write = 创建或整体覆盖
//   edit  = 字面量替换（默认要求唯一命中）
//   glob / grep = 在目录树里按文件名 / 内容找
// 路径一律相对会话工作目录解析（dsh session.header.cwd）；工作目录外的读写会先请求用户授权。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Plugin, ToolExecContext } from '@openmods/plugin-kit'

const MAX_READ_CHARS = 400_000
const MAX_GREP_FILE = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', '.gradle-home', '.gradle', 'dist', 'build', '.idea', '.vscode'])

interface Resolved {
  abs: string
  /** 是否落在会话工作目录内（决定要不要授权） */
  inside: boolean
}

function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function resolvePath(cwd: string | undefined, p: string): Resolved {
  const root = cwd || process.cwd()
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  // 已存在的路径用真实路径比对（符号链接不能绕出工作目录）；不存在就按字面比对
  const rootReal = existsSync(root) ? resolve(root) : root
  const absReal = existsSync(abs) ? resolve(abs) : abs
  const a = normCase(absReal)
  const r = normCase(rootReal)
  const inside = a === r || a.startsWith(r.endsWith(sep) ? r : r + sep)
  return { abs: absReal, inside }
}

function outsideReason(verb: string) {
  return (args: any, exec: ToolExecContext): string | null => {
    const raw = typeof args?.file_path === 'string' ? args.file_path
      : typeof args?.path === 'string' ? args.path : ''
    if (!raw) return null
    try {
      const r = resolvePath(exec.session.cwd, raw)
      return r.inside ? null : `${verb}工作目录外的路径：${r.abs}`
    } catch {
      return null
    }
  }
}

function relPath(cwd: string | undefined, abs: string): string {
  const root = cwd || process.cwd()
  const rel = relative(root, abs)
  return (rel || '.').split(sep).join('/')
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 极简 glob：** / * / ? / {a,b}，不引入依赖 */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(',').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        re += `(?:${alts.join('|')})`
        i = end
      } else re += '\\{'
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

function walk(root: string, onFile: (abs: string) => boolean | void, maxFiles = 20_000) {
  let seen = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) { stack.push(abs); continue }
      if (!st.isFile()) continue
      if (++seen > maxFiles) return
      if (onFile(abs) === false) return
    }
  }
}

export const plugin: Plugin = {
  name: 'fs-tools',
  apply(ctx) {
    ctx.tools.register({
      name: 'read',
      description: '读取一个 UTF-8 文本文件，返回带行号的内容（可用 offset/limit 分段读）。读大文件先看行数再分段，不要一次全塞进上下文。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径；相对路径以会话工作目录为根' },
          offset: { type: 'number', description: '起始行（1 起），默认 1' },
          limit: { type: 'number', description: '最多返回多少行，默认 2000' },
        },
        required: ['file_path'],
      },
      requiresApproval: outsideReason('读取'),
      async execute(args, exec) {
        const { abs } = resolvePath(exec.session.cwd, String(args.file_path ?? ''))
        if (!existsSync(abs)) return { forModel: `文件不存在：${abs}`, isError: true }
        const st = statSync(abs)
        if (st.isDirectory()) return { forModel: `这是目录，不是文件：${abs}（用 list_dir 看目录内容）`, isError: true }
        const buf = readFileSync(abs)
        if (isBinary(buf)) {
          return { forModel: `二进制文件（${(buf.length / 1024).toFixed(1)} KB），不能按文本读取：${abs}`, isError: true }
        }
        const text = buf.toString('utf8')
        const all = text.split('\n')
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
        const limit = Math.max(1, Math.min(5000, Math.floor(Number(args.limit) || 2000)))
        const slice = all.slice(offset - 1, offset - 1 + limit)
        let body = slice.map((line, i) => `${String(offset + i).padStart(6, ' ')}→${line}`).join('\n')
        let truncated = false
        if (body.length > MAX_READ_CHARS) { body = body.slice(0, MAX_READ_CHARS); truncated = true }
        const tail = offset - 1 + slice.length < all.length
          ? `\n… 还有 ${all.length - (offset - 1 + slice.length)} 行（用 offset=${offset + slice.length} 继续读）`
          : ''
        return {
          forModel: `${relPath(exec.session.cwd, abs)} · 共 ${all.length} 行\n${body}${truncated ? '\n…（超出单次读取上限，已截断）' : ''}${tail}`,
        }
      },
    })

    ctx.tools.register({
      name: 'write',
      description: '创建文件或整体覆盖内容（UTF-8）。会创建缺失的父目录。改已有文件优先用 edit，避免覆盖掉没读到的内容。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径；相对路径以会话工作目录为根' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['file_path', 'content'],
      },
      mutates: true,
      requiresApproval: outsideReason('写入'),
      async execute(args, exec) {
        const abs = resolvePath(exec.session.cwd, String(args.file_path ?? '')).abs
        const content = String(args.content ?? '')
        const existed = existsSync(abs)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, 'utf8')
        return {
          forModel: `${existed ? '已覆盖' : '已创建'} ${relPath(exec.session.cwd, abs)}（${content.split('\n').length} 行，${Buffer.byteLength(content)} 字节）`,
        }
      },
    })

    ctx.tools.register({
      name: 'edit',
      description: '按字面量替换修改已有文件：old_string 必须在文件里唯一出现（或用 replace_all）。只替换完全一致的文本，不猜、不做模糊匹配。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径；相对路径以会话工作目录为根' },
          old_string: { type: 'string', description: '要替换的原文（含缩进，逐字一致）' },
          new_string: { type: 'string', description: '替换后的文本；空字符串表示删除' },
          replace_all: { type: 'boolean', description: '替换所有匹配，默认 false（只允许唯一命中）' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      mutates: true,
      requiresApproval: outsideReason('修改'),
      async execute(args, exec) {
        const abs = resolvePath(exec.session.cwd, String(args.file_path ?? '')).abs
        if (!existsSync(abs)) return { forModel: `文件不存在：${abs}`, isError: true }
        const before = readFileSync(abs, 'utf8')
        const oldStr = String(args.old_string ?? '')
        const newStr = String(args.new_string ?? '')
        if (!oldStr) return { forModel: 'old_string 不能为空', isError: true }
        const count = before.split(oldStr).length - 1
        if (count === 0) {
          return { forModel: `没有找到 old_string（逐字匹配失败）。先 read 一遍目标文件确认原文与缩进。`, isError: true }
        }
        if (count > 1 && !args.replace_all) {
          return { forModel: `old_string 出现了 ${count} 次，无法确定改哪一处。请扩大上下文使其唯一，或传 replace_all:true。`, isError: true }
        }
        const after = args.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr)
        writeFileSync(abs, after, 'utf8')
        return { forModel: `已修改 ${relPath(exec.session.cwd, abs)}（替换 ${args.replace_all ? count : 1} 处）` }
      },
    })

    ctx.tools.register({
      name: 'list_dir',
      description: '列出目录内容（子目录 / 文件 / 大小）。不确定工程结构时先看它，再决定读哪个文件。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录路径，默认会话工作目录' } },
        required: [],
      },
      requiresApproval: outsideReason('列出'),
      async execute(args, exec) {
        const abs = resolvePath(exec.session.cwd, String(args.path ?? '.')).abs
        if (!existsSync(abs)) return { forModel: `目录不存在：${abs}`, isError: true }
        const st = statSync(abs)
        if (!st.isDirectory()) return { forModel: `这不是目录：${abs}`, isError: true }
        const rows: string[] = []
        const names = readdirSync(abs).sort((a, b) => a.localeCompare(b, 'zh-CN'))
        for (const name of names) {
          if (name === '.git' || name === 'node_modules') { rows.push(`${name}/  (跳过)`); continue }
          let info
          try { info = statSync(join(abs, name)) } catch { continue }
          rows.push(info.isDirectory()
            ? `${name}/`
            : `${name}  ${(info.size / 1024).toFixed(1)} KB`)
        }
        return { forModel: `${relPath(exec.session.cwd, abs)}/\n${rows.join('\n') || '（空目录）'}` }
      },
    })

    ctx.tools.register({
      name: 'glob',
      description: '按文件名模式找文件（支持 **、*、?、{a,b}），返回相对工作目录的路径。找东西优先用它，不要一层层 list_dir。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 **/*.java、src/**/*.tsx' },
          path: { type: 'string', description: '搜索根目录，默认会话工作目录' },
          limit: { type: 'number', description: '最多返回多少个，默认 200' },
        },
        required: ['pattern'],
      },
      requiresApproval: outsideReason('搜索'),
      async execute(args, exec) {
        const root = resolvePath(exec.session.cwd, String(args.path ?? '.')).abs
        if (!existsSync(root)) return { forModel: `目录不存在：${root}`, isError: true }
        const re = globToRegExp(String(args.pattern ?? '*'))
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 200))
        const hits: string[] = []
        walk(root, abs => {
          const rel = relPath(root, abs)
          if (re.test(rel)) hits.push(rel)
          if (hits.length >= limit) return false
        })
        return {
          forModel: hits.length
            ? `找到 ${hits.length} 个（根：${relPath(exec.session.cwd, root)}）：\n${hits.join('\n')}`
            : `没有匹配 ${args.pattern} 的文件（根：${relPath(exec.session.cwd, root)}）`,
        }
      },
    })

    ctx.tools.register({
      name: 'grep',
      description: '在目录树里按正则搜索文件内容，返回 路径:行号: 内容。找实现、找引用优先用它。默认跳过 node_modules/.git/构建目录与二进制文件。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式（JavaScript 语法）' },
          path: { type: 'string', description: '搜索根目录，默认会话工作目录' },
          glob: { type: 'string', description: '只搜匹配这个 glob 的文件，如 **/*.java' },
          case_sensitive: { type: 'boolean', description: '区分大小写，默认 false' },
          max_results: { type: 'number', description: '最多返回多少条匹配，默认 100' },
        },
        required: ['pattern'],
      },
      requiresApproval: outsideReason('搜索'),
      async execute(args, exec) {
        const root = resolvePath(exec.session.cwd, String(args.path ?? '.')).abs
        if (!existsSync(root)) return { forModel: `目录不存在：${root}`, isError: true }
        let re: RegExp
        try {
          re = new RegExp(String(args.pattern ?? ''), args.case_sensitive ? '' : 'i')
        } catch (e: any) {
          return { forModel: `正则不合法：${e.message}`, isError: true }
        }
        const fileRe = args.glob ? globToRegExp(String(args.glob)) : null
        const max = Math.max(1, Math.min(500, Number(args.max_results) || 100))
        const hits: string[] = []
        walk(root, abs => {
          const rel = relPath(root, abs)
          if (fileRe && !fileRe.test(rel)) return
          let st
          try { st = statSync(abs) } catch { return }
          if (st.size > MAX_GREP_FILE) return
          let buf: Buffer
          try { buf = readFileSync(abs) } catch { return }
          if (isBinary(buf)) return
          const lines = buf.toString('utf8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
            if (hits.length >= max) return false
          }
        })
        return {
          forModel: hits.length
            ? `匹配 ${hits.length} 条（根：${relPath(exec.session.cwd, root)}）：\n${hits.join('\n')}`
            : `没有匹配 /${args.pattern}/ 的内容（根：${relPath(exec.session.cwd, root)}）`,
        }
      },
    })
  },
}

export default plugin
