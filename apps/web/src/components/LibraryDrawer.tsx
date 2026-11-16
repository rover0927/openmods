import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import type { LibraryAssetDto } from '../types.js'

// 文档素材库抽屉 —— 从建模画布截取快照归档（几何 + 分组 + 贴图 + 动画）。
//
// 一张卡片的三种"用"法（语义严格区分）：
//   接着改    → 打开这个素材的编辑会话（没有就建），之后画布改动自动回写素材本身（不产生副本）
//   引用新会话 → 复制一份到新会话的画布上改，素材本身不动（副本迭代）
//   送入画布   → 把素材覆盖进当前会话的画布（拼装到别的工程里）
//
// 只做手动归档：不会自动保存每次建模结果，避免目录里堆满中间态。

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间：素材被就地改过后，"多久之前改的"比创建时间更有信息量 */
function fmtAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚更新'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前更新`
  return `${fmtTime(ts)} 更新`
}

export function LibraryDrawer({ open, sessionId, onClose, onToast, onOpenSession }: {
  open: boolean
  sessionId: string
  onClose: () => void
  onToast: (msg: string) => void
  /** 切到某个会话（引用新会话 / 接着改之后） */
  onOpenSession: (id: string) => void
}) {
  const [assets, setAssets] = useState<LibraryAssetDto[]>([])
  const [loading, setLoading] = useState(false)
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  /** 正在改名的素材 id + 草稿 */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  /** 正在执行动作的素材 id（防重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await api.library()
      setAssets(r.assets)
    } catch (e: any) {
      if (!silent) onToast(`读取素材库失败：${e.message}`)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  // 打开期间轮询：素材可能正被编辑会话回写（版本号/缩略图变了要看到）
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => void reload(true), 4000)
    return () => clearInterval(timer)
  }, [open, reload])

  if (!open) return null

  const capture = async () => {
    try {
      const r = await api.captureLibrary(sessionId, draftName.trim() || undefined)
      setNaming(false)
      setDraftName('')
      await reload()
      onToast(`已归档素材「${r.asset.name}」（${r.asset.elementCount} 个元素）`)
    } catch (e: any) {
      onToast(`截取失败：${e.message}`)
    }
  }

  /** 接着改：进这个素材的编辑会话，改动自动回写素材 */
  const edit = async (a: LibraryAssetDto) => {
    if (busyId) return
    setBusyId(a.id)
    try {
      const r = await api.editLibrary(a.id, sessionId)
      onToast(r.created
        ? `已为素材「${a.name}」建好编辑会话：之后画布改动会自动存回这个素材`
        : `继续改「${a.name}」：画布改动会自动存回这个素材`)
      onOpenSession(r.sessionId)
    } catch (e: any) {
      onToast(`打开失败：${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  /** 引用到新会话：复制一份，素材本身不动 */
  const fork = async (a: LibraryAssetDto) => {
    if (busyId) return
    setBusyId(a.id)
    try {
      const r = await api.forkLibrary(a.id, sessionId)
      onToast(`已引用「${a.name}」到新会话（画布已带上素材），直接说要怎么改`)
      onOpenSession(r.sessionId)
    } catch (e: any) {
      onToast(`引用失败：${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  const apply = async (a: LibraryAssetDto) => {
    if (busyId) return
    setBusyId(a.id)
    try {
      const r = await api.applyLibrary(a.id, sessionId)
      onToast(`已把「${a.name}」送进画布（${r.elementCount} 个元素）`)
    } catch (e: any) {
      onToast(`送入失败：${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (a: LibraryAssetDto) => {
    try {
      await api.deleteLibrary(a.id)
      await reload()
      onToast(`已删除「${a.name}」（编辑会话保留，只是不再自动回写）`)
    } catch (e: any) {
      onToast(`删除失败：${e.message}`)
    }
  }

  const commitRename = async () => {
    if (!renaming) return
    const { id, name } = renaming
    setRenaming(null)
    if (!name.trim()) return
    try {
      await api.renameLibrary(id, name.trim())
      await reload()
    } catch (e: any) {
      onToast(`改名失败：${e.message}`)
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer lib-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="drawer-title">文档素材库</span>
          <button className="sb-icon-btn" title="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="lib-toolbar">
          {naming ? (
            <>
              <input
                className="sb-rename"
                autoFocus
                placeholder="素材名（可留空）"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void capture()
                  if (e.key === 'Escape') { setNaming(false); setDraftName('') }
                }}
              />
              <button className="dialog-btn primary" onClick={() => void capture()}>截取</button>
              <button className="dialog-btn" onClick={() => { setNaming(false); setDraftName('') }}>取消</button>
            </>
          ) : (
            <button className="dialog-btn primary lib-capture" onClick={() => setNaming(true)}>
              + 从当前画布截取
            </button>
          )}
        </div>

        {loading && <div className="lib-hint">读取中…</div>}
        {!loading && assets.length === 0 && (
          <div className="lib-hint">
            还没有素材。让建模子代理在当前画布做出造型后，点上面的「从当前画布截取」，
            几何、分组与贴图会一起归档。<br />
            以后要改：<b>接着改</b> 就在这个素材上迭代（自动存回），<b>引用新会话</b> 则复制一份出去改。
          </div>
        )}

        <div className="lib-grid">
          {assets.map(a => (
            <div className={`lib-card ${a.editingSessionId ? 'editing' : ''}`} key={a.id}>
              <div className="lib-thumb">
                {/* 多色模型：调色板拼图比"首张贴图"（往往只是一块底色）更有辨识度 */}
                {(a.palette?.length ?? 0) >= 2 ? (
                  <span className="lib-swatch" title={`配色：${a.palette!.slice(0, 8).map(c => `#${c}`).join(' ')}`}>
                    {a.palette!.slice(0, 8).map(c => (
                      <i key={c} style={{ background: `#${c}` }} />
                    ))}
                  </span>
                ) : a.hasThumb ? (
                  <img src={api.libraryThumb(a.id, a.updatedAt ?? a.createdAt)} alt={a.name} loading="lazy" />
                ) : (
                  <span className="lib-thumb-empty">无贴图</span>
                )}
                {a.editingSessionId && (
                  <button
                    className="lib-live"
                    title="这个素材有编辑会话，改动会自动存回；点这里直接回到那个会话"
                    onClick={() => onOpenSession(a.editingSessionId!)}
                  >
                    <span className="lib-live-dot" />编辑中
                  </button>
                )}
              </div>
              <div className="lib-meta">
                {renaming?.id === a.id ? (
                  <input
                    className="sb-rename lib-rename"
                    autoFocus
                    value={renaming.name}
                    onChange={e => setRenaming({ id: a.id, name: e.target.value })}
                    onBlur={() => void commitRename()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void commitRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <div
                    className="lib-name"
                    title={`${a.name}\n双击改名`}
                    onDoubleClick={() => setRenaming({ id: a.id, name: a.name })}
                  >
                    {a.name}
                  </div>
                )}
                <div className="lib-sub">
                  v{a.version ?? 1} · {a.elementCount} 元素 · {a.resolution.width}×{a.resolution.height}
                </div>
                <div className="lib-sub lib-sub-dim">{fmtAgo(a.updatedAt ?? a.createdAt)}</div>
              </div>
              <div className="lib-actions">
                <button
                  className="lib-btn primary"
                  disabled={busyId === a.id}
                  title="打开这个素材的编辑会话：之后画布改动自动存回这个素材（不产生副本）"
                  onClick={() => void edit(a)}
                >接着改</button>
                <button
                  className="lib-btn"
                  disabled={busyId === a.id}
                  title="复制一份到新会话里改，素材本身不变"
                  onClick={() => void fork(a)}
                >引用新会话</button>
              </div>
              <div className="lib-actions">
                <button
                  className="lib-btn"
                  disabled={busyId === a.id}
                  title="把素材覆盖进当前会话的画布"
                  onClick={() => void apply(a)}
                >送入画布</button>
                <button className="lib-btn danger" onClick={() => void remove(a)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}
