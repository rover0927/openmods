// 独立 Forge 1.20.1 生产测试客户端：安装 / 同步 mods / 启动 / 状态 / 停止。
//
// 与 mcdev 的 runClient 不同：这里启动的是**生产客户端**，选中的构建 jar 放进
// <clientDir>/mods/，适合多个模组联调。客户端目录默认在 data/mc-test-client，
// 也可在设置里用 testClientDir 指向已有的 .minecraft。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/**
 * 本机 MDK 工位（与 mcdev 插件的 MC_ROOT 同一套解析）：
 * 测试客户端优先复用这里的 ForgeGradle 预热缓存离线组装，避免再走官方源安装。
 */
const MC_ROOT = process.env.OPENMODS_MC_ROOT
  ?? (existsSync(join(ROOT, '..', 'mincraft-maker'))
    ? join(ROOT, '..', 'mincraft-maker', 'projects')
    : join(ROOT, 'data', 'mcprojects'))
const WARM_GRADLE_HOME = process.env.GRADLE_USER_HOME
  ?? (existsSync(join(MC_ROOT, '.gradle-home')) ? join(MC_ROOT, '.gradle-home') : '')
const FORGE_GRADLE_CACHE = WARM_GRADLE_HOME ? join(WARM_GRADLE_HOME, 'caches', 'forge_gradle') : ''

/** 本机 MDK 的 ForgeGradle 预热缓存（离线组装生产客户端的来源） */
interface MdkEnv {
  home: string
  forgeGradle: string
}

/**
 * 解析 MDK 缓存：显式工程目录优先（工程自身或其父目录的 .gradle-home），
 * 其次默认的 MC_ROOT/.gradle-home。要求 minecraft_repo 里有 vanilla version.json。
 */
function resolveMdkEnv(projectDir?: string): MdkEnv | undefined {
  const homes: string[] = []
  const explicit = String(projectDir ?? '').trim()
  if (explicit) {
    const dir = resolve(explicit)
    homes.push(join(dir, '.gradle-home'), join(dirname(dir), '.gradle-home'), dir)
  }
  if (WARM_GRADLE_HOME) homes.push(WARM_GRADLE_HOME)
  for (const home of homes) {
    const fg = join(home, 'caches', 'forge_gradle')
    if (existsSync(join(fg, 'minecraft_repo', 'versions', VANILLA_VERSION_ID, 'version.json'))) {
      return { home, forgeGradle: fg }
    }
  }
  return undefined
}
/** 离线构建包里打包的 Forge 依赖（安装器之外还有全套库） */
const VENDOR_MAVEN = join(ROOT, 'plugins', 'mcdev', 'vendor', 'fg-maven')
const TEST_ROOT = join(ROOT, 'data', 'mc-test-client')
const RUNS_DIR = join(TEST_ROOT, 'runs')
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

/** 测试客户端来源（对应设置里的 testClientMode） */
export type TestClientMode = 'auto' | 'mdk' | 'production'

export interface TestClientOptions {
  testClientDir?: string
  testClientMode?: TestClientMode
  /** 指定 MDK 工程目录（空 = 在 MC_ROOT 下自动找） */
  testMdkDir?: string
}

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
  /** 本次运行的日志归档目录（selected.json / latest.log / summary.json） */
  runDir?: string
  /** 游戏 latest.log 的绝对路径 */
  logFile?: string
  /** 从 FML Mod List 解析出的模组与状态 */
  mods: { jar: string; modId: string; state: string }[]
  /** 能归因到具体 jar 的错误 */
  issues: { jar: string; modId?: string; message: string }[]
}

interface TestClientState {
  phase: TestClientPhase
  pid?: number
  startedAt?: number
  selected: { name: string; source: 'library' | 'build' }[]
  clientDir?: string
  /** 本次运行的日志归档目录 */
  runDir?: string
  error?: string
}

let busy = false

/**
 * Java 解析：设置 → 环境（OPENMODS_JAVA_HOME）优先，其次 JAVA_HOME，最后旧默认路径。
 * 三者都不可用时直接抛中文可操作提示（测试客户端必须有 JDK 17）。
 */
