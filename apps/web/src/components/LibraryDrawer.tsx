import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { LibraryAssetDto, LibraryFileDto } from '../types.js'

// 文档素材库抽屉 —— 统一「多文件资产」：模型快照、jar、贴图、bbmodel、任意文本文件都能塞进来。
//
// 入库方式（三选一）：
//   上传 / 拖拽 → 浏览器直接把文件发给服务端（不经过磁盘中转）
//   工作目录导入 → 填会话工作目录里的相对路径，服务端校验不越界
//   从当前画布截取 → 建模结果自动归档（会话画布的 auto 素材也在这里）
//
// 模型类资产的四种"用"法（语义严格区分）：
//   画布打开   → 在右侧画布新开一个标签预览（只读，绝不覆盖会话画布）
//   接着改    → 打开这个素材的编辑会话（没有就建），之后画布改动自动回写素材本身（不产生副本）
//   引用新会话 → 复制一份到新会话的画布上改，素材本身不动（副本迭代）
//   送入画布   → 把素材覆盖进当前会话的画布（有确认弹窗：会话画布已自动存进素材库，不丢）
//
// 非模型资产（纯 jar / 贴图 / 文本）只提供下载与预览，不参与画布。

type KindFilter = 'all' | 'model' | 'jar' | 'image' | 'file'

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'model', label: '模型' },
  { id: 'jar', label: 'jar' },
  { id: 'image', label: '图片' },
  { id: 'file', label: '文件' },
]

const KIND_ICON: Record<LibraryFileDto['kind'], string> = {
  model: '◈',
  image: '▣',
  jar: '⬢',
  archive: '⬢',
  text: '≡',
  other: '•',
}

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

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 一张卡片按能力归类：有模型算「模型」，有 jar 算「jar」，有图片/其它文件各算一类 */
function kindsOf(a: LibraryAssetDto): Set<KindFilter> {
  const set = new Set<KindFilter>()
  if (a.model || a.elementCount > 0) set.add('model')
  if (a.jar) set.add('jar')
  for (const f of a.files ?? []) {
    if (f.kind === 'image') set.add('image')
    else if (f.kind !== 'model' && f.kind !== 'jar') set.add('file')
  }
  return set
}

