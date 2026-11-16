import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api.js'
import type { FeaturesDto, PrefsDto, WakeEntry } from '../types.js'
import { AgentsSkillsPane } from './AgentSkillsPane.js'

export type SettingsSectionId = 'general' | 'features' | 'models' | 'agents' | 'subagent' | 'automation'

interface DraftModel {
  id: string
  name: string
  contextWindow?: number
  badge?: string
  badgeType?: 'price' | 'peak'
  desc?: string
  memberOnly?: boolean
  vision?: boolean
}

interface DraftProvider {
  displayName: string
  baseURL: string
  apiKeyInput: string
  apiKeySet: boolean
  models: DraftModel[]
}

const ROUTE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const DEFAULT_PREFS: PrefsDto = {
  fontSize: 14,
  theme: 'dark',
  enterToSend: true,
  maxActiveSubagents: 4,
  autoWake: true,
  canvasAutoWake: true,
  inlineSubagents: true,
  modOutput: '',
  features: {},
}

// ---- 设置控件（dsh SettingsRow / Switch / Segmented / Stepper 的对应物） ----

function Row(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label">{props.label}</span>
        {props.hint && <span className="setting-row-hint">{props.hint}</span>}
      </div>
      <div className="setting-control">{props.children}</div>
    </div>
  )
}

function Switch(props: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      title={props.title}
      disabled={props.disabled}
      className={`switch ${props.on ? 'on' : ''}`}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="switch-thumb" />
    </button>
  )
}

