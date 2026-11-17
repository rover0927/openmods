/** 关于 openmods 的内容（弹窗与设置页共用） */
export function AboutContent({ onToast }: { onToast: (msg: string) => void }) {
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      onToast(`已复制${label}：${text}`)
    } catch {
      onToast('复制失败，请手动选择文本')
    }
  }

  return (
    <>
      <p className="about-desc">Minecraft AI 建模 / Forge 模组开发工作台。</p>
      <div className="about-meta">
        版本 0.1.0 · MIT License · 画布基于 Blockbench 5.2.2（GPL-3.0）
      </div>

      <div className="about-contact">
        <div className="about-row">
          <span className="about-label">交流群聊</span>
          <b className="about-value">791661444</b>
          <button className="lib-chip" onClick={() => void copy('791661444', '群号')}>复制</button>
        </div>
        <div className="about-row">
          <span className="about-label">个人 QQ</span>
          <a className="about-value" href="mailto:1967702661@qq.com">1967702661@qq.com</a>
          <button className="lib-chip" onClick={() => void copy('1967702661@qq.com', 'QQ 邮箱')}>复制</button>
        </div>
      </div>

      <div className="about-links">
        <a href="https://github.com/rover0927/openmods" target="_blank" rel="noreferrer">GitHub 仓库</a>
        <a href="https://github.com/rover0927/openmods/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT 协议</a>
      </div>
    </>
  )
}

/** 关于 openmods：版本、仓库、交流群与个人联系方式 */
export function AboutDialog({ open, onClose, onToast }: {
  open: boolean
  onClose: () => void
  onToast: (msg: string) => void
}) {
  if (!open) return null

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog about-dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-title-row">
          <div className="dialog-title">关于 openmods</div>
          <button className="dialog-x" title="关闭" onClick={onClose}>×</button>
        </div>

        <div className="dialog-body about-body">
          <AboutContent onToast={onToast} />
        </div>

        <div className="dialog-actions">
          <button className="dialog-btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