const JAVA_HINT = '未找到 Java：请到 设置 → 环境 选择 JDK（测试客户端需要 Java 17）'

function javaHome(): string | undefined {
  for (const raw of [process.env.OPENMODS_JAVA_HOME, process.env.JAVA_HOME, 'F:/sdk_java/jdk-17']) {
    const home = String(raw ?? '').trim()
    if (!home) continue
    if (existsSync(join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) return home
  }
  return undefined
}

function javaExe(tool = 'java'): string {
  const home = javaHome()
  if (!home) throw new Error(JAVA_HINT)
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

/**
 * 安装器处理器生成的生产客户端 jar：srg / extra / forge-client。
 * 只有版本 JSON 不够——缺这三个文件时 Forge 会在 MinecraftLocator 直接崩溃。
 */
function patchedClientPaths(clientDir: string): string[] {
  try {
    const forge = readJson(versionJson(clientDir, FORGE_VERSION_ID))
    const args = Array.isArray(forge?.arguments?.game) ? forge.arguments.game.map(String) : []
    const argOf = (flag: string) => {
      const i = args.indexOf(flag)
      return i >= 0 ? args[i + 1] : ''
    }
    const mcpVersion = argOf('--fml.mcpVersion')
    const forgeVersion = argOf('--fml.forgeVersion')
    const mcVersion = argOf('--fml.mcVersion') || VANILLA_VERSION_ID
    const forgeGroup = argOf('--fml.forgeGroup') || 'net.minecraftforge'
    if (!mcpVersion || !forgeVersion) return []
    // 安装器产物目录是 <mcVersion>-<mcpVersion> / <mcVersion>-<forgeVersion>，
    // 不是版本 JSON 的 id（1.20.1-forge-47.4.10）
    const mcAndMcp = `${mcVersion}-${mcpVersion}`
    const mcAndForge = `${mcVersion}-${forgeVersion}`
    return [
      `net/minecraft/client/${mcAndMcp}/client-${mcAndMcp}-srg.jar`,
      `net/minecraft/client/${mcAndMcp}/client-${mcAndMcp}-extra.jar`,
      `${forgeGroup.replace(/\./g, '/')}/forge/${mcAndForge}/forge-${mcAndForge}-client.jar`,
    ]
  } catch {
    return []
  }
}

/** 客户端是否真的可启动（版本文件 + 安装器生成的三个 patched jar） */
function clientReady(clientDir: string): boolean {
  if (!hasForge(clientDir)) return false
  const paths = patchedClientPaths(clientDir)
  if (!paths.length) return false
  return paths.every(p => existsSync(join(clientDir, 'libraries', p)))
}

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'

/** 版本 JSON 的 rules：按当前系统裁剪，避免把 mac/linux 的 natives 也塞进 classpath */
function ruleAllows(rules: any): boolean {
  if (!Array.isArray(rules) || !rules.length) return true
  let allowed = false
  for (const r of rules) {
    const os = r?.os
    if (os && os.name && os.name !== OS_NAME) continue
    if (os && os.arch && os.arch !== process.arch) continue
    if (r?.action === 'allow') allowed = true
    if (r?.action === 'disallow') return false
  }
  return allowed
}

function sha1(path: string): string | undefined {
  try { return createHash('sha1').update(readFileSync(path)).digest('hex') } catch { return undefined }
}

function copyIfMissing(src: string, dst: string): boolean {
  if (existsSync(dst)) return true
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    return true
  } catch { return false }
}

/** 按 maven 相对路径列出本地所有候选文件（受管目录 / 离线包 / MDK 预热缓存 / Gradle modules-2） */
function findLocalArtifacts(rel: string, env?: MdkEnv): string[] {
  const p = rel.replace(/\\/g, '/')
  const fg = env?.forgeGradle ?? FORGE_GRADLE_CACHE
  const home = env?.home ?? WARM_GRADLE_HOME
  const roots: string[] = [
    join(MINECRAFT_DIR, 'libraries'),
    VENDOR_MAVEN,
    ...(fg
      ? [
        join(fg, 'maven_downloader'),
        join(fg, 'minecraft_user_repo'),
        join(fg, 'mcp_repo'),
      ]
      : []),
  ]
  const out: string[] = []
  for (const root of roots) {
    const f = join(root, p)
    if (existsSync(f)) out.push(f)
  }
  // Gradle modules-2 按 sha1 分桶：modules-2/files-2.1/<group>/<artifact>/<version>/<hash>/<file>
  if (home) {
    const parts = p.split('/')
    if (parts.length >= 4) {
      const file = parts[parts.length - 1]
      const version = parts[parts.length - 2]
      const artifact = parts[parts.length - 3]
      const group = parts.slice(0, -3).join('.')
      const versionDir = join(home, 'caches', 'modules-2', 'files-2.1', group, artifact, version)
      try {
        for (const hash of readdirSync(versionDir)) {
          const f = join(versionDir, hash, file)
          if (existsSync(f)) out.push(f)
        }
      } catch { /* 该库不在 gradle 缓存 */ }
    }
  }
  return out
}

function resetInstallLog() {
  try {
    mkdirSync(TEST_ROOT, { recursive: true })
    writeFileSync(INSTALL_LOG, '')
  } catch { /* 日志写失败不阻塞 */ }
}

function installNote(line: string) {
  try {
    mkdirSync(TEST_ROOT, { recursive: true })
    appendFileSync(INSTALL_LOG, `${line}\n`)
  } catch { /* 日志写失败不阻塞 */ }
}

/** 从 Forge 安装器 jar 抽出 version.json / install_profile.json（离线安装要用它的库清单与 sha1） */
function extractForgeMeta(clientDir: string): { installProfile?: string } {
  if (!existsSync(INSTALLER)) return {}
  const tmp = join(TEST_ROOT, '.forge-meta')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    const r = spawnSync(javaExe('jar'), ['xf', INSTALLER, 'version.json', 'install_profile.json'], {
      cwd: tmp,
      windowsHide: true,
    })
    if (r.status !== 0) return {}
    const ver = join(tmp, 'version.json')
    if (existsSync(ver)) {
      const dst = versionJson(clientDir, FORGE_VERSION_ID)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(ver, dst)
    }
    const profile = join(tmp, 'install_profile.json')
    if (!existsSync(profile)) return {}
    // 安装器会反复读它，放到受管目录里而不是临时目录
    const keep = join(TEST_ROOT, 'install_profile.json')
    copyFileSync(profile, keep)
    return { installProfile: keep }
  } catch {
    return {}
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 按 sha1 校验把本地已有的库补进 <clientDir>/libraries；返回是否就绪 */
function seedArtifact(clientDir: string, rel: string, expected: string, env?: MdkEnv): 'kept' | 'copied' | 'missing' {
  const dst = join(clientDir, 'libraries', rel)
  if (existsSync(dst) && (!expected || sha1(dst) === expected)) return 'kept'
  const src = findLocalArtifacts(rel, env).find(p => !expected || sha1(p) === expected)
  if (!src) return 'missing'
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    return 'copied'
  } catch {
    return 'missing'
  }
}

/**
 * 复用本机 MDK 的 ForgeGradle 预热缓存离线组装测试客户端：
 * 版本 JSON / 客户端 jar 来自 minecraft_repo，库来自离线包、maven_downloader 与 modules-2，
 * 安装器处理器需要的 36 个库也一起补齐，之后 `--offline` 安装无需联网。
 * 素材（assets）留在缓存目录里直接用，不复制 600MB。
 * 返回还缺的库；为空表示可以尝试离线安装。
 */
function seedFromLocalMdk(clientDir: string, env: MdkEnv): string[] {
  resetInstallLog()
  installNote(`[local] 复用本机 MDK 缓存：${env.forgeGradle}`)
  const vanillaDir = join(clientDir, 'versions', VANILLA_VERSION_ID)
  const mcRepo = join(env.forgeGradle, 'minecraft_repo', 'versions', VANILLA_VERSION_ID)
  mkdirSync(vanillaDir, { recursive: true })

  if (!copyIfMissing(join(mcRepo, 'version.json'), versionJson(clientDir, VANILLA_VERSION_ID))) {
    installNote('[local] 缺少 vanilla version.json')
  }
  copyIfMissing(join(mcRepo, 'client.jar'), join(vanillaDir, `${VANILLA_VERSION_ID}.jar`))
  installNote(`[local] 客户端版本文件：${existsSync(versionJson(clientDir, VANILLA_VERSION_ID)) ? '就绪' : '缺失'}`)

  let installProfile = ''
  if (!existsSync(versionJson(clientDir, FORGE_VERSION_ID))) {
    installNote('[local] 从安装器 jar 提取 Forge 版本文件')
  }
  const meta = extractForgeMeta(clientDir)
  installProfile = meta.installProfile ?? join(TEST_ROOT, 'install_profile.json')
  if (!existsSync(installProfile)) {
    installNote('[local] 缺少 install_profile.json，无法离线安装')
    return ['install_profile.json']
  }
  if (!hasForge(clientDir)) return ['版本 JSON']

  const vanilla = readJson(versionJson(clientDir, VANILLA_VERSION_ID))
  const forge = readJson(versionJson(clientDir, FORGE_VERSION_ID))
  const libs = mergeLibraries(vanilla, forge)
  const missing: string[] = []
  let copied = 0
  let kept = 0
  for (const lib of libs) {
    const rel = libPath(lib)
    if (!rel) continue
    const expected = lib?.downloads?.artifact?.sha1 ? String(lib.downloads.artifact.sha1) : ''
    const r = seedArtifact(clientDir, rel, expected, env)
    if (r === 'missing') missing.push(rel)
    else if (r === 'copied') copied++
    else kept++
  }
  installNote(`[local] 客户端库：复用 ${kept}、补齐 ${copied}、缺失 ${missing.length}`)

  // 安装器处理器自己的库（trove/guava25/FART/srgutils…）：校验不过离线安装会直接失败
  try {
    const profile = readJson(installProfile)
    let pKept = 0
    let pCopied = 0
    let pMissing = 0
    for (const lib of Array.isArray(profile?.libraries) ? profile.libraries : []) {
      const art = lib?.downloads?.artifact
      if (!art?.path) continue
      const r = seedArtifact(clientDir, String(art.path), String(art.sha1 ?? ''), env)
      if (r === 'missing') {
        pMissing++
        missing.push(String(art.path))
      } else if (r === 'copied') pCopied++
      else pKept++
    }
    installNote(`[local] 安装器库：复用 ${pKept}、补齐 ${pCopied}、缺失 ${pMissing}`)
  } catch {
    installNote('[local] install_profile.json 解析失败')
    missing.push('install_profile.json')
  }

  if (missing.length) installNote(`[local] 缺失示例：${missing.slice(0, 8).join('、')}`)
  return missing
}

/** 运行一个长期进程并把输出写进日志；返回退出码 */
function runLogged(cmd: string, args: string[], opts: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  log: string
  timeoutMs: number
  /** 追加到已有日志（保留本地播种的输出） */
  append?: boolean
}): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    mkdirSync(TEST_ROOT, { recursive: true })
    const out = createWriteStream(opts.log, { flags: opts.append ? 'a' : 'w' })
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

