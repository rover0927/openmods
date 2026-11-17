// mcdev 插件：Minecraft 1.20.1 Forge 模组开发的工程面（脚手架 / 文件 / Gradle / 日志 / 模型导出）
//
// 设计边界（和 dsh 的 mc_scaffold/mc_gradle 对齐）：
// - 只做 Java + 1.20.1 + Forge 47.x；平台/版本写死，不接受别的组合，避免模型自由发挥。
// - 工程路径统一走 resolveProject()：裸名解析到 MC_ROOT 下，绝对路径必须存在；
//   文件读写只允许落在工程目录内（realpath 前缀校验），不碰仓库其它地方。
// - runClient 是长驻进程：mc_gradle background=true 时立即返回 pid + 控制台日志路径，
//   由 mc_log 轮询 run/logs/latest.log 判断是否真的起来了。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile, cp } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ToolResult } from '@openmods/plugin-kit'
import { WORKSPACE_TOOL_NAMES } from '@openmods/plugin-kit'
import { solidPng } from '../bb-tools/png.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/**
 * 新工程默认目录：优先 ../mincraft-maker/projects（MDK 与技能包所在的工位），
 * 其次 data/mcprojects。可用 OPENMODS_MC_ROOT 覆盖。
 */
const MC_ROOT = process.env.OPENMODS_MC_ROOT
  ?? (existsSync(join(ROOT, '..', 'mincraft-maker')) ? join(ROOT, '..', 'mincraft-maker', 'projects') : join(ROOT, 'data', 'mcprojects'))
const TEMPLATE = fileURLToPath(new URL('./template/forge-1.20.1/', import.meta.url))

/**
 * 本机预热好的 Gradle 缓存（MC_ROOT/.gradle-home）：存在就作为默认 GRADLE_USER_HOME 共享，
 * 否则每个会话都会在自己工作区重建一份空缓存，遇到镜像抖动就直接构建失败。
 */
const WARM_GRADLE_HOME = existsSync(join(MC_ROOT, '.gradle-home')) ? join(MC_ROOT, '.gradle-home') : null

/** 可复制的现成参考工程（MC_ROOT 下含 build.gradle 的目录），列进 mc_scaffold 说明供 from 使用 */
const REFERENCE_PROJECTS: string[] = (() => {
  try {
    return readdirSync(MC_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(MC_ROOT, e.name, 'build.gradle')))
      .map(e => e.name)
      .sort()
      .slice(0, 8)
  } catch { return [] }
})()

/**
 * 离线构建包（打包在项目里，共约 243M）：
 * - gradle-8.8/      解压后的 Gradle 8.8 发行版（gradlew 首跑免下载）
 * - fg-maven/        FG maven_downloader 全量快照（installertools/mcp_config/mojang 库等，含 .md5）
 * seedWrapperDist / seedMavenCache 优先从这里复制，镜像只做兜底。
 */
const VENDOR = fileURLToPath(new URL('./vendor/', import.meta.url))

/** Forge 47.4.10 = 1.20.1 当前 MDK 版本；只允许这一个平台。 */
const PINNED = { mc: '1.20.1', forge: '47.4.10', fg: '6.0.54', gradle: '8.8', java: 17 }

/**
 * 国内镜像基址：USTC 的 bmclapi 直连（无 302 跳转），比 bmclapi2 那条
 * 302→cernet→ustc 的链稳定得多（那条偶发 404 / 半截文件）。
 */
const MIRROR = (process.env.OPENMODS_MIRROR ?? 'https://unicom.mirrors.ustc.edu.cn/bmclapi').replace(/\/+$/, '')

/**
 * ForgeGradle 有一批构件不走 Gradle 仓库，而是拿编译期常量
 * （Utils.FORGE_MAVEN = https://maven.minecraftforge.net/）直接用 HttpClient 下到
 * <GRADLE_USER_HOME>/caches/forge_gradle/maven_downloader/ 下。
 * 常量是 final String，运行期改不了、仓库改写也管不着，所以只能提前把文件按
 * 原样摆进缓存。少一个的后果是构建卡在官方源上（该 HttpClient 没有读超时）。
 */
const FG_SEED: string[] = [
  'net/minecraftforge/installertools/1.3.2/installertools-1.3.2-fatjar.jar',
  'net/minecraftforge/mergetool/1.1.7/mergetool-1.1.7-api.jar',
  'net/minecraftforge/renamer/2.0.4/renamer-2.0.4-all.jar',
  // 两个 mcp_config 版本号都不能少：OfficialChannelProvider 用裸版本 1.20.1，
  // MCPRepo 跑 joined/strip 步骤时用带时间戳的 1.20.1-20230612.114412。
  // 缺任何一个，MavenArtifactDownloader 会转去走 Gradle 解析（镜像是第 1 个仓库也不生效），
  // 表现成 "Could not resolve dependency: de.oceanlabs.mcp:mcp_config:…"。
  'de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip',
  'de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip',
  'net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-installer.jar',
  'net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-universal.jar',
  'net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-userdev.jar',
  'net/minecraftforge/forge/1.20.1-47.4.10/forge-1.20.1-47.4.10-sources.jar',
]

/**
 * 离线播种 Gradle 发行版：按工程 gradle-wrapper.properties 的 distributionUrl 算出
 * wrapper 的缓存 key（MD5 → base36，与 Java wrapper 同一算法），把 vendor/gradle-8.8
 * 复制成 `<GRADLE_USER_HOME>/wrapper/dists/gradle-8.8-bin/<key>/gradle-8.8` 并落 .ok 标记。
 * 有 .ok 的目录 wrapper 直接视为已安装，不再联网下载。
 */
async function seedWrapperDist(gradleHome: string, projectDir: string): Promise<'seeded' | 'cached' | 'skipped'> {
  const vendorDist = join(VENDOR, 'gradle-8.8')
  if (!existsSync(join(vendorDist, 'bin'))) return 'skipped'
  const propsFile = join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties')
  if (!existsSync(propsFile)) return 'skipped'
  const props = readFileSync(propsFile, 'utf8')
  const url = props.match(/^distributionUrl=(.+)$/m)?.[1]?.replace(/\\:/g, ':').trim()
  if (!url || !url.includes('gradle-8.8-bin.zip')) return 'skipped'
  const key = BigInt(`0x${createHash('md5').update(url).digest('hex')}`).toString(36)
  const dest = join(gradleHome, 'wrapper', 'dists', 'gradle-8.8-bin', key)
  if (existsSync(join(dest, 'gradle-8.8', 'bin', 'gradle.bat')) || existsSync(join(dest, 'gradle-8.8', 'bin', 'gradle'))) return 'cached'
  await cp(vendorDist, join(dest, 'gradle-8.8'), { recursive: true })
  await writeFile(join(dest, 'gradle-8.8-bin.zip.lck'), '')
  await writeFile(join(dest, 'gradle-8.8-bin.zip.ok'), '')
  return 'seeded'
}

/**
 * 把 vendor/fg-maven 全量快照补进 maven_downloader（只补缺失文件，不覆盖）。
 * 快照比 FG_SEED 清单大：runClient/downloadClient 还要一批 moang 库（authlib、
 * brigadier、fastutil…），一并离线。
 */
async function seedVendorMaven(gradleHome: string): Promise<boolean> {
  const vendorMaven = join(VENDOR, 'fg-maven')
  if (!existsSync(vendorMaven)) return false
  const dest = join(gradleHome, 'caches', 'forge_gradle', 'maven_downloader')
  await mkdir(dest, { recursive: true })
  await cp(vendorMaven, dest, { recursive: true, force: false, errorOnExist: false })
  return true
}

/**
 * 补齐 maven_downloader 缓存：vendor 快照优先，仍缺的按镜像下载兜底。
 * FG 下载完会比 md5，缺了旁文件还会回头去官方源要，所以 .md5 一并落盘。
 */
