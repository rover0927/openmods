import { useEffect, useRef, type RefObject } from 'react'
import type { CanvasState } from '../types.js'

interface Props {
  canvas: CanvasState
  iframeRef: RefObject<HTMLIFrameElement>
  onIframeReady: () => void
}

export function CanvasPane({ canvas, iframeRef, onIframeReady }: Props) {
  const readySent = useRef(false)

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === 'bb_ready' && !readySent.current) {
        readySent.current = true
        onIframeReady()
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onIframeReady])

  return (
    <section className="canvas-pane">
      <div className="canvas-area">
        <iframe ref={iframeRef} className="bb-iframe" src="/bb/index.html" title="Blockbench 只读画布" />
        {!canvas.hasModel && (
          <div className="canvas-empty">
            <div className="canvas-empty-title">画布还是空的</div>
            <div className="canvas-empty-sub">在右边描述你想要的模型，AI 会在这里一步步做出来。</div>
          </div>
        )}
      </div>
      <div className="canvas-status">
        <span>模式: free 通用模型 ▾</span>
        <span>{canvas.elements} 个部件</span>
        <span>{canvas.textures} 张贴图</span>
        {canvas.hasModel && <span className="dim">视角: {canvas.view}</span>}
      </div>
    </section>
  )
}