/** 安装测试客户端：离线（只跑处理器、不联网）或联网；装完要求三个 patched jar 都存在 */
async function installClient(offline: boolean): Promise<string> {
  if (!existsSync(INSTALLER)) throw new Error(`缺少 Forge 安装器：${INSTALLER}`)
  mkdirSync(MINECRAFT_DIR, { recursive: true })
  const profiles = join(MINECRAFT_DIR, 'launcher_profiles.json')
  if (!existsSync(profiles)) writeFileSync(profiles, '{ "profiles": {} }')
  installNote(`[local] ${offline ? '离线' : '联网'}安装 Forge 测试客户端…`)

  const args = ['-Djava.awt.headless=true', '-jar', INSTALLER]
  if (offline) args.push('--offline')
  args.push('--installClient', MINECRAFT_DIR)
  const code = await runLogged(javaExe(), args, {
    log: INSTALL_LOG,
    timeoutMs: offline ? 5 * 60_000 : 15 * 60_000,
    append: true,
  })
  if (clientReady(MINECRAFT_DIR)) return MINECRAFT_DIR

  const log = readText(INSTALL_LOG)
  const hint = code !== 0 ? `安装器退出码 ${code}` : '安装器未生成完整的客户端文件'
  throw new Error(`${hint}。${tailLines(log, 20)}`)
}