async function seedMavenCache(gradleHome: string): Promise<{ added: number; skipped: number; failed: string[] }> {
  const dest = join(gradleHome, 'caches', 'forge_gradle', 'maven_downloader')
  let added = 0, skipped = 0
  const failed: string[] = []
  const vendorUsed = await seedVendorMaven(gradleHome).catch(() => false)
  for (const rel of FG_SEED) {
    const out = join(dest, ...rel.split('/'))
    if (existsSync(out) && (await stat(out).catch(() => ({ size: 0 }))).size > 0) { skipped++; continue }
    try {
      await mkdir(dirname(out), { recursive: true })
      if (vendorUsed) {
        // vendor 没盖住这个文件（快照不完整时）才走镜像
        const vendorFile = join(VENDOR, 'fg-maven', ...rel.split('/'))
        if (existsSync(vendorFile) && (await stat(vendorFile)).size > 0) {
          await cp(vendorFile, out)
          const vendorMd5 = `${vendorFile}.md5`
          if (existsSync(vendorMd5)) await cp(vendorMd5, `${out}.md5`)
          added++
          continue
        }
      }
      const res = await fetch(`${MIRROR}/${rel}`, { signal: AbortSignal.timeout(180_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('空文件')
      await writeFile(out, buf)
      const md5 = await fetch(`${MIRROR}/${rel}.md5`, { signal: AbortSignal.timeout(30_000) })
        .then(r => (r.ok ? r.text() : '')).catch(() => '')
      const expect = md5.trim().toLowerCase()
      if (expect && expect !== createHash('md5').update(buf).digest('hex')) {
        await rm(out, { force: true })
        throw new Error('md5 不匹配')
      }
      if (expect) await writeFile(`${out}.md5`, `${expect}\n`)
      added++
    } catch (e: any) {
      failed.push(`${rel.split('/').pop()}（${e?.message ?? e}）`)
    }
  }
  return { added, skipped, failed }
}

export { seedMavenCache, seedWrapperDist }

const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/
const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

function fail(text: string): ToolResult {
  return { forModel: text, isError: true }
}

/**
 * Windows 上 Gradle/javac 与 Minecraft 日志常按系统代码页（GBK）输出；
 * 直接按 UTF-8 解码会把中文变成 `����`。先按 UTF-8 解，出现替换字符再按 GB18030 重解。
 */
function decodeText(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gb18030').decode(buf) } catch { return utf8 }
}

// ---- 工程 build/runClient 状态（mc_gradle 与右侧 dock 的「测试 Mod」按钮共用同一份） ----
// data/mcdev-state.json：projectDir → { lastBuild, runClient }。durable，重启后 UI 仍能显示构建状态。
interface McBuildRecord { task: string; ok: boolean; code: number; time: number }
interface McProjectState { lastBuild?: McBuildRecord; runClient?: { pid: number; startedAt: number } }
type McStateMap = Record<string, McProjectState>

const MC_STATE_FILE = join(ROOT, 'data', 'mcdev-state.json')

function readMcState(): McStateMap {
  try {
    const raw = JSON.parse(readFileSync(MC_STATE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw as McStateMap : {}
  } catch { return {} }
}

function writeMcState(map: McStateMap) {
  try {
    mkdirSync(dirname(MC_STATE_FILE), { recursive: true })
    // 先写临时文件再 rename：读侧不会读到半截 JSON（并发写/进程被杀时尤其重要）
    const tmp = `${MC_STATE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(map, null, 2))
    renameSync(tmp, MC_STATE_FILE)
  } catch { /* 落盘失败不阻塞构建 */ }
}

/** 记录一次 gradlew 任务结果（只认 build 任务为「构建状态」） */
function recordBuild(projectDir: string, task: string, code: number) {
  const map = readMcState()
  const cur: McProjectState = map[projectDir] ?? {}
  if (task === 'build') cur.lastBuild = { task, ok: code === 0, code, time: Date.now() }
  map[projectDir] = cur
  writeMcState(map)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 本工具使用的工程根目录：**会话绑定的 cwd 优先**（左栏可切换），
 * 没有绑定才回落到 MC_ROOT。这样同一个服务端可以同时开多个工程会话，
 * 各自 mc_scaffold / mc_list 都落在自己的目录里。
 */
function rootOf(exec?: { session?: { cwd?: string } }): string {
  const cwd = exec?.session?.cwd
  return typeof cwd === 'string' && cwd.trim() ? cwd : MC_ROOT
}

/** 裸名 → <root>/<name>；绝对路径原样返回（要求已存在） */
async function resolveProject(input: string, root: string): Promise<string> {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('project 不能为空：传工程目录绝对路径，或当前会话目录下的工程名')
  const dir = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`工程目录不存在: ${dir}`)
  return await realpath(dir)
}

/** 工程内相对路径 → 绝对路径，越界抛错 */
async function safeJoin(projectDir: string, rel: string): Promise<string> {
  const clean = String(rel ?? '').replace(/^[/\\]+/, '')
  const abs = resolve(projectDir, clean)
  const prefix = projectDir.endsWith('\\') || projectDir.endsWith('/') ? projectDir : projectDir + (process.platform === 'win32' ? '\\' : '/')
  if (abs !== projectDir && !abs.startsWith(prefix)) {
    throw new Error(`路径越界：${rel}`)
  }
  return abs
}

async function copyTree(from: string, to: string, skip: Set<string>): Promise<string[]> {
  const written: string[] = []
  const walk = async (src: string, dst: string, rel: string) => {
    const entries = await readdir(src, { withFileTypes: true })
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const s = join(src, e.name)
      const d = join(dst, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await mkdir(d, { recursive: true })
        await walk(s, d, r)
      } else {
        await writeFile(d, await readFile(s))
        written.push(r)
      }
    }
  }
  await mkdir(to, { recursive: true })
  await walk(from, to, '')
  return written
}

function replaceAll(text: string, pairs: [string, string][]): string {
  let out = text
  for (const [from, to] of pairs) out = out.split(from).join(to)
  return out
}

/** 复制参考工程时跳过的目录：构建产物、运行目录、IDE/工具缓存都不跟过去 */
const REF_COPY_SKIP = new Set(['.git', '.gradle', '.idea', '.vscode', 'bin', 'build', 'out', 'run', 'tools'])

/** gradle.properties 取一个键（缺省空串） */
function propOf(text: string, key: string): string {
  return text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
}

/** 参考工程：MC_ROOT 下的名字或绝对路径，必须是含 build.gradle 的目录 */
async function resolveReference(input: string): Promise<string> {
  const dir = isAbsolute(input) ? resolve(input) : resolve(MC_ROOT, input)
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`参考工程不存在：${dir}`)
  if (!existsSync(join(dir, 'build.gradle'))) throw new Error(`不是 Forge 工程（缺 build.gradle）：${dir}`)
  return dir
}

/** 在 src/main/java 里找主类（*Mod.java，层级最浅的优先） */
async function findMainClass(projectDir: string): Promise<{ className: string; pkgRel: string } | null> {
  const base = join(projectDir, 'src/main/java')
  if (!existsSync(base)) return null
  let best: { className: string; pkgRel: string; depth: number } | null = null
  const walk = async (dir: string, rel: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { await walk(join(dir, e.name), r); continue }
      if (!/^[A-Za-z0-9_]+Mod\.java$/.test(e.name)) continue
      const depth = r.split('/').length
      if (!best || depth < best.depth) best = { className: e.name.slice(0, -5), pkgRel: rel, depth }
    }
  }
  await walk(base, '')
  const found = best as { className: string; pkgRel: string; depth: number } | null
  return found ? { className: found.className, pkgRel: found.pkgRel } : null
}

/** 递归搬 Java 包目录，顺带做文本替换与文件改名（主类 XxxMod.java → 新主类名） */
async function moveJavaTree(src: string, dst: string, pairs: [string, string][], renameMap: Record<string, string>) {
  await mkdir(dst, { recursive: true })
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name)
    const d = join(dst, renameMap[e.name] ?? e.name)
    if (e.isDirectory()) await moveJavaTree(s, d, pairs, renameMap)
    else {
      const text = await readFile(s, 'utf8').catch(() => null)
      if (text === null) await writeFile(d, await readFile(s))
      else await writeFile(d, replaceAll(text, pairs))
    }
  }
}

/** gradle.properties：mod_id / mod_name / group / 作者 / 描述 */
async function writeGradleProps(projectDir: string, opts: { modId: string; packageName: string; displayName?: string; author?: string }) {
  const propsPath = join(projectDir, 'gradle.properties')
  let props = await readFile(propsPath, 'utf8')
  props = props
    .replace(/^mod_id=.*$/m, `mod_id=${opts.modId}`)
    .replace(/^mod_name=.*$/m, `mod_name=${opts.displayName ?? opts.modId}`)
    .replace(/^mod_group_id=.*$/m, `mod_group_id=${opts.packageName}`)
    .replace(/^mod_authors=.*$/m, `mod_authors=${opts.author ?? 'openmods'}`)
    .replace(/^mod_description=.*$/m, `mod_description=${opts.displayName ?? opts.modId} - built with openmods`)
  await writeFile(propsPath, props)
}

/**
 * 复制参考工程骨架：整棵树搬过来（跳过构建产物/运行目录），把
 *   旧包名 → 新包名、旧主类名 → 新主类名、旧 modid → 新 modid、旧显示名 → 新显示名
 * 同时做 Java 包目录 / assets|data 命名空间目录的改名。
 * 业务代码不做裁剪，复制完由模型按新需求删改（参考工程本身就是可编译起点）。
 */
async function copyReferenceProject(
  refDir: string,
  projectDir: string,
  opts: { modId: string; packageName: string; mainClass: string; displayName?: string },
): Promise<string[]> {
  const refProps = await readFile(join(refDir, 'gradle.properties'), 'utf8').catch(() => '')
  const oldModId = propOf(refProps, 'mod_id')
  const oldName = propOf(refProps, 'mod_name')
  if (!oldModId) throw new Error(`参考工程 gradle.properties 缺少 mod_id：${refDir}`)
  const main = await findMainClass(refDir)
  if (!main) throw new Error(`参考工程找不到主类（*Mod.java）：${refDir}`)

  const files = await copyTree(refDir, projectDir, REF_COPY_SKIP)
  // 根级噪音（构建日志 / 崩溃记录 / 画布导出的 bbmodel）不跟着搬
  for (const f of files.filter(f => !f.includes('/') && /\.(log|bbmodel)$/i.test(f))) {
    await rm(join(projectDir, f), { force: true })
  }

  const pairs: [string, string][] = [
    [main.pkgRel.split('/').join('.'), opts.packageName],
    [main.className, opts.mainClass],
    [oldModId, opts.modId],
  ]
  const shown = opts.displayName ?? opts.modId
  if (oldName && oldName !== oldModId) pairs.push([oldName, shown])

  // 1) Java 包目录搬家 + 主类改名
  const javaRoot = join(projectDir, 'src/main/java')
  const oldPkgDir = join(javaRoot, main.pkgRel)
  const newPkgDir = join(javaRoot, ...opts.packageName.split('.'))
  if (existsSync(oldPkgDir) && resolve(oldPkgDir) !== resolve(newPkgDir)) {
    await moveJavaTree(oldPkgDir, newPkgDir, pairs, { [`${main.className}.java`]: `${opts.mainClass}.java` })
    await rm(oldPkgDir, { recursive: true, force: true })
    // 清掉因搬家变空的父目录（如 com/openmodsai）
    let dir = dirname(oldPkgDir)
    while (dir.startsWith(javaRoot) && resolve(dir) !== resolve(javaRoot)) {
      await rmdir(dir).catch(() => {})
      dir = dirname(dir)
    }
  }

  // 2) 资源/数据命名空间目录改名（assets/reddragon → assets/icedragon）
  for (const kind of ['assets', 'data']) {
    const from = join(projectDir, 'src/main/resources', kind, oldModId)
    const to = join(projectDir, 'src/main/resources', kind, opts.modId)
    if (from !== to && existsSync(from)) {
      if (existsSync(to)) await rm(to, { recursive: true, force: true })
      await rename(from, to).catch(async () => {
        await cp(from, to, { recursive: true })
        await rm(from, { recursive: true, force: true })
      })
    }
  }

  // 3) 其余文本文件（json/toml/gradle/properties/txt/mcmeta）统一替换 modid/显示名
  const textExt = /\.(java|json|toml|mcmeta|gradle|properties|txt|md)$/i
  const walkReplace = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (REF_COPY_SKIP.has(e.name)) continue
        await walkReplace(join(dir, e.name))
        continue
      }
      if (!textExt.test(e.name)) continue
      const p = join(dir, e.name)
      const text = await readFile(p, 'utf8').catch(() => null)
      if (text === null) continue
      const next = replaceAll(text, pairs)
      if (next !== text) await writeFile(p, next)
    }
  }
  await walkReplace(projectDir)

  return files
}

/**
 * 从模板创建 1.20.1 Forge 工程。
 * 模板就是官方 MDK 47.4.10（已经预置 BMCLAPI 镜像 + 超时 + run 配置），
 * 这里只替换包名/modid/主类/显示名，并修改示例类的类名。
 */
async function scaffold(opts: {
  name: string
  modId: string
  packageName: string
  displayName?: string
  author?: string
  /** 目标根目录（会话 cwd）；缺省 MC_ROOT */
  root?: string
  /** 可选：参考工程（MC_ROOT 下的名字或绝对路径），复制其骨架并改包名/modid */
  from?: string
}): Promise<{ projectDir: string; files: string[] }> {
  const { modId, packageName } = opts
  if (!MOD_ID_RE.test(modId)) throw new Error(`modId 非法（小写字母开头，只含 a-z0-9_）：${modId}`)
  if (!PKG_RE.test(packageName)) throw new Error(`packageName 非法（如 com.example.mymod）：${packageName}`)

  const rawName = opts.name.trim()
  // 绝对路径原样使用：以前一律当目录名清洗，会把 F:\...\dragon 变成 F--Project-... 的嵌套目录，
  // 模型只好再手工 mv 一堆文件。
  const projectDir = isAbsolute(rawName)
    ? resolve(rawName)
    : resolve(opts.root ?? MC_ROOT, rawName.replace(/[^a-zA-Z0-9._-]/g, '-'))
  const exists = await stat(projectDir).catch(() => null)
  if (exists) {
    const entries = await readdir(projectDir)
    if (entries.length) throw new Error(`目标目录非空：${projectDir}`)
  }

  const mainClass = modId.split('_').map(s => s ? s[0].toUpperCase() + s.slice(1) : s).join('') + 'Mod'
  const pkgPath = packageName.split('.').join('/')

  // 0) 参考工程复制骨架：直接搬现成工程（如 reddragon-mod）的源码/资源，改包名+modid。
  //    比从空模板手搓实体、模型、渲染、动画快一个数量级，也是「本机已有 MDK 资源」的入口。
  if (opts.from) {
    const refDir = await resolveReference(opts.from)
    const files = await copyReferenceProject(refDir, projectDir, { modId, packageName, mainClass, displayName: opts.displayName })
    await writeGradleProps(projectDir, opts)
    return { projectDir, files }
  }

  const files = await copyTree(TEMPLATE, projectDir, new Set([...REF_COPY_SKIP, 'run-console.log']))

  // 1) 包目录搬家：src/main/java/com/example/examplemod → <pkgPath>
  const oldPkgDir = join(projectDir, 'src/main/java/com/example/examplemod')
  const newPkgDir = join(projectDir, 'src/main/java', pkgPath)
  await mkdir(newPkgDir, { recursive: true })
  for (const f of await readdir(oldPkgDir)) {
    const content = replaceAll(await readFile(join(oldPkgDir, f), 'utf8'), [
      ['com.example.examplemod', packageName],
      ['ExampleMod', mainClass],
      ['examplemod', modId],
      ['Example Mod', opts.displayName ?? modId],
    ])
    const outName = f === 'ExampleMod.java' ? `${mainClass}.java` : f
    await writeFile(join(newPkgDir, outName), content)
  }
  // 只删模板自带的示例包目录。注意不能删 com/example 整个父目录：
  // 用户包名常常是 com.example.<modid>，新包就在里面（删父目录会把刚写的文件一起删掉）。
  await rm(oldPkgDir, { recursive: true, force: true })
  // 顺手清掉因搬家而空掉的父目录（失败无所谓，非空目录 rmdir 会抛错）
  await rmdir(join(projectDir, 'src/main/java/com/example')).catch(() => {})

  // 2) gradle.properties：mod_id / mod_name / group / 作者 / 描述
  await writeGradleProps(projectDir, opts)

  // 3) 示例资源：ruby 的模型/贴图/语言 + 创造栏名
  //    ⚠️ Minecraft 的缺失模型和缺失贴图都渲染成同一个黑紫格，
  //    所以「注册了物品但没写 models/item/<id>.json」在游戏里就是紫黑方块，必须先给资源。
  const assets = join(projectDir, 'src/main/resources/assets', modId)
  await mkdir(join(assets, 'models/item'), { recursive: true })
  await mkdir(join(assets, 'textures/item'), { recursive: true })
  await mkdir(join(assets, 'lang'), { recursive: true })
  await writeFile(join(assets, 'models/item/ruby.json'), JSON.stringify({
    parent: 'minecraft:item/generated',
    textures: { layer0: `${modId}:item/ruby` },
  }, null, 2) + '\n')
  await writeFile(join(assets, 'textures/item/ruby.png'), solidPng('#c0392b', 16, 16))
  await writeFile(join(assets, 'lang/zh_cn.json'), JSON.stringify({
    [`item.${modId}.ruby`]: '红宝石',
    [`itemGroup.${modId}.ruby_tab`]: '红宝石',
  }, null, 2) + '\n')
  await writeFile(join(assets, 'lang/en_us.json'), JSON.stringify({
    [`item.${modId}.ruby`]: 'Ruby',
    [`itemGroup.${modId}.ruby_tab`]: 'Ruby',
  }, null, 2) + '\n')

  // 4) 主类：把 MDK 的示例（example_block / example_item / example_tab）整段换成 ruby + ruby_tab。
  //    只加注册不删示例的话，示例物品仍然出现在创造栏里且没有模型 → 一片黑紫格。
  const mainPath = join(newPkgDir, `${mainClass}.java`)
  let main = await readFile(mainPath, 'utf8')
  if (!main.includes('RUBY')) {
    // 4.1 注册段整体替换（从 EXAMPLE_BLOCK 注释到 tab 的 .build());）
    main = main.replace(
      /[ \t]*\/\/ Creates a new Block with the id[\s\S]*?\.build\(\)\);\n/,
      [
        '    // 物品：' + `${modId}:ruby`,
        '    // 模型 models/item/ruby.json、贴图 textures/item/ruby.png、语言 key item.' + modId + '.ruby 都已就位',
        '    public static final RegistryObject<Item> RUBY = ITEMS.register("ruby", () -> new Item(new Item.Properties()));',
        '',
        '    // 创造模式物品栏：' + `${modId}:ruby_tab，排在「战斗」页后面`,
        '    // 语言 key 是 itemGroup.' + modId + '.ruby_tab，漏了会显示成原始 key',
        '    public static final RegistryObject<CreativeModeTab> RUBY_TAB = CREATIVE_MODE_TABS.register("ruby_tab", () -> CreativeModeTab.builder()',
        '            .withTabsBefore(CreativeModeTabs.COMBAT)',
        '            .icon(() -> RUBY.get().getDefaultInstance())',
        '            .displayItems((parameters, output) -> output.accept(RUBY.get()))',
        '            .build());',
        '',
      ].join('\n'),
    )
    // 4.2 去掉 addCreative 监听注册 + 方法本身（示例物品已不存在）
    main = main
      .replace(/[ \t]*\/\/ Register the item to a creative tab\n[ \t]*modEventBus\.addListener\(this::addCreative\);\n\n?/, '')
      .replace(/[ \t]*\/\/ Add the example block item to the building blocks tab\n[ \t]*private void addCreative\(BuildCreativeModeTabContentsEvent event\)\n[\s\S]*?\n    \}\n\n?/, '')
      // 4.3 清掉不再使用的 import（Block / Blocks 仍被 BLOCKS 与 Blocks.DIRT 使用，保留）
      .replace(/^import net\.minecraft\.world\.food\.FoodProperties;\n/m, '')
      .replace(/^import net\.minecraft\.world\.item\.BlockItem;\n/m, '')
      .replace(/^import net\.minecraft\.world\.level\.block\.state\.BlockBehaviour;\n/m, '')
      .replace(/^import net\.minecraft\.world\.level\.material\.MapColor;\n/m, '')
      .replace(/^import net\.minecraftforge\.event\.BuildCreativeModeTabContentsEvent;\n/m, '')
    await writeFile(mainPath, main)
  }

  return { projectDir, files: files.filter(f => !f.startsWith('src/main/java/com/example')) }
}

/** 运行 gradlew；background=true 用于 runClient（长驻），立即返回 pid */
async function runGradle(opts: {
  projectDir: string
  task: string
  args?: string[]
  background?: boolean
  timeoutSec?: number
  /** 会话工作目录：GRADLE_USER_HOME 缺省时用它下面的 .gradle-home（预热缓存就放那儿） */
  root?: string
  /** 非后台任务结束回调（构建结果推给 UI / 插件事件用） */
  onResult?: (r: { task: string; ok: boolean; code: number }) => void
}): Promise<ToolResult> {
  const { projectDir, task } = opts
  if (!/^[a-zA-Z][\w:.-]*$/.test(task)) return fail(`任务名不合法：${task}`)
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const argv = [gradlew, task, '--console=plain', ...(opts.args ?? [])]
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME ?? 'F:/sdk_java/jdk-17',
    GRADLE_USER_HOME: process.env.OPENMODS_GRADLE_HOME ?? process.env.GRADLE_USER_HOME ?? WARM_GRADLE_HOME ?? join(opts.root ?? MC_ROOT, '.gradle-home'),
  }
  // 首次跑之前先把两块最容易挂的缓存摆好：FG 绕开 Gradle 仓库直连官方源的
  // 构件（无读超时，缺了就无限期卡住）+ wrapper 发行版（gradlew 首跑免下载）。
  const seed = await seedMavenCache(env.GRADLE_USER_HOME)
  const wrapper = await seedWrapperDist(env.GRADLE_USER_HOME, projectDir)
  const seedNote = (seed.added || seed.failed.length)
    ? `缓存补齐（${wrapper === 'seeded' ? 'Gradle 发行版已从项目内 vendor 播种' : wrapper === 'cached' ? 'Gradle 发行版已有缓存' : 'Gradle 发行版无 vendor 包'}）：新增 ${seed.added}、已存在 ${seed.skipped}`
      + (seed.failed.length ? `、失败 ${seed.failed.join('、')}` : '') + '\n'
    : wrapper === 'seeded'
      ? 'Gradle 发行版已从项目内 vendor 播种，wrapper 免联网下载。\n'
      : ''

  if (opts.background) {
    if (task === 'runClient') {
      const r = await launchClient(projectDir, env)
      return {
        forModel: seedNote + r.stoppedNote
          + `已在后台启动 runClient（pid ${r.pid}）。控制台日志 ${r.logPath}（已重置）；游戏日志用 mc_log 读 run/logs/latest.log。`
          + `\n启动后用 mc_log project=. waitSec=120 等启动标记，不要用 bash sleep/tail 轮询；不要重复启动。`,
      }
    }
    // 其它任务照旧后台跑：不登记 runClient 状态
    await mkdir(join(projectDir, 'run'), { recursive: true })
    const logPath = join(projectDir, 'run-console.log')
    const out = createWriteStream(logPath, { flags: 'w' })
    const child = spawn(gradlew, argv.slice(1), {
      cwd: projectDir, env, shell: process.platform === 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(out)
    child.stderr?.pipe(out)
    child.unref()
    return {
      forModel: seedNote + `已在后台启动 ${task}（pid ${child.pid}）。控制台日志 ${logPath}（已重置）。`,
    }
  }

  const timeoutMs = Math.min(Math.max((opts.timeoutSec ?? 600) * 1000, 30_000), 3_600_000)
  return await new Promise<ToolResult>(resolvePromise => {
    const child = spawn(gradlew, argv.slice(1), {
      cwd: projectDir, env, shell: process.platform === 'win32', windowsHide: true,
    })
    let raw = Buffer.alloc(0)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let markerTimer: ReturnType<typeof setTimeout> | undefined
    const text = () => decodeText(raw)
    const netHint = () => /Connection refused|SSL|Could not resolve|Could not GET|Read timed out/i.test(text())
      ? '\n依赖下载失败（镜像/网络）：优先检查网络，或用 OPENMODS_GRADLE_HOME 指向已预热缓存；'
        + '不要为此修改 build.gradle / gradle.properties 的 MC、Forge、Gradle 版本。'
      : ''
    /**
     * 收尾：Gradle daemon 有时攥着 stdout/stderr 句柄不放，只等 close 会一直拖到 timeout。
     * 因此「BUILD SUCCESSFUL / BUILD FAILED 出现后短暂收尾」或进程 exit 后强制收尾，
     * 保证工具结果（和会话回合）及时结束。
     */
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(markerTimer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      recordBuild(projectDir, task, code)
      opts.onResult?.({ task, ok: code === 0, code })
      const out = text()
      const tail = out.length > 8000 ? `…（截断，共 ${out.length} 字符）\n${out.slice(-8000)}` : out
      resolvePromise({
        forModel: seedNote + `gradlew ${task} 退出码 ${code}\n${tail || '（无输出）'}${code === 0 ? '' : netHint()}`,
        isError: code !== 0,
      })
    }
    const onData = (d: Buffer) => {
      raw = Buffer.concat([raw, d])
      if (raw.length > 400_000) raw = raw.subarray(-200_000) // 防跑飞
      // 构建结束标记：成功/失败都立刻进入收尾（留 600ms 吃掉剩余输出），不再等 close
      const now = text()
      if (!markerTimer && /BUILD (SUCCESSFUL|FAILED) in|FAILURE: Build failed/.test(now)) {
        const ok = /BUILD SUCCESSFUL in/.test(now)
        markerTimer = setTimeout(() => finish(ok ? 0 : 1), 600)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(markerTimer)
      child.kill('SIGTERM')
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolvePromise(fail(`gradlew ${task} 超时（${timeoutMs / 1000}s）。尾部输出：\n${text().slice(-4000)}`))
    }, timeoutMs)
    child.on('close', code => finish(code ?? -1))
    // close 依赖管道关闭；daemon 不放手时用 exit 兜底（再给 400ms 收尾输出）
    child.on('exit', code => { setTimeout(() => finish(code ?? -1), 400) })
    child.on('error', e => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(markerTimer)
      resolvePromise(fail(`无法启动 gradlew：${e.message}`))
    })
  })
}

/** 日志行过滤：pattern 为空时返回尾部 tailLines 行，否则返回带行号的匹配行 */
function grepLines(text: string, pattern: string, maxMatches: number, tailLines: number): { body: string; detail: string } {
  const all = text.split(/\r?\n/)
  if (!pattern) {
    const count = Math.min(tailLines, all.length)
    return { body: all.slice(-count).join('\n'), detail: `最后 ${count} 行` }
  }
  const re = new RegExp(pattern, 'i')
  const hits: string[] = []
  for (let i = 0; i < all.length; i++) {
    if (!re.test(all[i])) continue
    hits.push(`${i + 1}:${all[i]}`)
    if (hits.length >= maxMatches) break
  }
  if (hits.length) return { body: hits.join('\n'), detail: `匹配 /${pattern}/ ${hits.length}${hits.length >= maxMatches ? '+' : ''} 条` }
  const count = Math.min(tailLines, all.length)
  return { body: all.slice(-count).join('\n'), detail: `没有匹配 /${pattern}/ 的行，下面是最后 ${count} 行` }
}

const SOURCE_SKIP = new Set(['build', '.gradle', 'run', 'out', '.git', 'node_modules'])

/** 源码/资源的最新修改时间：用于判断 runClient 启动后是否又改过代码 */
function newestSourceMtime(dir: string, depth = 0): number {
  if (depth > 12) return 0
  let newest = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SOURCE_SKIP.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) newest = Math.max(newest, newestSourceMtime(p, depth + 1))
      else { try { newest = Math.max(newest, statSync(p).mtimeMs) } catch { /* 文件刚被删 */ } }
    }
  } catch { /* 目录不存在/无权限 */ }
  return newest
}

/** latest.log 尾部 + 启动状态；waitSec > 0 时轮询等待启动标记（最多 180s） */
async function readLogs(projectDir: string, lines: number, waitSec = 0, pattern = '', maxMatches = 40): Promise<string> {
  const n = Math.min(Math.max(lines || 80, 10), 400)
  // 先校验正则，避免等到拿到日志才抛错
  if (pattern) new RegExp(pattern, 'i')
  const max = Math.min(Math.max(maxMatches || 40, 1), 200)
  const state = readMcState()[projectDir]?.runClient
  const startedAt = state?.startedAt
  const waitMs = Math.min(Math.max(Number(waitSec) || 0, 0), 180) * 1000
  const deadline = Date.now() + waitMs
  const marks = ['Sound engine started', 'Forge mod loading', 'Backend library: LWJGL', 'Created: 1024x512']
  let stale = ''

  /** 只认本次 runClient 之后产生的日志，避免拿上一次运行的成功标记当本次结果 */
  const readFresh = async (): Promise<{ text: string; path: string } | null> => {
    for (const p of [join(projectDir, 'run/logs/latest.log'), join(projectDir, 'run/logs/debug.log')]) {
      const st = await stat(p).catch(() => null)
      if (!st) continue
      if (startedAt && st.mtimeMs < startedAt - 2000) {
        stale = `latest.log 是上一次运行的（${new Date(st.mtimeMs).toLocaleTimeString()}），已忽略。`
        continue
      }
      const buf = await readFile(p).catch(() => null)
      if (buf) return { text: decodeText(buf), path: p }
    }
    return null
  }

  const format = (text: string, path: string, timedOut: boolean) => {
    const all = text.split(/\r?\n/)
    const seen = marks.filter(m => text.includes(m))
    const crashed = /---- Minecraft Crash Report ----|A fatal error has been detected/.test(text)
    const live = state ? pidAlive(state.pid) : false
    // runClient 启动后模型又改了源码时，这份日志对应的是旧代码，不能拿来验收新改动
    const sourceMtime = Math.max(
      newestSourceMtime(join(projectDir, 'src')),
      ...[join(projectDir, 'build.gradle'), join(projectDir, 'settings.gradle'), join(projectDir, 'gradle.properties')]
        .map(p => { try { return statSync(p).mtimeMs } catch { return 0 } }),
    )
    const editedAfterStart = !!startedAt && sourceMtime > startedAt + 2000
    const picked = grepLines(text, pattern, max, n)
    const head = [
      `日志 ${relative(projectDir, path)}（共 ${all.length} 行，${picked.detail}）`,
      seen.length ? `启动标记：${seen.join(' / ')}` : '启动标记：尚未出现',
      crashed ? '⚠ 日志里出现崩溃报告' : '',
      editedAfterStart
        ? `⚠ 客户端启动后源码有改动（最新 ${new Date(sourceMtime).toLocaleTimeString()}）；这份日志对应旧代码，改完请重新 build + runClient。`
        : '',
      state
        ? (live
          ? `客户端运行中（pid ${state.pid}，已启动 ${Math.round((Date.now() - state.startedAt) / 1000)}s）`
          : `客户端已退出（pid ${state.pid}）`)
        : '未登记运行中的 runClient（可能是手动启动的客户端）',
      timedOut && !crashed && !seen.includes('Sound engine started')
        ? `等待 ${Math.round(waitMs / 1000)}s 未看到 Sound engine started`
        : '',
    ].filter(Boolean).join('\n')
    return `${head}\n\n${picked.body}`
  }

  for (;;) {
    const log = await readFresh()
    if (log) {
      const done = /Sound engine started|---- Minecraft Crash Report ----|A fatal error has been detected/.test(log.text)
        || (!!state && !pidAlive(state.pid))
      const timedOut = !waitMs || Date.now() >= deadline
      if (done || timedOut) return format(log.text, log.path, waitMs > 0 && timedOut)
    }
    if (!waitMs || Date.now() >= deadline) break
    // 客户端已经退出且没有新日志：不必把 waitSec 耗满
    if (state && !pidAlive(state.pid)) break
    await new Promise(r => setTimeout(r, Math.min(1500, Math.max(0, deadline - Date.now()))))
  }

  // 没有可用的 latest.log 时再看崩溃报告；只认本次 runClient 之后生成的，避免拿旧崩溃误导
  const crashDir = join(projectDir, 'run/crash-reports')
  const reports = await readdir(crashDir).catch(() => [] as string[])
  if (reports.length) {
    const newest = reports.sort().at(-1)!
    const reportPath = join(crashDir, newest)
    const st = await stat(reportPath).catch(() => null)
    if (!startedAt || (st && st.mtimeMs >= startedAt - 2000)) {
      const text = decodeText(await readFile(reportPath).catch(() => Buffer.alloc(0)))
      const body = pattern ? grepLines(text, pattern, max, 80).body : text.split(/\r?\n/).slice(0, 80).join('\n')
      return `没有可用的 latest.log，但有崩溃报告 ${newest}：\n\n${body}`
    }
  }

  const total = waitMs ? `等待 ${Math.round(waitMs / 1000)}s 后仍未出现 latest.log` : '还没有可用的 latest.log'
  const status = state
    ? (pidAlive(state.pid)
      ? `客户端运行中（pid ${state.pid}，已启动 ${Math.round((Date.now() - state.startedAt) / 1000)}s），latest.log 尚未生成。${stale}`
      : `客户端已退出（pid ${state.pid}），latest.log 尚未生成。${stale}`)
    : `没有检测到运行中的 runClient：先 mc_gradle task=runClient background=true，再 mc_log waitSec=120。${stale}`
  const consoleBuf = await readFile(join(projectDir, 'run-console.log')).catch(() => null)
  const consoleBody = consoleBuf ? grepLines(decodeText(consoleBuf), pattern, max, 40) : null
  const tail = consoleBody
    ? `\n\nrun-console.log ${pattern ? `匹配 /${pattern}/` : '尾部'}：\n${consoleBody.body}`
    : ''
  return `${total}。${status}${tail}`
}

/** mcmod 角色的提示词归插件自己：关掉 mc 开关后这套工作流连角色一起消失 */
const MCMOD_PROMPT = '你是 Minecraft 1.20.1 Forge 模组开发主代理（mcmod）。只做 **Java + Minecraft 1.20.1 + Forge 47.x**；'
  + '用户要 Fabric / NeoForge / 1.20.2+ / Kotlin / 网易版时，明确说明本代理不覆盖，不要硬改工程。\n'
  + '你有完整工作台：read/write/edit/glob/grep 读写工程、bash 跑命令、terminal_open/terminal_kill 拉起/结束长任务终端、'
  + 'ask_user_question 问用户、todo_write 记步骤、exit_plan_mode 提交计划。工作目录就是当前工程目录，相对路径都以它为根。\n'
  + '工作流固定：\n'
  + '1) 先 load_skill("minecraft-forge-1.20.1") 拿到工具链与 API 约束；它会返回技能目录和 references 清单，'
  + '需要精确签名时用 load_skill name="minecraft-forge-1.20.1" file="references/forge-1.20.1-api.md" 读取，不要凭记忆写，也不要从会话目录猜 skills/ 相对路径。\n'
  + '2) 核对需求：modid、Java 包名、要加的东西（物品/方块/实体/命令/玩法）。信息不足时用 ask_user_question 一次问全，别反复问。\n'
  + '3) 建工程：先看会话目录里是否已有工程（存在 build.gradle 就直接沿用，不要重复 scaffold）。目录为空才用 mc_scaffold：'
  + 'name 只传目录名或绝对路径，目标必须是空目录，建完不要再手工 mv 文件。做龙/实体/方块等有现成示例时，'
  + '用 mc_scaffold 的 from=参考工程（可用项见工具说明）复制骨架，再改包名/modid，不要从零手搓框架。\n'
  + '   然后用 read/edit/write（或 mc_list/mc_read/mc_write）改 Java 与资源。\n'
  + '4) 构建失败先分流：出现 Connection refused / SSL / Could not resolve / Read timed out 是镜像或网络问题——'
  + '告知用户或换网络/源，不要改代码，也不要动 build.gradle、settings.gradle、gradle wrapper 或平台版本；'
  + '只有编译错误才按报错改代码。本机已有预热 Gradle 缓存，不要建议用户重新下载依赖。\n'
  + '5) 造型（物品/方块/生物外观）派给 spawn_modeling_subagent；派发完结束这一轮，等系统汇总回合。汇总回合先请用户验收画布模型（ask_user_question：通过 / 要改哪里 / 重做），用户通过后用 canvas_export 把完整画布工程导出成 JSON（分组骨骼/pivot/UV/贴图/动画全在内），再用脚本解析生成 Java 模型类与贴图——这是唯一不失真的落地路径。mc_export_model 只产原版 item 模型（无骨骼无动画），仅限导出简单物品外观。不要自己手搓几何，更不要派子代理抄画布。\n'
  + '   若 canvas_export 产物解析后发现与画布不符（不太可能），先核对解析代码再考虑其它路径；仍不行就 ask_user_question 问用户怎么落地（比如让用户从 Blockbench 手动保存 .bbmodel），不要反复盲试、更不要据此重做模型。\n'
  + '   画布组织：一个画布可以放多个模型；用户要求拆开时，用 create_canvas 新建空白画布，再用 split_canvas_group 把顶层分组迁到新画布（默认不切换活跃画布，可连续拆）。不要复制坐标、也不要手工重建模型。\n'
  + '6) 构建用 mc_gradle task=build；要验证能否进游戏就用 mc_gradle task=runClient background=true，'
  + '   然后 mc_log project=. waitSec=120 等启动标记（Sound engine started / Forge mod loading），失败先看崩溃报告再改。'
  + '   **不要用 bash sleep/tail/grep 轮询客户端日志**：mc_log waitSec 会轮询等待并在标记出现/崩溃/超时时返回；'
  + '   查具体错误用 mc_log pattern="ERROR|Exception"（不要在 bash 里 grep 日志，日志可能是 GBK/二进制）。'
  + '   **不要猜 tty-N**，bash 前台命令结束后没有可读终端；mc_gradle 启动 runClient 会自动停掉同一工程的上一个客户端，不要重复启动。'
  + '   **runClient 启动后不要改源码**；如果改了，先 build 再重新 runClient（会自动停旧客户端），'
  + '   不要拿旧客户端的日志验收新代码——mc_log 检测到启动后源码有改动会直接提示。'
  + '   连续两次 mc_log waitSec 仍没有启动标记，就把当前进度和日志片段告诉用户，不要继续加长 sleep。\n'
  + '7) 收尾汇报：改了哪些文件、build 是否通过、客户端是否真的起来了、还有哪些没验证。\n'
  + '工具名以本清单为准，只能调用实际注册的工具；没有 mc_export、mc_edit、mc_canvas_outline、mc_list_outline、export_model、save_model 这些工具——'
  + '画布工程整体导出叫 canvas_export（含骨骼/贴图/动画），导出原版 item 模型才叫 mc_export_model，改工程文件用 edit/write。拿不准就先看函数目录（工具定义），不要凭名字猜。\n'
  + '铁律：不改 MC 版本、不换加载器、不动 gradle.properties 里的 minecraft_version/forge_version；'
  + '资源路径全小写；每次写完 Java 都要重新 build，不能只靠肉眼检查。'

const MCMOD_TOOLS = [
  'load_skill', 'mc_scaffold', 'mc_list', 'mc_read', 'mc_write', 'mc_gradle', 'mc_log', 'mc_export_model', 'canvas_export',
  'create_canvas', 'split_canvas_group', 'spawn_modeling_subagent', 'list_subagents', ...WORKSPACE_TOOL_NAMES,
]

const plugin: Plugin = {
  name: 'mcdev',
  // 关闭 mc 开关时整个插件不加载：mc_* 工具、mcmod 角色、Forge 技能一起消失
  features: [{ id: 'mc', name: 'Minecraft 模组开发', description: 'MC 模组脚手架、Gradle 构建、日志与运行工具。', default: true }],
  requires: ['mc'],
  skills: ['minecraft-forge-1.20.1'],
  apply(ctx) {
    ctx.profiles.register({
      id: 'mcmod',
      name: 'Minecraft 1.20.1 模组开发（mcmod）',
      prompt: MCMOD_PROMPT,
      toolFilter: MCMOD_TOOLS,
      skills: ['minecraft-forge-1.20.1'],
    })
    ctx.tools.register({
      name: 'mc_scaffold',
      mutates: true,
      description: '创建 Minecraft 1.20.1 Forge（47.4.10）模组工程：官方 MDK 模板 + 国内镜像 + 示例资源。'
        + 'name 传工程目录名（如 ruby-mod），也可传绝对路径（必须是空目录/不存在）；会话目录本身就是工程根时传 "."。'
        + '不要传了路径又手工 mv 文件——目标目录会被直接使用。'
        + (REFERENCE_PROJECTS.length
          ? ` 现成参考工程（用 from 复制骨架，比手搓快）：${REFERENCE_PROJECTS.join('、')}。`
          : ''),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工程目录名（如 ruby-mod），或绝对路径（空目录/不存在）；会话目录即工程根时传 "."' },
          modId: { type: 'string', description: 'modid，小写字母开头、只含 a-z0-9_（如 rubymod）' },
          packageName: { type: 'string', description: 'Java 包名（如 com.example.rubymod）' },
          displayName: { type: 'string', description: '游戏内显示名（可选）' },
          author: { type: 'string', description: '作者（可选）' },
          from: { type: 'string', description: '可选：参考工程名（见说明）或绝对路径；复制其源码/资源骨架并自动改包名/modid/主类名' },
        },
        required: ['name', 'modId', 'packageName'],
      },
      async execute(args, exec) {
        try {
          const out = await scaffold({
            name: String(args.name), modId: String(args.modId), packageName: String(args.packageName),
            displayName: args.displayName ? String(args.displayName) : undefined,
            author: args.author ? String(args.author) : undefined,
            from: args.from ? String(args.from) : undefined,
            root: rootOf(exec),
          })
          return {
            forModel: `已创建 1.20.1 Forge 工程：${out.projectDir}\n`
              + (args.from ? `骨架来自参考工程 ${String(args.from)}（包名/modid/主类名已替换）\n` : '')
              + `主类 src/main/java/${String(args.packageName).replace(/\./g, '/')}/`
              + `${String(args.modId).split('_').map(x => x ? x[0].toUpperCase() + x.slice(1) : x).join('')}Mod.java\n`
              + `下一步：mc_gradle build（缓存已就绪时约 3 分钟；全新 GRADLE_USER_HOME 首次 5~8 分钟）→ mc_gradle runClient background=true。`,
          }
        } catch (e: any) { return fail(`创建失败：${e.message}`) }
      },
    })

    ctx.tools.register({
      name: 'mc_list',
      description: '列出工程目录（默认两层，跳过 build/.gradle/run 的噪音）。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录（绝对路径或 MC_ROOT 下的名字）' },
          path: { type: 'string', description: '相对工程根的路径，默认空（工程根）' },
          depth: { type: 'integer', description: '递归层数，默认 2' },
        },
        required: ['project'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          const base = await safeJoin(dir, String(args.path ?? ''))
          const depth = Math.min(Math.max(Number(args.depth ?? 2), 1), 4)
          const skip = new Set(['build', '.gradle', 'run', 'node_modules', '.git'])
          const out: string[] = []
          const walk = async (d: string, rel: string, level: number) => {
            if (level > depth) return
            const entries = await readdir(d, { withFileTypes: true })
            for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
              if (skip.has(e.name)) continue
              const r = rel ? `${rel}/${e.name}` : e.name
              out.push(e.isDirectory() ? `${r}/` : r)
              if (e.isDirectory()) await walk(join(d, e.name), r, level + 1)
            }
          }
          await walk(base, '', 1)
          return { forModel: out.length ? out.join('\n') : '（空目录）' }
        } catch (e: any) { return fail(e.message) }
      },
    })

    ctx.tools.register({
      name: 'mc_read',
      description: '读工程内的文本文件（相对工程根）。默认最多 400 行，超长用 offset/limit 分段。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录' },
          path: { type: 'string', description: '相对工程根的文件路径' },
          offset: { type: 'integer', description: '起始行（1 起），默认 1' },
          limit: { type: 'integer', description: '最多读多少行，默认 400' },
        },
        required: ['project', 'path'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          const file = await safeJoin(dir, String(args.path))
          const text = await readFile(file, 'utf8')
          const lines = text.split(/\r?\n/)
          const offset = Math.max(Number(args.offset ?? 1), 1)
          const limit = Math.min(Math.max(Number(args.limit ?? 400), 1), 2000)
          const slice = lines.slice(offset - 1, offset - 1 + limit)
          return { forModel: `# ${args.path}（第 ${offset}~${offset + slice.length - 1} 行 / 共 ${lines.length} 行）\n${slice.join('\n')}` }
        } catch (e: any) { return fail(e.message) }
      },
    })

    ctx.tools.register({
      name: 'mc_write',
      mutates: true,
      description: '写工程内的文本文件（相对工程根，自动建目录，整文件覆盖）。Java/JSON/TOML/语言文件都用它。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录' },
          path: { type: 'string', description: '相对工程根的文件路径（如 src/main/java/com/x/y/ItemRegistry.java）' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['project', 'path', 'content'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          const file = await safeJoin(dir, String(args.path))
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, String(args.content ?? ''), 'utf8')
          return { forModel: `已写入 ${args.path}（${String(args.content ?? '').length} 字符）` }
        } catch (e: any) { return fail(e.message) }
      },
    })

    ctx.tools.register({
      name: 'mc_gradle',
      mutates: true,
      description: '在工程里跑 gradlew 任务（build / runClient / runData / --stop）。'
        + 'runClient 是长驻进程，必须 background=true；启动前会自动停掉同一工程的上一个客户端。'
        + '普通任务默认 600s 超时，返回尾部输出。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录' },
          task: { type: 'string', description: 'Gradle 任务名，如 build / runClient / runData / compileJava' },
          args: { type: 'string', description: '附加参数（空格分隔，可空）' },
          background: { type: 'boolean', description: 'true 时立即返回 pid（runClient 用）' },
          timeoutSec: { type: 'integer', description: '超时秒数，默认 600' },
        },
        required: ['project', 'task'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          const extra = String(args.args ?? '').trim() ? String(args.args).trim().split(/\s+/) : []
          return await runGradle({
            projectDir: dir,
            task: String(args.task),
            args: extra,
            background: !!args.background,
            timeoutSec: Number(args.timeoutSec ?? 600),
            root: rootOf(exec),
            // 构建结果广播给前端：点了「测试 Mod」/AI 跑完 build 都弹升级成就
            onResult: r => {
              if (r.task !== 'build') return
              ctx.events.emit('mc/build', {
                sessionId: exec.sessionId,
                project: basename(dir),
                ok: r.ok,
                code: r.code,
                time: Date.now(),
              })
            },
          })
        } catch (e: any) { return fail(e.message) }
      },
    })

    ctx.tools.register({
      name: 'mc_log',
      description: '读 run/logs/latest.log 尾部，并给出启动标记（Sound engine started / Forge mod loading）与崩溃提示。'
        + 'runClient 之后用 waitSec（最长 180s）等启动标记出现，不要用 bash sleep/tail 轮询日志。'
        + 'pattern 可用正则过滤（如 "ERROR|Exception|Corrupt PNG"），返回带行号的匹配行；日志会先按 UTF-8/GBK 解码。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录' },
          lines: { type: 'integer', description: '读最后多少行，默认 80' },
          waitSec: { type: 'integer', description: '等待启动标记的秒数（0~180，默认 0）；runClient 后建议 120' },
          pattern: { type: 'string', description: '可选：正则过滤日志行（如 ERROR|Exception），返回行号' },
          maxMatches: { type: 'integer', description: 'pattern 最多返回多少条，默认 40，最大 200' },
        },
        required: ['project'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          return {
            forModel: await readLogs(
              dir,
              Number(args.lines ?? 80),
              Number(args.waitSec ?? 0),
              String(args.pattern ?? ''),
              Number(args.maxMatches ?? 40),
            ),
          }
        } catch (e: any) { return fail(e.message) }
      },
    })

    ctx.tools.register({
      name: 'mc_export_model',
      mutates: true,
      description: '把当前画布上的模型导出成 Java 版 item 模型（models/item/<name>.json）+ 16×16 贴图，写进工程资源目录。'
        + '建模交给 spawn_modeling_subagent 做完后，用这个工具落进模组。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录' },
          modId: { type: 'string', description: 'modid（资源命名空间）' },
          name: { type: 'string', description: '物品名（小写，决定模型/贴图文件名）' },
          textureColor: { type: 'string', description: '没有画布贴图时的纯色（#RRGGBB，可选）' },
        },
        required: ['project', 'modId', 'name'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          const modId = String(args.modId)
          const name = String(args.name)
          if (!MOD_ID_RE.test(modId)) return fail(`modId 非法：${modId}`)
          if (!/^[a-z0-9_./-]+$/.test(name)) return fail(`name 只能用 a-z0-9_./-：${name}`)

          const doc: any = exec.canvas.read(exec.sessionId)
          if (!doc?.elements?.length) {
            return fail('当前画布没有模型：先让建模子代理建好模型（spawn_modeling_subagent），结算后再导出。')
          }

          // Blockbench 以中心为原点（-8..8），Java 物品模型以角为原点（0..16）
          const SHIFT = 8
          const clamp16 = (v: number) => Math.max(0, Math.min(16, Math.round(v * 100) / 100))
          const elements = doc.elements.slice(0, 64).map((e: any) => {
            const faces: Record<string, any> = {}
            for (const dir of ['north', 'south', 'east', 'west', 'up', 'down']) {
              const f = e.faces?.[dir]
              if (!f) continue
              const uv = (f.uv ?? [0, 0, 16, 16]).map(clamp16)
              faces[dir] = { uv, texture: '#0' }
            }
            return {
              from: [clamp16(e.from[0] + SHIFT), clamp16(e.from[1]), clamp16(e.from[2] + SHIFT)],
              to: [clamp16(e.to[0] + SHIFT), clamp16(e.to[1]), clamp16(e.to[2] + SHIFT)],
              faces,
            }
          })

          const assets = join(dir, 'src/main/resources/assets', modId)
          await mkdir(join(assets, 'models/item'), { recursive: true })
          await mkdir(join(assets, 'textures/item'), { recursive: true })
          await writeFile(join(assets, 'models/item', `${name}.json`), JSON.stringify({
            credit: 'exported by openmods mcdev',
            texture_size: [16, 16],
            textures: { 0: `${modId}:item/${name}` },
            elements,
          }, null, 2) + '\n')

          const tex = doc.textures?.[0]?.source
          let texNote = '纯色贴图'
          if (typeof tex === 'string' && tex.startsWith('data:image/png;base64,')) {
            await writeFile(join(assets, 'textures/item', `${name}.png`), Buffer.from(tex.split(',')[1], 'base64'))
            texNote = '画布贴图'
          } else {
            await writeFile(join(assets, 'textures/item', `${name}.png`), solidPng(String(args.textureColor ?? '#b4b4b4'), 16, 16))
          }

          return {
            forModel: `已导出 ${elements.length} 个立方体到 assets/${modId}/models/item/${name}.json，`
              + `贴图 textures/item/${name}.png（${texNote}）。\n`
              + `坐标已从 Blockbench 中心原点平移到 Java 的 0..16；旋转未导出（Java item 模型只支持单轴 rotation）。\n`
              + `记得在语言文件加 item.${modId}.${name}，并在物品注册里引用。`,
          }
        } catch (e: any) { return fail(`导出失败：${e.message}`) }
      },
    })

    // ---- 插件自带 HTTP 接口 ----
    // 关闭 mc 开关时本插件整个不 apply，这些路由也就不存在（前端按 /api/features 隐藏入口）。
    /** mod-output 必须是真实存在的目录；不存在返回 null */
    const existingDir = async (raw: string): Promise<string | null> => {
      const p = String(raw ?? '').trim()
      if (!p) return null
      try {
        const abs = await realpath(p)
        return (await stat(abs)).isDirectory() ? abs : null
      } catch { return null }
    }

    /** 会话 cwd 下的 MC 工程状态：构建结果 / runClient 运行中 / jar 产物 */
    ctx.http.route('GET', '/api/mc/state', async (req, reply) => {
      const root = ctx.sessions.cwdOf(String(req.query.sessionId ?? ''))
      if (!root) return reply.code(404).send({ error: '会话不存在或目录无效' })
      return { root, projects: await listMcProjects(root) }
    })

    /** jar 导出：把工程的最新构建产物复制到设置里的 mod-output 目录（prefs.modOutput） */
    ctx.http.route('POST', '/api/mc/export', async (req, reply) => {
      const root = ctx.sessions.cwdOf(String(req.body?.sessionId ?? ''))
      if (!root) return reply.code(404).send({ error: '会话不存在或目录无效' })
      const dest = String(ctx.prefs.get().modOutput ?? '')
      if (!dest) return reply.code(400).send({ error: '尚未配置 mod-output：请到 设置 → 通用 → Mod 构建里填写 jar 导出目录' })
      const resolved = await existingDir(dest)
      if (!resolved) return reply.code(400).send({ error: `mod-output 目录不存在：${dest}` })
      const project = String(req.body?.project ?? '')
      const projects = await listMcProjects(root)
      const p = projects.find(x => x.name === project) ?? projects[0]
      if (!p?.jars?.length) return reply.code(404).send({ error: '该工程还没有构建产物 jar（先跑 gradlew build）' })
      const jar = p.jars[0]
      try {
        const out = join(resolved, jar.name)
        await copyFile(jar.path, out)
        return { ok: true, name: jar.name, dest: out, size: jar.size }
      } catch (e: any) {
        return reply.code(500).send({ error: `复制失败：${e.message}` })
      }
    })

    /** 启动 runClient（等价 mc_gradle task=runClient background=true，同一套状态登记） */
    ctx.http.route('POST', '/api/mc/run', async (req, reply) => {
      const root = ctx.sessions.cwdOf(String(req.body?.sessionId ?? ''))
      if (!root) return reply.code(404).send({ error: '会话不存在或目录无效' })
      const raw = String(req.body?.project ?? '').trim()
      if (!raw) return reply.code(400).send({ error: 'project 不能为空' })
      // 工程名可能指向 cwd 自身（会话直接绑到 mod 目录），不能一律 join(root, name)
      const known = (await listMcProjects(root)).find(p => p.name === raw)
      const dir = known?.dir ?? (raw.includes('\\') || raw.includes('/') ? resolve(raw) : resolve(root, raw))
      try { if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'build.gradle'))) throw new Error() } catch {
        return reply.code(400).send({ error: `不是有效的 MC 工程：${raw}` })
      }
      try {
        const r = await startRunClient(dir, root)
        return { ok: true, ...r }
      } catch (e: any) {
        return reply.code(500).send({ error: e.message })
      }
    })

    /** 停掉工程的 runClient */
    ctx.http.route('POST', '/api/mc/stop', async (req, reply) => {
      const root = ctx.sessions.cwdOf(String(req.body?.sessionId ?? ''))
      if (!root) return reply.code(404).send({ error: '会话不存在' })
      const raw = String(req.body?.project ?? '').trim()
      const known = (await listMcProjects(root)).find(p => p.name === raw)
      const dir = known?.dir ?? resolve(root, raw.replace(/^[/\\]+/, ''))
      try { if (!statSync(dir).isDirectory()) throw new Error() } catch { return reply.code(400).send({ error: '工程目录不存在' }) }
      return { ok: true, stopped: stopRunClient(dir) }
    })

    /** 下载构建出的 mod jar（必须是 .jar 且真实存在） */
    ctx.http.route('GET', '/api/mc/jar', async (req, reply) => {
      const raw = String(req.query.path ?? '')
      if (!raw.endsWith('.jar')) return reply.code(400).send({ error: '只允许下载 .jar' })
      const abs = resolve(raw)
      try { if (!statSync(abs).isFile()) throw new Error() } catch { return reply.code(404).send({ error: '文件不存在' }) }
      return reply.header('content-type', 'application/java-archive')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(abs.split(/[\\/]/).pop() ?? 'mod.jar')}"`)
        .send(createReadStream(abs))
    })
  },
}

