// 上下文占用meter（逐像素复刻 dsh ui-conversation `ContextMeter`）：
//   环 + 百分比常驻在 composer dock 里；点一下弹出面板——
//   header 一句话读数 + `~已用 / 窗口`，横向分段条，下面三行图例（系统提示词 / 工具定义 / 对话）。
// 面板的段长只按 breakdown **比例**分配，总长仍用 provider 锚定的占用百分比（dsh 同款取舍，
// 这样图与数字不会打架：分项是启发式估算，总量是模型自己报的）。
import { useEffect, useRef, useState } from 'react'
import type { ContextBreakdownDto } from '../types.js'

/** 环几何：14px viewBox、2px 描边（dsh RADIUS/CIRCUMFERENCE） */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const PANEL_W = 264

/** 紧凑 token 数：1.2k / 12.3k / 123k / 1.0M / 12M（dsh `number.thousand|million` 语义） */
function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

/** 图例行：顺序 = 分段条从左到右（dsh ROWS） */
const ROWS = [
  { key: 'systemTokens', label: '系统提示词', cls: 'cm-system' },
  { key: 'toolsTokens', label: '工具定义', cls: 'cm-tools' },
  { key: 'messageTokens', label: '对话', cls: 'cm-messages' },
] as const

export function ContextMeter(props: {
  usedTokens: number | null
  contextWindow: number | null
  breakdown: ContextBreakdownDto | null
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  /** 面板贴住环的上方；窗口尺寸变化时重算，避免 fixed 定位漂到屏幕外 */
  const place = () => {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - PANEL_W - 12))
    setPos({ left, bottom: Math.max(12, window.innerHeight - r.top + 8) })
  }

  // 关闭条件与 dsh 一致：面板外按下指针、Esc
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
    }
  }, [open])

  const used = props.usedTokens ?? 0
  const win = props.contextWindow ?? 0
  const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : null
  const bd = props.breakdown
  const bdTotal = bd ? bd.systemTokens + bd.toolsTokens + bd.messageTokens : 0

  const toggle = () => {
    // 贴在按钮上方生长；composer dock 在底部，永远有空间
    place()
    setOpen(o => !o)
  }

  // 分段条：有 breakdown 就按比例拆三段，否则退回一条总量（dsh 同款降级）
  const segments = bd && bdTotal > 0
    ? ROWS.map(row => ({ cls: row.cls, width: (pct ?? 0) * bd[row.key] / bdTotal })).filter(s => s.width > 0)
    : [{ cls: '', width: pct ?? 0 }]

  return (
    <span ref={rootRef} className="ctx-meter-root">
      <button
        type="button"
        className={`pill ring-pill ctx-meter ${open ? 'open' : ''}`}
        title={`上下文占用 ${fmtTok(used)} / ${fmtTok(win)} tokens${pct !== null ? `（${pct}%）` : ''}`}
        aria-label={`上下文已用 ${pct ?? 0}%`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="cm-track" cx="7" cy="7" r={RADIUS} fill="none" strokeWidth="2" />
          <circle
            className="cm-fill" cx="7" cy="7" r={RADIUS} fill="none" strokeWidth="2" strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * (pct ?? 0)) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span>{pct !== null ? `${pct}%` : '—'}</span>
        <span className="ctx-meter-tok">{fmtTok(used)} tok</span>
      </button>

      {open && pos && (
        <div
          className="cm-panel"
          style={{ left: pos.left, bottom: pos.bottom }}
          role="dialog"
          aria-label={`上下文已用 ${pct ?? 0}%`}
        >
          <div className="cm-head">
            <span className="cm-lead">上下文已用</span>
            <span className="cm-pct">{pct !== null ? `${pct}%` : '—'}</span>
            <span className="cm-fig">{`~${fmtTok(used)} / ${fmtTok(win)}`}</span>
          </div>
          <div className="cm-bar">
            {segments.map((s, i) => (
              <div key={i} className={`cm-seg ${s.cls}`} style={{ width: `${s.width}%` }} />
            ))}
          </div>
          {bd && bdTotal > 0 && (
            <dl className="cm-rows">
              {ROWS.map(row => (
                <div key={row.key} className="cm-row">
                  <dt><span className={`cm-swatch ${row.cls}`} aria-hidden="true" />{row.label}</dt>
                  <dd>{`~${fmtTok(bd[row.key])}`}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </span>
  )
}
