// 在线下载离线构建包（openmods-vendor.zip）：下载到 data/vendor-download，
// 解压到 plugins/mcdev/vendor，全程暴露进度、速度，并支持取消。
// 这个文件只做下载/解压，不写 settings.json；前端下载完重新调用 /api/env/status 即可看到 vendor 候选。
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VENDOR_DIR = join(ROOT, 'plugins', 'mcdev', 'vendor')
const TMP_DIR = join(ROOT, 'data', 'vendor-download')
const ZIP_PATH = join(TMP_DIR, 'openmods-vendor.zip')
const UNPACK_DIR = join(TMP_DIR, 'unpacked')
const DOWNLOAD_URL = 'https://github.com/rover0927/openmods/releases/latest/download/openmods-vendor.zip'
/** 国内加速镜像：直接前缀拼接 GitHub 下载地址 */
const MIRROR_PREFIX = 'https://gh-proxy.com/'
/** Release API：先问 api.github.com 要 asset，再以 octet-stream 下载 */
const LATEST_RELEASE_API = 'https://api.github.com/repos/rover0927/openmods/releases/latest'
const ASSET_NAME = 'openmods-vendor.zip'
/** 连接/首字节超时：30 秒内没有响应头或首个数据块即中止 */
const CONNECT_TIMEOUT_MS = 30_000
/** 整体下载上限：10 分钟，避免网络半死时无限等待 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** 有效 zip 的最小体积（1MB）；低于此值基本是错误页或空文件 */
const MIN_ZIP_BYTES = 1024 * 1024
/** vendor 里必须存在的两个顶层目录（zip 结构约定） */
const VENDOR_ENTRIES = ['gradle-8.8', 'fg-maven']

/** 下载源：国内镜像 / GitHub 官方直链 / Release API */
export type VendorSource = 'mirror' | 'official' | 'release'

export function isVendorSource(v: unknown): v is VendorSource {
  return v === 'mirror' || v === 'official' || v === 'release'
}

export type VendorDownloadStatus = 'idle' | 'downloading' | 'extracting' | 'done' | 'cancelled' | 'error'

export interface VendorDownloadState {
  status: VendorDownloadStatus
  /** 本次下载使用的源；status=idle 时为空 */
  source?: VendorSource
  /** 本次下载的落盘绝对路径（固定 data/vendor-download/openmods-vendor.zip） */
  targetPath: string
  /** 已下载字节数 */
  received: number
  /** 总字节数（服务端未给 content-length 时为 0） */
  total: number
  /** 平滑后的瞬时速度，字节/秒 */
  speed: number
  startedAt: number
  finishedAt?: number
  error?: string
}

let state: VendorDownloadState = { status: 'idle', received: 0, total: 0, speed: 0, startedAt: 0, targetPath: ZIP_PATH }
let abort: AbortController | null = null
let tar: ChildProcess | null = null

export function vendorDownloadStatus(): VendorDownloadState {
  return { ...state }
}

/** 取消下载或解压；没有进行中的任务返回 false */
export function cancelVendorDownload(): boolean {
  if (!abort) return false
  abort.abort()
  tar?.kill()
  return true
}

/** 启动下载；已有任务时返回错误（避免并发写同一个 zip） */
export function startVendorDownload(source: VendorSource = 'mirror'): { ok: boolean; error?: string } {
  if (abort) return { ok: false, error: '已有下载任务在进行' }
  abort = new AbortController()
  state = { status: 'downloading', source, received: 0, total: 0, speed: 0, startedAt: Date.now(), targetPath: ZIP_PATH }
  void run(abort.signal, source)
  return { ok: true }
}

