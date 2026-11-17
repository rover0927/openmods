import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { PrefsDto, WakeEntry } from '../types.js'
import { SettingsPage, type SettingsSectionId } from './SettingsPage.js'
import { McIcon, type McIconName } from './McIcon.js'

/** 设置分区：对齐 dsh 的分区粒度（通用 / 模型 / 子代理 / 自动化） */
const SECTIONS: { id: SettingsSectionId; label: string; icon: McIconName }[] = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'features', label: '功能', icon: 'features' },
  { id: 'models', label: '模型', icon: 'model' },
  { id: 'agents', label: '代理与技能', icon: 'agents' },
  { id: 'subagent', label: '子代理', icon: 'subagents' },
  { id: 'automation', label: '自动化', icon: 'automation' },
  { id: 'about', label: '关于', icon: 'about' },
]

// 设置窗口 —— 复刻 dsh SettingsRoot：overlay + mask + 800×800 面板
// （188px 导航轨 / 标题 / 右上操作 / 右侧可滚动分区内容）
export function SettingsWindow(props: {
  open: boolean
  onClose: () => void
  onToast: (msg: string) => void
  onModelsChanged: () => void
  prefs: PrefsDto | null
  onPrefs: (prefs: PrefsDto) => void
  wakeLog: WakeEntry[]
}) {
  const [section, setSection] = useState<SettingsSectionId>('general')

  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props])

  if (!props.open) return null

  const exportConfig = async () => {
    try {
      const blob = await fetch('/api/settings/file').then(r => {
        if (!r.ok) throw new Error('读取失败')
        return r.blob()
      })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'settings.json'
      a.click()
      URL.revokeObjectURL(a.href)
      props.onToast('配置文件已导出：openmods/data/settings.json')
    } catch (e: any) {
      props.onToast(`打开配置文件失败：${e.message}`)
    }
  }

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-mask" aria-hidden="true" onClick={props.onClose} />
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
        <div className="settings-title">设置</div>
        <nav className="settings-nav">
          <div className="settings-nav-list">
            {SECTIONS.map(s => (
              <button
                key={s.id}
                className={`settings-nav-cell ${section === s.id ? 'active' : ''}`}
                aria-current={section === s.id ? 'true' : undefined}
                onClick={() => setSection(s.id)}
              >
                <span className="settings-nav-icon" aria-hidden="true"><McIcon name={s.icon} size={16} /></span>
                <span className="settings-nav-label">{s.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-header">
          <div className="settings-header-actions">
            <button className="settings-link" onClick={exportConfig} title="导出 data/settings.json">打开配置文件</button>
            <button className="settings-close" onClick={props.onClose} aria-label="关闭">✕</button>
          </div>
        </div>
        <div className="settings-options">
          <SettingsPage
            section={section}
            prefs={props.prefs}
            onPrefs={props.onPrefs}
            onToast={props.onToast}
            onModelsChanged={props.onModelsChanged}
            wakeLog={props.wakeLog}
          />
        </div>
      </div>
    </div>
  )
}