export default plugin

// ---- MC 工程状态（插件自己的 UI 路由数据源） ----

export interface McProjectUiInfo {
  name: string
  dir: string
  /** gradlew build 最近一次结果（UI 据此显示绿/红点与按钮可用性） */
  lastBuild?: McBuildRecord
  /** runClient 是否还在跑（pid 存活） */
  runClientRunning: boolean
  runClientStartedAt?: number
  /** build/libs 下的 jar（最新在前） */
  jars: { name: string; path: string; size: number; mtime: number }[]
}

/** 列出 MC 工程与其构建产物：root 自身（cwd 就是工程根）以及它的一层子目录 */
async function listMcProjects(root: string): Promise<McProjectUiInfo[]> {
  const state = readMcState()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  // 会话工作目录本身就是工程根（用户把 cwd 直接绑到 mod 目录）时，只扫一层子目录会得到 0 个工程，
  // 标题栏的「测试 Mod」按钮就整组不渲染——把它自己也算进来。
  const candidates: { name: string; dir: string }[] = []
  if (existsSync(join(root, 'build.gradle'))) candidates.push({ name: basename(root) || root, dir: root })
  for (const e of entries) {
    if (e.isDirectory()) candidates.push({ name: e.name, dir: join(root, e.name) })
  }
  const out: McProjectUiInfo[] = []
  for (const { name, dir } of candidates) {
    if (!existsSync(join(dir, 'build.gradle'))) continue
    const s = state[dir] ?? {}
    const libs = join(dir, 'build', 'libs')
    const jarFiles = await readdir(libs).catch(() => [] as string[])
    const jars: McProjectUiInfo['jars'] = []
    for (const j of jarFiles) {
      if (!j.endsWith('.jar')) continue
      const p = join(libs, j)
      const st = await stat(p).catch(() => null)
      if (st?.isFile()) jars.push({ name: j, path: p, size: st.size, mtime: st.mtimeMs })
    }
    jars.sort((a, b) => b.mtime - a.mtime)
    out.push({
      name,
      dir,
      lastBuild: s.lastBuild,
      runClientRunning: !!s.runClient && pidAlive(s.runClient.pid),
      runClientStartedAt: s.runClient?.startedAt,
      jars,
    })
  }
  return out
}