async function run(signal: AbortSignal, source: VendorSource): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true })
  let sampleAt = Date.now()
  let sampleBytes = 0
  /** 超时原因：超时是可读失败，不能当作「已取消」 */
  let timeoutMessage: string | undefined
  const abortFor = (msg: string) => {
    if (timeoutMessage || !abort || abort.signal.aborted) return
    timeoutMessage = msg
    abort.abort()
  }
  // 连接/首字节 30 秒无进展即中止；整体下载再给 10 分钟上限
  const connectTimer = setTimeout(
    () => abortFor('连接超时：30 秒内没有收到响应数据（可取消后换源重试）'),
    CONNECT_TIMEOUT_MS,
  )
  const totalTimer = setTimeout(
    () => abortFor('下载超时：超过 10 分钟仍未完成（可取消后换源重试）'),
    DOWNLOAD_TIMEOUT_MS,
  )
  try {
    const res = await openDownload(source, signal)
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText || '未知状态'}`)
    if (!res.body) throw new Error('下载失败：响应没有内容（可能被网络拦截）')
    state.total = Number(res.headers.get('content-length') ?? 0) || 0

    // 边下边统计：Transform 里累加字节并每 500ms 更新一次平滑速度
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        // 首个数据块到达，连接阶段结束
        clearTimeout(connectTimer)
        state.received += chunk.length
        const now = Date.now()
        if (now - sampleAt >= 500) {
          const inst = (state.received - sampleBytes) / ((now - sampleAt) / 1000)
          state.speed = state.speed ? state.speed * 0.6 + inst * 0.4 : inst
          sampleAt = now
          sampleBytes = state.received
        }
        cb(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(res.body as any), meter, createWriteStream(ZIP_PATH), { signal })
    if (signal.aborted) throw new Error('已取消')
    // 数据已落盘，整体下载超时不再适用（解压另算）
    clearTimeout(totalTimer)

    // 解压前校验体积与 zip 魔数：拦截空文件、错误页等「假成功」
    assertZipFile()

    state.status = 'extracting'
    state.speed = 0
    rmSync(UNPACK_DIR, { recursive: true, force: true })
    mkdirSync(UNPACK_DIR, { recursive: true })
    await extractZip(ZIP_PATH, UNPACK_DIR)
    for (const name of VENDOR_ENTRIES) {
      if (!existsSync(join(UNPACK_DIR, name))) throw new Error(`压缩包缺少 ${name}/，可能下载不完整`)
    }

    // 先解压到临时目录，校验通过再替换 vendor：取消/失败不会破坏已有离线包
    mkdirSync(VENDOR_DIR, { recursive: true })
    for (const name of VENDOR_ENTRIES) {
      const dest = join(VENDOR_DIR, name)
      rmSync(dest, { recursive: true, force: true })
      renameSync(join(UNPACK_DIR, name), dest)
    }
    state.status = 'done'
    state.finishedAt = Date.now()
  } catch (e: any) {
    if (timeoutMessage) {
      state.status = 'error'
      state.error = timeoutMessage
    } else if (signal.aborted) {
      // 用户主动取消：不显示错误
      state.status = 'cancelled'
    } else {
      state.status = 'error'
      state.error = readableError(e)
    }
    state.speed = 0
    state.finishedAt = Date.now()
  } finally {
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
    tar = null
    abort = null
    // 无论成功失败都不留 zip / 临时解压目录（0KB 文件也不会残留）
    rmSync(ZIP_PATH, { force: true })
    rmSync(UNPACK_DIR, { recursive: true, force: true })
  }
}

/** 解压前校验：体积 > 1MB 且文件头为 PK，否则判定为无效 zip（错误页/空文件） */
function assertZipFile(): void {
  const size = statSync(ZIP_PATH).size
  if (size === 0) throw new Error('下载失败：文件为 0 字节（可能被网络拦截）')
  if (size <= MIN_ZIP_BYTES) {
    throw new Error(`下载内容不是有效 zip（可能被网络拦截）：文件仅 ${size} 字节`)
  }
  const fd = openSync(ZIP_PATH, 'r')
  try {
    const head = Buffer.alloc(2)
    readSync(fd, head, 0, 2, 0)
    if (head.toString('latin1') !== 'PK') {
      throw new Error('下载内容不是有效 zip（可能被网络拦截）：文件头不是 PK')
    }
  } finally {
    closeSync(fd)
  }
}

/** fetch 失败常是 TypeError('fetch failed')，展开底层 cause（ENOTFOUND/ECONNRESET 等）便于定位 */
function readableError(e: any): string {
  const msg = e?.message ? String(e.message) : String(e)
  const cause = e?.cause
  if (!cause) return msg
  const detail = cause.code ? `${cause.code} ${cause.message ?? ''}`.trim() : String(cause.message ?? cause)
  return `${msg}：${detail}`
}

/** 按所选源打开下载流：三个源最终都指向同一个 asset */
async function openDownload(source: VendorSource, signal: AbortSignal): Promise<Response> {
  if (source === 'mirror') {
    return fetch(MIRROR_PREFIX + DOWNLOAD_URL, { redirect: 'follow', signal })
  }
  if (source === 'official') {
    return fetch(DOWNLOAD_URL, { redirect: 'follow', signal })
  }
  // release：api.github.com 在部分网络下比 github.com 可达；先拿 asset，再走 octet-stream 重定向
  const rel = await fetch(LATEST_RELEASE_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'openmods' },
    signal,
  })
  if (!rel.ok) throw new Error(`获取 Release 失败：HTTP ${rel.status} ${rel.statusText}`)
  const data = await rel.json() as { tag_name?: string; assets?: { name: string; url: string }[] }
  const asset = (data.assets ?? []).find(a => a.name === ASSET_NAME)
  if (!asset) throw new Error(`Release ${data.tag_name ?? ''} 中没有 ${ASSET_NAME}`)
  return fetch(asset.url, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'openmods' },
    redirect: 'follow',
    signal,
  })
}

/** 用系统 tar 解 zip（Windows 10+ 自带 bsdtar 支持 zip） */
function extractZip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', zip, '-C', dest], { windowsHide: true })
    tar = p
    let err = ''
    p.stderr?.on('data', d => { err += String(d) })
    p.on('error', e => reject(new Error(`解压失败：${e.message}`)))
    p.on('close', code => {
      tar = null
      if (code === 0) resolve()
      else reject(new Error(`解压失败（tar 退出码 ${code}）：${err.trim().slice(0, 300) || '未知错误'}`))
    })
  })
}
