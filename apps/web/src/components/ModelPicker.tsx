import { useRef } from 'react'
import type { ModelInfoDto } from '../types.js'

/** 思考强度档位的显示名（端点可能返回任意档位，未命中时显示原值） */
const THINK_LABEL: Record<string, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

/**
 * 模型切换浮层：锚定在输入框右上角（不铺暗色遮罩），
 * 结构参考现代模型选择器，外观沿用 MC 像素边框/凹槽。
 */
export function ModelPicker(props: {
  models: ModelInfoDto[]
  currentModelId: string
  reasoningEffort: string
  onPick: (id: string) => void
  onPickReasoningEffort: (v: string) => void
  onClose: () => void
}) {
  const current = props.models.find(m => m.id === props.currentModelId)
  const efforts = current?.reasoningEfforts ?? []
  // 未显式选择时，滑杆停在端点声明的默认档位；没有默认就停第一档
  const activeEffort = props.reasoningEffort || current?.reasoningDefault || efforts[0] || ''
  const activeIndex = Math.max(0, efforts.indexOf(activeEffort))
  const pct = efforts.length > 1 ? (activeIndex / (efforts.length - 1)) * 100 : 100
  const trackRef = useRef<HTMLDivElement>(null)

  /** 点击/拖动滑杆：按位置取最近的档位 */
  const pickAt = (clientX: number) => {
    const el = trackRef.current
    if (!el || efforts.length === 0) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const idx = Math.round(ratio * (efforts.length - 1))
    props.onPickReasoningEffort(efforts[idx])
  }

  return (
    <>
      <div className="picker-backdrop" onClick={props.onClose} />
      <div className="picker-pop">
        <div className="modal picker" onClick={e => e.stopPropagation()}>
          <div className="picker-provider">
            <span className="picker-provider-icon" aria-hidden="true" />
            <span className="picker-provider-name">
              {current?.providerName ?? current?.providerRoute ?? '未配置供应商'}
            </span>
            <span className="picker-api-badge">API</span>
            <button type="button" className="picker-close" onClick={props.onClose} title="关闭">×</button>
          </div>

          <div className="picker-section-title">模型</div>
          <div className="picker-models">
            {props.models.length === 0 && (
              <div className="picker-empty">未配置供应商（设置 → 模型 中添加）</div>
            )}
            {props.models.map(m => (
              <button
                key={m.id}
                type="button"
                className={`picker-model ${m.id === props.currentModelId ? 'selected' : ''} ${m.disabled ? 'disabled' : ''}`}
                onClick={() => !m.disabled && props.onPick(m.id)}
                disabled={m.disabled}
              >
                <span className="picker-model-name">{m.displayName}</span>
                {m.providerRoute !== current?.providerRoute && (
                  <span className="picker-model-provider">{m.providerName ?? m.providerRoute}</span>
                )}
                {m.vision && <span className="picker-model-vision">视觉</span>}
                {m.disabled
                  ? <span className="picker-model-need">{m.disabledReason}</span>
                  : m.id === props.currentModelId ? <span className="picker-check">✓</span> : null}
              </button>
            ))}
          </div>

          {efforts.length > 0 && (
            <div className="think-card">
              <div className="think-head">
                <span>思考强度</span>
                <span className="think-value">{THINK_LABEL[activeEffort] ?? activeEffort}</span>
                <button
                  type="button"
                  className="think-default"
                  title="使用端点默认档位（不发送 reasoning_effort）"
                  onClick={() => props.onPickReasoningEffort('')}
                >默认</button>
              </div>
              <div
                ref={trackRef}
                className="think-slider"
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pickAt(e.clientX) }}
                onPointerMove={e => { if (e.buttons === 1) pickAt(e.clientX) }}
              >
                <span className="think-track" />
                {efforts.map((e, i) => (
                  <span
                    key={e}
                    className={`think-tick ${i <= activeIndex ? 'on' : ''}`}
                    style={{ left: `${efforts.length > 1 ? (i / (efforts.length - 1)) * 100 : 100}%` }}
                  />
                ))}
                <span className="think-thumb" style={{ left: `${pct}%` }} />
              </div>
              <div className="think-levels">
                {efforts.map(e => <span key={e}>{THINK_LABEL[e] ?? e}</span>)}
              </div>
            </div>
          )}

          <button type="button" className="picker-done" onClick={props.onClose}>选择模型</button>
        </div>
      </div>
    </>
  )
}
