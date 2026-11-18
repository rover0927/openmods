// 在线下载测试客户端离线包（openmods-test-client.zip）：下载到 data/test-client-download，
// 解压到 data/mc-test-client/.minecraft，带进度/速度/取消。
// zip 结构约定：顶层包含 .minecraft/，或直接是 versions/ + libraries/。
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TEST_ROOT = join(ROOT, 'data', 'mc-test-client')
const CLIENT_DIR = join(TEST_ROOT, '.minecraft')
const TMP_DIR = join(ROOT, 'data', 'test-client-download')
const ZIP_PATH = join(TMP_DIR, 'openmods-test-client.zip')
const UNPACK_DIR = join(TMP_DIR, 'unpacked')
const DOWNLOAD_URL = 'https://github.com/rover0927/openmods/releases/latest/download/openmods-test-client.zip'
const LATEST_RELEASE_API = 'https://api.github.com/repos/rover0927/openmods/releases/latest'
const ASSET_NAME = 'openmods-test-client.zip'
const CONNECT_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const MIN_ZIP_BYTES = 1024 * 1024

export type TestClientSource = 'official' | 'release'

export function isTestClientSource(v: unknown): v is TestClientSource {
  return v === 'official' || v === 'release'
}

export type TestClientDownloadStatus = 'idle' | 'downloading' | 'extracting' | 'done' | 'cancelled' | 'error'

export interface TestClientDownloadState {
  status: TestClientDownloadStatus
  source?: TestClientSource
  received: number
  total: number
  speed: number
  startedAt: number
  finishedAt?: number
  targetPath: string
  error?: string
}

let state: TestClientDownloadState = {
  status: 'idle', received: 0, total: 0, speed: 0, startedAt: 0, targetPath: CLIENT_DIR,
}
let abort: AbortController | null = null
let tar: ChildProcess | null = null

export function testClientDownloadStatus(): TestClientDownloadState {
  return { ...state }
}

export function cancelTestClientDownload(): boolean {
  if (!abort) return false
  abort.abort()
  tar?.kill()
  return true
}

export function startTestClientDownload(source: TestClientSource = 'official'): { ok: boolean; error?: string } {
  if (abort) return { ok: false, error: '已有下载任务在进行' }
  abort = new AbortController()
  state = {
    status: 'downloading', source, received: 0, total: 0, speed: 0, startedAt: Date.now(), targetPath: CLIENT_DIR,
  }
  void run(abort.signal, source)
  return { ok: true }
}

async function openDownload(source: TestClientSource, signal: AbortSignal): Promise<Response> {
  if (source === 'official') return fetch(DOWNLOAD_URL, { redirect: 'follow', signal })
  const rel = await fetch(LATEST_RELEASE_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'openmods' },
    signal,
  })
  if (!rel.ok) throw new Error(`获取 Release 失败：HTTP ${rel.status} ${rel.statusText}`)
  const data = await rel.json() as { tag_name?: string; assets?: { name: string; url: string }[] }
  const asset = (data.assets ?? []).find(a => a.name === ASSET_NAME)
  if (!asset) throw new Error(`Release ${data.tag_name ?? ''} 中没有 ${ASSET_NAME}（请先上传测试客户端离线包）`)
  return fetch(asset.url, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'openmods' },
    redirect: 'follow',
    signal,
  })
}

async function run(signal: AbortSignal, source: TestClientSource): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true })
  let sampleAt = Date.now()
  let sampleBytes = 0
  let timeoutMessage: string | undefined
  const abortFor = (msg: string) => {
    if (timeoutMessage || !abort || abort.signal.aborted) return
    timeoutMessage = msg
    abort.abort()
  }
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

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
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
    clearTimeout(totalTimer)
    assertZipFile()

    state.status = 'extracting'
    state.speed = 0
    rmSync(UNPACK_DIR, { recursive: true, force: true })
    mkdirSync(UNPACK_DIR, { recursive: true })
    await extractZip(ZIP_PATH, UNPACK_DIR)
    installClientDir(UNPACK_DIR)
    state.status = 'done'
    state.finishedAt = Date.now()
  } catch (e: any) {
    const msg = timeoutMessage ?? (e?.message ?? String(e))
    state.status = signal.aborted && !timeoutMessage ? 'cancelled' : 'error'
    state.error = state.status === 'cancelled' ? undefined : msg
    state.speed = 0
    state.finishedAt = Date.now()
  } finally {
    tar = null
    abort = null
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
    rmSync(ZIP_PATH, { force: true })
    rmSync(UNPACK_DIR, { recursive: true, force: true })
  }
}

function assertZipFile() {
  try {
    const stat = statSync(ZIP_PATH)
    if (stat.size <= MIN_ZIP_BYTES) throw new Error('downloaded file too small')
    const fd = openSync(ZIP_PATH, 'r')
    const buf = Buffer.alloc(2)
    readSync(fd, buf, 0, 2, 0)
    closeSync(fd)
    if (buf.toString('latin1') !== 'PK') throw new Error('not a zip')
  } catch {
    throw new Error('下载内容不是有效 zip（可能被网络拦截或文件不完整）')
  }
}

/** 把解压产物落到 data/mc-test-client/.minecraft（兼容 zip 顶层带 .minecraft/） */
function installClientDir(unpacked: string) {
  const nested = join(unpacked, '.minecraft')
  const sourceDir = existsSync(join(nested, 'versions')) || existsSync(join(nested, 'libraries'))
    ? nested
    : unpacked
  if (!existsSync(join(sourceDir, 'versions')) && !existsSync(join(sourceDir, 'libraries'))) {
    throw new Error('测试客户端包结构不符合预期（缺少 versions/libraries 或 .minecraft/）')
  }
  mkdirSync(TEST_ROOT, { recursive: true })
  const backup = join(TEST_ROOT, '.minecraft.old')
  rmSync(backup, { recursive: true, force: true })
  if (existsSync(CLIENT_DIR)) renameSync(CLIENT_DIR, backup)
  try {
    renameSync(sourceDir, CLIENT_DIR)
  } catch (e) {
    // 失败时恢复旧客户端
    rmSync(CLIENT_DIR, { recursive: true, force: true })
    if (existsSync(backup)) renameSync(backup, CLIENT_DIR)
    throw e
  }
  rmSync(backup, { recursive: true, force: true })
}

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
