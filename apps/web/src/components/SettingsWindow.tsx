import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api.js'
import type { PrefsDto, WakeEntry } from '../types.js'
import { SettingsPage, type SettingsSectionId } from './SettingsPage.js'

/** 设置分区：对齐 dsh 的分区粒度（通用 / 模型 / 子代理 / 自动化） */
const SECTIONS: { id: SettingsSectionId; label: string; icon: ReactNode }[] = [
  {
    id: 'general',
    label: '通用',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="2.4" />
        <path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'models',
    label: '模型',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <ellipse cx="8" cy="4.2" rx="4.8" ry="2.2" />
        <path d="M3.2 4.2v7.6c0 1.2 2.1 2.2 4.8 2.2s4.8-1 4.8-2.2V4.2" strokeLinecap="round" />
        <path d="M3.2 8c0 1.2 2.1 2.2 4.8 2.2s4.8-1 4.8-2.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'subagent',
    label: '子代理',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="6" cy="5.6" r="2.2" />
        <path d="M2.2 13.2c0-2.1 1.7-3.6 3.8-3.6s3.8 1.5 3.8 3.6" strokeLinecap="round" />
        <circle cx="11.6" cy="6.4" r="1.6" />
        <path d="M10.4 13.2c0-1.6 1.1-2.7 2.6-2.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'automation',
    label: '自动化',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M8.9 1.6 3.4 9.2h3.4L6.9 14.4 12.6 6.6H9.1l-.2-5Z" strokeLinejoin="round" />
      </svg>
    ),
  },
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
                <span className="settings-nav-icon" aria-hidden="true">{s.icon}</span>
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
