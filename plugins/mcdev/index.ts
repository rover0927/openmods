// mcdev 插件：Minecraft 1.20.1 Forge 模组开发的工程面（脚手架 / 文件 / Gradle / 日志 / 模型导出）
//
// 设计边界（和 dsh 的 mc_scaffold/mc_gradle 对齐）：
// - 只做 Java + 1.20.1 + Forge 47.x；平台/版本写死，不接受别的组合，避免模型自由发挥。
// - 工程路径统一走 resolveProject()：裸名解析到 MC_ROOT 下，绝对路径必须存在；
//   文件读写只允许落在工程目录内（realpath 前缀校验），不碰仓库其它地方。
// - runClient 是长驻进程：mc_gradle background=true 时立即返回 pid + 控制台日志路径，
//   由 mc_log 轮询 run/logs/latest.log 判断是否真的起来了。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile, cp } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ToolResult } from '@openmods/plugin-kit'
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
    writeFileSync(MC_STATE_FILE, JSON.stringify(map, null, 2))
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
}): Promise<{ projectDir: string; files: string[] }> {
  const { modId, packageName } = opts
  if (!MOD_ID_RE.test(modId)) throw new Error(`modId 非法（小写字母开头，只含 a-z0-9_）：${modId}`)
  if (!PKG_RE.test(packageName)) throw new Error(`packageName 非法（如 com.example.mymod）：${packageName}`)

  const dirName = opts.name.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
  const projectDir = resolve(opts.root ?? MC_ROOT, dirName)
  const exists = await stat(projectDir).catch(() => null)
  if (exists) {
    const entries = await readdir(projectDir)
    if (entries.length) throw new Error(`目标目录非空：${projectDir}`)
  }

  const mainClass = modId.split('_').map(s => s ? s[0].toUpperCase() + s.slice(1) : s).join('') + 'Mod'
  const pkgPath = packageName.split('.').join('/')

  const files = await copyTree(TEMPLATE, projectDir, new Set(['.git', 'run', 'build', '.gradle']))

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
  const { rm, rmdir } = await import('node:fs/promises')
  await rm(oldPkgDir, { recursive: true, force: true })
  // 顺手清掉因搬家而空掉的父目录（失败无所谓，非空目录 rmdir 会抛错）
  await rmdir(join(projectDir, 'src/main/java/com/example')).catch(() => {})

  // 2) gradle.properties：mod_id / mod_name / group / 作者 / 描述
  const propsPath = join(projectDir, 'gradle.properties')
  let props = await readFile(propsPath, 'utf8')
  props = props
    .replace(/^mod_id=.*$/m, `mod_id=${modId}`)
    .replace(/^mod_name=.*$/m, `mod_name=${opts.displayName ?? modId}`)
    .replace(/^mod_group_id=.*$/m, `mod_group_id=${packageName}`)
    .replace(/^mod_authors=.*$/m, `mod_authors=${opts.author ?? 'openmods'}`)
    .replace(/^mod_description=.*$/m, `mod_description=${opts.displayName ?? modId} - built with openmods`)
  await writeFile(propsPath, props)

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
}): Promise<ToolResult> {
  const { projectDir, task } = opts
  if (!/^[a-zA-Z][\w:.-]*$/.test(task)) return fail(`任务名不合法：${task}`)
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const argv = [gradlew, task, '--console=plain', ...(opts.args ?? [])]
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME ?? 'F:/sdk_java/jdk-17',
    GRADLE_USER_HOME: process.env.OPENMODS_GRADLE_HOME ?? process.env.GRADLE_USER_HOME ?? join(opts.root ?? MC_ROOT, '.gradle-home'),
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
    await mkdir(join(projectDir, 'run'), { recursive: true })
    const logPath = join(projectDir, 'run-console.log')
    const out = createWriteStream(logPath, { flags: 'a' })
    const child = spawn(gradlew, argv.slice(1), {
      cwd: projectDir, env, shell: process.platform === 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(out)
    child.stderr?.pipe(out)
    // runClient 记入工程状态：右侧 dock 的「测试 Mod」按钮据此显示运行中 / 提供停止
    if (task === 'runClient' && child.pid) {
      const map = readMcState()
      const cur: McProjectState = map[projectDir] ?? {}
      cur.runClient = { pid: child.pid, startedAt: Date.now() }
      map[projectDir] = cur
      writeMcState(map)
      child.on('exit', () => {
        const m = readMcState()
        if (m[projectDir]?.runClient?.pid === child.pid) {
          if (cur.runClient) delete cur.runClient
          map[projectDir] = cur
          writeMcState(map)
        }
      })
    }
    child.unref()
    return {
      forModel: seedNote + `已在后台启动 ${task}（pid ${child.pid}）。控制台日志 ${logPath}；游戏日志用 mc_log 读 run/logs/latest.log。`
        + `\n首次启动要下资源（约 600MB 贴图音效）并反编译，可能 5~15 分钟；不要重复启动，先轮询日志。`,
    }
  }

  const timeoutMs = Math.min(Math.max((opts.timeoutSec ?? 600) * 1000, 30_000), 3_600_000)
  return await new Promise<ToolResult>(resolvePromise => {
    const child = spawn(gradlew, argv.slice(1), {
      cwd: projectDir, env, shell: process.platform === 'win32', windowsHide: true,
    })
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString('utf8')
      if (buf.length > 400_000) buf = buf.slice(-200_000) // 防跑飞
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolvePromise(fail(`gradlew ${task} 超时（${timeoutMs / 1000}s）。尾部输出：\n${buf.slice(-4000)}`))
    }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      recordBuild(projectDir, task, code ?? -1)
      const tail = buf.length > 8000 ? `…（截断，共 ${buf.length} 字符）\n${buf.slice(-8000)}` : buf
      const ok = code === 0
      resolvePromise({
        forModel: seedNote + `gradlew ${task} 退出码 ${code}\n${tail || '（无输出）'}`,
        isError: !ok,
      })
    })
    child.on('error', e => {
      clearTimeout(timer)
      resolvePromise(fail(`无法启动 gradlew：${e.message}`))
    })
  })
}