async function ensureClient(
  prefDir: string | undefined,
  mode: TestClientMode,
  env: MdkEnv | undefined,
): Promise<string> {
  const custom = String(prefDir ?? '').trim()
  if (custom) {
    const dir = resolve(custom)
    if (clientReady(dir)) return dir
    throw new Error(`测试客户端目录不完整（缺 Forge ${FORGE_VERSION_ID} 的 patched jar）：${dir}`)
  }
  if (clientReady(MINECRAFT_DIR)) return MINECRAFT_DIR

  if (mode !== 'production') {
    if (!env) {
      if (mode === 'mdk') {
        throw new Error('没有检测到本机 MDK 的 ForgeGradle 缓存：请先在该 MDK 工程里跑一次 gradlew runClient，或在设置里填写 MDK 工程目录。')
      }
    } else {
      const missing = seedFromLocalMdk(MINECRAFT_DIR, env)
      if (!missing.length) {
        try {
          return await installClient(true)
        } catch (e: any) {
          if (mode === 'mdk') throw new Error(`离线安装失败：${e?.message ?? e}`)
          installNote(`[local] 离线安装失败，回退联网：${e?.message ?? e}`)
        }
      } else {
        installNote(`[local] 缓存不完整（缺 ${missing.length} 个库），跳过离线安装`)
        if (mode === 'mdk') {
          throw new Error(`本地 MDK 缓存不完整，缺 ${missing.length} 个库（如 ${missing.slice(0, 3).join('、')}）。可切换为「自动」或「独立安装」联网补齐。`)
        }
      }
    }
  }
  return installClient(false)
}

