// 独立 Forge 1.20.1 生产测试客户端：安装 / 同步 mods / 启动 / 状态 / 停止。
//
// 与 mcdev 的 runClient 不同：这里启动的是**生产客户端**，选中的构建 jar 放进
// <clientDir>/mods/，适合多个模组联调。客户端目录默认在 data/mc-test-client，
// 也可在设置里用 testClientDir 指向已有的 .minecraft。
import { spawn, spawnSync } from 'node:child_process'
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TEST_ROOT = join(ROOT, 'data', 'mc-test-client')
const MINECRAFT_DIR = join(TEST_ROOT, '.minecraft')
const STATE_FILE = join(TEST_ROOT, 'state.json')
const MODS_MANIFEST = join(TEST_ROOT, 'mods.json')
const CONSOLE_LOG = join(TEST_ROOT, 'client-console.log')
const INSTALL_LOG = join(TEST_ROOT, 'install.log')
const INSTALLER = join(
  ROOT,
  'plugins/mcdev/vendor/fg-maven/net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-installer.jar',
)
const FORGE_VERSION_ID = '1.20.1-forge-47.4.10'
const VANILLA_VERSION_ID = '1.20.1'

export type TestClientPhase = 'idle' | 'installing' | 'starting' | 'running' | 'exited' | 'error'

export interface TestClientJar {
  name: string
  data: Buffer
  source: 'library' | 'build'
}

export interface TestClientStatus {
  phase: TestClientPhase
  running: boolean
  pid?: number
  startedAt?: number
  selected: { name: string; source: 'library' | 'build' }[]
  logTail: string
  projectDir?: string
  error?: string
}

interface TestClientState {
  phase: TestClientPhase
  pid?: number
  startedAt?: number
  selected: { name: string; source: 'library' | 'build' }[]
  clientDir?: string
  error?: string
}

let busy = false

function javaExe(tool = 'java'): string {
  const home = process.env.JAVA_HOME ?? 'F:/sdk_java/jdk-17'
  const p = join(home, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool)
  return existsSync(p) ? p : tool
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Windows 控制台/客户端日志可能是 GBK；先 UTF-8，出现替换字符再按 GB18030 */
function decodeText(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gb18030').decode(buf) } catch { return utf8 }
}

function readText(path: string): string {
  try { return decodeText(readFileSync(path)) } catch { return '' }
}

function tailLines(text: string, lines: number): string {
  return text.split(/\r?\n/).slice(-Math.max(1, lines)).join('\n')
}

function readState(): TestClientState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as TestClientState
    return s && typeof s === 'object' ? s : { phase: 'idle', selected: [] }
  } catch {
    return { phase: 'idle', selected: [] }
  }
}

