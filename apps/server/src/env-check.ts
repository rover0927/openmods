// 首次运行环境检测：Java 17 / Gradle 离线缓存 / Git。
// 检测结果给前端「环境向导」与「设置 → 环境」共用；用户选择保存到 data/settings.json 的
// environment 字段，再由 applyEnvironment 写进 OPENMODS_* 进程环境，供 mc_gradle、
// 测试客户端与自更新读取。这里只做只读探测，唯一的写操作是 fixVendorLayout（整理错位目录）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvironmentConfig } from './settings.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MCDEV_DIR = join(ROOT, 'plugins', 'mcdev')
const VENDOR_DIR = join(MCDEV_DIR, 'vendor')

/**
 * MC 工程根目录：与 plugins/mcdev 的 MC_ROOT 保持同一套解析
 * （优先同级 mincraft-maker/projects，其次 data/mcprojects；OPENMODS_MC_ROOT 可覆盖）。
 */
const MC_ROOT = process.env.OPENMODS_MC_ROOT
  ?? (existsSync(join(ROOT, '..', 'mincraft-maker'))
    ? join(ROOT, '..', 'mincraft-maker', 'projects')
    : join(ROOT, 'data', 'mcprojects'))

const IS_WIN = process.platform === 'win32'
const JAVA_REL = join('bin', IS_WIN ? 'java.exe' : 'java')

export interface EnvCandidate {
  /** 保存到 environment 的值（vendor 离线包用空字符串：不覆盖 GRADLE_USER_HOME，靠播种命中） */
  value: string
  label: string
  version?: string
  ok: boolean
  note?: string
}

export interface EnvCheck {
  id: 'java' | 'gradle' | 'git'
  status: 'ok' | 'warn' | 'fail'
  summary: string
  details: string[]
  candidates: EnvCandidate[]
  actions?: { id: 'fix-vendor'; label: string }[]
}

export interface EnvStatus {
  /** 用户是否处理过向导（environment.setupDone） */
  configured: boolean
  config: EnvironmentConfig
  checks: EnvCheck[]
  updatedAt?: number
}

/** 探测 Java 主版本：跑 `<home>/bin/java -version`，解析不成返回 null */
function probeJava(home: string): { major: number; version: string } | null {
  const exe = join(home, JAVA_REL)
  if (!existsSync(exe)) return null
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // 形如：openjdk version "17.0.10" 2024-01-16 / java version "1.8.0_301"
  const m = /version "([^"]+)"/.exec(text)
  if (!m) return null
  const parts = m[1].split(/[._]/)
  const first = Number(parts[0])
  const major = first === 1 ? Number(parts[1] ?? 0) : first
  if (!Number.isFinite(major) || major <= 0) return null
  return { major, version: m[1] }
}

/** 目录下的子目录（不存在/无权限时返回空） */
function childDirs(dir: string | undefined): string[] {
  if (!dir) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(dir, e.name))
  } catch { return [] }
}

