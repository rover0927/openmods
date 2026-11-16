// 工作区文件浏览（右侧「文件」标签的数据源）——
// 对应 dsh `ui-sidebar-files`：一次只列一层目录，点击文件在面板里预览。
//
// 安全边界：所有路径都必须落在 ROOT 之内（realpath 前缀校验），
// 越界一律 403。这是本地工具，但要防 ../ 穿越。
import { readdirSync, statSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

export interface FileEntry {
  name: string
  /** 相对 ROOT 的 POSIX 路径（前端只用这个值再发请求） */
  path: string
  type: 'dir' | 'file'
  size?: number
  mtime?: number
}

/** 文本预览白名单（其余按二进制处理，图片单独走 img 渲染） */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.env', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.htm', '.xml', '.svg',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.ps1', '.sql', '.gitignore',
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const MAX_TEXT_BYTES = 512 * 1024

export interface FileService {
  /** 列出目录（root 自身用 ''） */
  list(relPath: string): { path: string; entries: FileEntry[] }
  /** 读文本（超限截断，告知 truncated） */
  readText(relPath: string): { path: string; text: string; truncated: boolean; size: number }
  /** 读原始字节（图片预览） */
  readBytes(relPath: string): { path: string; bytes: Buffer; mediaType: string } | undefined
  /** 供 /api/fs 返回 root 展示名 */
  readonly root: string
}

/** 把外部传入的相对路径收束到 ROOT 之内
 * @param root 工作区根（绝对路径）
 * @param rel 相对路径（'' = 根）
 * @returns 绝对路径 */
function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel || '.')
  const rootReal = existsSync(root) ? realpathSync(root) : root
  const absReal = existsSync(abs) ? realpathSync(abs) : abs
  if (absReal !== rootReal && !absReal.startsWith(rootReal + sep)) {
    throw new Error('路径超出工作区范围')
  }
  return absReal
}

function toRel(root: string, abs: string): string {
  const r = relative(root, abs)
  return r.split(sep).join('/')
}

export function createFileService(root: string): FileService {
  const rootReal = existsSync(root) ? realpathSync(root) : root

  return {
    root: rootReal,

    list(relPath: string) {
      const abs = safeJoin(rootReal, relPath)
      const st = statSync(abs)
      if (!st.isDirectory()) throw new Error('不是目录')
      const entries: FileEntry[] = []
      for (const name of readdirSync(abs)) {
        if (name === 'node_modules' || name === '.git') continue
        let info
        try { info = statSync(join(abs, name)) } catch { continue }
        entries.push({
          name,
          path: toRel(rootReal, join(abs, name)),
          type: info.isDirectory() ? 'dir' : 'file',
          ...(info.isDirectory() ? {} : { size: info.size }),
          mtime: Math.round(info.mtimeMs),
        })
      }
      // 目录优先，再按名字（大小写不敏感）——dsh 的树也是稳定顺序
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1))
      return { path: toRel(rootReal, abs), entries }
    },

    readText(relPath: string) {
      const abs = safeJoin(rootReal, relPath)
      const st = statSync(abs)
      if (st.isDirectory()) throw new Error('这是目录')
      const bytes = readFileSync(abs)
      const truncated = bytes.length > MAX_TEXT_BYTES
      const slice = truncated ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes
      return { path: toRel(rootReal, abs), text: slice.toString('utf8'), truncated, size: bytes.length }
    },

    readBytes(relPath: string) {
      const abs = safeJoin(rootReal, relPath)
      const ext = extname(abs).toLowerCase()
      if (!IMAGE_EXT.has(ext)) return undefined
      const mediaType = ext === '.svg' ? 'image/svg+xml'
        : ext === '.png' ? 'image/png'
          : ext === '.webp' ? 'image/webp'
            : ext === '.gif' ? 'image/gif' : 'image/jpeg'
      return { path: toRel(rootReal, abs), bytes: readFileSync(abs), mediaType }
    },
  }
}

export function isTextPath(relPath: string): boolean {
  const ext = extname(relPath).toLowerCase()
  return TEXT_EXT.has(ext) || relPath.split('/').pop() === 'Dockerfile'
}

export function isImagePath(relPath: string): boolean {
  return IMAGE_EXT.has(extname(relPath).toLowerCase())
}