/** 读尾部日志 + 识别客户端是否真的起来了 */
async function readLogs(projectDir: string, lines: number): Promise<string> {
  const n = Math.min(Math.max(lines || 80, 10), 400)
  const candidates = [
    join(projectDir, 'run/logs/latest.log'),
    join(projectDir, 'run/logs/debug.log'),
  ]
  for (const p of candidates) {
    const text = await readFile(p, 'utf8').catch(() => null)
    if (!text) continue
    const all = text.split(/\r?\n/)
    const tail = all.slice(-n).join('\n')
    const marks = ['Sound engine started', 'Forge mod loading', 'Backend library: LWJGL', 'Created: 1024x512']
    const seen = marks.filter(m => text.includes(m))
    const crashed = /---- Minecraft Crash Report ----|A fatal error has been detected/.test(text)
    const head = [
      `日志 ${relative(projectDir, p)}（共 ${all.length} 行，最后 ${n} 行）`,
      seen.length ? `启动标记：${seen.join(' / ')}` : '启动标记：尚未出现',
      crashed ? '⚠ 日志里出现崩溃报告' : '',
    ].filter(Boolean).join('\n')
    return `${head}\n\n${tail}`
  }
  const crashDir = join(projectDir, 'run/crash-reports')
  const reports = await readdir(crashDir).catch(() => [] as string[])
  if (reports.length) {
    const newest = reports.sort().at(-1)!
    const text = await readFile(join(crashDir, newest), 'utf8').catch(() => '')
    return `没有 latest.log，但有崩溃报告 ${newest}：\n\n${text.split(/\r?\n/).slice(0, 80).join('\n')}`
  }
  return '还没有日志：先 mc_gradle runClient（background=true），等启动后再读。'
}

