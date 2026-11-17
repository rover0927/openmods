import type { CSSProperties } from 'react'

/**
 * 左上角品牌方块（草方块）。
 * DOM 契约沿用 minecraft-pixel-ui：mc-stage > mc-iso-tilt > mc-cube > 六面。
 * 视角倾斜固定在 iso-tilt 层，旋转动画只作用在 cube 层；
 * 悬停/聚焦由外层 `.sb-brand-main` 触发（见 mc-theme.css）。
 */
export function GrassCube(props: { size?: number }) {
  const style = { '--mc-size': `${props.size ?? 24}px` } as CSSProperties
  return (
    <span className="mc-stage mc-brand-cube" style={style} aria-hidden="true">
      <span className="mc-iso-tilt">
        <span className="mc-cube">
          <span className="face top" />
          <span className="face front" />
          <span className="face right" />
          <span className="face back" />
          <span className="face left" />
          <span className="face bottom" />
        </span>
      </span>
    </span>
  )
}
