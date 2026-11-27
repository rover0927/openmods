// 自更新：检查 GitHub 上的 openmods main，由用户手动确认后 git pull + 重建前端。
// 不自动改动工作区；有未提交的跟踪文件时支持自动 git stash 暂存后更新。
import { spawn, spawnSync } from 'node:child_process'
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
  /** 落后时列出的新提交（最多 10 条，最新在前） */
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
  stashed?: boolean
  build?: 'ok' | 'failed' | 'skipped'
  output?: string
  needsRestart?: boolean
}

let applying = false

const GIT_MISSING = '未检测到 Git，请到 设置 → 环境 配置 Git 路径（安装：https://git-scm.com）'

/** Git 可执行文件：设置 → 环境 保存的路径优先，否则用 PATH 里的 git */
function gitBinary(): string {
  return process.env.OPENMODS_GIT?.trim() || 'git'
}

/** 探测 Git 是否可执行：返回中文错误消息，可用时返回 undefined */
function gitMissing(): string | undefined {
  const r = spawnSync(gitBinary(), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  const err = r.error as NodeJS.ErrnoException | undefined
  if (err?.code === 'ENOENT') return GIT_MISSING
  if (r.status !== 0) return `Git 无法执行（${gitBinary()}），请到 设置 → 环境 检查 Git 路径`
  return undefined
}

function git(args: string[], timeout = 60_000) {
  return spawnSync(gitBinary(), args, {
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

function gitError(r: { status: number | null; stdout?: string; stderr?: string; error?: Error }): string {
  // spawn 找不到可执行文件时不抛异常，只在 error 上带 ENOENT
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return GIT_MISSING
  return String(r.stderr ?? '').trim() || String(r.stdout ?? '').trim() || `git 退出码 ${r.status ?? -1}`
}

/** 异步执行进程（用于 fetch / merge / npm install / npm run build，避免阻塞 Fastify 事件循环） */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; shell?: boolean },
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: opts.shell ?? false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolve({ status: -1, stdout, stderr: `${stderr}\n执行超时（${Math.round(opts.timeout / 1000)}s）`.trim() })
    }, opts.timeout)
    child.stdout?.on('data', d => { stdout += String(d) })
    child.stderr?.on('data', d => { stderr += String(d) })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: -1, stdout, stderr, error: err })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
}

function gitAsync(args: string[], timeout = 60_000) {
  return spawnAsync(gitBinary(), args, { timeout })
}

function commitOfRef(ref: string): UpdateCommit | undefined {
  const raw = gitOut(['show', '-s', '--format=%H%x09%s%x09%aI%x09%an', ref])
  if (!raw) return undefined
  const [sha, subject, date, author] = raw.split('\t')
  return { sha, short: sha.slice(0, 7), subject: subject ?? '', date: date ?? '', author: author ?? '' }
}

function localCommit(): UpdateCommit | undefined {
  return commitOfRef('HEAD')
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
    // Git 缺失与"不是仓库"都会让 rev-parse 失败：先给可操作的安装提示，再退回目录提示
    const missing = gitMissing()
    if (missing) return { ...base, error: missing }
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
      // compare 的 base=本地、head=远端：ahead_by 是远端独有提交（本地落后），
      // behind_by 是本地独有提交（本地领先）。不能直接把 cmp.status 当成本地状态。
      const remoteOnly = Number(cmp.ahead_by ?? 0)
      const localOnly = Number(cmp.behind_by ?? 0)
      base.aheadBy = localOnly
      base.behindBy = remoteOnly
      base.state = remoteOnly > 0 && localOnly > 0
        ? 'diverged'
        : remoteOnly > 0
          ? 'behind'
          : localOnly > 0
            ? 'ahead'
            : 'identical'
      base.commits = Array.isArray(cmp.commits) ? cmp.commits.slice(-10).map(mapCommit).reverse() : []
    }
  } catch (apiErr: any) {
    // GitHub REST API 限流（403）或不可达时，自动回退到 git fetch origin main + 本地对比
    const fetched = await gitAsync(['fetch', 'origin', BRANCH], 45_000)
    const remote = commitOfRef(`origin/${BRANCH}`)
    if (fetched.status === 0 && remote) {
      base.remote = remote
      if (base.local.sha === remote.sha) {
        base.state = 'identical'
      } else {
        const counts = gitOut(['rev-list', '--left-right', '--count', `HEAD...origin/${BRANCH}`])
        const [localOnlyStr, remoteOnlyStr] = counts.split(/\s+/)
        const localOnly = Number(localOnlyStr) || 0
        const remoteOnly = Number(remoteOnlyStr) || 0
        base.aheadBy = localOnly
        base.behindBy = remoteOnly
        base.state = remoteOnly > 0 && localOnly > 0
          ? 'diverged'
          : remoteOnly > 0
            ? 'behind'
            : localOnly > 0
              ? 'ahead'
              : 'identical'
        if (remoteOnly > 0) {
          const logRaw = gitOut(['log', '-n', '10', '--format=%H%x09%s%x09%aI%x09%an', `HEAD..origin/${BRANCH}`])
          base.commits = logRaw
            ? logRaw.split(/\r?\n/).filter(Boolean).map(line => {
                const [sha, subject, date, author] = line.split('\t')
                return { sha, short: sha.slice(0, 7), subject: subject ?? '', date: date ?? '', author: author ?? '' }
              })
            : []
        }
      }
    } else {
      base.error = `检查远端失败：${apiErr?.message ?? apiErr}`
    }
  }
  return base
}