/** 清理上次管理的 jar，再写入本次选中的 jar；不碰用户手动放进 mods 的文件 */
function syncMods(modsDir: string, jars: TestClientJar[], manifest = MODS_MANIFEST) {
  mkdirSync(modsDir, { recursive: true })
  let previous: string[] = []
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8'))
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
  mkdirSync(dirname(manifest), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ files, updatedAt: Date.now() }, null, 2))
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

/**
 * 合并版本 JSON 的 libraries：按系统裁剪 rules，group:artifact[:classifier] 去重，
 * 子版本（Forge）覆盖父版本。1.20.1 的 natives 是独立条目（classifier=natives-windows），
 * 不能按 group:artifact 合并，否则会把主 jar 顶掉。
 */
function mergeLibraries(vanilla: any, forge: any): any[] {
  const map = new Map<string, any>()
  for (const lib of [...(vanilla?.libraries ?? []), ...(forge?.libraries ?? [])]) {
    if (!lib?.name || !ruleAllows(lib.rules)) continue
    const parts = String(lib.name).split(':')
    const key = parts.length >= 4 ? `${parts[0]}:${parts[1]}:${parts[3]}` : `${parts[0]}:${parts[1]}`
    map.set(key, lib)
  }
  return [...map.values()]
}

/** 1.20.1 的 natives 独立条目：解压 DLL 到 natives 目录 */
function windowsNativePath(lib: any): string | undefined {
  if (process.platform !== 'win32') return undefined
  const parts = String(lib?.name ?? '').split(':')
  if (parts.length < 4 || parts[3] !== 'natives-windows') return undefined
  return lib?.downloads?.artifact?.path ? String(lib.downloads.artifact.path) : undefined
}

