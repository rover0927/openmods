// 在线下载离线构建包（openmods-vendor.zip）：下载到 data/vendor-download，
// 解压到 plugins/mcdev/vendor，全程暴露进度、速度，并支持取消。
// 这个文件只做下载/解压，不写 settings.json；前端下载完重新调用 /api/env/status 即可看到 vendor 候选。
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
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

let state: VendorDownloadState = { status: 'idle', received: 0, total: 0, speed: 0, startedAt: 0 }
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
  state = { status: 'downloading', source, received: 0, total: 0, speed: 0, startedAt: Date.now() }
  void run(abort.signal, source)
  return { ok: true }
}

async function run(signal: AbortSignal, source: VendorSource): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true })
  let sampleAt = Date.now()
  let sampleBytes = 0
  try {
    const res = await openDownload(source, signal)
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)
    state.total = Number(res.headers.get('content-length') ?? 0) || 0

    // 边下边统计：Transform 里累加字节并每 500ms 更新一次平滑速度
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
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
    state.status = signal.aborted ? 'cancelled' : 'error'
    state.error = signal.aborted ? undefined : (e?.message ?? String(e))
    state.speed = 0
    state.finishedAt = Date.now()
  } finally {
    tar = null
    abort = null
    rmSync(ZIP_PATH, { force: true })
    rmSync(UNPACK_DIR, { recursive: true, force: true })
  }
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