function runNpmAsync(args: string[], timeout: number) {
  return spawnAsync('npm', args, {
    timeout,
    shell: process.platform === 'win32',
  })
}

/** 拉取最新代码并重建前端；完成后需要用户重启服务 */
export async function applyUpdate(opts?: { autoStash?: boolean }): Promise<UpdateApplyResult> {
  if (applying) return { ok: false, error: '已有更新正在进行，请稍候' }
  applying = true
  try {
    const missing = gitMissing()
    if (missing) return { ok: false, error: missing }
    if (gitOut(['rev-parse', '--is-inside-work-tree']) !== 'true') {
      return { ok: false, error: '当前目录不是 git 仓库，无法自更新' }
    }
    const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch && branch !== BRANCH) {
      return { ok: false, error: `当前在 ${branch} 分支，请先切回 ${BRANCH}` }
    }
    const dirty = dirtyFiles()
    let stashed = false
    if (dirty.length) {
      if (!opts?.autoStash) {
        return { ok: false, error: `有 ${dirty.length} 个未提交改动，请先提交或勾选自动暂存：${dirty.slice(0, 5).join('、')}` }
      }
      const stashRes = await gitAsync(['stash', 'push', '-m', `openmods-auto-update-${new Date().toISOString()}`], 30_000)
      if (stashRes.status !== 0) {
        return { ok: false, error: `自动暂存本地改动失败：${gitError(stashRes)}` }
      }
      stashed = true
    }
    const before = gitOut(['rev-parse', 'HEAD'])
    if (!before) return { ok: false, error: '读不到本地提交' }

    const fetched = await gitAsync(['fetch', 'origin', BRANCH], 180_000)
    if (fetched.status !== 0) {
      return { ok: false, error: `git fetch 失败：${gitError(fetched)}`, stashed }
    }
    const merged = await gitAsync(['merge', '--ff-only', `origin/${BRANCH}`], 120_000)
    if (merged.status !== 0) {
      return { ok: false, error: `git merge 失败：${gitError(merged)}`, stashed }
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
        const install = await runNpmAsync(['install'], 10 * 60_000)
        output += `\n[npm install]\n${install.stdout ?? ''}${install.stderr ?? ''}`
        if (install.status !== 0) {
          return {
            ok: true, before, after, changed, stashed, build: 'failed', needsRestart: true,
            output: output.trim().slice(-4000),
            error: '代码已更新，但 npm install 失败，请手动处理',
          }
        }
      }
      const built = await runNpmAsync(['run', 'build'], 5 * 60_000)
      output += `\n[npm run build]\n${built.stdout ?? ''}${built.stderr ?? ''}`
      build = built.status === 0 ? 'ok' : 'failed'
    }
    return {
      ok: true,
      before,
      after,
      changed,
      stashed,
      build,
      needsRestart: before !== after,
      output: output.trim().slice(-4000),
      ...(build === 'failed' ? { error: '代码已更新，但前端构建失败，请手动 npm run build' } : {}),
    }
  } finally {
    applying = false
  }
}