/** PATH 里 java 可执行文件对应的 home（`where java` / `which java` 的父目录的父目录） */
function javaHomeFromPath(): string | undefined {
  const r = IS_WIN
    ? spawnSync('where', ['java'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    : spawnSync('which', ['java'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (r.status !== 0) return undefined
  const first = String(r.stdout ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
  if (!first) return undefined
  return dirname(dirname(first))
}

/** 候选去重键：Windows 大小写不敏感 */
function javaKey(p: string): string {
  const abs = resolve(p)
  return IS_WIN ? abs.toLowerCase() : abs
}

function javaCheck(config: EnvironmentConfig): EnvCheck {
  const guesses: { home: string; label: string }[] = []
  const add = (home: string | undefined, label: string) => {
    const p = String(home ?? '').trim()
    if (p) guesses.push({ home: p, label })
  }
  add(config.javaHome, '已保存配置')
  add(process.env.JAVA_HOME, 'JAVA_HOME')
  add(javaHomeFromPath(), 'PATH')
  for (const d of childDirs(join(homedir(), '.jdks'))) add(d, '用户 .jdks')
  for (const d of childDirs(join(homedir(), '.gradle', 'jdks'))) add(d, 'Gradle 下载的 JDK')
  if (IS_WIN) {
    const bases = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Amazon Corretto',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium') : '',
    ]
    for (const base of bases) {
      if (!base) continue
      for (const d of childDirs(base)) add(d, '常见安装目录')
    }
  }
  // 历史克隆的旧默认路径：存在就列出来，方便用户直接选
  add('F:/sdk_java/jdk-17', '旧默认路径')

  const seen = new Set<string>()
  const candidates: EnvCandidate[] = []
  for (const g of guesses) {
    const key = javaKey(g.home)
    if (seen.has(key)) continue
    seen.add(key)
    const info = probeJava(g.home)
    if (!info) {
      // 只有用户显式配置的路径才保留失败项；自动扫描到的无效目录直接略过
      if (g.label === '已保存配置') {
        candidates.push({
          value: g.home, label: `${g.label}：${g.home}`, ok: false,
          note: '无法运行 bin/java，目录可能已被删除或不是 JDK',
        })
      }
      continue
    }
    const ok = info.major === 17
    candidates.push({
      value: g.home,
      label: `${g.label}：${g.home}`,
      version: info.version,
      ok,
      note: ok ? undefined : '不适用于 1.20.1（需要 JDK 17）',
    })
  }
  // Java 17 排前面，其余按主版本新→旧
  candidates.sort((a, b) => Number(b.ok) - Number(a.ok))

  const best = candidates.find(c => c.ok)
  const details: string[] = [
    `共检测到 ${candidates.length} 个可用的 JDK 目录。`,
  ]
  if (!best) {
    details.push(
      'Minecraft 1.20.1 + Forge 47.x 只能用 JDK 17（更高版本无法构建/启动）。',
      '下载地址：https://adoptium.net/temurin/releases/?version=17（选 Windows x64 JDK 17）',
      '安装后点「重新检测」，或手动选择 JDK 目录。',
    )
  }
  return {
    id: 'java',
    status: best ? 'ok' : 'fail',
    summary: best
      ? `已找到 Java 17：${best.version}`
      : '未找到 Java 17（Minecraft 1.20.1 需要 JDK 17）',
    details,
    candidates,
  }
}

/** Gradle 8.8 发行版目录是否可用（vendor 与 wrapper 缓存都用这一套判断） */
function hasGradleDist(dir: string): boolean {
  return existsSync(join(dir, 'bin', 'gradle.bat')) || existsSync(join(dir, 'bin', 'gradle'))
}

function gradleCheck(config: EnvironmentConfig): EnvCheck {
  const candidates: EnvCandidate[] = []
  const actions: { id: 'fix-vendor'; label: string }[] = []

  // 1) 项目内 vendor 离线包（推荐：mc_gradle 自动播种到 Gradle 缓存）
  const vendorOk = hasGradleDist(join(VENDOR_DIR, 'gradle-8.8')) && existsSync(join(VENDOR_DIR, 'fg-maven'))
  if (vendorOk) {
    candidates.push({
      value: '',
      label: '项目内 vendor 离线包（推荐）',
      ok: true,
      note: '自动播种到 Gradle 缓存，构建不需要联网下载 Gradle',
    })
  }

  // 2) 解压错位：gradle-8.8 / fg-maven 直接躺在 plugins/mcdev 下（会话 2121e7e7 的故障现场）
  const stray = ['gradle-8.8', 'fg-maven'].filter(name => existsSync(join(MCDEV_DIR, name)))
  if (stray.length) {
    candidates.push({
      value: '',
      label: `plugins/mcdev 下解压错位（${stray.join('、')}）`,
      ok: false,
      note: '必须在 plugins/mcdev/vendor/ 下才会被识别；可点「整理 vendor」自动移动',
    })
    actions.push({ id: 'fix-vendor', label: '整理到 vendor/' })
  }

  // 3) Gradle 用户目录：看 ForgeGradle 与 wrapper 两个关键标记
  const homes: { value: string; label: string }[] = []
  const addHome = (value: string | undefined, label: string) => {
    const p = String(value ?? '').trim()
    if (!p) return
    const key = IS_WIN ? resolve(p).toLowerCase() : resolve(p)
    if (homes.some(h => (IS_WIN ? resolve(h.value).toLowerCase() : resolve(h.value)) === key)) return
    homes.push({ value: p, label })
  }
  addHome(join(MC_ROOT, '.gradle-home'), 'MC_ROOT/.gradle-home')
  addHome(process.env.OPENMODS_GRADLE_HOME, 'OPENMODS_GRADLE_HOME')
  addHome(process.env.GRADLE_USER_HOME, 'GRADLE_USER_HOME')
  addHome(join(homedir(), '.gradle'), '用户 ~/.gradle')
  addHome(config.gradleHome, '已保存配置')

  for (const h of homes) {
    if (!existsSync(h.value)) {
      // 已保存但被删掉的目录要显式告知（否则构建时才突然失败）
      if (h.label === '已保存配置') {
        candidates.push({
          value: h.value, label: `${h.label}：${h.value}`, ok: false,
          note: '目录不存在，缓存可能已被删除；请重新检测或改用联网下载',
        })
      }
      continue
    }
    const maven = existsSync(join(h.value, 'caches', 'forge_gradle', 'maven_downloader'))
    const wrapper = existsSync(join(h.value, 'wrapper', 'dists', 'gradle-8.8-bin'))
    const ok = maven && wrapper
    candidates.push({
      value: h.value,
      label: `${h.label}：${h.value}`,
      ok,
      note: ok
        ? 'ForgeGradle 与 Gradle 8.8 wrapper 缓存齐全'
        : `缺少 ${[!maven ? 'caches/forge_gradle/maven_downloader' : '', !wrapper ? 'wrapper/dists/gradle-8.8-bin' : ''].filter(Boolean).join('、')}，首次构建需要联网补齐`,
    })
  }

  const ready = vendorOk || candidates.some(c => c.ok)
  const details: string[] = [
    `已检查 ${candidates.length} 个缓存来源。`,
    ready
      ? '构建会直接命中的离线缓存，不会重新下载 Gradle 发行版。'
      : '没有完整的离线缓存：mc_gradle 会走国内镜像联网下载（首次构建更慢，网络不稳时可能失败）。',
  ]
  if (stray.length) details.push('检测到解压错位目录：点「整理到 vendor/」可自动修复，不需要重新下载。')

  return {
    id: 'gradle',
    status: ready ? 'ok' : 'warn',
    summary: vendorOk
      ? '离线缓存已就绪：项目内 vendor 包完整'
      : ready
        ? '离线缓存已就绪：Gradle 用户目录缓存完整'
        : '未检测到完整的离线 Gradle 缓存（将联网下载）',
    details,
    candidates,
    ...(actions.length ? { actions } : {}),
  }
}

/** 解析 git 版本：返回 { version, exe }，找不到可执行文件返回 undefined */
function probeGit(exe: string): { version?: string; found: boolean } {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const err = r.error as NodeJS.ErrnoException | undefined
  if (err?.code === 'ENOENT' || r.status !== 0) return { found: false }
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { found: true, version: /git version (\S+)/.exec(text)?.[1] }
}

function gitCheck(config: EnvironmentConfig): EnvCheck {
  const custom = (config.gitPath || process.env.OPENMODS_GIT || '').trim()
  const exe = custom || 'git'
  const probe = probeGit(exe)
  const candidates: EnvCandidate[] = [{
    value: custom,
    label: custom ? `自定义路径：${custom}` : 'PATH 中的 git',
    version: probe.version,
    ok: probe.found,
    note: probe.found ? undefined : '无法执行；未安装或路径不正确',
  }]
  return {
    id: 'git',
    status: probe.found ? 'ok' : 'fail',
    summary: probe.found
      ? `已找到 Git：${probe.version ?? '版本未知'}`
      : '未检测到 Git：自更新与版本检查不可用',
    details: probe.found
      ? ['自更新（检查 GitHub main / git pull）会使用这个 Git。']
      : [
        '请到 https://git-scm.com 下载安装 Git（Windows 选默认选项即可）。',
        '安装后在设置 → 环境点「重新检测」，或手动填写 git.exe 路径。',
      ],
    candidates,
  }
}

/** 完整检测：三项结果 + 当前保存的配置（updatedAt 供前端显示检测时间） */
export function checkEnvStatus(config: EnvironmentConfig): EnvStatus {
  return {
    configured: !!config.setupDone,
    config,
    checks: [javaCheck(config), gradleCheck(config), gitCheck(config)],
    updatedAt: Date.now(),
  }
}

/** 把配置写进进程环境（空值删除）；启动时与保存后各调用一次 */
export function applyEnvironment(config: EnvironmentConfig) {
  const setOrDelete = (key: string, value: string) => {
    if (value) process.env[key] = value
    else delete process.env[key]
  }
  setOrDelete('OPENMODS_JAVA_HOME', config.javaHome)
  setOrDelete('OPENMODS_GRADLE_HOME', config.gradleHome)
  setOrDelete('OPENMODS_GIT', config.gitPath)
}

export interface VendorFixResult {
  ok: boolean
  moved: string[]
  error?: string
}

/**
 * 整理错位的离线包：plugins/mcdev/{gradle-8.8,fg-maven} → plugins/mcdev/vendor/。
 * 目标已存在时不覆盖（宁可报错也不毁掉现有 vendor）；缺目录视为已处理。
 */
export function fixVendorLayout(): VendorFixResult {
  const moved: string[] = []
  mkdirSync(VENDOR_DIR, { recursive: true })
  for (const name of ['gradle-8.8', 'fg-maven']) {
    const src = join(MCDEV_DIR, name)
    const dst = join(VENDOR_DIR, name)
    if (!existsSync(src)) continue
    if (existsSync(dst)) {
      return {
        ok: false,
        moved,
        error: `plugins/mcdev/vendor/${name} 已存在，未覆盖；请先确认哪个是完整包，手动清理后重试`,
      }
    }
    try {
      renameSync(src, dst)
      moved.push(name)
    } catch (e: any) {
      return { ok: false, moved, error: `移动 ${name} 失败：${e?.message ?? e}` }
    }
  }
  return { ok: true, moved }
}

/**
 * 校验用户提交的环境 patch（只校验提供了的字段）。
 * 校验失败抛中文错误，API 层转 400；不合法时绝不写进进程环境。
 */
export function validateEnvironmentPatch(patch: {
  javaHome?: string
  gradleHome?: string
  gitPath?: string
}) {
  if (patch.javaHome !== undefined) {
    const home = String(patch.javaHome ?? '').trim()
    if (home) {
      const exe = join(home, JAVA_REL)
      if (!existsSync(exe)) throw new Error(`Java 路径无效：找不到 ${exe}`)
      const info = probeJava(home)
      if (!info) throw new Error('Java 路径无效：无法运行 bin/java -version')
      if (info.major !== 17) {
        throw new Error(`该 JDK 是 Java ${info.version}，不适用于 1.20.1（需要 JDK 17）`)
      }
    }
  }
  if (patch.gradleHome !== undefined) {
    const home = String(patch.gradleHome ?? '').trim()
    if (home && !existsSync(home)) throw new Error(`Gradle 缓存目录不存在：${home}`)
  }
  if (patch.gitPath !== undefined) {
    const exe = String(patch.gitPath ?? '').trim()
    if (exe && !probeGit(exe).found) throw new Error(`Git 路径无效：无法执行 ${exe}`)
  }
}