/** 同一工程只保留一个 runClient：停旧 → 重置控制台日志 → spawn → 登记状态（AI / dock 共用） */
async function launchClient(projectDir: string, env: NodeJS.ProcessEnv): Promise<{ pid: number; logPath: string; stoppedNote: string }> {
  const old = readMcState()[projectDir]?.runClient
  let stoppedNote = ''
  if (old) {
    stoppedNote = stopRunClient(projectDir)
      ? `已停止上一个客户端（pid ${old.pid}）。\n`
      : (pidAlive(old.pid) ? `⚠ 上一个客户端（pid ${old.pid}）未能停止。\n` : '')
  }
  await mkdir(join(projectDir, 'run'), { recursive: true })
  const logPath = join(projectDir, 'run-console.log')
  const out = createWriteStream(logPath, { flags: 'w' })
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const child = spawn(gradlew, ['runClient', '--console=plain'], {
    cwd: projectDir, env, shell: process.platform === 'win32', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!child.pid) throw new Error('gradlew 启动失败')
  child.on('error', () => { /* 启动失败由 pid/退出状态体现，避免 unhandled error */ })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  trackRunClient(projectDir, child)
  child.unref()
  return { pid: child.pid, logPath, stoppedNote }
}

/** 登记 runClient 状态；退出回调必须重新读 state，不能拿 spawn 时的旧 map 整份覆盖 */
function trackRunClient(projectDir: string, child: ChildProcess) {
  if (!child.pid) return
  const map = readMcState()
  const cur: McProjectState = map[projectDir] ?? {}
  cur.runClient = { pid: child.pid, startedAt: Date.now() }
  map[projectDir] = cur
  writeMcState(map)
  child.on('exit', () => {
    const fresh = readMcState()
    const entry = fresh[projectDir]
    if (!entry?.runClient || entry.runClient.pid !== child.pid) return
    delete entry.runClient
    writeMcState(fresh)
  })
}

/** UI「测试 Mod」按钮：与 mc_gradle background 共用 launchClient（镜像 seed / GRADLE_USER_HOME / 状态登记） */
async function startRunClient(projectDir: string, root: string): Promise<{ pid: number; logPath: string }> {
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME ?? 'F:/sdk_java/jdk-17',
    GRADLE_USER_HOME: process.env.OPENMODS_GRADLE_HOME ?? process.env.GRADLE_USER_HOME ?? WARM_GRADLE_HOME ?? join(root, '.gradle-home'),
  }
  await seedMavenCache(env.GRADLE_USER_HOME)
  await seedWrapperDist(env.GRADLE_USER_HOME, projectDir)
  const r = await launchClient(projectDir, env)
  return { pid: r.pid, logPath: r.logPath }
}

/** 停掉工程正在跑的 runClient（进程树终止，最多等 2s 确认退出） */
function stopRunClient(projectDir: string): boolean {
  const clear = () => {
    const map = readMcState()
    if (map[projectDir]?.runClient) { delete map[projectDir].runClient; writeMcState(map) }
  }
  const s = readMcState()[projectDir]?.runClient
  if (!s) return false
  if (!pidAlive(s.pid)) { clear(); return false }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(s.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try { process.kill(-s.pid, 'SIGTERM') } catch { try { process.kill(s.pid, 'SIGTERM') } catch { /* 已退出 */ } }
  }
  // 等进程树真正退出，避免新客户端刚启动就撞上旧的窗口/端口
  const until = Date.now() + 2000
  while (pidAlive(s.pid) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  if (process.platform !== 'win32' && pidAlive(s.pid)) {
    try { process.kill(-s.pid, 'SIGKILL') } catch { try { process.kill(s.pid, 'SIGKILL') } catch { /* 已退出 */ } }
  }
  if (pidAlive(s.pid)) return false
  clear()
  return true
}
