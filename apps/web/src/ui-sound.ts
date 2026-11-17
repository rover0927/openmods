// 界面音效：MC 原版 UI 点击 / 切换 / 成就提示音（public/sounds/ui/*.ogg）
//
// - 每个音效复用一个 HTMLAudioElement：连点时重头播放，不会叠出多条音轨；
// - 全局 pointerdown 委托：只对可交互元素发声，按钮禁用、文本输入 / 拖拽不响；
// - 设置 → 通用「界面音效」可整体关闭（App 的 applyPrefs 调 setUiSoundEnabled）。
const SOURCES = {
  click: '/sounds/ui/click.ogg',
  /** 页签 / 开关 / 分段这类切换控件用更短的 pop，和普通按钮区分 */
  pop: '/sounds/ui/pop.ogg',
  /** 提示条（成就弹窗） */
  toast: '/sounds/ui/toast_in.ogg',
} as const
type SoundName = keyof typeof SOURCES

const VOLUME: Record<SoundName, number> = { click: 0.32, pop: 0.26, toast: 0.28 }

let enabled = true
let installed = false
const players = new Map<SoundName, HTMLAudioElement>()

function player(name: SoundName): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null
  let audio = players.get(name)
  if (!audio) {
    audio = new Audio(SOURCES[name])
    audio.preload = 'auto'
    audio.volume = VOLUME[name]
    players.set(name, audio)
  }
  return audio
}

/** 设置 → 通用「界面音效」：关掉后所有 UI 声音静默（包括提示音） */
export function setUiSoundEnabled(on: boolean): void {
  enabled = on
}

export function playUiSound(name: SoundName): void {
  if (!enabled) return
  const audio = player(name)
  if (!audio) return
  try {
    audio.currentTime = 0
    // 浏览器拦截自动播放时静默忽略，不打断交互
    void audio.play().catch(() => {})
  } catch { /* 某些浏览器在未解锁媒体时抛错 */ }
}

export function playToastSound(): void {
  playUiSound('toast')
}

/** 会发声的可点区域：原生控件 + 本应用自绘的行 / 卡片 / 页签 */
const CLICKABLE = [
  'button', 'a[href]', 'select', 'summary',
  '[role="button"]', '[role="tab"]', '[role="treeitem"]', '[role="option"]', '[role="menuitem"]', '[role="switch"]',
  '.sb-row', '.sb-project', '.sb-settings', '.sb-brand-main',
  '.canvas-tab', '.canvas-pick-row', '.canvas-pick-new', '.canvas-reload',
  '.model-row', '.lib-card', '.ask-option', '.menu-item', '.dock-menu-item',
  '.file-crumb', '.web-nav', '.img-cell', '.msg-img',
].join(',')

/** 切换类控件走 pop 音：页签、开关、分段、chips */
const TOGGLE = '.switch, .seg-btn, .model-chip, .lib-chip, .anim-chip, .canvas-tab, .dock-tab, [role="switch"]'

export function installUiSound(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('pointerdown', e => {
    if (!enabled || e.button !== 0) return
    const target = e.target
    if (!(target instanceof Element)) return
    // 输入文字、拖拽选择不发声
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    const el = target.closest(CLICKABLE)
    if (!el) return
    if ((el as HTMLButtonElement).disabled) return
    if (el.closest('[aria-disabled="true"]')) return
    playUiSound(el.closest(TOGGLE) ? 'pop' : 'click')
  }, { capture: true, passive: true })
}