function Seg<T extends string | number>(props: {
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {props.options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          disabled={o.disabled}
          className={`seg-btn ${props.value === o.value ? 'active' : ''}`}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stepper(props: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="num-field">
      <button type="button" className="num-btn" disabled={props.value <= props.min}
        onClick={() => props.onChange(Math.max(props.min, props.value - 1))}>−</button>
      <span className="num-value">{props.value}</span>
      <button type="button" className="num-btn" disabled={props.value >= props.max}
        onClick={() => props.onChange(Math.min(props.max, props.value + 1))}>＋</button>
    </div>
  )
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 设置页 —— 复刻 dsh ui-settings：每个分区一页，行式布局，开关即时生效
export function SettingsPage(props: {
  section: SettingsSectionId
  prefs: PrefsDto | null
  onPrefs: (prefs: PrefsDto) => void
  onToast: (msg: string) => void
  onModelsChanged: () => void
  wakeLog: WakeEntry[]
}) {
  const prefs = props.prefs ?? DEFAULT_PREFS

  // 模型页的草稿（providers）
  const [revision, setRevision] = useState(0)
  const revisionRef = useRef(0)
  const [routeOrder, setRouteOrder] = useState<string[]>([])
  const [draft, setDraft] = useState<Record<string, DraftProvider>>({})
  const [newRoute, setNewRoute] = useState('')
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [discovering, setDiscovering] = useState<string | null>(null)
  /** mod-output 输入草稿：null = 沿用已保存值（失焦/回车才落盘，避免每键一次 PUT） */
  const [modOutputDraft, setModOutputDraft] = useState<string | null>(null)
  /** 功能开关的服务端视图（enabled = 本次启动实际加载，pendingRestart = 已改待重启） */
  const [featInfo, setFeatInfo] = useState<FeaturesDto | null>(null)
  const [featBusy, setFeatBusy] = useState<string | null>(null)

  const loadFeatures = async () => {
    try {
      setFeatInfo(await api.features())
    } catch (e: any) {
      props.onToast(`读取功能开关失败：${e.message}`)
    }
  }

  useEffect(() => {
    if (props.section === 'features') void loadFeatures()
  }, [props.section]) // eslint-disable-line react-hooks/exhaustive-deps

  const setFeature = async (id: string, on: boolean) => {
    setFeatBusy(id)
    try {
      await patchPrefs({ features: { ...(prefs.features ?? {}), [id]: on } })
      await loadFeatures()
    } finally {
      setFeatBusy(null)
    }
  }

  const discover = async (route: string) => {
    const d = draft[route]
    if (!d?.baseURL?.trim()) {
      props.onToast('请先填写 Base URL 再自动获取模型')
      return
    }
    setDiscovering(route)
    try {
      const res = await api.discoverModels(d.baseURL.trim(), {
        route,
        apiKey: d.apiKeyInput.trim() || undefined,
      })
      const found = res.models
      setDraft(prev => ({
        ...prev,
        [route]: { ...prev[route], models: found.map(m => ({ ...m, name: m.name ?? m.id })) },
      }))
      props.onToast(`✓ 自动获取到 ${found.length} 个模型（保存后生效）`)
    } catch (e: any) {
      props.onToast(`自动获取失败：${e.message}`)
    } finally {
      setDiscovering(null)
    }
  }

  useEffect(() => {
    // providers 与"生效的模型目录"一起取：后者带默认目录合并后的 vision / contextWindow
    // （复刻 dsh modelInfo()：目录条目优先，缺省回落到官方默认）。
    Promise.all([api.settings(), api.models()])
      .then(([{ settings }, { models }]) => {
        setRevision(settings.revision)
        revisionRef.current = settings.revision
        if (settings.prefs) props.onPrefs(settings.prefs)
        const effective = new Map(models.map(m => [m.id, m]))
        const order = Object.keys(settings.providers)
        setRouteOrder(order)
        const d: Record<string, DraftProvider> = {}
        for (const [route, p] of Object.entries(settings.providers)) {
          d[route] = {
            displayName: p.displayName,
            baseURL: p.baseURL,
            apiKeyInput: '',
            apiKeySet: p.apiKey.set,
            models: p.models.map(m => {
              const eff = effective.get(`${route}/${m.id}`)
              return {
                ...m,
                name: (m.name && m.name !== m.id) ? m.name : (eff?.displayName ?? m.name),
                vision: m.vision ?? eff?.vision ?? false,
                contextWindow: m.contextWindow ?? eff?.contextWindow,
              }
            }),
          }
        }
        setDraft(d)
      })
      .catch(e => props.onToast(`加载设置失败：${e.message}`))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 偏好即时保存：先乐观生效，失败回滚（dsh 设置项无「保存」按钮） */
  const patchPrefs = async (patch: Partial<PrefsDto>) => {
    const before = prefs
    props.onPrefs({ ...before, ...patch })
    try {
      const res = await api.savePrefs(patch, revisionRef.current)
      revisionRef.current = res.revision
      setRevision(res.revision)
      props.onPrefs(res.prefs)
    } catch (e: any) {
      props.onPrefs(before)
      props.onToast(`设置保存失败：${e.message}`)
    }
  }

  const patchProvider = (route: string, patch: Partial<DraftProvider>) => {
    setDraft(prev => ({ ...prev, [route]: { ...prev[route], ...patch } }))
  }

  const patchModel = (route: string, idx: number, patch: Partial<DraftModel>) => {
    setDraft(prev => {
      const models = prev[route].models.map((m, i) => (i === idx ? { ...m, ...patch } : m))
      return { ...prev, [route]: { ...prev[route], models } }
    })
  }

  const addProvider = () => {
    const route = newRoute.trim().toLowerCase()
    if (!ROUTE_RE.test(route)) {
      props.onToast('供应商标识需小写字母开头，仅含小写字母/数字/连字符，如 my-gateway')
      return
    }
    if (draft[route]) {
      props.onToast(`供应商标识 ${route} 已存在`)
      return
    }
    setDraft(prev => ({
      ...prev,
      [route]: { displayName: route, baseURL: 'https://', apiKeyInput: '', apiKeySet: false, models: [{ id: 'model-1', name: '模型 1', contextWindow: 131072 }] },
    }))
    setRouteOrder(prev => [...prev, route])
    setNewRoute('')
    setAdding(false)
  }

  const removeProvider = (route: string) => {
    setDraft(prev => {
      const next = { ...prev }
      delete next[route]
      return next
    })
    setRouteOrder(prev => prev.filter(r => r !== route))
  }

  const save = async () => {
    setSaving(true)
    try {
      const providers: Record<string, any> = {}
      for (const [route, d] of Object.entries(draft)) {
        providers[route] = {
          displayName: d.displayName || route,
          baseURL: d.baseURL,
          models: d.models.filter(m => m.id.trim()),
        }
      }
      const res = await api.saveSettings({ providers }, revisionRef.current)
      revisionRef.current = res.revision
      setRevision(res.revision)
      // key 单独走 credentials 通道
      for (const [route, d] of Object.entries(draft)) {
        if (d.apiKeyInput.trim()) await api.setCredential(route, d.apiKeyInput.trim())
      }
      props.onToast('设置已保存（下一轮对话生效）')
      props.onModelsChanged()
      const { settings } = await api.settings()
      setDraft(prev => {
        const next: typeof prev = {}
        for (const [route, p] of Object.entries(settings.providers)) {
          next[route] = { ...prev[route], apiKeySet: p.apiKey.set, models: prev[route]?.models ?? p.models }
        }
        return next
      })
    } catch (e: any) {
      props.onToast(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // ---- 通用 ----
  if (props.section === 'general') {
    return (
      <div className="settings-section">
        <div className="settings-section-head">
          <h2>通用</h2>
          <p>外观、字号与发送键。改动即时生效，不需要保存。</p>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">外观</div>
          <Row label="主题" hint="深色 / 浅色，切换即时生效（建模画布与终端保持深色）">
            <Seg<'dark' | 'light'>
              value={prefs.theme}
              options={[{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }]}
              onChange={v => void patchPrefs({ theme: v })}
            />
          </Row>
          <Row label="字号" hint="对话正文与输入框的字号，行高保持 24px 节奏">
            <Seg
              value={prefs.fontSize}
              options={[{ value: 13, label: '小' }, { value: 14, label: '标准' }, { value: 15, label: '大' }]}
              onChange={v => void patchPrefs({ fontSize: v })}
            />
          </Row>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">对话</div>
          <Row label="发送键" hint="换行始终可用：Shift + Enter">
            <Seg
              value={prefs.enterToSend ? 'enter' : 'mod-enter'}
              options={[
                { value: 'enter', label: 'Enter 发送' },
                { value: 'mod-enter', label: '⌘/Ctrl+Enter 发送' },
              ]}
              onChange={v => void patchPrefs({ enterToSend: v === 'enter' })}
            />
          </Row>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">Mod 构建</div>
          <Row label="mod-output（jar 导出目录）" hint="标题栏「jar ⤓」按钮会把最新构建产物复制到这里；留空则回退浏览器下载">
            <input
              className="mod-output-input"
              value={modOutputDraft ?? prefs.modOutput ?? ''}
              placeholder="例如 F:\\mc-outputs"
              onChange={e => setModOutputDraft(e.target.value)}
              onBlur={() => {
                if (modOutputDraft !== null && modOutputDraft !== (prefs.modOutput ?? '')) {
                  void patchPrefs({ modOutput: modOutputDraft })
                }
                setModOutputDraft(null)
              }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
          </Row>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">配置</div>
          <Row label="配置文件" hint="data/settings.json（供应商与偏好同一条 revision）">
            <span className="setting-row-hint">revision {revision}</span>
          </Row>
        </div>
      </div>
    )
  }

  // ---- 功能开关 ----
  if (props.section === 'features') {
    const list = featInfo?.features ?? []
    return (
      <div className="settings-section">
        <div className="settings-section-head">
          <h2>功能</h2>
          <p>
            按需开启模块：关掉画布与 Minecraft 模组开发后，就是一个纯粹的编码代理
            （文件、终端、命令、技能照常可用）。改动保存后需要重启服务生效。
          </p>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">模块</div>
          {list.length === 0 && <div className="setting-row-hint">读取中…</div>}
          {list.map(f => {
            const on = (prefs.features ?? {})[f.id] ?? f.enabled
            return (
              <Row
                key={f.id}
                label={f.name}
                hint={`${f.description}${f.pendingRestart ? ' · 已修改，重启后生效' : ''}`}
              >
                <Switch on={on} disabled={featBusy !== null} onChange={v => void setFeature(f.id, v)} />
              </Row>
            )
          })}
        </div>

        <div className="setting-group">
          <div className="setting-group-title">插件</div>
          <Row label="已加载" hint={(featInfo?.plugins.loaded ?? []).join('、') || '—'}>
            <span className="setting-row-hint">{featInfo?.plugins.loaded.length ?? 0} 个</span>
          </Row>
          {(featInfo?.plugins.skipped ?? []).map(s => (
            <Row key={s.name} label={`已跳过 · ${s.name}`} hint={s.reason}>
              <span className="setting-row-hint">依赖未满足</span>
            </Row>
          ))}
          {(featInfo?.plugins.failed ?? []).map(f => (
            <Row
              key={`${f.name}-${f.phase}`}
              label={`加载失败 · ${f.name}`}
              hint={`${f.phase === 'import' ? '导入失败' : 'apply 失败'}：${f.error}`}
            >
              <span className="setting-row-hint">能力已缺失</span>
            </Row>
          ))}
        </div>

        <div className="setting-group">
          <div className="setting-group-title">角色</div>
          <Row label="当前可用" hint="角色由插件注册：关掉对应功能，角色、工具与技能一起消失">
            <span className="setting-row-hint">{(featInfo?.profiles ?? []).map(p => p.name).join('、') || '—'}</span>
          </Row>
        </div>
      </div>
    )
  }

  // ---- 代理与技能 ----
  if (props.section === 'agents') {
    return <AgentsSkillsPane onToast={props.onToast} />
  }

  // ---- 子代理 ----
  if (props.section === 'subagent') {
    return (
      <div className="settings-section">
        <div className="settings-section-head">
          <h2>子代理</h2>
          <p>子代理在同一个会话里并行建模、共享当前画布；这里管并发与唤醒。</p>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">并发</div>
          <Row label="同时运行的子代理上限" hint="超过上限的派发会被拒绝，等一个完成后再派">
            <Stepper
              value={prefs.maxActiveSubagents}
              min={1}
              max={8}
              onChange={v => void patchPrefs({ maxActiveSubagents: v })}
            />
          </Row>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">唤醒</div>
          <Row
            label="结算后自动唤醒"
            hint="全部子代理结算后，自动开一轮汇总与验收；关闭则只落一条完成通知，不唤醒主会话"
          >
            <Switch on={prefs.autoWake} onChange={v => void patchPrefs({ autoWake: v })} />
          </Row>
          <Row
            label="在对话里显示运行状态"
            hint="运行中的子代理以加载动画列在当前对话底部；关闭后只在右侧「子代理」标签页查看"
          >
            <Switch on={prefs.inlineSubagents} onChange={v => void patchPrefs({ inlineSubagents: v })} />
          </Row>
        </div>
      </div>
    )
  }

  // ---- 自动化 ----
  if (props.section === 'automation') {
    return (
      <div className="settings-section">
        <div className="settings-section-head">
          <h2>自动化</h2>
          <p>让 AI 自己唤醒右侧拓展：画布有改动或子任务完成时，自动展开并刷新建模标签。</p>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">唤醒策略</div>
          <Row
            label="画布自动唤醒"
            hint="AI 改动画布、派发子代理或某个子任务结算时，自动展开右侧「建模」标签并载入最新模型"
          >
            <Switch on={prefs.canvasAutoWake} onChange={v => void patchPrefs({ canvasAutoWake: v })} />
          </Row>
        </div>

        <div className="setting-group">
          <div className="setting-group-title">最近的唤醒（本次打开窗口）</div>
          {props.wakeLog.length === 0 ? (
            <div className="setting-row">
              <span className="setting-row-hint">还没有唤醒记录。AI 开始改画布时会出现在这里。</span>
            </div>
          ) : (
            <div className="wake-log">
              {props.wakeLog.slice(0, 8).map((w, i) => (
                <div className="wake-row" key={`${w.at}-${i}`}>
                  <span className="wake-dot" />
                  <span className="wake-time">{fmtClock(w.at)}</span>
                  <span>{w.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ---- 模型 ----
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h2>模型</h2>
        <p>供应商与模型目录；API key 单独加密存储，改动下一轮对话生效。</p>
      </div>

      {routeOrder.map(route => {
        const d = draft[route]
        if (!d) return null
        return (
          <div key={route} className="settings-card">
            <div className="card-head">
              <span className="provider-route">{route}</span>
              <button className="btn ghost danger-text" onClick={() => removeProvider(route)}>删除</button>
            </div>
            <div className="field-grid">
              <label className="field">
                显示名
                <input value={d.displayName} onChange={e => patchProvider(route, { displayName: e.target.value })} />
              </label>
              <label className="field">
                Base URL
                <input value={d.baseURL} onChange={e => patchProvider(route, { baseURL: e.target.value })} placeholder="https://api.deepseek.com" />
              </label>
              <label className="field">
                API key
                <input
                  type="password"
                  value={d.apiKeyInput}
                  placeholder={d.apiKeySet ? '已配置（输入可覆盖）' : '未配置'}
                  onChange={e => patchProvider(route, { apiKeyInput: e.target.value })}
                />
              </label>
            </div>
            <div className="model-list">
              <div className="model-list-head">
                <span>模型目录</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn ghost"
                    disabled={discovering === route}
                    title="向 Base URL 的 /models 端点探测模型列表并自动填充"
                    onClick={() => discover(route)}
                  >{discovering === route ? '获取中…' : '⟳ 自动获取'}</button>
                  <button className="btn ghost" onClick={() => patchProvider(route, {
                    models: [...d.models, { id: `model-${d.models.length + 1}`, name: '', contextWindow: 131072 }],
                  })}>＋ 添加模型</button>
                </span>
              </div>
              {d.models.map((m, idx) => (
                <div key={idx} className="model-edit-row">
                  <input placeholder="模型 id" value={m.id} onChange={e => patchModel(route, idx, { id: e.target.value })} />
                  <input placeholder="显示名" value={m.name} onChange={e => patchModel(route, idx, { name: e.target.value })} />
                  <input
                    type="number"
                    placeholder="上下文窗口"
                    title="上下文窗口（token）；留空则用该供应商默认值 / 官方目录值"
                    value={m.contextWindow ?? ''}
                    onChange={e => patchModel(route, idx, { contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })}
                  />
                  <label className="member-check" title="支持视觉（图片）输入">
                    <input type="checkbox" checked={!!m.vision} onChange={e => patchModel(route, idx, { vision: e.target.checked })} />👁
                  </label>
                  <label className="member-check">
                    <input type="checkbox" checked={!!m.memberOnly} onChange={e => patchModel(route, idx, { memberOnly: e.target.checked })} />需会员
                  </label>
                  <button className="btn ghost danger-text" onClick={() => patchProvider(route, { models: d.models.filter((_, i) => i !== idx) })}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {adding ? (
        <div className="settings-card adding">
          <div className="field-grid">
            <label className="field">
              供应商标识
              <input autoFocus value={newRoute} onChange={e => setNewRoute(e.target.value)} placeholder="my-gateway" />
            </label>
          </div>
          <div className="add-actions">
            <button className="btn primary" onClick={addProvider}>创建</button>
            <button className="btn ghost" onClick={() => setAdding(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="add-provider-btn" onClick={() => setAdding(true)}>＋ 新增自定义供应商</button>
      )}

      <div className="settings-card">
        <div className="card-head"><span className="provider-route">图片输入</span></div>
        <div className="bridge-desc">
          能收图的模型（在模型行勾了 👁 视觉）会直接收到图片本身——图片按内容寻址存在
          <code> data/attachments</code>，会话日志里只留引用。
          纯文本模型收到的是一行占位说明（<code>[image omitted because this model accepts text only]</code>），
          不会由另一个模型替它描述图片：换一个能收图的模型再看，图还在。
        </div>
      </div>

      <div className="settings-footer">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存模型设置'}</button>
        <span>revision {revision} · 本页只保存模型定义，偏好开关是即时的</span>
      </div>
    </div>
  )
}
