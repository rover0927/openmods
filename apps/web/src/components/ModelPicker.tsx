import type { ModelInfoDto } from '../types.js'

export function ModelPicker(props: {
  models: ModelInfoDto[]
  currentModelId: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal picker" onClick={e => e.stopPropagation()}>
        <div className="picker-head">
          <span>选择模型</span>
          <span className="dim">下一轮生效</span>
        </div>
        {props.models.length === 0 && <div className="dim" style={{ padding: 10 }}>还没有可用模型（设置 → 模型 中添加供应商）。</div>}
        {props.models.map(m => (
          <button
            key={m.id}
            className={`model-row ${m.id === props.currentModelId ? 'selected' : ''} ${m.disabled ? 'disabled' : ''}`}
            onClick={() => !m.disabled && props.onPick(m.id)}
            disabled={m.disabled}
          >
            <span className={`model-dot ${m.id === props.currentModelId ? 'green' : ''}`}>🧊</span>
            <span className="model-info">
              <span className="model-name">
                {m.displayName}
                {m.vision && <span className="vision-badge" title="支持视觉（图片）输入">👁</span>}
                {m.badge && <span className={`badge ${m.badgeType === 'peak' ? 'peak' : 'price'}`}>{m.badge}</span>}
              </span>
              <span className="model-desc dim">{m.desc}</span>
            </span>
            <span className="model-right">
              {m.disabled
                ? <span className="need-member">{m.disabledReason}</span>
                : m.id === props.currentModelId ? <span className="check">✓</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
