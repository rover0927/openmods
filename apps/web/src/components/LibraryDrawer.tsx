import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type {
  LibraryAssetDto, LibraryAssetKind, LibraryFileDto, LibraryJarItemDto, McTestJarSelectionDto, McTestStatusDto,
} from '../types.js'

// 文档素材库抽屉 —— 模型 / Jar / 图片 / 文件四类互相独立。
//
// 模型：画布打开 / 接着改 / 引用新会话 / 送入画布（不混 jar）
// Jar：素材库归档 + 工程 build/libs 扫描，多选后由独立 Forge 生产测试客户端启动
// 图片 / 文件：归档、预览、下载
//
// 入库：上传 / 拖拽 / 工作目录导入 / 从当前画布截取。每个 jar 单独成资产。

type LibTab = LibraryAssetKind

const TABS: { id: LibTab; label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'jar', label: 'Jar 构建' },
  { id: 'image', label: '图片' },
  { id: 'file', label: '文件' },
]

const PHASE_LABEL: Record<McTestStatusDto['phase'], string> = {
  idle: '未启动',
  installing: '准备中…',
  starting: '启动中…',
  running: '运行中',
  exited: '已退出',
  error: '失败',
}

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

function jarKey(j: LibraryJarItemDto): string {
  return j.source === 'library' ? `asset:${j.assetId}:${j.fileId ?? ''}` : `build:${j.path ?? j.name}`
}

