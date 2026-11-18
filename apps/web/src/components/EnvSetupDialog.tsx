import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { EnvCheckDto, EnvStatusDto, VendorDownloadDto } from '../types.js'

const CHECK_TITLES: Record<EnvCheckDto['id'], string> = {
  java: 'Java',
  gradle: 'Gradle 缓存',
  git: 'Git',
  'test-client': '测试客户端',
}

const STATUS_TEXT: Record<EnvCheckDto['status'], string> = {
  ok: '就绪',
  warn: '需注意',
  fail: '未找到',
}

interface Draft {
  java: string
  gradle: string
  git: string
  'test-client': string
}

/** 候选下标（-1 = 自定义输入，不与任何候选对应） */
interface Picked {
  java: number
  gradle: number
  git: number
  'test-client': number
}

/**
 * 初始选中：已保存配置优先，其次第一个 ok 候选。
 * 已保存的空字符串与 vendor 候选（value=''）相等时也能命中；同名 value 只认 ok 的那条，
 * 避免把「解压错位」这类空的失败候选误标成已选。
 */
function initialSelection(check: EnvCheckDto | undefined, saved: string): { value: string; index: number } {
  if (!check) return { value: saved, index: -1 }
  const exact = check.candidates.findIndex(c => c.value === saved && (saved !== '' || c.ok))
  if (exact >= 0) return { value: saved, index: exact }
  const ok = check.candidates.findIndex(c => c.ok)
  if (ok >= 0) return { value: check.candidates[ok].value, index: ok }
  if (check.candidates.length > 0) return { value: check.candidates[0].value, index: 0 }
  return { value: saved, index: -1 }
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 字节数 → 人类可读（1024 进制，保留一位小数） */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 剩余秒数 → 「2 分 05 秒」；无法估算时返回 -- */
function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--'
  const s = Math.ceil(seconds)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`
}

/** 下载源展示名 */
const SOURCE_LABEL: Record<'mirror' | 'official' | 'release', string> = {
  mirror: '国内镜像',
  official: 'GitHub 官方',
  release: 'Release API',
}

/** 下载落盘位置（相对仓库根目录，对应服务端 data/vendor-download/openmods-vendor.zip） */
const VENDOR_ZIP_LABEL = 'data/vendor-download/openmods-vendor.zip'

/** 下载中一直没有字节、超过该时长就提示可能卡在等待响应 */
const VENDOR_WAIT_HINT_MS = 10_000

/**
 * 环境检测面板：首次运行向导（mode='dialog'）与 设置 → 环境（mode='page'）共用。
 * 三张卡片分别是 Java / Gradle 缓存 / Git：状态徽章、摘要、候选单选与自定义路径。
 */
export function EnvSetupPanel(props: {
  mode: 'dialog' | 'page'
  onToast: (msg: string) => void
  onSaved?: (s: EnvStatusDto) => void
  onRequestClose?: () => void
}) {
  const [status, setStatus] = useState<EnvStatusDto | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [error, setError] = useState('')
  /** 在线下载离线构建包的实时状态（下载中每 800ms 轮询一次） */
  const [vendorDl, setVendorDl] = useState<VendorDownloadDto | null>(null)
  const vendorPrev = useRef<VendorDownloadDto['status'] | null>(null)
  /** 下载中 received 一直是 0：开始等待的时刻（0 = 未在等待） */
  const vendorWaitAt = useRef(0)
  const [vendorWaiting, setVendorWaiting] = useState(false)
  const toastRef = useRef(props.onToast)
  toastRef.current = props.onToast

  /** 检测结果落地：同时把三张卡片的选中值对齐到「已保存配置 / 第一个 ok」 */
  const applyStatus = useCallback((s: EnvStatusDto) => {
    setStatus(s)
    const find = (id: EnvCheckDto['id']) => s.checks.find(c => c.id === id)
    const java = initialSelection(find('java'), s.config.javaHome ?? '')
    const gradle = initialSelection(find('gradle'), s.config.gradleHome ?? '')
    const git = initialSelection(find('git'), s.config.gitPath ?? '')
    const client = initialSelection(find('test-client'), s.prefs?.testClientDir ?? '')
    setDraft({ java: java.value, gradle: gradle.value, git: git.value, 'test-client': client.value })
    setPicked({ java: java.index, gradle: gradle.index, git: git.index, 'test-client': client.index })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      applyStatus(await api.envStatus())
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [applyStatus])

  // 对话框每次打开都会重新挂载；设置页进入分区时挂载，两边都是「打开即检测」
  useEffect(() => { void load() }, [load])

  // 下载状态轮询：进行中每 800ms 一次；从进行中转为完成/失败时刷新环境检测
  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      try {
        const s = await api.envVendorStatus()
        if (stopped) return
        setVendorDl(s)
        const prev = vendorPrev.current
        vendorPrev.current = s.status
        if (prev === 'downloading' || prev === 'extracting') {
          if (s.status === 'done') {
            toastRef.current('构建包已下载并解压到 plugins/mcdev/vendor/')
            void load()
          } else if (s.status === 'error') {
            toastRef.current(`构建包下载失败：${s.error ?? '未知错误'}`)
          }
        }
        if (s.status === 'downloading' || s.status === 'extracting') {
          timer = window.setTimeout(tick, 800)
        }
      } catch {
        // 轮询失败不打扰用户；重新进入环境页会重新读取状态
      }
    }
    void tick()
    return () => { stopped = true; if (timer) window.clearTimeout(timer) }
  }, [load])

  // 下载中长时间 received=0 → 提示「等待响应」，避免看起来一直 0KB 无反馈
  useEffect(() => {
    if (vendorDl?.status !== 'downloading' || vendorDl.received > 0) {
      vendorWaitAt.current = 0
      setVendorWaiting(false)
      return
    }
    if (!vendorWaitAt.current) vendorWaitAt.current = Date.now()
    const left = Math.max(0, VENDOR_WAIT_HINT_MS - (Date.now() - vendorWaitAt.current))
    const timer = window.setTimeout(() => setVendorWaiting(true), left)
    return () => { window.clearTimeout(timer) }
  }, [vendorDl?.status, vendorDl?.received])

  const startVendorDownload = async (source: 'mirror' | 'official' | 'release') => {
    try {
      await api.envVendorStart(source)
      setVendorDl(await api.envVendorStatus())
    } catch (e: any) {
      props.onToast(`启动下载失败：${e.message}`)
    }
  }

  const cancelVendorDownload = async () => {
    try {
      await api.envVendorCancel()
    } catch (e: any) {
      props.onToast(`取消失败：${e.message}`)
    }
  }

  /** 手输/选目录都算自定义：清掉候选下标，保存时按输入值提交 */
  const setField = (id: EnvCheckDto['id'], value: string) => {
    setDraft(prev => (prev ? { ...prev, [id]: value } : prev))
    setPicked(prev => (prev ? { ...prev, [id]: -1 } : prev))
  }

  /** 点选候选：值可能为空（vendor 离线包），但下标唯一，radio 始终只有一个选中 */
  const pickCandidate = (id: EnvCheckDto['id'], value: string, index: number) => {
    setDraft(prev => (prev ? { ...prev, [id]: value } : prev))
    setPicked(prev => (prev ? { ...prev, [id]: index } : prev))
  }

  /** Java / Gradle / 测试客户端用系统目录选择器；Git 是文件路径，直接文本输入 */
  const pickDir = async (id: 'java' | 'gradle' | 'test-client') => {
    try {
      const title = id === 'java' ? '选择 JDK 17 目录'
        : id === 'gradle' ? '选择 Gradle 缓存目录'
          : '选择测试客户端 .minecraft 目录'
      const r = await api.pickDir(draft?.[id] || undefined, title)
      if (r.path) setField(id, r.path)
    } catch (e: any) {
      props.onToast(`选择目录失败：${e.message}`)
    }
  }

  /** 整理错位解压的离线包（plugins/mcdev/{gradle-8.8,fg-maven} → vendor/） */
  const fixVendor = async () => {
    setFixing(true)
    try {
      applyStatus(await api.envApply({ fixVendorLayout: true }))
      props.onToast('已把错位的缓存整理到 plugins/mcdev/vendor/')
    } catch (e: any) {
      props.onToast(`整理失败：${e.message}`)
    } finally {
      setFixing(false)
    }
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const s = await api.envApply({
        javaHome: draft.java.trim(),
        gradleHome: draft.gradle.trim(),
        gitPath: draft.git.trim(),
        testClientDir: draft['test-client'].trim(),
        setupDone: true,
      })
      applyStatus(s)
      props.onToast('环境配置已保存，后续构建立即生效')
      props.onSaved?.(s)
      props.onRequestClose?.()
    } catch (e: any) {
      props.onToast(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  /** 稍后配置：只记 setupDone，不写路径；设置 → 环境 仍显示未解决项 */
  const skip = async () => {
    setSaving(true)
    try {
      applyStatus(await api.envApply({ setupDone: true }))
      props.onToast('已跳过环境配置；可随时到 设置 → 环境 调整')
      props.onRequestClose?.()
    } catch (e: any) {
      props.onToast(`跳过失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const busy = loading || saving || fixing

  if (!status) {
    return (
      <div className={`env-panel ${props.mode === 'page' ? 'env-panel-page' : ''}`}>
        <div className={`env-loading ${error ? 'err' : ''}`}>
          {error ? `检测失败：${error}` : '正在检测 Java / Gradle 缓存 / Git…'}
        </div>
        <div className="env-actions">
          <button className="btn" disabled={loading} onClick={() => void load()}>
            {loading ? '检测中…' : '重新检测'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`env-panel ${props.mode === 'page' ? 'env-panel-page' : ''}`}>
      <div className="env-panel-hint">
        检测 Java / Gradle 离线缓存 / Git / 测试客户端。绿=就绪，黄=能用但需注意，红=缺失；
        选择后保存会立即应用到构建、测试客户端与自更新。
      </div>
      {error && <div className="env-load-error">重新检测失败：{error}</div>}

      <div className="env-cards">
        {status.checks.map(check => {
          const value = draft?.[check.id] ?? ''
          const pickedIndex = picked?.[check.id] ?? -1
          const custom = pickedIndex < 0 && value !== ''
          return (
            <div className="env-card" key={check.id}>
              <div className="env-card-head">
                <span className="env-card-title">{CHECK_TITLES[check.id]}</span>
                <span className={`env-status-pill ${check.status}`}>{STATUS_TEXT[check.status]}</span>
              </div>
              <div className="env-card-summary">{check.summary}</div>
              {check.details.length > 0 && (
                <ul className="env-details">
                  {check.details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}

              {check.candidates.length > 0 && (
                <div className="env-candidates">
                  {check.candidates.map((c, i) => {
                    const selected = i === pickedIndex
                    return (
                      <label
                        key={`${check.id}-${i}-${c.value}`}
                        className={`env-candidate ${selected ? 'selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name={`env-${check.id}`}
                          checked={selected}
                          onChange={() => pickCandidate(check.id, c.value, i)}
                        />
                        <span className="env-candidate-body">
                          <span className="env-candidate-label">{c.label}</span>
                          <span className="env-candidate-meta">
                            {c.version && <span className="env-candidate-version">v{c.version}</span>}
                            <span className={`env-candidate-flag ${c.ok ? 'ok' : 'bad'}`}>
                              {c.ok ? '可用' : '不可用'}
                            </span>
                          </span>
                          {c.note && <span className="env-candidate-note">{c.note}</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}

              <div className={`env-custom-path ${custom ? 'selected' : ''}`}>
                <span className="env-custom-label">自定义路径</span>
                <input
                  className="env-path-input"
                  value={value}
                  spellCheck={false}
                  placeholder={check.id === 'git'
                    ? '留空 = 使用 PATH 中的 git'
                    : check.id === 'test-client'
                      ? '留空 = 使用默认 data/mc-test-client/.minecraft'
                      : '留空 = 自动检测'}
                  onChange={e => setField(check.id, e.target.value)}
                />
                {check.id === 'java' && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    title="打开系统目录选择器"
                    onClick={() => void pickDir('java')}
                  >选择目录</button>
                )}
                {check.id === 'gradle' && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    title="打开系统目录选择器"
                    onClick={() => void pickDir('gradle')}
                  >选择目录</button>
                )}
                {check.id === 'test-client' && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    title="选择已安装的 .minecraft 目录"
                    onClick={() => void pickDir('test-client')}
                  >选择目录</button>
                )}
              </div>

              {check.actions?.some(a => a.id === 'fix-vendor') && (
                <div className="env-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void fixVendor()}
                  >{fixing ? '整理中…' : '整理到 vendor/'}</button>
                </div>
              )}

              {check.id === 'gradle' && (
                <div className="env-vendor">
                  {vendorDl && (vendorDl.status === 'downloading' || vendorDl.status === 'extracting') ? (
                    <>
                      <div className="env-vendor-head">
                        <span>
                          {vendorDl.status === 'extracting'
                            ? '正在解压到 plugins/mcdev/vendor/…'
                            : vendorWaiting && vendorDl.received === 0
                              ? `正在下载构建包（${SOURCE_LABEL[vendorDl.source ?? 'mirror']}）· 等待响应…（如长时间无进度请取消并换源）`
                              : `正在下载构建包${vendorDl.total ? ` ${Math.min(100, Math.round((vendorDl.received / vendorDl.total) * 100))}%` : ''}（${SOURCE_LABEL[vendorDl.source ?? 'mirror']}）`}
                        </span>
                        {vendorDl.status === 'downloading' && (
                          <span className="env-vendor-stat">
                            {fmtBytes(vendorDl.received)}
                            {vendorDl.total ? ` / ${fmtBytes(vendorDl.total)}` : ''}
                            {vendorDl.speed > 0 ? ` · ${fmtBytes(vendorDl.speed)}/s` : ''}
                            {vendorDl.total && vendorDl.speed > 0
                              ? ` · 剩余 ${fmtEta((vendorDl.total - vendorDl.received) / vendorDl.speed)}`
                              : ''}
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => void cancelVendorDownload()}
                        >取消</button>
                      </div>
                      <div className="env-vendor-bar">
                        <span style={{
                          width: vendorDl.status === 'extracting'
                            ? '100%'
                            : `${vendorDl.total ? Math.min(100, (vendorDl.received / vendorDl.total) * 100) : 0}%`,
                        }} />
                      </div>
                      <div className="env-vendor-note">保存到 {VENDOR_ZIP_LABEL}</div>
                    </>
                  ) : (
                    <>
                      <div className="env-vendor-head">
                        <span>
                          {vendorDl?.status === 'done'
                            ? '构建包已就绪'
                            : '在线下载构建包（约 224 MB），选择下载源：'}
                        </span>
                      </div>
                      <div className="env-vendor-sources">
                        <button type="button" className="btn" onClick={() => void startVendorDownload('mirror')}>
                          国内镜像
                        </button>
                        <button type="button" className="btn ghost" onClick={() => void startVendorDownload('official')}>
                          GitHub 官方
                        </button>
                        <button type="button" className="btn ghost" onClick={() => void startVendorDownload('release')}>
                          Release API
                        </button>
                      </div>
                      <div className="env-vendor-note">
                        镜像走 gh-proxy 加速；官方直连 github.com；Release API 经 api.github.com 获取直链。
                      </div>
                      {vendorDl?.status === 'error' && (
                        <div className="env-vendor-error">下载失败：{vendorDl.error ?? '未知错误'}</div>
                      )}
                      {vendorDl?.status === 'cancelled' && (
                        <div className="env-vendor-note">已取消，可重新下载。</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="env-footer">
        <span className="env-footer-note">
          {status.updatedAt ? `上次检测 ${fmtClock(status.updatedAt)} · ${status.configured ? '已配置' : '尚未配置'}` : ''}
        </span>
        <div className="env-actions">
          <button className="btn" disabled={busy} onClick={() => void load()}>
            {loading ? '检测中…' : '重新检测'}
          </button>
          {props.mode === 'dialog' && (
            <button className="btn ghost" disabled={busy} onClick={() => void skip()}>稍后配置</button>
          )}
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {saving ? '保存中…' : (props.mode === 'dialog' ? '保存并继续' : '保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 首次运行环境向导：遮罩 + MC 风格弹窗，内部复用环境检测面板 */
export function EnvSetupDialog(props: {
  open: boolean
  onClose: () => void
  onToast: (msg: string) => void
  onSaved?: (s: EnvStatusDto) => void
}) {
  if (!props.open) return null

  return (
    <div className="dialog-backdrop env-dialog-backdrop">
      <div className="dialog env-dialog" role="dialog" aria-modal="true" aria-label="首次运行环境检测">
        <div className="dialog-title-row">
          <div className="dialog-title">首次运行环境检测</div>
          <button className="dialog-x" title="关闭" onClick={props.onClose}>×</button>
        </div>
        <div className="dialog-body env-dialog-body">
          <EnvSetupPanel
            mode="dialog"
            onToast={props.onToast}
            onSaved={props.onSaved}
            onRequestClose={props.onClose}
          />
        </div>
      </div>
    </div>
  )
}