export function LibraryDrawer({ open, sessionId, onClose, onToast, onOpenSession, onOpenInCanvas, canvasEnabled = true }: {
  open: boolean
  sessionId: string
  onClose: () => void
  onToast: (msg: string) => void
  /** 切到某个会话（引用新会话 / 接着改之后） */
  onOpenSession: (id: string) => void
  /** 在画布新标签打开素材（只读预览，不覆盖会话画布） */
  onOpenInCanvas: (asset: LibraryAssetDto) => void
  /** 画布功能关闭时隐藏截取与模型类操作 */
  canvasEnabled?: boolean
}) {
  const [assets, setAssets] = useState<LibraryAssetDto[]>([])
  const [loading, setLoading] = useState(false)
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [filter, setFilter] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importDraft, setImportDraft] = useState('')
  /** 正在改名的素材 id + 草稿 */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  /** 正在执行动作的素材 id（防重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

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

  /** 多文件上传：首个文件建素材，其余追加进同一个素材 */
  const uploadFiles = async (picked: FileList | File[]) => {
    const list = Array.from(picked)
    if (!list.length || uploading) return
    setUploading(true)
    try {
      let asset = (await api.uploadLibrary(list[0], { sessionId })).asset
      for (const f of list.slice(1)) {
        asset = (await api.appendLibraryFile(asset.id, f)).asset
      }
      await reload()
      onToast(`已入库「${asset.name}」（${asset.files.length} 个文件）`)
    } catch (e: any) {
      onToast(`上传失败：${e.message}`)
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  /** 从会话工作目录导入（相对 cwd 的路径，逗号/换行分隔） */
  const doImport = async () => {
    const paths = importDraft.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
    if (!paths.length) {
      onToast('请填写工作目录下的文件路径')
      return
    }
    try {
      const r = await api.importLibraryFromCwd(sessionId, paths)
      setImporting(false)
      setImportDraft('')
      await reload()
      onToast(`已从工作目录导入「${r.asset.name}」（${r.asset.files.length} 个文件）`)
    } catch (e: any) {
      onToast(`导入失败：${e.message}`)
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
    // 覆盖是破坏性动作：明确确认（会话画布有自动入库兜底，但用户当前上下文可能没保存）
    if (!window.confirm(`「送入画布」会覆盖当前会话画布的内容。\n会话模型已在素材库自动存档（auto），但如果刚才的改动还没入库，请先「从当前画布截取」。\n\n确定覆盖？`)) return
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

  const q = query.trim().toLowerCase()
  const visible = assets.filter(a => {
    if (filter !== 'all' && !kindsOf(a).has(filter)) return false
    if (!q) return true
    if (a.name.toLowerCase().includes(q)) return true
    return (a.files ?? []).some(f => f.name.toLowerCase().includes(q))
  })

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer lib-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="drawer-title">文档素材库</span>
          <button className="sb-icon-btn" title="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="lib-searchrow">
          <input
            className="lib-search"
            placeholder="搜索素材或文件名…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button
            className="dialog-btn primary lib-upload"
            disabled={uploading}
            title="上传 jar / 模型 / 贴图 / 文本，可多选"
            onClick={() => fileInput.current?.click()}
          >{uploading ? '上传中…' : '＋ 上传'}</button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={e => { if (e.target.files) void uploadFiles(e.target.files) }}
          />
        </div>

        <div className="lib-filters">
          {FILTERS.map(f => (
            <button
              key={f.id}
              className={`lib-chip ${filter === f.id ? 'on' : ''}`}
              onClick={() => setFilter(f.id)}
            >{f.label}</button>
          ))}
          <span className="lib-filters-gap" />
          <button className="lib-chip" onClick={() => setImporting(v => !v)}>从工作目录导入</button>
        </div>

        {importing && (
          <div className="lib-importrow">
            <textarea
              className="lib-import"
              autoFocus
              placeholder="工作目录下的相对路径（多个用逗号或换行分隔），例如 build/libs/mymod.jar"
              value={importDraft}
              onChange={e => setImportDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setImporting(false); setImportDraft('') }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doImport() }
              }}
            />
            <button className="dialog-btn primary" onClick={() => void doImport()}>导入</button>
            <button className="dialog-btn" onClick={() => { setImporting(false); setImportDraft('') }}>取消</button>
          </div>
        )}

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
          ) : canvasEnabled ? (
            <button className="dialog-btn primary lib-capture" onClick={() => setNaming(true)}>
              + 从当前画布截取
            </button>
          ) : null}
        </div>

        <div
          className={`lib-drop ${dragging ? 'dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={e => {
            // 只在真正离开整个区域时收起高亮（子元素间移动不算）
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files)
          }}
        >
          {dragging && <div className="lib-drop-hint">松开鼠标，把文件加入素材库</div>}

          {loading && <div className="lib-hint">读取中…</div>}
          {!loading && visible.length === 0 && (
            <div className="lib-hint">
              {assets.length === 0 ? (
                <>
                  还没有素材。把 jar / 模型 / 贴图直接拖进这块区域，或点右上角「上传」；
                  也可以让建模子代理做出造型后点「从当前画布截取」，几何与贴图会一起归档。<br />
                  以后要改：<b>接着改</b> 就在这个素材上迭代（自动存回），<b>引用新会话</b> 则复制一份出去改。
                </>
              ) : (
                <>没有匹配的素材（换个类型或清空搜索）。</>
              )}
            </div>
          )}

          <div className="lib-grid">
            {visible.map(a => {
              const model = !!a.model || a.elementCount > 0
              const shownFiles = (a.files ?? []).slice(0, 4)
              return (
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
                      <span className="lib-thumb-empty">{a.jar ? `⬢ ${fmtSize(a.jar.size)}` : '无预览'}</span>
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
                      {model
                        ? <>v{a.version ?? 1} · {a.elementCount} 元素 · {a.resolution.width}×{a.resolution.height}</>
                        : <>{(a.files ?? []).length} 个文件 · {fmtSize((a.files ?? []).reduce((s, f) => s + f.size, 0))}</>}
                    </div>
                    <div className="lib-sub lib-sub-dim">
                      {fmtAgo(a.updatedAt ?? a.createdAt)}
                      {a.source?.provider === 'upload' ? ' · 上传' : a.source?.provider === 'cwd' ? ' · 目录导入' : ''}
                    </div>
                  </div>

                  {shownFiles.length > 0 && (
                    <div className="lib-files">
                      {shownFiles.map(f => {
                        const inline = f.kind === 'image' || (f.kind === 'text' && !/\.(html?)$/i.test(f.name))
                        return (
                          <a
                            key={f.id}
                            className="lib-file"
                            href={api.libraryFileUrl(a.id, f.id, !inline)}
                            {...(inline ? { target: '_blank', rel: 'noreferrer' } : { download: f.name })}
                            title={`${f.name}（${fmtSize(f.size)}）`}
                          >
                            <span className="lib-file-icon">{KIND_ICON[f.kind]}</span>
                            <span className="lib-file-name">{f.name}</span>
                            <span className="lib-file-size">{fmtSize(f.size)}</span>
                          </a>
                        )
                      })}
                      {(a.files?.length ?? 0) > shownFiles.length && (
                        <div className="lib-file-more">还有 {a.files.length - shownFiles.length} 个文件…</div>
                      )}
                    </div>
                  )}

                  {model && canvasEnabled && (
                    <>
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
                          title="在右侧画布新开一个标签预览（只读，不覆盖会话画布）"
                          onClick={() => onOpenInCanvas(a)}
                        >画布打开</button>
                        <button
                          className="lib-btn"
                          disabled={busyId === a.id}
                          title="把素材覆盖进当前会话的画布（会弹确认）"
                          onClick={() => void apply(a)}
                        >送入画布</button>
                        <button className="lib-btn danger" onClick={() => void remove(a)}>删除</button>
                      </div>
                    </>
                  )}

                  <div className="lib-actions">
                    {a.jar && (
                      <a
                        className="lib-btn lib-jar"
                        href={a.jar.fileId ? api.libraryFileUrl(a.id, a.jar.fileId, true) : api.libraryJarUrl(a.id)}
                        download={a.jar.name}
                        title={`下载 ${a.jar.name}（${fmtSize(a.jar.size)}）`}
                      >下载 jar</a>
                    )}
                    {!model || !canvasEnabled ? (
                      <button className="lib-btn danger" onClick={() => void remove(a)}>删除</button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </aside>
    </>
  )
}