export function LibraryDrawer({ open, sessionId, testStatus, onRefreshTestStatus, onClose, onToast, onOpenSession, onOpenInCanvas, canvasEnabled = true }: {
  open: boolean
  sessionId: string
  /** 统一测试启动器状态（App 全局持有，底部悬浮进度条共用） */
  testStatus: McTestStatusDto | null
  onRefreshTestStatus: () => void
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
  const [tab, setTab] = useState<LibTab>('model')
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importDraft, setImportDraft] = useState('')
  /** 正在改名的素材 id + 草稿 */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  /** 正在执行动作的素材 id（防重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [jarItems, setJarItems] = useState<LibraryJarItemDto[]>([])
  const [jarLoading, setJarLoading] = useState(false)
  const [selectedJars, setSelectedJars] = useState<Set<string>>(new Set())
  const [showLog, setShowLog] = useState(false)
  const [archiving, setArchiving] = useState<string | null>(null)
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

  const reloadJars = useCallback(async (silent = false) => {
    if (!silent) setJarLoading(true)
    try {
      const r = await api.libraryJars(sessionId)
      setJarItems(r.jars)
    } catch (e: any) {
      if (!silent) onToast(`读取 jar 列表失败：${e.message}`)
    } finally {
      if (!silent) setJarLoading(false)
    }
  }, [sessionId, onToast])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  // 打开期间轮询：素材可能正被编辑会话回写
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => void reload(true), 4000)
    return () => clearInterval(timer)
  }, [open, reload])

  // Jar 构建列表：切到 Jar 页时刷新，并定时发现新的 build 产物
  useEffect(() => {
    if (!open || tab !== 'jar') return
    void reloadJars()
    const timer = setInterval(() => void reloadJars(true), 6000)
    return () => clearInterval(timer)
  }, [open, tab, reloadJars])

  // 列表刷新后剔除已不存在的选择（归档/删除/构建被清理）
  useEffect(() => {
    const valid = new Set(jarItems.map(jarKey))
    setSelectedJars(prev => {
      const next = new Set([...prev].filter(k => valid.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [jarItems])

  if (!open) return null

  const phase = testStatus?.phase ?? 'idle'
  const busyPhase = phase === 'installing' || phase === 'starting'
  const q = query.trim().toLowerCase()
  const matchQuery = (a: LibraryAssetDto) => !q
    || a.name.toLowerCase().includes(q)
    || (a.files ?? []).some(f => f.name.toLowerCase().includes(q))
  const visibleAssets = assets.filter(a => a.kind === tab && matchQuery(a))
  const visibleJars = jarItems.filter(j => !q
    || j.name.toLowerCase().includes(q)
    || (j.project ?? '').toLowerCase().includes(q))
  const counts: Record<LibTab, number> = {
    model: assets.filter(a => a.kind === 'model').length,
    jar: jarItems.length,
    image: assets.filter(a => a.kind === 'image').length,
    file: assets.filter(a => a.kind === 'file').length,
  }
  const selectedCount = selectedJars.size

  const capture = async () => {
    try {
      const r = await api.captureLibrary(sessionId, draftName.trim() || undefined)
      setNaming(false)
      setDraftName('')
      await reload()
      void reloadJars(true)
      onToast(`已归档模型「${r.asset.name}」${r.jarAsset ? `；同时归档 jar「${r.jarAsset.name}」` : ''}`)
    } catch (e: any) {
      onToast(`截取失败：${e.message}`)
    }
  }

  /** 每个文件单独入库：jar 不再和模型混在同一个资产里 */
  const uploadFiles = async (picked: FileList | File[]) => {
    const list = Array.from(picked)
    if (!list.length || uploading) return
    setUploading(true)
    try {
      for (const f of list) await api.uploadLibrary(f, { sessionId })
      await reload()
      if (list.some(f => /\.jar$/i.test(f.name))) {
        setTab('jar')
        void reloadJars()
      }
      onToast(`已入库 ${list.length} 个文件`)
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
      const count = r.assets?.length ?? 1
      setImporting(false)
      setImportDraft('')
      await reload()
      if (r.assets?.some(a => a.kind === 'jar')) {
        setTab('jar')
        void reloadJars()
      }
      onToast(`已从工作目录导入 ${count} 个素材`)
    } catch (e: any) {
      onToast(`导入失败：${e.message}`)
    }
  }

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

  const removeAsset = async (id: string, name: string) => {
    try {
      await api.deleteLibrary(id)
      await reload()
      void reloadJars(true)
      onToast(`已删除「${name}」`)
    } catch (e: any) {
      onToast(`删除失败：${e.message}`)
    }
  }

  const remove = (a: LibraryAssetDto) => removeAsset(a.id, a.name)

  const archiveJar = async (j: LibraryJarItemDto) => {
    if (j.source !== 'build' || !j.path) return
    setArchiving(j.path)
    try {
      const r = await api.archiveLibraryJar(sessionId, j.path)
      await reload()
      await reloadJars(true)
      onToast(`已归档「${r.asset.name}」`)
    } catch (e: any) {
      onToast(`归档失败：${e.message}`)
    } finally {
      setArchiving(null)
    }
  }

  const toggleJar = (key: string) => {
    setSelectedJars(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAllJars = () => setSelectedJars(new Set(visibleJars.map(jarKey)))
  const clearJars = () => setSelectedJars(new Set())

  const startTest = async () => {
    const items = jarItems.filter(j => selectedJars.has(jarKey(j)))
    if (!items.length) {
      onToast('先勾选要测试的 jar')
      return
    }
    const jars: McTestJarSelectionDto[] = items.map(j => j.source === 'library'
      ? { source: 'library', assetId: j.assetId, fileId: j.fileId, name: j.name }
      : { source: 'build', path: j.path, name: j.name })
    try {
      await api.mcTestRun(jars, sessionId)
      setShowLog(true)
      onToast(`正在准备测试客户端（${jars.length} 个 jar）…`)
      onRefreshTestStatus()
      setTimeout(onRefreshTestStatus, 800)
    } catch (e: any) {
      onToast(`启动失败：${e.message}`)
    }
  }

  const stopTest = async () => {
    try {
      const r = await api.mcTestStop()
      onToast(r.stopped ? '已停止测试客户端' : '测试客户端没有在运行')
      onRefreshTestStatus()
    } catch (e: any) {
      onToast(`停止失败：${e.message}`)
    }
  }

  /** 复制日志路径（目录/文件），方便用户去资源管理器查看 */
  const copyPath = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      onToast(`已复制：${text}`)
    } catch {
      onToast('复制失败，请手动选择路径')
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

  const renderAssetCard = (a: LibraryAssetDto) => {
    const model = a.kind === 'model'
    const shownFiles = (a.files ?? []).filter(f => f.kind !== 'jar').slice(0, 4)
    const firstImage = (a.files ?? []).find(f => f.kind === 'image')
    return (
      <div className={`lib-card ${a.editingSessionId ? 'editing' : ''}`} key={a.id}>
        <div className="lib-thumb">
          {model && a.hasThumb ? (
            <img src={api.libraryThumb(a.id, a.updatedAt ?? a.createdAt)} alt={a.name} loading="lazy" />
          ) : firstImage ? (
            <img src={api.libraryFileUrl(a.id, firstImage.id)} alt={a.name} loading="lazy" />
          ) : (a.palette?.length ?? 0) >= 2 ? (
            <span className="lib-swatch" title={`配色：${a.palette!.slice(0, 8).map(c => `#${c}`).join(' ')}`}>
              {a.palette!.slice(0, 8).map(c => (
                <i key={c} style={{ background: `#${c}` }} />
              ))}
            </span>
          ) : (
            <span className="lib-thumb-empty">{model ? '无预览' : `${(a.files ?? []).length} 个文件`}</span>
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
            {a.source?.provider === 'upload' ? ' · 上传' : a.source?.provider === 'cwd' ? ' · 目录导入' : a.kind === 'jar' ? ' · 构建归档' : ''}
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
        {(!model || !canvasEnabled) && (
          <div className="lib-actions">
            <button className="lib-btn danger" onClick={() => void remove(a)}>删除</button>
          </div>
        )}
      </div>
    )
  }

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
            placeholder="搜索模型 / jar / 文件名…"
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

        <div className="lib-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`lib-tab ${tab === t.id ? 'on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}<span className="lib-tab-count">{counts[t.id]}</span>
            </button>
          ))}
        </div>

        <div className="lib-toolbar">
          {tab === 'model' && canvasEnabled && (
            naming ? (
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
            )
          )}
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

        <div
          className={`lib-drop ${dragging ? 'dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files)
          }}
        >
          {dragging && <div className="lib-drop-hint">松开鼠标，把文件加入素材库</div>}

          {tab === 'jar' ? (
            <div className="lib-jar-pane">
              <div className="lib-launcher">
                <div className="lib-launcher-row">
                  <span className="lib-launcher-count">已选 {selectedCount} 个</span>
                  <button className="lib-chip" onClick={selectAllJars}>全选</button>
                  <button className="lib-chip" onClick={clearJars}>清空</button>
                  <span className={`lib-test-phase ${phase}`}>{PHASE_LABEL[phase]}</span>
                  <span className="lib-filters-gap" />
                  {phase === 'running' ? (
                    <button className="dialog-btn" onClick={() => void stopTest()}>停止</button>
                  ) : (
                    <button
                      className="dialog-btn primary"
                      disabled={!selectedCount || busyPhase}
                      onClick={() => void startTest()}
                    >{busyPhase ? '启动中…' : '启动测试游戏'}</button>
                  )}
                  <button className="lib-chip" onClick={() => setShowLog(v => !v)}>
                    {showLog ? '收起日志' : '查看日志'}
                  </button>
                  {testStatus?.runDir && (
                    <button className="lib-chip" title={testStatus.runDir} onClick={() => void copyPath(testStatus.runDir!)}>
                      日志目录
                    </button>
                  )}
                </div>
                {testStatus?.error && <div className="lib-launcher-error">{testStatus.error}</div>}
                {!!testStatus?.issues?.length && (
                  <div className="lib-launcher-error">
                    {testStatus.issues.map((it, i) => (
                      <div key={`${it.jar}-${it.modId ?? ''}-${i}`}>
                        <b>{it.jar || it.modId || '客户端'}</b>
                        {it.jar && it.modId ? `（${it.modId}）` : ''}：{it.message}
                      </div>
                    ))}
                  </div>
                )}
                {showLog && (
                  <>
                    {testStatus?.runDir && <div className="lib-hint">本次日志已归档：{testStatus.runDir}</div>}
                    {!!testStatus?.mods?.length && (
                      <div className="lib-hint">
                        模组：{testStatus.mods.map(m => `${m.modId || m.jar}（${m.state}）`).join('、')}
                      </div>
                    )}
                    <pre className="lib-log">{testStatus?.logTail || '（还没有日志）'}</pre>
                  </>
                )}
              </div>

              {jarLoading && <div className="lib-hint">读取中…</div>}
              {!jarLoading && visibleJars.length === 0 && (
                <div className="lib-hint">
                  还没有 jar 构建。跑一次 `mc_gradle build` 后，工程 build/libs 下的 jar 会自动出现在这里；
                  也可以从素材库上传 jar。
                </div>
              )}
              <div className="lib-jar-list">
                {visibleJars.map(j => {
                  const key = jarKey(j)
                  const checked = selectedJars.has(key)
                  return (
                    <div className={`lib-jar-row ${checked ? 'on' : ''}`} key={key}>
                      <label className="lib-jar-check" title="勾选后加入测试客户端">
                        <input type="checkbox" checked={checked} onChange={() => toggleJar(key)} />
                      </label>
                      <span className="lib-jar-name" title={j.name}>{j.name}</span>
                      <span className="lib-jar-src">
                        {j.source === 'library' ? '素材库' : '工程构建'}
                        {j.project ? ` · ${j.project}` : ''}
                        {j.archived ? ' · 已归档' : ''}
                      </span>
                      <span className="lib-jar-size">{fmtSize(j.size)}</span>
                      <span className="lib-jar-time">{fmtAgo(j.updatedAt ?? j.mtime ?? Date.now())}</span>
                      <span className="lib-jar-actions">
                        {j.source === 'build' && (
                          <button
                            className="lib-btn"
                            disabled={archiving === j.path}
                            title="把这个构建产物复制进素材库"
                            onClick={() => void archiveJar(j)}
                          >{archiving === j.path ? '归档中…' : '归档'}</button>
                        )}
                        {j.source === 'library' && j.assetId && j.fileId && (
                          <a
                            className="lib-btn"
                            href={api.libraryFileUrl(j.assetId, j.fileId, true)}
                            download={j.name}
                          >下载</a>
                        )}
                        {j.source === 'library' && j.assetId && (
                          <button className="lib-btn danger" onClick={() => void removeAsset(j.assetId!, j.name)}>删除</button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <>
              {loading && <div className="lib-hint">读取中…</div>}
              {!loading && visibleAssets.length === 0 && (
                <div className="lib-hint">
                  {assets.length === 0 ? (
                    <>
                      还没有素材。把 jar / 模型 / 贴图直接拖进这块区域，或点右上角「上传」；
                      也可以让子代理做出造型后点「从当前画布截取」，几何与贴图会一起归档。<br />
                      以后要改：<b>接着改</b> 就在这个素材上迭代（自动存回），<b>引用新会话</b> 则复制一份出去改。
                    </>
                  ) : (
                    <>没有匹配的{TABS.find(t => t.id === tab)?.label}素材（换个搜索词）。</>
                  )}
                </div>
              )}
              <div className="lib-grid">
                {visibleAssets.map(renderAssetCard)}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
