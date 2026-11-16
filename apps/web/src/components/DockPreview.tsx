// 右侧拓展的三种预览面板（复刻 dsh ui-sidebar-documentpreview / -files / -browser 的最小面）：
//   图片 —— 当前会话的参考图网格 + 灯箱
//   文件 —— 工作区目录逐层浏览 + 文本/图片预览
//   网页 —— 内嵌 iframe（含回环地址）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionImageDto } from '../types.js'
import { Lightbox } from './Lightbox.js'

/* ------------------------------ 图片 ------------------------------ */

export function ImagesPane(props: { images: SessionImageDto[] }) {
  const [openAt, setOpenAt] = useState<number | null>(null)
  const images = props.images

  if (!images.length) {
    return (
      <div className="ds-empty">
        这个会话还没有参考图。<br />
        在输入框粘贴或选择图片后再看这里。
      </div>
    )
  }

  return (
    <div className="img-pane">
      <div className="img-grid">
        {images.map((img, i) => (
          <button
            key={`${img.id}-${i}`}
            className="img-cell"
            title={img.name ?? img.id}
            onClick={() => setOpenAt(i)}
          >
            <img src={img.src} alt={img.name ?? '参考图'} loading="lazy" />
          </button>
        ))}
      </div>
      <Lightbox images={images} at={openAt} onAt={setOpenAt} />
    </div>
  )
}

/* ------------------------------ 文件 ------------------------------ */

interface FileEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
}

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|env|log|ts|tsx|js|jsx|mjs|cjs|css|html?|xml|svg|py|go|rs|java|c|h|cpp|sh|ps1|sql)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i

