// 右侧「网页」标签的服务端半边：嵌入性探测 + 代理渲染。
//
// dsh 的 Web 版浏览器只用 iframe（Desktop 才用 Electron `<webview>`），并且明确
// "不代理或探测远程页面"；openmods 没有 Electron，iframe 又是唯一载体，于是这里多两步：
//   1. `/api/web/probe`   —— 服务端先看一眼目标响应头（X-Frame-Options / CSP frame-ancestors），
//      让界面能**提前**说清"这个站不许被嵌入"，而不是给用户一块白屏。
//   2. `/api/web/proxy`   —— 用户显式点"代理打开"时才走：本机转发一份 HTML 并注入 `<base>`，
//      让 iframe 以同源身份显示。脚本/登录/站内跳转在代理模式下可能失效，UI 里会标注。

/** 单页 HTML 上限（超过就截断并提示），避免把整个视频流读进内存 */
const MAX_HTML_BYTES = 8 * 1024 * 1024
/** 非 HTML 资源（图片/PDF）上限 */
const MAX_BINARY_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 20_000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36 openmods-webview/0.1'

export interface WebTarget {
  url: string
  origin: string
}

/** 地址校验：只放行 http/https、无内嵌凭据（与 dsh `parseBrowserAddress` 的允许集一致）。 */
export function parseWebTarget(input: string): WebTarget | { error: string } {
  const raw = String(input ?? '').trim()
  if (!raw) return { error: '地址为空' }
  if (raw.length > 16 * 1024) return { error: '地址过长' }
  let url: URL
  try { url = new URL(raw) } catch { return { error: '地址格式不对' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: '只支持 http / https 地址' }
  if (url.username || url.password) return { error: '地址里不能带用户名/密码' }
  return { url: url.href, origin: url.origin }
}

export interface ProbeResult {
  ok: boolean
  /** 目标最终地址（跟随重定向后） */
  finalUrl?: string
  status?: number
  contentType?: string
  /** iframe 能否直接嵌入 */
  embeddable?: boolean
  /** 不能嵌入的原因（给界面直接显示） */
  reason?: string
  /** 网络层错误 */
  error?: string
}

/** `frame-ancestors` 里出现除 `*` 之外的来源都视为"只允许特定站点嵌入"（我们不是其中之一）。 */
function frameAncestorsBlocks(csp: string): boolean {
  for (const directive of csp.split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    if (parts[0].toLowerCase() !== 'frame-ancestors') continue
    const sources = parts.slice(1).map(s => s.toLowerCase())
    if (sources.includes('*') || sources.includes('http:') || sources.includes('https:')) return false
    return true
  }
  return false
}

/** fetch 的失败信息默认只有一句 "fetch failed"；把 undici 的 cause（DNS/连接/TLS）带出来。 */
function errText(e: any): string {
  if (e?.name === 'TimeoutError') return `连接超时（${TIMEOUT_MS / 1000}s）`
  const cause = e?.cause
  const code = cause?.code ?? cause?.errno
  if (code) return `${code}${cause?.message ? `: ${cause.message}` : ''}`
  return e?.message ?? String(e)
}

async function readSnippet(res: Response): Promise<void> {
  // 只探测响应头，正文立刻取消：不下载整页
  try { await res.body?.cancel() } catch { /* 已结束 */ }
}

export async function probeWeb(url: string): Promise<ProbeResult> {
  const target = parseWebTarget(url)
  if ('error' in target) return { ok: false, error: target.error }
  let res: Response
  try {
    res = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e: any) {
    return { ok: false, error: errText(e) }
  }
  const headers = res.headers
  const xfo = (headers.get('x-frame-options') ?? '').toLowerCase()
  const csp = headers.get('content-security-policy') ?? ''
  let embeddable = true
  let reason: string | undefined
  if (xfo.includes('deny')) { embeddable = false; reason = '站点设置 X-Frame-Options: DENY（禁止任何页面嵌入）' }
  else if (xfo.includes('sameorigin')) { embeddable = false; reason = '站点设置 X-Frame-Options: SAMEORIGIN（只允许同源页面嵌入）' }
  else if (frameAncestorsBlocks(csp)) { embeddable = false; reason = '站点的 CSP frame-ancestors 只允许指定来源嵌入' }
  const contentType = headers.get('content-type') ?? ''
  await readSnippet(res)
  return {
    ok: true,
    finalUrl: res.url || target.url,
    status: res.status,
    contentType,
    embeddable,
    ...(reason ? { reason } : {}),
  }
}

/** 从 content-type 里取 charset，按它解码（很多老站是 gbk，用 UTF-8 硬解会乱码）。 */
function decodeBody(bytes: ArrayBuffer, contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType)
  const label = (m?.[1] ?? 'utf-8').toLowerCase()
  try { return new TextDecoder(label).decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 注入 `<base>`（让相对资源仍指向原站）、移除原页面的 CSP meta 与自带 `<base>`。
 * 不重写站内链接：点击后会回到原站、被 iframe 策略挡住 —— 这是代理模式的已知边界。
 */
export function rewriteHtml(html: string, finalUrl: string): string {
  let out = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
  const base = `<base href="${escapeAttr(finalUrl)}">`
  if (/<head\b[^>]*>/i.test(out)) return out.replace(/<head\b[^>]*>/i, m => m + base)
  if (/<html\b[^>]*>/i.test(out)) return out.replace(/<html\b[^>]*>/i, m => `${m}<head>${base}</head>`)
  return base + out
}

export interface ProxyResult {
  status: number
  contentType: string
  body: Buffer
  /** 响应被截断（超过上限） */
  truncated?: boolean
  finalUrl: string
}

export async function proxyWeb(url: string): Promise<ProxyResult | { error: string }> {
  const target = parseWebTarget(url)
  if ('error' in target) return { error: target.error }
  let res: Response
  try {
    res = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e: any) {
    return { error: errText(e) }
  }
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  const finalUrl = res.url || target.url
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType)
  const limit = isHtml ? MAX_HTML_BYTES : MAX_BINARY_BYTES
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > limit) {
          chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - limit))))
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
        chunks.push(value)
      }
    }
  } catch (e: any) {
    if (!chunks.length) return { error: errText(e) }
  }
  const bytes = Buffer.concat(chunks.map(c => Buffer.from(c)))
  if (!isHtml) return { status: res.status, contentType, body: bytes, finalUrl, ...(truncated ? { truncated } : {}) }
  const html = rewriteHtml(decodeBody(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), contentType), finalUrl)
  return {
    status: res.status,
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from(html, 'utf8'),
    finalUrl,
    ...(truncated ? { truncated } : {}),
  }
}
