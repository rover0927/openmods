// Java 后台进程探测（Windows / Linux）：Gradle daemon / gradlew 启动器 / Minecraft 客户端。
// 供前端浮窗自动检测与手动结束；结束接口只允许操作本模块列表里的 PID，避免误杀任意进程。
import { spawnSync } from 'node:child_process'

export type JavaProcKind = 'gradle-daemon' | 'gradle-launcher' | 'minecraft-client'

export interface JavaProcInfo {
  pid: number
  ppid: number
  kind: JavaProcKind
  /** 命令行（超长截断），用于展示与用户判断 */
  cmd: string
  memoryMB: number
  /** CPU 时间（用户态 + 内核态，秒） */
  cpuSec: number
  /** 进程启动时间（epoch ms；取不到为 0） */
  startedAt: number
}

/** 只认这三类，其它 java.exe（IDE / 其它项目）不展示也不允许结束 */
function classify(cmd: string): JavaProcKind | null {
  if (/GradleDaemon|gradle-daemon-main/i.test(cmd)) return 'gradle-daemon'
  if (/gradle-wrapper\.jar|org\.gradle\.launcher\.GradleMain|-Dorg\.gradle\.appname=gradlew/i.test(cmd)) return 'gradle-launcher'
  if (/net\.minecraftforge|--fml\.|cpw\.mods\.bootstraplauncher|net\.minecraft\.client\.main\.Main/i.test(cmd)) return 'minecraft-client'
  return null
}

/** ps 的 etime / time：`[[dd-]hh:]mm:ss` → 秒 */
function parseElapsed(raw: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(raw ?? '').trim())
  if (!m) return 0
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4])
}

/** Linux：只列当前用户的 java 进程，避免“全部结束”碰到别人的 Gradle */
function listLinuxProcesses(): { ok: boolean; error?: string; processes: JavaProcInfo[] } {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const r = spawnSync('ps', [
    ...(uid === undefined ? [] : ['-u', String(uid)]),
    '-o', 'pid=,ppid=,rss=,etime=,time=,comm=,args=',
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  })
  if (r.error) return { ok: false, error: `检测失败：${r.error.message}`, processes: [] }
  if (r.status !== 0) {
    return { ok: false, error: (String(r.stderr ?? '').trim() || `ps 退出码 ${r.status}`).slice(0, 300), processes: [] }
  }
  const now = Date.now()
  const processes: JavaProcInfo[] = []
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    // 列：pid ppid rss(KB) etime time comm args（args 可含空格，放最后整段取）
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!m) continue
    const [, pid, ppid, rss, etime, cputime, comm, cmdRaw] = m
    if (!/^java(w)?$/i.test(comm)) continue
    const cmd = cmdRaw.trim()
    const kind = classify(cmd)
    if (!kind) continue
    const elapsed = parseElapsed(etime)
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      kind,
      cmd: cmd.length > 500 ? `${cmd.slice(0, 500)}…` : cmd,
      memoryMB: Math.round(Number(rss) / 1024),
      cpuSec: parseElapsed(cputime),
      startedAt: elapsed > 0 ? now - elapsed * 1000 : 0,
    })
  }
  return { ok: true, processes }
}

function sortProcesses(processes: JavaProcInfo[]): JavaProcInfo[] {
  const order: Record<JavaProcKind, number> = { 'gradle-daemon': 0, 'gradle-launcher': 1, 'minecraft-client': 2 }
  return processes.sort((a, b) => (order[a.kind] - order[b.kind]) || (a.startedAt - b.startedAt))
}

export function listJavaProcesses(): { ok: boolean; error?: string; processes: JavaProcInfo[] } {
  if (process.platform === 'linux') {
    const r = listLinuxProcesses()
    return r.ok ? { ...r, processes: sortProcesses(r.processes) } : r
  }
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows / Linux 进程检测', processes: [] }
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process -Filter "Name=\'java.exe\'" |',
    "Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,UserModeTime,KernelModeTime,@{n='StartedAt';e={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' } }} |",
    'ConvertTo-Json -Compress',
  ].join(' ')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
  })
  if (r.error) return { ok: false, error: `检测失败：${r.error.message}`, processes: [] }
  if (r.status !== 0) {
    return { ok: false, error: (String(r.stderr ?? '').trim() || `PowerShell 退出码 ${r.status}`).slice(0, 300), processes: [] }
  }
  const raw = String(r.stdout ?? '').trim()
  if (!raw) return { ok: true, processes: [] }
  let data: any
  try { data = JSON.parse(raw) } catch { return { ok: false, error: '解析进程列表失败', processes: [] } }
  const rows: any[] = Array.isArray(data) ? data : [data]
  const processes: JavaProcInfo[] = []
  for (const p of rows) {
    const cmd = String(p?.CommandLine ?? '').trim()
    if (!cmd) continue
    const kind = classify(cmd)
    if (!kind) continue
    processes.push({
      pid: Number(p.ProcessId) || 0,
      ppid: Number(p.ParentProcessId) || 0,
      kind,
      cmd: cmd.length > 500 ? `${cmd.slice(0, 500)}…` : cmd,
      memoryMB: Math.round((Number(p.WorkingSetSize) || 0) / 1024 / 1024),
      cpuSec: Math.round(((Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0)) / 1e7),
      startedAt: p.StartedAt ? (Date.parse(String(p.StartedAt)) || 0) : 0,
    })
  }
  return { ok: true, processes: sortProcesses(processes) }
}

function killPid(pid: number): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') {
    // Linux：只允许结束本模块列出的进程（同用户），发送 SIGTERM 让它优雅退出
    try {
      process.kill(pid, 'SIGTERM')
    } catch (e: any) {
      return { ok: false, error: e?.code === 'ESRCH' ? '进程已不存在' : (e?.message ?? String(e)) }
    }
    return { ok: true }
  }
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 15_000 })
  if (r.error) return { ok: false, error: r.error.message }
  if (r.status !== 0) {
    return { ok: false, error: (String(r.stderr ?? '') || String(r.stdout ?? '') || `taskkill 退出码 ${r.status}`).trim().slice(0, 300) }
  }
  return { ok: true }
}

/** 结束单个进程：先确认它在可监控列表里（防止前端传入任意 PID） */
export function killJavaProcess(pid: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(pid) || pid <= 0) return { ok: false, error: 'pid 无效' }
  const list = listJavaProcesses()
  if (!list.ok) return { ok: false, error: list.error }
  if (!list.processes.some(p => p.pid === pid)) return { ok: false, error: `不是可监控的 Java 进程：${pid}` }
  return killPid(pid)
}

/** 批量结束：默认只结束 Gradle；includeClient 时连 Minecraft 客户端一起 */
export function killJavaProcesses(opts: { includeClient?: boolean } = {}): {
  ok: boolean
  killed: number[]
  failed: { pid: number; error: string }[]
} {
  const list = listJavaProcesses()
  if (!list.ok) return { ok: false, killed: [], failed: [] }
  const killed: number[] = []
  const failed: { pid: number; error: string }[] = []
  for (const p of list.processes) {
    if (p.kind === 'minecraft-client' && !opts.includeClient) continue
    const r = killPid(p.pid)
    if (r.ok) killed.push(p.pid)
    else failed.push({ pid: p.pid, error: r.error ?? '未知错误' })
  }
  return { ok: failed.length === 0, killed, failed }
}
