// 自更新：检查 GitHub 上的 openmods main，由用户手动确认后 git pull + 重建前端。
// 不自动改动工作区；有未提交的跟踪文件时拒绝更新。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REPO = 'rover0927/openmods'
const BRANCH = 'main'

export interface UpdateCommit {
  sha: string
  short: string
  subject: string
  date: string
  author: string
}

export type UpdateState = 'identical' | 'behind' | 'ahead' | 'diverged' | 'unknown'

export interface UpdateStatus {
  repo: string
  branch: string
  local?: UpdateCommit
  remote?: UpdateCommit
  state: UpdateState
  aheadBy: number
  behindBy: number
  /** 落后时列出的新提交（最多 10 条） */
  commits: UpdateCommit[]
  dirty: boolean
  dirtyFiles: string[]
  error?: string
}

export interface UpdateApplyResult {
  ok: boolean
  error?: string
  before?: string
  after?: string
  changed?: string[]
  build?: 'ok' | 'failed' | 'skipped'
  output?: string
  needsRestart?: boolean
}

let applying = false

function git(args: string[], timeout = 60_000) {
  return spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function gitOut(args: string[], timeout = 60_000): string {
  const r = git(args, timeout)
  return r.status === 0 ? String(r.stdout ?? '').trim() : ''
}

function gitError(r: ReturnType<typeof spawnSync>): string {
  return String(r.stderr ?? '').trim() || String(r.stdout ?? '').trim() || `git 退出码 ${r.status ?? -1}`
}

function localCommit(): UpdateCommit | undefined {
  const raw = gitOut(['show', '-s', '--format=%H%x09%s%x09%aI%x09%an', 'HEAD'])
  if (!raw) return undefined
  const [sha, subject, date, author] = raw.split('\t')
  return { sha, short: sha.slice(0, 7), subject: subject ?? '', date: date ?? '', author: author ?? '' }
}

function dirtyFiles(): string[] {
  // 不能对整体 output 做 trim：第一行是 " M path"，trim 会吃掉前导空格导致切错路径
  const r = git(['status', '--porcelain', '--untracked-files=no'])
  if (r.status !== 0) return []
  const raw = String(r.stdout ?? '').replace(/\r?\n$/, '')
  if (!raw) return []
  return raw.split(/\r?\n/).map(l => l.slice(3).trim()).filter(Boolean).slice(0, 30)
}

async function api(path: string): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { 'User-Agent': 'openmods', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function mapCommit(c: any): UpdateCommit {
  const message = String(c?.commit?.message ?? '')
  return {
    sha: String(c?.sha ?? ''),
    short: String(c?.sha ?? '').slice(0, 7),
    subject: message.split(/\r?\n/)[0] ?? '',
    date: String(c?.commit?.author?.date ?? ''),
    author: String(c?.commit?.author?.name ?? ''),
  }
}

/** 检查本地 HEAD 与 GitHub main 的差异 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    repo: REPO,
    branch: '',
    state: 'unknown',
    aheadBy: 0,
    behindBy: 0,
    commits: [],
    dirty: false,
    dirtyFiles: [],
  }
  if (gitOut(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { ...base, error: '当前目录不是 git 仓库，无法自更新（可用 Releases 覆盖安装）' }
  }
  base.branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || BRANCH
  base.local = localCommit()
  base.dirtyFiles = dirtyFiles()
  base.dirty = base.dirtyFiles.length > 0
  if (!base.local) return { ...base, error: '读不到本地 git 提交' }

  try {
    const remoteCommit = await api(`/repos/${REPO}/commits/${BRANCH}`)
    base.remote = mapCommit(remoteCommit)
    if (base.local.sha === base.remote.sha) {
      base.state = 'identical'
    } else {
      const cmp = await api(`/repos/${REPO}/compare/${base.local.sha}...${base.remote.sha}`)
      base.state = cmp.status === 'ahead' || cmp.status === 'behind' || cmp.status === 'diverged'
        ? cmp.status
        : 'unknown'
      base.aheadBy = Number(cmp.ahead_by ?? 0)
      base.behindBy = Number(cmp.behind_by ?? 0)
      base.commits = Array.isArray(cmp.commits) ? cmp.commits.slice(-10).map(mapCommit) : []
    }
  } catch (e: any) {
    base.error = `检查远端失败：${e?.message ?? e}`
  }
  return base
}

function runNpm(args: string[], timeout: number) {
  return spawnSync('npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    shell: process.platform === 'win32',
  })
}

/** 拉取最新代码并重建前端；完成后需要用户重启服务 */
export async function applyUpdate(): Promise<UpdateApplyResult> {
  if (applying) return { ok: false, error: '已有更新正在进行，请稍候' }
  applying = true
  try {
    if (gitOut(['rev-parse', '--is-inside-work-tree']) !== 'true') {
      return { ok: false, error: '当前目录不是 git 仓库，无法自更新' }
    }
    const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch && branch !== BRANCH) {
      return { ok: false, error: `当前在 ${branch} 分支，请先切回 ${BRANCH}` }
    }
    const dirty = dirtyFiles()
    if (dirty.length) {
      return { ok: false, error: `有 ${dirty.length} 个未提交改动，请先提交或暂存：${dirty.slice(0, 5).join('、')}` }
    }
    const before = gitOut(['rev-parse', 'HEAD'])
    if (!before) return { ok: false, error: '读不到本地提交' }

    const fetched = git(['fetch', 'origin', BRANCH], 180_000)
    if (fetched.status !== 0) {
      return { ok: false, error: `git fetch 失败：${gitError(fetched)}` }
    }
    const merged = git(['merge', '--ff-only', `origin/${BRANCH}`], 120_000)
    if (merged.status !== 0) {
      return { ok: false, error: `git merge 失败：${gitError(merged)}` }
    }
    const after = gitOut(['rev-parse', 'HEAD'])
    const changed = gitOut(['diff', '--name-only', before, after])
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)

    let build: UpdateApplyResult['build'] = 'skipped'
    let output = ''
    if (before !== after) {
      const packageChanged = changed.some(p => p === 'package.json' || p === 'package-lock.json')
      if (packageChanged) {
        const install = runNpm(['install'], 10 * 60_000)
        output += `\n[npm install]\n${install.stdout ?? ''}${install.stderr ?? ''}`
        if (install.status !== 0) {
          return {
            ok: true, before, after, changed, build: 'failed', needsRestart: true,
            output: output.trim().slice(-4000),
            error: '代码已更新，但 npm install 失败，请手动处理',
          }
        }
      }
      const built = runNpm(['run', 'build'], 5 * 60_000)
      output += `\n[npm run build]\n${built.stdout ?? ''}${built.stderr ?? ''}`
      build = built.status === 0 ? 'ok' : 'failed'
    }
    return {
      ok: true,
      before,
      after,
      changed,
      build,
      needsRestart: before !== after,
      output: output.trim().slice(-4000),
      ...(build === 'failed' ? { error: '代码已更新，但前端构建失败，请手动 npm run build' } : {}),
    }
  } finally {
    applying = false
  }
}