const plugin: Plugin = {
  name: 'mcdev',
  apply(ctx) {
    ctx.tools.register({
      name: 'mc_scaffold',
      mutates: true,
      description: '创建 Minecraft 1.20.1 Forge（47.4.10）模组工程：官方 MDK 模板 + 国内镜像 + 示例资源。'
        + 'project 传工程名（落在 data/mcprojects/<name>）或绝对路径（必须是空目录/不存在）。只支持 Java + 1.20.1。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工程目录名 / 模组名（如 ruby-mod）' },
          modId: { type: 'string', description: 'modid，小写字母开头、只含 a-z0-9_（如 rubymod）' },
          packageName: { type: 'string', description: 'Java 包名（如 com.example.rubymod）' },
          displayName: { type: 'string', description: '游戏内显示名（可选）' },
          author: { type: 'string', description: '作者（可选）' },
        },
        required: ['name', 'modId', 'packageName'],
      },
      async execute(args, exec) {
        try {
          const out = await scaffold({
            name: String(args.name), modId: String(args.modId), packageName: String(args.packageName),
            displayName: args.displayName ? String(args.displayName) : undefined,
            author: args.author ? String(args.author) : undefined,
            root: rootOf(exec),
          })
          return {
            forModel: `已创建 1.20.1 Forge 工程：${out.projectDir}\n`
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
        + 'runClient 是长驻进程，必须 background=true；普通任务默认 600s 超时，返回尾部输出。',
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
          })
        } catch (e: any) { return fail(e.message) }
      },
    })

    ctx.tools.register({
      name: 'mc_log',
      description: '读 run/logs/latest.log 尾部，并给出启动标记（Sound engine started / Forge mod loading）与崩溃提示。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '工程目录' },
          lines: { type: 'integer', description: '读最后多少行，默认 80' },
        },
        required: ['project'],
      },
      async execute(args, exec) {
        try {
          const dir = await resolveProject(String(args.project), rootOf(exec))
          return { forModel: await readLogs(dir, Number(args.lines ?? 80)) }
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
  },
}

export default plugin

// ---- 供服务端 UI 路由使用（右侧 dock 的「测试 Mod」按钮 / jar 导出） ----

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

/** 扫 root 一层，列出含 build.gradle 的工程与其构建产物 */
export async function listMcProjects(root: string): Promise<McProjectUiInfo[]> {
  const state = readMcState()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out: McProjectUiInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
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
      name: e.name,
      dir,
      lastBuild: s.lastBuild,
      runClientRunning: !!s.runClient && pidAlive(s.runClient.pid),
      runClientStartedAt: s.runClient?.startedAt,
      jars,
    })
  }
  return out
}

/** UI「测试 Mod」按钮：与 mc_gradle background 同一套实现（镜像 seed / GRADLE_USER_HOME / 状态登记） */
export function startRunClient(projectDir: string, root: string): Promise<{ pid: number; logPath: string }> {
  return new Promise((res, rej) => {
    ;(async () => {
      try {
        const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
        const env = {
          ...process.env,
          JAVA_HOME: process.env.JAVA_HOME ?? 'F:/sdk_java/jdk-17',
          GRADLE_USER_HOME: process.env.OPENMODS_GRADLE_HOME ?? process.env.GRADLE_USER_HOME ?? join(root, '.gradle-home'),
        }
        await seedMavenCache(env.GRADLE_USER_HOME)
        await seedWrapperDist(env.GRADLE_USER_HOME, projectDir)
        await mkdir(join(projectDir, 'run'), { recursive: true })
        const logPath = join(projectDir, 'run-console.log')
        const out = createWriteStream(logPath, { flags: 'a' })
        const child = spawn(gradlew, ['runClient', '--console=plain'], {
          cwd: projectDir, env, shell: process.platform === 'win32', windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (!child.pid) throw new Error('gradlew 启动失败')
        child.stdout?.pipe(out)
        child.stderr?.pipe(out)
        const map = readMcState()
        const cur: McProjectState = map[projectDir] ?? {}
        cur.runClient = { pid: child.pid, startedAt: Date.now() }
        map[projectDir] = cur
        writeMcState(map)
        child.on('exit', () => {
          const m = readMcState()
          if (m[projectDir]?.runClient?.pid === child.pid) {
            if (cur.runClient) delete cur.runClient
            map[projectDir] = cur
            writeMcState(map)
          }
        })
        child.unref()
        res({ pid: child.pid, logPath })
      } catch (e: any) { rej(e) }
    })()
  })
}

/** 停掉工程正在跑的 runClient（进程树终止） */
export function stopRunClient(projectDir: string): boolean {
  const s = readMcState()[projectDir]?.runClient
  if (!s || !pidAlive(s.pid)) {
    const map = readMcState()
    if (map[projectDir]?.runClient) { delete map[projectDir].runClient; writeMcState(map) }
    return false
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(s.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try { process.kill(-s.pid, 'SIGTERM') } catch { try { process.kill(s.pid, 'SIGTERM') } catch { /* 已退出 */ } }
  }
  return true
}
