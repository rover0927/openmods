import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import type { EnvCheckDto, EnvStatusDto } from '../types.js'

const CHECK_TITLES: Record<EnvCheckDto['id'], string> = {
  java: 'Java',
  gradle: 'Gradle 缓存',
  git: 'Git',
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
}

/** 候选下标（-1 = 自定义输入，不与任何候选对应） */
interface Picked {
  java: number
  gradle: number
  git: number
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

  /** 检测结果落地：同时把三张卡片的选中值对齐到「已保存配置 / 第一个 ok」 */
  const applyStatus = useCallback((s: EnvStatusDto) => {
    setStatus(s)
    const find = (id: EnvCheckDto['id']) => s.checks.find(c => c.id === id)
    const java = initialSelection(find('java'), s.config.javaHome ?? '')
    const gradle = initialSelection(find('gradle'), s.config.gradleHome ?? '')
    const git = initialSelection(find('git'), s.config.gitPath ?? '')
    setDraft({ java: java.value, gradle: gradle.value, git: git.value })
    setPicked({ java: java.index, gradle: gradle.index, git: git.index })
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

  /** Java / Gradle 用系统目录选择器；Git 是文件路径，直接文本输入 */
  const pickDir = async (id: 'java' | 'gradle') => {
    try {
      const r = await api.pickDir(draft?.[id] || undefined, id === 'java' ? '选择 JDK 17 目录' : '选择 Gradle 缓存目录')
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
        检测 Java / Gradle 离线缓存 / Git。绿=就绪，黄=能用但需注意，红=缺失；
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
                  placeholder={check.id === 'git' ? '留空 = 使用 PATH 中的 git' : '留空 = 自动检测'}
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