function fmtSize(n?: number): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function FilesPane() {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [root, setRoot] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; kind: 'text' | 'image'; text?: string; truncated?: boolean } | null>(null)

  const load = useCallback(async (target: string) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/fs?path=${encodeURIComponent(target)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setEntries(json.entries ?? [])
      setPath(json.path ?? '')
      setRoot(json.root ?? '')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load('') }, [load])

  const openEntry = async (entry: FileEntry) => {
    if (entry.type === 'dir') { setPreview(null); await load(entry.path); return }
    if (IMAGE_EXT.test(entry.name)) {
      setPreview({ path: entry.path, kind: 'image' })
      return
    }
    if (!TEXT_EXT.test(entry.name)) {
      setPreview({ path: entry.path, kind: 'text', text: '这个文件类型暂不支持预览（只预览文本与图片）。' })
      return
    }
    try {
      const res = await fetch(`/api/fs/text?path=${encodeURIComponent(entry.path)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setPreview({ path: entry.path, kind: 'text', text: json.text, truncated: json.truncated })
    } catch (e: any) {
      setError(e.message)
    }
  }

  const crumbs = path ? path.split('/') : []
  const parent = crumbs.slice(0, -1).join('/')

  if (preview) {
    return (
      <div className="file-pane">
        <div className="file-bar">
          <button className="file-crumb" onClick={() => setPreview(null)}>‹ 返回</button>
          <span className="file-path" title={preview.path}>{preview.path}</span>
          <a className="file-crumb" href={`/api/fs/raw?path=${encodeURIComponent(preview.path)}`} target="_blank" rel="noreferrer" title="新窗口打开">⤢</a>
        </div>
        {preview.kind === 'image' ? (
          <div className="file-image"><img src={`/api/fs/raw?path=${encodeURIComponent(preview.path)}`} alt={preview.path} /></div>
        ) : (
          <pre className="file-text">{preview.text}{preview.truncated ? '\n\n…（文件较大，已截断）' : ''}</pre>
        )}
      </div>
    )
  }

  return (
    <div className="file-pane">
      <div className="file-bar">
        <button className="file-crumb" disabled={!path} onClick={() => void load(parent)}>‹</button>
        <button className="file-crumb" onClick={() => void load('')} title={root}>工作区</button>
        {crumbs.map((c, i) => (
          <button key={i} className="file-crumb" onClick={() => void load(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
        ))}
        <span className="file-bar-spacer" />
        <button className="file-crumb" onClick={() => void load(path)} title="刷新">⟳</button>
      </div>
      <div className="file-list">
        {loading && <div className="ds-empty">读取中…</div>}
        {error && <div className="ds-empty">读取失败：{error}</div>}
        {!loading && !error && entries.length === 0 && <div className="ds-empty">空目录</div>}
        {entries.map(e => (
          <button key={e.path} className={`file-row ${e.type}`} onClick={() => void openEntry(e)} title={e.path}>
            <span className="file-icon" aria-hidden="true">{e.type === 'dir' ? '▸' : '·'}</span>
            <span className="file-name">{e.name}</span>
            <span className="file-size">{fmtSize(e.size)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------ 网页 ------------------------------ */

const SELF_ORIGIN = typeof location === 'undefined' ? '' : location.origin
const RECENT_KEY = 'openmods.webRecent'
const ADDR_KEY = 'openmods.webAddr'

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x: any) => typeof x === 'string').slice(0, 8) : []
  } catch { return [] }
}

/**
 * 地址解析（复刻 dsh `parseBrowserAddress`）：不带 scheme 时补全（本地/回环补 http，其余 https），
 * 只放行 http(s)、拒绝内嵌凭据与**当前应用自身 origin**——后者正是"只能显示当前页面"的来源：
 * 老实现把 location.origin 当默认地址，iframe 里永远套着 openmods 自己。
 */
function parseAddress(input: string): { url: string } | { error: string } {
  const raw = String(input ?? '').trim()
  if (!raw) return { error: '先输入一个地址' }
  const explicit = /^[a-zA-Z][a-zA-Z\d+.-]*:(?!\d+(?:[/?#]|$))/.test(raw)
  const loopback = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(raw)
  const candidate = explicit ? raw : `${loopback ? 'http' : 'https'}://${raw}`
  let u: URL
  try { u = new URL(candidate) } catch { return { error: '地址格式不对' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '只支持 http / https 地址' }
  if (u.username || u.password) return { error: '地址里不能带用户名/密码' }
  if (SELF_ORIGIN && u.origin === SELF_ORIGIN) return { error: '这是当前应用自身；本地服务请换一个端口' }
  return { url: u.href }
}

interface WebProbe {
  ok: boolean
  finalUrl?: string
  status?: number
  contentType?: string
  embeddable?: boolean
  reason?: string
  error?: string
}

export function WebPane() {
  const saved = localStorage.getItem(ADDR_KEY) ?? ''
  const [address, setAddress] = useState(saved === SELF_ORIGIN ? '' : saved)
  const [loaded, setLoaded] = useState<{ src: string; url: string; proxied: boolean } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'blocked'; text: string; url?: string } | null>(null)
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const navRef = useRef<{ list: string[]; at: number }>({ list: [], at: -1 })
  const [nav, setNav] = useState(navRef.current)

  const pushNav = (url: string) => {
    const cur = navRef.current
    const cut = cur.at >= 0 ? cur.list.slice(0, cur.at + 1) : []
    const list = [...cut, url]
    navRef.current = { list, at: list.length - 1 }
    setNav(navRef.current)
  }

  const go = useCallback(async (input: string, opts: { push?: boolean; forceProxy?: boolean } = {}) => {
    const parsed = parseAddress(input)
    if ('error' in parsed) { setNotice({ kind: 'error', text: parsed.error }); return }
    const url = parsed.url
    setLoading(true)
    setNotice(null)
    setAddress(url)
    localStorage.setItem(ADDR_KEY, url)

    let probe: WebProbe
    try {
      const res = await fetch(`/api/web/probe?url=${encodeURIComponent(url)}`)
      probe = await res.json()
    } catch (e: any) {
      setLoading(false); setNotice({ kind: 'error', text: `探测失败：${e.message}` }); return
    }
    if (!probe.ok) {
      setLoading(false); setNotice({ kind: 'error', text: `打不开：${probe.error ?? '未知错误'}` }); return
    }
    const blocked = probe.embeddable === false
    if (blocked && !opts.forceProxy) {
      setLoading(false)
      setNotice({ kind: 'blocked', text: probe.reason ?? '站点禁止被嵌入', url })
      setRecent(prev => {
        const next = [url, ...prev.filter(x => x !== url)].slice(0, 8)
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
        return next
      })
      return
    }
    const proxied = blocked || !!opts.forceProxy
    // 探测阶段结束就收掉"正在探测"：iframe 的 load 事件在跨源页面里不可靠
    setLoading(false)
    setLoaded({
      src: proxied ? `/api/web/proxy?url=${encodeURIComponent(url)}` : url,
      url: probe.finalUrl ?? url,
      proxied,
    })
    setNonce(n => n + 1)
    if (opts.push !== false) pushNav(url)
    setRecent(prev => {
      const next = [url, ...prev.filter(x => x !== url)].slice(0, 8)
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const step = (delta: number) => {
    const target = nav.list[nav.at + delta]
    if (!target) return
    navRef.current = { list: nav.list, at: nav.at + delta }
    setNav(navRef.current)
    void go(target, { push: false })
  }

  const reload = () => {
    if (!loaded) return
    setNonce(n => n + 1)
    setNotice(null)
  }

  const canBack = nav.at > 0
  const canForward = nav.at >= 0 && nav.at < nav.list.length - 1

  return (
    <div className="web-pane">
      <div className="web-bar">
        <div className="web-navs">
          <button className="web-nav" onClick={() => step(-1)} disabled={!canBack} title="后退">‹</button>
          <button className="web-nav" onClick={() => step(1)} disabled={!canForward} title="前进">›</button>
          <button className="web-nav" onClick={reload} disabled={!loaded} title="刷新">⟳</button>
        </div>
        <input
          className="web-url"
          value={address}
          placeholder="输入地址：example.com 或 127.0.0.1:3000"
          spellCheck={false}
          onChange={e => setAddress(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void go(address) }}
          onFocus={e => e.currentTarget.select()}
        />
        <div className="web-acts">
          <button className="dock-act" onClick={() => void go(address)}>打开</button>
          <button
            className={`dock-act ${loaded?.proxied ? 'on' : ''}`}
          disabled={!loaded}
          title={loaded?.proxied ? '切回 iframe 直连（站点拒绝嵌入时会失败）' : '站点拒绝嵌入时，改由本机代理显示'}
            onClick={() => { if (loaded) void go(loaded.url, { forceProxy: !loaded.proxied }) }}
          >
            代理
          </button>
          <a
            className="dock-act"
            href={loaded?.url || undefined}
            target="_blank"
            rel="noreferrer"
            title="在浏览器新标签打开"
            aria-disabled={!loaded}
            onClick={e => { if (!loaded) e.preventDefault() }}
          >⤢</a>
        </div>
      </div>

      {loaded?.proxied && (
        <div className="web-status proxy">
          代理模式：页面经本机转发，脚本 / 登录 / 站内跳转可能失效
        </div>
      )}
      {loading && <div className="web-status">正在探测目标地址…</div>}

      <div className="web-frame-wrap">
        {loaded ? (
          <iframe
            key={`${loaded.src}#${nonce}`}
            className="web-frame"
            src={loaded.src}
            title="网页预览"
            onLoad={() => setLoading(false)}
            sandbox={loaded.proxied
              // 代理页与父页面同源，不能再给 allow-same-origin（否则被转发的脚本可读本应用的 storage）
              ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
              : 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="web-start">
            <div className="web-start-icon" aria-hidden="true">◫</div>
            <div className="web-start-title">在右侧浏览网页</div>
            <div className="web-start-desc">
              输入 http(s) 地址，或 <code>127.0.0.1</code> 上的本地服务（不带协议时自动补全）。
              站点若禁止被嵌入，会先说明原因，再决定是否用代理打开。
            </div>
            {recent.length > 0 && (
              <div className="web-recent">
                <div className="web-recent-head">最近访问</div>
                {recent.map(u => (
                  <button key={u} className="web-recent-row" onClick={() => void go(u)} title={u}>
                    <span className="web-recent-dot" aria-hidden="true" />
                    <span className="web-recent-url">{u}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {notice && <div className="web-notice-mask" onClick={() => setNotice(null)} />}
        {notice && (
          <div className={`web-notice ${notice.kind}`}>
            <div className="web-notice-title">
              {notice.kind === 'blocked' ? '这个页面不能直接嵌入' : '打不开这个地址'}
            </div>
            <div className="web-notice-text">{notice.text}</div>
            <div className="web-notice-actions">
              {notice.kind === 'blocked' && notice.url && (
                <button className="web-notice-btn" onClick={() => void go(notice.url!, { forceProxy: true })}>用代理打开</button>
              )}
              {notice.url && (
                <a className="web-notice-btn ghost" href={notice.url} target="_blank" rel="noreferrer">在浏览器打开</a>
              )}
              <button className="web-notice-btn ghost" onClick={() => setNotice(null)}>关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