/** 素材优先用 MDK 预热缓存（600MB，不复制）；自定义客户端仍用自带 assets */
function resolveAssetsDir(clientDir: string, indexId: string, env?: MdkEnv): string {
  const own = join(clientDir, 'assets')
  if (existsSync(join(own, 'indexes', `${indexId}.json`))) return own
  const fg = env?.forgeGradle ?? FORGE_GRADLE_CACHE
  const warm = fg ? join(fg, 'assets') : ''
  if (warm && existsSync(join(warm, 'indexes', `${indexId}.json`))) return warm
  return own
}

function buildLaunch(clientDir: string, env?: MdkEnv): { args: string[]; cwd: string } {
  const vanilla = readJson(versionJson(clientDir, VANILLA_VERSION_ID))
  const forge = readJson(versionJson(clientDir, FORGE_VERSION_ID))
  const librariesDir = join(clientDir, 'libraries')
  const nativesDir = join(clientDir, 'natives')
  const assetsIndex = String(vanilla?.assetIndex?.id ?? '5')
  const assetsDir = resolveAssetsDir(clientDir, assetsIndex, env)

  const libs = mergeLibraries(vanilla, forge)
  const cp: string[] = []
  const nativeJars: string[] = []
  const missing: string[] = []
  for (const lib of libs) {
    const np = nativePath(lib) ?? windowsNativePath(lib)
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
  // 生产客户端的原版/Forge 类由 MinecraftLocator 从 libraries 里的 srg/extra/client 加载；
  // 不能再把 versions/1.20.1/1.20.1.jar 放进 classpath，否则同名包会触发 ResolutionException
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

/** 本次运行的日志目录：runs/YYYYMMDD-HHmmss（并列时加序号） */
function newRunDir(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const base = join(RUNS_DIR, stamp)
  let dir = base
  let i = 2
  while (existsSync(dir)) dir = `${base}-${i++}`
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 从 FML 崩溃报告的 Mod List 解析 jar / modId / 状态 */
function parseModList(text: string): { jar: string; modId: string; state: string }[] {
  const out: { jar: string; modId: string; state: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+\.jar)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([A-Z_]+)/.exec(line)
    if (!m) continue
    const row = { jar: m[1].trim(), modId: m[3].trim(), state: m[5].trim() }
    if (!out.some(x => x.jar === row.jar && x.modId === row.modId)) out.push(row)
  }
  return out
}

/** 把日志里能归因到具体 jar 的错误挑出来 */
function parseIssues(
  text: string,
  selected: { name: string; source: 'library' | 'build' }[],
): { jar: string; modId?: string; message: string }[] {
  const mods = parseModList(text)
  const issues: { jar: string; modId?: string; message: string }[] = []
  const seen = new Set<string>()
  const add = (jar: string, message: string, modId?: string) => {
    const key = `${jar}|${modId ?? ''}|${message}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ jar, ...(modId ? { modId } : {}), message })
  }
  const selectedJars = new Set(selected.map(s => basename(s.name).toLowerCase()))
  const modById = new Map(mods.map(m => [m.modId, m]))

  for (const m of mods) {
    if (!selectedJars.has(basename(m.jar).toLowerCase())) continue
    if (/ERROR|DISABLED|FAILED/.test(m.state)) add(m.jar, `模组状态 ${m.state}`, m.modId)
  }

  const reCreate = /Failed to create mod instance\. ModID:\s*(\S+)/g
  let m: RegExpExecArray | null
  while ((m = reCreate.exec(text))) {
    const modId = m[1]
    const hit = modById.get(modId)
    if (hit && selectedJars.has(basename(hit.jar).toLowerCase())) {
      add(hit.jar, '创建模组实例失败，详见日志堆栈', modId)
    }
  }

  // 只报选中 jar 的 mods.toml 缺失；Forge 自带的 fmlcore/language 模块是正常警告
  const reMissing = /Mod file (.+?) is missing mods\.toml/g
  while ((m = reMissing.exec(text))) {
    const file = basename(m[1])
    if (selectedJars.has(file.toLowerCase())) add(file, '缺少 mods.toml')
  }

  // 资源命名空间（如 icedragon:ice_nest）→ modId → jar；这是注册表/世界生成崩溃最可靠的归因
  for (const line of text.split(/\r?\n/)) {
    if (!/ERROR|FATAL|Exception|Unbound|Caused by|Registry/.test(line)) continue
    const reNs = /\b([a-z][a-z0-9_]{2,63}):[a-z0-9_./-]+/g
    let n: RegExpExecArray | null
    while ((n = reNs.exec(line))) {
      const modId = n[1]
      if (modId === 'minecraft' || modId === 'forge' || modId === 'fml' || modId === 'realms') continue
      const hit = modById.get(modId)
      const jar = hit?.jar
        ?? selected.map(x => basename(x.name)).find(name => name.toLowerCase().includes(modId)) 
      if (!jar || !selectedJars.has(basename(jar).toLowerCase())) continue
      add(jar, line.trim().slice(0, 300), modId)
    }
  }

  // 选中 jar 文件名直接出现在 ERROR/FATAL 行里
  const names = selected.map(s => basename(s.name)).filter(Boolean)
  for (const line of text.split(/\r?\n/)) {
    if (!/ERROR|FATAL/.test(line)) continue
    for (const name of names) {
      if (line.includes(name)) add(name, line.trim().slice(0, 300))
    }
  }

  if (!issues.length && /ReportedException|Failed to load registries/.test(text)) {
    add('', '客户端崩溃，但未能归因到具体 jar；请查看日志与 crash-reports')
  }
  return issues.slice(0, 20)
}

/** 本次启动之后生成的最新崩溃报告 */
function newestCrashReport(clientDir: string, startedAt?: number): string {
  try {
    const dir = join(clientDir, 'crash-reports')
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    const hit = files.find(x => !startedAt || x.t >= startedAt - 5000)
    return hit ? join(dir, hit.f) : ''
  } catch {
    return ''
  }
}

function collectLogText(s: TestClientState): string {
  const latest = s.clientDir ? readText(join(s.clientDir, 'logs', 'latest.log')) : ''
  const crash = s.clientDir ? readText(newestCrashReport(s.clientDir, s.startedAt)) : ''
  return [latest, readText(CONSOLE_LOG), crash].filter(Boolean).join('\n')
}

/** 归档本次运行日志：selected.json 已在启动时写，这里补 latest/console/crash + summary */
function archiveRun(s: TestClientState, exitCode?: number) {
  if (!s.runDir) return
  try {
    mkdirSync(s.runDir, { recursive: true })
    const latest = s.clientDir ? join(s.clientDir, 'logs', 'latest.log') : ''
    const fresh = !!latest && existsSync(latest)
      && (!s.startedAt || statSync(latest).mtimeMs >= s.startedAt - 5000)
    if (fresh) copyFileSync(latest, join(s.runDir, 'latest.log'))
    if (existsSync(CONSOLE_LOG)) copyFileSync(CONSOLE_LOG, join(s.runDir, 'client-console.log'))
    // 安装日志只在本次启动期间写过时归档，避免每次把历史 1MB+ 安装日志复制一遍
    if (existsSync(INSTALL_LOG) && (!s.startedAt || statSync(INSTALL_LOG).mtimeMs >= s.startedAt - 5000)) {
      copyFileSync(INSTALL_LOG, join(s.runDir, 'install.log'))
    }
    const crash = s.clientDir ? newestCrashReport(s.clientDir, s.startedAt) : ''
    if (crash) copyFileSync(crash, join(s.runDir, basename(crash)))
    const text = collectLogText(s)
    writeFileSync(join(s.runDir, 'summary.json'), JSON.stringify({
      startedAt: s.startedAt,
      endedAt: Date.now(),
      exitCode,
      selected: s.selected,
      mods: parseModList(text),
      issues: parseIssues(text, s.selected),
    }, null, 2))
  } catch { /* 日志归档失败不阻塞启动/停止 */ }
}

function launch(clientDir: string, selected: TestClientState['selected'], env?: MdkEnv, runDir?: string) {
  const { args, cwd } = buildLaunch(clientDir, env)
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
    writeState({ phase: 'error', selected, clientDir, runDir, error: e.message })
  })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  child.on('exit', code => {
    // 等日志 flush 完再归档；之后即使 server 重启，runs/<时间>/ 里仍有完整记录
    setTimeout(() => {
      const cur = readState()
      archiveRun({ ...cur, pid: undefined }, code ?? undefined)
    }, 1500).unref?.()
  })
  child.unref()
  writeState({
    phase: 'starting',
    pid: child.pid,
    startedAt: Date.now(),
    selected,
    clientDir,
    runDir,
  })
}

/** 启动测试客户端：异步准备/同步/拉起，调用方立即返回 */
export async function startTestClient(jars: TestClientJar[], opts: TestClientOptions = {}): Promise<void> {
  if (busy) throw new Error('测试客户端正在安装或启动，请稍候')
  if (!jars.length) throw new Error('至少选择一个 jar')
  busy = true
  // 同一时间只保留一个测试客户端：先停旧进程，避免 jar 被占用/双开
  const prev = readState()
  if (prev.pid && pidAlive(prev.pid)) stopTestClient()
  const selected = jars.map(j => ({ name: j.name, source: j.source }))
  const mode = opts.testClientMode ?? 'auto'
  // production 只走联网安装器/testClientDir；auto/mdk 优先用本机 MDK 缓存离线组装
  const env = mode === 'production' ? undefined : resolveMdkEnv(opts.testMdkDir)
  // 每次运行独立归档：选中的 jar（含 hash）先落盘，日志退出后补进同一目录
  const runDir = newRunDir()
  writeFileSync(join(runDir, 'selected.json'), JSON.stringify(jars.map(j => ({
    name: j.name,
    source: j.source,
    size: j.data.length,
    sha256: createHash('sha256').update(j.data).digest('hex'),
  })), null, 2))
  writeState({ phase: 'installing', selected, runDir })
  try {
    const clientDir = await ensureClient(opts.testClientDir, mode, env)
    writeState({ phase: 'starting', selected, clientDir, runDir })
    syncMods(join(clientDir, 'mods'), jars)
    launch(clientDir, selected, env, runDir)
  } catch (e: any) {
    writeState({ phase: 'error', selected, runDir, error: e?.message ?? String(e) })
    archiveRun({ phase: 'error', selected, runDir, startedAt: Date.now() })
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
  else if (s.phase === 'exited' || s.pid) phase = 'exited'
  else phase = 'idle'
  // 安装阶段优先看安装器日志：上一次启动的 console 还留在盘上，不能拿来当本次进度
  const source = s.phase === 'installing' ? (readText(INSTALL_LOG) || console) : (log || console)
  const parseText = s.phase === 'installing' ? readText(INSTALL_LOG) : collectLogText(s)
  const selected = Array.isArray(s.selected) ? s.selected : []
  const selectedNames = new Set(selected.map(x => basename(x.name).toLowerCase()))
  return {
    phase,
    running: alive,
    pid: s.pid,
    startedAt: s.startedAt,
    selected,
    logTail: tailLines(source, Math.max(10, Math.min(400, tail))),
    projectDir: s.clientDir ?? MINECRAFT_DIR,
    error: s.error,
    runDir: s.runDir,
    logFile: s.clientDir ? join(s.clientDir, 'logs', 'latest.log') : undefined,
    mods: parseModList(parseText).filter(m => selectedNames.has(basename(m.jar).toLowerCase())),
    issues: parseIssues(parseText, selected),
  }
}

/** 停止测试客户端（整棵进程树） */
export function stopTestClient(): boolean {
  const s = readState()
  if (!s.pid || !pidAlive(s.pid)) {
    writeState({ ...s, phase: s.phase === 'installing' ? 'installing' : 'exited', pid: undefined })
    archiveRun({ ...s, pid: undefined })
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
  // 等 latest.log 落盘再归档
  setTimeout(() => archiveRun({ ...s, pid: undefined }), 1200).unref?.()
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
