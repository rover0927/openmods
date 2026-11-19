// Java 后台进程探测（仅 Windows）：Gradle daemon / gradlew 启动器 / Minecraft 客户端。
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

export function listJavaProcesses(): { ok: boolean; error?: string; processes: JavaProcInfo[] } {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows 进程检测', processes: [] }
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
  const order: Record<JavaProcKind, number> = { 'gradle-daemon': 0, 'gradle-launcher': 1, 'minecraft-client': 2 }
  processes.sort((a, b) => (order[a.kind] - order[b.kind]) || (a.startedAt - b.startedAt))
  return { ok: true, processes }
}

function killPid(pid: number): { ok: boolean; error?: string } {
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