function writeState(state: TestClientState) {
  try {
    mkdirSync(TEST_ROOT, { recursive: true })
    const tmp = `${STATE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    try { renameSync(tmp, STATE_FILE) } catch {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
      try { unlinkSync(tmp) } catch { /* 忽略 */ }
    }
  } catch { /* 状态写失败不阻塞启动 */ }
}

function versionJson(clientDir: string, id: string): string {
  return join(clientDir, 'versions', id, `${id}.json`)
}

function hasForge(clientDir: string): boolean {
  return existsSync(versionJson(clientDir, FORGE_VERSION_ID)) && existsSync(versionJson(clientDir, VANILLA_VERSION_ID))
}

/** 运行一个长期进程并把输出写进日志；返回退出码 */
function runLogged(cmd: string, args: string[], opts: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  log: string
  timeoutMs: number
}): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    mkdirSync(TEST_ROOT, { recursive: true })
    const out = createWriteStream(opts.log, { flags: 'w' })
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? TEST_ROOT,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(out)
    child.stderr?.pipe(out)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch { /* 已退出 */ }
    }, opts.timeoutMs)
    child.on('error', e => { clearTimeout(timer); out.end(); reject(e) })
    child.on('exit', code => {
      clearTimeout(timer)
      out.end()
      if (timedOut) reject(new Error(`安装器超时（${Math.round(opts.timeoutMs / 1000)}s）`))
      else resolvePromise(code ?? -1)
    })
  })
}

/** 安装测试客户端：Forge installer 的 --installClient <dir> 直接装到受管目录 */
async function installClient(): Promise<string> {
  if (!existsSync(INSTALLER)) throw new Error(`缺少 Forge 安装器：${INSTALLER}`)
  mkdirSync(MINECRAFT_DIR, { recursive: true })
  const profiles = join(MINECRAFT_DIR, 'launcher_profiles.json')
  if (!existsSync(profiles)) writeFileSync(profiles, '{ "profiles": {} }')

  const code = await runLogged(javaExe(), [
    '-Djava.awt.headless=true', '-jar', INSTALLER, '--installClient', MINECRAFT_DIR,
  ], {
    log: INSTALL_LOG,
    timeoutMs: 15 * 60_000,
  })
  if (hasForge(MINECRAFT_DIR)) return MINECRAFT_DIR

  const log = readText(INSTALL_LOG)
  const hint = code !== 0 ? `安装器退出码 ${code}` : '安装器未生成 Forge 版本文件'
  throw new Error(`${hint}。${tailLines(log, 20)}`)
}

async function ensureClient(prefDir?: string): Promise<string> {
  const custom = String(prefDir ?? '').trim()
  if (custom) {
    const dir = resolve(custom)
    if (hasForge(dir)) return dir
    throw new Error(`测试客户端目录里没有 Forge ${FORGE_VERSION_ID}：${dir}`)
  }
  if (hasForge(MINECRAFT_DIR)) return MINECRAFT_DIR
  return installClient()
}

/** 清理上次管理的 jar，再写入本次选中的 jar；不碰用户手动放进 mods 的文件 */
function syncMods(clientDir: string, jars: TestClientJar[]) {
  const modsDir = join(clientDir, 'mods')
  mkdirSync(modsDir, { recursive: true })
  let previous: string[] = []
  try {
    const m = JSON.parse(readFileSync(MODS_MANIFEST, 'utf8'))
    previous = Array.isArray(m?.files) ? m.files.map(String) : []
  } catch { /* 没有清单 */ }
  for (const f of previous) {
    try { unlinkSync(join(modsDir, basename(f))) } catch { /* 已不存在 */ }
  }
  const used = new Set<string>()
  const files: string[] = []
  for (const jar of jars) {
    let name = basename(jar.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'mod.jar'
    if (!/\.jar$/i.test(name)) name = `${name}.jar`
    let candidate = name
    let n = 2
    while (used.has(candidate.toLowerCase())) candidate = name.replace(/\.jar$/i, `-${n++}.jar`)
    used.add(candidate.toLowerCase())
    writeFileSync(join(modsDir, candidate), jar.data)
    files.push(candidate)
  }
  mkdirSync(TEST_ROOT, { recursive: true })
  writeFileSync(MODS_MANIFEST, JSON.stringify({ files, updatedAt: Date.now() }, null, 2))
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function libPath(lib: any): string | undefined {
  if (lib?.downloads?.artifact?.path) return String(lib.downloads.artifact.path)
  const name = String(lib?.name ?? '')
  const parts = name.split(':')
  if (parts.length < 3) return undefined
  const [group, artifact, version, classifier] = parts
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
}

function nativePath(lib: any): string | undefined {
  if (!lib?.natives || process.platform !== 'win32') return undefined
  const cls = String(lib.natives.windows ?? '').replace('${arch}', process.arch.includes('64') ? '64' : '32')
  const d = cls ? lib?.downloads?.classifiers?.[cls] : undefined
  return d?.path ? String(d.path) : undefined
}

/** 合并版本 JSON 的 libraries：非 native 按 group:artifact 去重，子版本（Forge）覆盖父版本 */
function mergeLibraries(vanilla: any, forge: any): any[] {
  const map = new Map<string, any>()
  for (const lib of [...(vanilla?.libraries ?? []), ...(forge?.libraries ?? [])]) {
    if (!lib?.name) continue
    const key = String(lib.name).split(':').slice(0, 2).join(':')
    // native 条目也保留；classpath 阶段只取 artifact
    if (lib.natives) {
      map.set(`${key}:natives`, lib)
    } else {
      map.set(key, lib)
    }
  }
  return [...map.values()]
}

function buildLaunch(clientDir: string): { args: string[]; cwd: string } {
  const vanilla = readJson(versionJson(clientDir, VANILLA_VERSION_ID))
  const forge = readJson(versionJson(clientDir, FORGE_VERSION_ID))
  const librariesDir = join(clientDir, 'libraries')
  const nativesDir = join(clientDir, 'natives')
  const assetsDir = join(clientDir, 'assets')
  const assetsIndex = String(vanilla?.assetIndex?.id ?? '5')

  const libs = mergeLibraries(vanilla, forge)
  const cp: string[] = []
  const nativeJars: string[] = []
  const missing: string[] = []
  for (const lib of libs) {
    const np = nativePath(lib)
    if (np) {
      const abs = join(librariesDir, np)
      if (existsSync(abs)) nativeJars.push(abs)
      else missing.push(np)
    }
    const p = libPath(lib)
    if (!p) continue
    const abs = join(librariesDir, p)
    if (existsSync(abs)) cp.push(abs)
    else if (!np) missing.push(p)
  }
  const vanillaJar = join(clientDir, 'versions', VANILLA_VERSION_ID, `${VANILLA_VERSION_ID}.jar`)
  const forgeJar = join(clientDir, 'versions', FORGE_VERSION_ID, `${FORGE_VERSION_ID}.jar`)
  if (existsSync(vanillaJar)) cp.push(vanillaJar)
  else missing.push(vanillaJar)
  if (existsSync(forgeJar)) cp.push(forgeJar)
  if (missing.length) throw new Error(`测试客户端缺少 ${missing.length} 个库/文件，例如 ${missing.slice(0, 3).join('、')}`)

  // 解压 natives（生产客户端需要 DLL）
  const jarTool = javaExe('jar')
  rmSync(nativesDir, { recursive: true, force: true })
  mkdirSync(nativesDir, { recursive: true })
  for (const jar of nativeJars) {
    const r = spawnSync(jarTool, ['xf', jar], { cwd: nativesDir, windowsHide: true })
    if (r.status !== 0) throw new Error(`解压 natives 失败：${basename(jar)}`)
  }

  const vars: Record<string, string> = {
    library_directory: librariesDir,
    classpath_separator: delimiter,
    classpath: cp.join(delimiter),
    natives_directory: nativesDir,
    launcher_name: 'openmods',
    launcher_version: '0.1.0',
    version_name: FORGE_VERSION_ID,
    game_directory: clientDir,
    assets_root: assetsDir,
    assets_index_name: assetsIndex,
    auth_player_name: 'Dev',
    auth_uuid: '00000000-0000-0000-0000-000000000000',
    auth_access_token: '0',
    user_type: 'legacy',
    version_type: 'release',
    user_properties: '{}',
    clientid: '',
    auth_xuid: '',
    resolution_width: '1280',
    resolution_height: '720',
  }
  const replace = (s: string) => s.replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] ?? '')
  const jvmRaw = [...(vanilla?.arguments?.jvm ?? []), ...(forge?.arguments?.jvm ?? [])]
    .filter((a: any) => typeof a === 'string')
    .map(replace)
  const gameRaw = [...(vanilla?.arguments?.game ?? []), ...(forge?.arguments?.game ?? [])]
    .filter((a: any) => typeof a === 'string')
    .map(replace)

  const jvm = [...jvmRaw]
  if (!jvm.some(a => a === '-Djava.library.path' || a.startsWith('-Djava.library.path='))) {
    jvm.push(`-Djava.library.path=${nativesDir}`)
  }
  if (!jvm.includes('-cp') && !jvm.includes('-classpath')) jvm.push('-cp', cp.join(delimiter))
  if (!jvm.some(a => a.startsWith('-Dminecraft.launcher.brand='))) jvm.push('-Dminecraft.launcher.brand=openmods')
  if (!jvm.some(a => a.startsWith('-Dminecraft.launcher.version='))) jvm.push('-Dminecraft.launcher.version=0.1.0')

  const game = [...gameRaw]
  const addIfMissing = (flag: string, value: string) => {
    if (!game.includes(flag)) game.push(flag, value)
  }
  addIfMissing('--gameDir', clientDir)
  addIfMissing('--assetsDir', assetsDir)
  addIfMissing('--assetIndex', assetsIndex)
  addIfMissing('--username', 'Dev')
  addIfMissing('--uuid', '00000000-0000-0000-0000-000000000000')
  addIfMissing('--accessToken', '0')
  addIfMissing('--userType', 'legacy')
  addIfMissing('--version', FORGE_VERSION_ID)
  addIfMissing('--versionType', 'release')

  const mainClass = String(forge?.mainClass ?? vanilla?.mainClass ?? '')
  if (!mainClass) throw new Error('版本 JSON 没有 mainClass')
  return { args: [...jvm, mainClass, ...game], cwd: clientDir }
}

function launch(clientDir: string, selected: TestClientState['selected']) {
  const { args, cwd } = buildLaunch(clientDir)
  mkdirSync(TEST_ROOT, { recursive: true })
  const out = createWriteStream(CONSOLE_LOG, { flags: 'w' })
  const child = spawn(javaExe(), args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!child.pid) throw new Error('Java 进程启动失败')
  child.on('error', e => {
    writeState({ phase: 'error', selected, clientDir, error: e.message })
  })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  child.unref()
  writeState({
    phase: 'starting',
    pid: child.pid,
    startedAt: Date.now(),
    selected,
    clientDir,
  })
}

/** 启动测试客户端：异步安装/同步/拉起，调用方立即返回 */
export async function startTestClient(jars: TestClientJar[], opts: { testClientDir?: string } = {}): Promise<void> {
  if (busy) throw new Error('测试客户端正在安装或启动，请稍候')
  if (!jars.length) throw new Error('至少选择一个 jar')
  busy = true
  // 同一时间只保留一个测试客户端：先停旧进程，避免 jar 被占用/双开
  const prev = readState()
  if (prev.pid && pidAlive(prev.pid)) stopTestClient()
  const selected = jars.map(j => ({ name: j.name, source: j.source }))
  writeState({ phase: 'installing', selected })
  try {
    const clientDir = await ensureClient(opts.testClientDir)
    writeState({ phase: 'starting', selected, clientDir })
    syncMods(clientDir, jars)
    launch(clientDir, selected)
  } catch (e: any) {
    writeState({ phase: 'error', selected, error: e?.message ?? String(e) })
    throw e
  } finally {
    busy = false
  }
}

export function testClientBusy(): boolean {
  return busy
}

function latestLog(clientDir: string, startedAt?: number): string {
  const p = join(clientDir, 'logs', 'latest.log')
  try {
    const st = statSync(p)
    // 只认本次启动之后的日志，避免拿上一局当本次结果
    if (!startedAt || st.mtimeMs >= startedAt - 5000) return readText(p)
  } catch { /* 没有 latest.log */ }
  return ''
}

export function getTestClientStatus(tail = 120): TestClientStatus {
  const s = readState()
  const alive = !!s.pid && pidAlive(s.pid)
  const log = s.clientDir ? latestLog(s.clientDir, s.startedAt) : ''
  const console = readText(CONSOLE_LOG)
  let phase: TestClientPhase = s.phase
  if (s.phase === 'error') phase = 'error'
  else if (s.phase === 'installing') phase = busy ? 'installing' : 'error'
  else if (alive) phase = /Sound engine started/.test(log) ? 'running' : 'starting'
  else if (s.pid) phase = 'exited'
  else phase = 'idle'
  const source = log || console
  return {
    phase,
    running: alive,
    pid: s.pid,
    startedAt: s.startedAt,
    selected: Array.isArray(s.selected) ? s.selected : [],
    logTail: tailLines(source, Math.max(10, Math.min(400, tail))),
    projectDir: s.clientDir ?? MINECRAFT_DIR,
    error: s.error,
  }
}

/** 停止测试客户端（整棵进程树） */
export function stopTestClient(): boolean {
  const s = readState()
  if (!s.pid || !pidAlive(s.pid)) {
    writeState({ ...s, phase: s.phase === 'installing' ? 'installing' : 'exited', pid: undefined })
    return false
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(s.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try { process.kill(-s.pid, 'SIGTERM') } catch { try { process.kill(s.pid, 'SIGTERM') } catch { /* 已退出 */ } }
  }
  const until = Date.now() + 2000
  while (pidAlive(s.pid) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  writeState({ ...s, phase: 'exited', pid: undefined })
  return true
}

/** 测试客户端目录（供状态展示） */
export function testClientDir(): string {
  return readState().clientDir ?? MINECRAFT_DIR
}

/** 读取上次管理的 mods 清单（调试/测试用） */
export function readModsManifest(): string[] {
  try {
    const m = JSON.parse(readFileSync(MODS_MANIFEST, 'utf8'))
    return Array.isArray(m?.files) ? m.files.map(String) : []
  } catch { return [] }
}

export { TEST_ROOT, MINECRAFT_DIR }
