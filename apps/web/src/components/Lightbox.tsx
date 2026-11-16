// 图片灯箱（消息列表与右侧「图片」标签共用）：← → 翻页、⤢ 新窗口、✕ / Esc 关闭
import { useEffect } from 'react'
import type { SessionImageDto } from '../types.js'

export function Lightbox(props: {
  images: SessionImageDto[]
  /** 当前索引；null 表示关闭 */
  at: number | null
  onAt: (next: number | null) => void
}) {
  const { images, at } = props

  useEffect(() => {
    if (at === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onAt(null)
      if (e.key === 'ArrowRight') props.onAt(Math.min(images.length - 1, at + 1))
      if (e.key === 'ArrowLeft') props.onAt(Math.max(0, at - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [at, images.length, props])

  const current = at === null ? null : images[at]
  if (!current || at === null) return null

  return (
    <div className="lightbox" onClick={() => props.onAt(null)}>
      <div className="lightbox-body" onClick={e => e.stopPropagation()}>
        <img src={current.src} alt={current.name ?? '参考图'} />
        <div className="lightbox-bar">
          <button className="lightbox-btn" disabled={at === 0} onClick={() => props.onAt(Math.max(0, at - 1))}>‹</button>
          <span className="lightbox-meta">
            {at + 1} / {images.length}
            {current.name ? ` · ${current.name}` : ''}
          </span>
          <button
            className="lightbox-btn" disabled={at === images.length - 1}
            onClick={() => props.onAt(Math.min(images.length - 1, at + 1))}
          >›</button>
          <a className="lightbox-btn" href={current.src} target="_blank" rel="noreferrer" title="新窗口打开">⤢</a>
          <button className="lightbox-btn" onClick={() => props.onAt(null)} title="关闭">✕</button>
        </div>
      </div>
    </div>
  )
}
