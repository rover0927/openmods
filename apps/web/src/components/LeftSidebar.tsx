import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import type { ArchivedView, ProjectDto, SessionSummaryDto } from '../types.js'

// 时间：复刻 dsh 的 relativeTime 分桶（刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / 月-日）
function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return '昨天'
  if (day < 7) return `${day} 天前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export interface ToastAction {
  label: string
  run: () => void
}

/** 浮层菜单/对话框的锚点（fixed 定位，避免被 .session-list 的 overflow 裁掉） */
interface Anchor {
  x: number
  y: number
}

const VIEW_LABEL: Record<ArchivedView, string> = {
  hide: '默认',
  all: '全部会话',
  only: '仅已归档',
}

/** 目录名（左栏只显示最后一段，完整路径放 title） */
function dirName(p: string): string {
  const s = String(p ?? '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

// 左栏 —— 复刻 dsh SidebarRoot + WorkspaceBrowser：会话按项目分组，未归属的进「未分组」，
// 归档是全局软删除（可筛选、可撤销），删除项目只注销分组、会话回落到未分组。
export function LeftSidebar(props: {
  sessionId: string
  /** 新建会话后 +1，触发列表重新拉取 */
  version: number
  onOpenSession: (id: string) => void
  /** projectId 为空 = 未分组 */
  onNewSession: (projectId?: string) => void
  onOpenSettings: () => void
  /** 打开文档素材库抽屉 */
  onOpenLibrary: () => void
  onToast: (msg: string, action?: ToastAction) => void
}) {
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [sessions, setSessions] = useState<SessionSummaryDto[]>([])
  const [archivedView, setArchivedView] = useState<ArchivedView>(() => {
    const stored = localStorage.getItem('openmods.archivedView')
    return stored === 'all' || stored === 'only' ? stored : 'hide'
  })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** 新建分组弹窗（dsh 新建工作区语义：名称 + 可关联本地目录） */
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newCwd, setNewCwd] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ProjectDto | null>(null)
  const [confirmArchive, setConfirmArchive] = useState<{ session: SessionSummaryDto; activity: any[] } | null>(null)
  const [rail, setRail] = useState(() => localStorage.getItem('openmods.sbRail') === '1')
  const [menu, setMenu] = useState<{ session: SessionSummaryDto; at: Anchor } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ project: ProjectDto; at: Anchor } | null>(null)
  const { onToast } = props

  const reload = useCallback(async () => {
    const [base, list] = await Promise.all([api.projects(), api.listSessions(archivedView)])
    setProjects(base.projects)
    setSessions(list.sessions)
  }, [archivedView])

  useEffect(() => {
    localStorage.setItem('openmods.archivedView', archivedView)
  }, [archivedView])

  // 收窄成 56px rail（dsh 的 collapsed 栏）：列宽由 --rail-w 驱动，App 的 grid 跟着变
  useEffect(() => {
    localStorage.setItem('openmods.sbRail', rail ? '1' : '0')
    document.documentElement.style.setProperty('--rail-w', rail ? '56px' : '240px')
  }, [rail])

  useEffect(() => {
    void reload().catch(() => { /* 服务未起时静默 */ })
  }, [reload, props.version])

  // 分组：项目内按记账顺序（sessionIds），未归属的按最近活跃排
  const groups = useMemo(() => {
    const byProject = new Map<string, SessionSummaryDto[]>()
    const ungrouped: SessionSummaryDto[] = []
    for (const s of sessions) {
      if (s.projectId) {
        if (!byProject.has(s.projectId)) byProject.set(s.projectId, [])
        byProject.get(s.projectId)!.push(s)
      } else {
        ungrouped.push(s)
      }
    }
    const ordered = projects.map(project => {
      const rows = byProject.get(project.id) ?? []
      const rank = new Map(project.sessionIds.map((id, index) => [id, index]))
      rows.sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999))
      return { project, rows }
    })
    return { ordered, ungrouped }
  }, [projects, sessions])

  const toggleGroup = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  const archive = useCallback(async (session: SessionSummaryDto) => {
    try {
      const result = await api.archiveSession(session.id)
      if ('conflict' in result) {
        setConfirmArchive({ session, activity: result.activity })
        return
      }
      await reload()
      onToast('会话已归档', { label: '撤销', run: () => { void api.unarchiveSession(session.id).then(reload) } })
    } catch (e: any) {
      onToast(`归档失败：${e.message}`)
    }
  }, [reload, onToast])

  const restore = useCallback(async (session: SessionSummaryDto) => {
    try {
      await api.unarchiveSession(session.id)
      await reload()
      onToast('已取消归档')
    } catch (e: any) {
      onToast(`取消归档失败：${e.message}`)
    }
  }, [reload, onToast])

  const stopAndArchive = useCallback(async () => {
    if (!confirmArchive) return
    const session = confirmArchive.session
    setConfirmArchive(null)
    try {
      await api.archiveSession(session.id, true)
      await reload()
      onToast('已停止并归档', { label: '撤销', run: () => { void api.unarchiveSession(session.id).then(reload) } })
    } catch (e: any) {
      onToast(`归档失败：${e.message}`)
    }
  }, [confirmArchive, reload, onToast])

  const createProject = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) return
    try {
      await api.createProject(title, newCwd || undefined)
      setNewTitle('')
      setNewCwd('')
      setCreating(false)
      await reload()
      onToast(newCwd ? `已创建分组并关联目录：${dirName(newCwd)}` : `已创建分组：${title}`)
    } catch (e: any) {
      onToast(`新建分组失败：${e.message}`)
    }
  }, [newTitle, newCwd, reload, onToast])

  const renameProject = useCallback(async () => {
    if (!renaming) return
    const title = renaming.title.trim()
    const target = renaming
    setRenaming(null)
    if (!title) return
    try {
      await api.renameProject(target.id, title)
      await reload()
    } catch (e: any) {
      onToast(`重命名失败：${e.message}`)
    }
  }, [renaming, reload, onToast])

  const deleteProject = useCallback(async () => {
    if (!confirmDelete) return
    const project = confirmDelete
    setConfirmDelete(null)
    try {
      const result = await api.deleteProject(project.id)
      await reload()
      onToast(result.movedSessionIds.length
        ? `已删除项目「${project.title}」，${result.movedSessionIds.length} 个会话移到未分组`
        : `已删除项目「${project.title}」`)
    } catch (e: any) {
      onToast(`删除项目失败：${e.message}`)
    }
  }, [confirmDelete, reload, onToast])

  const moveTo = useCallback(async (session: SessionSummaryDto, projectId?: string) => {
    setMenu(null)
    try {
      if (projectId) await api.attachSession(projectId, session.id)
      else if (session.projectId) await api.detachSession(session.projectId, session.id)
      await reload()
    } catch (e: any) {
      onToast(`移动失败：${e.message}`)
    }
  }, [reload, onToast])

  // ---- 目录选择：直接用系统原生文件夹对话框（资源管理器风格），不再自绘目录树 ----
  /** 弹出系统选择框并直接应用：会话→落会话 cwd；已有分组→setProjectCwd；新建分组→回填 newCwd */
  const pickDir = useCallback(async (
    purpose: 'session' | 'new-project',
    session?: SessionSummaryDto,
    editProjectId?: string,
    start?: string,
  ) => {
    try {
      const r = await api.pickDir(
        start || (purpose === 'session' ? session?.cwd : undefined),
        purpose === 'session' ? '绑定工作目录' : '选择关联文件夹',
      )
      if (!r.path) return // 取消
      if (purpose === 'new-project') {
        if (editProjectId) {
          await api.setProjectCwd(editProjectId, r.path)
          await reload()
          onToast(`已为该分组关联目录：${dirName(r.path)}`)
        } else {
          setNewCwd(r.path)
        }
        return
      }
      if (!session) return
      await api.setSessionCwd(session.id, r.path)
      await reload()
      onToast(`已绑定目录：${r.path}`)
    } catch (e: any) {
      onToast(`选择目录失败：${e.message}`)
    }
  }, [reload, onToast])

  const renderRow = (s: SessionSummaryDto) => {
    const archived = !!s.archived
    const selected = s.id === props.sessionId
    return (
      <div
        key={s.id}
        className={`sb-row sb-session ${selected ? 'selected' : ''} ${archived ? 'archived' : ''}`}
        role="treeitem"
        aria-selected={selected}
        onClick={() => {
          // dsh：已归档对话暂时无法查看，请取消归档后查看
          if (archived) onToast('已归档对话暂时无法查看，请取消归档后查看')
          else props.onOpenSession(s.id)
        }}
        title={`${s.title || '新会话'} · ${s.id}`}
      >
        <span className="sb-title">
          {s.libraryName && (
            <span className="sb-lib-mark" title={`素材编辑会话：${s.libraryName}（改动自动回写该素材）`}>▤</span>
          )}
          {s.title || '新会话'}
        </span>
        <span className="sb-time">{archived ? '已归档' : formatTime(s.updatedAt)}</span>
        <span className="sb-row-actions">
          <button
            className="sb-icon-btn"
            title="会话操作"
            onClick={e => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenu({ session: s, at: { x: rect.left, y: rect.bottom + 4 } })
            }}
          >⋯</button>
        </span>
      </div>
    )
  }

  const renderGroup = (key: string, title: string, rows: SessionSummaryDto[], project?: ProjectDto) => {
    const isCollapsed = !!collapsed[key]
    const renamingThis = renaming && project && renaming.id === project.id ? renaming : null
    return (
      <div className="sb-group" key={key}>
        <div className="sb-row sb-project" onClick={() => toggleGroup(key)} title={project ? project.title : '没有归入任何项目的会话'}>
          <span className="sb-slot sb-folder" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
          {renamingThis ? (
            <input
              className="sb-rename"
              autoFocus
              value={renamingThis.title}
              onClick={e => e.stopPropagation()}
              onChange={e => setRenaming({ id: renamingThis.id, title: e.target.value })}
              onBlur={renameProject}
              onKeyDown={e => {
                if (e.key === 'Enter') renameProject()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <span className="sb-title">{title}</span>
          )}
          {project && (
            <span className="sb-row-actions">
              <button
                className="sb-icon-btn"
                title="在此项目中新建会话"
                onClick={e => { e.stopPropagation(); props.onNewSession(project.id) }}
              >＋</button>
              <button
                className="sb-icon-btn"
                title="项目操作"
                onClick={e => {
                  e.stopPropagation()
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setProjectMenu({ project, at: { x: rect.left, y: rect.bottom + 4 } })
                }}
              >⋯</button>
            </span>
          )}
        </div>
        {/* 空的项目分组不用提示（有个 0 就够了）；未分组为空才值得说明 */}
        {!isCollapsed && rows.length === 0 && !project && (
          <div className="sb-hint">{archivedView === 'only' ? '暂无已归档会话' : '暂无会话'}</div>
        )}
        {!isCollapsed && rows.map(renderRow)}
      </div>
    )
  }

  return (
    <aside className={`left-sidebar ${rail ? 'rail' : ''}`}>
      <div className="sb-brand">
        <button className="sb-brand-main" onClick={() => props.onNewSession()} title="新建会话">
          <span className="sb-mark" aria-hidden="true" />
          {!rail && <span className="sb-name">openmods</span>}
        </button>
        <button className="sb-toggle" onClick={() => setRail(r => !r)} title={rail ? '展开侧栏' : '收起侧栏'}>
          {rail ? '»' : '«'}
        </button>
      </div>

      <button className="sb-new" onClick={() => props.onNewSession()} title="新建会话（⌘/Ctrl+N）">
        <span aria-hidden="true" className="sb-new-plus">＋</span>
        {!rail && <span>新会话</span>}
      </button>

      {rail ? (
        <div className="sb-rail-list">
          <button className="sb-rail-btn" title="新建分组" onClick={() => { setRail(false); setCreating(true); setNewTitle(''); setNewCwd('') }}>▣</button>
          <button className="sb-rail-btn" title="文档素材库" onClick={props.onOpenLibrary}>▤</button>
          <button className="sb-rail-btn" title="设置" onClick={props.onOpenSettings}>⚙</button>
        </div>
      ) : (
        <>
          <div className="sb-section-head">
            <span className="sb-section-title">会话</span>
            <span className="sb-section-actions">
              <button className="sb-icon-btn" title="新建分组" onClick={() => { setCreating(true); setNewTitle(''); setNewCwd('') }}>＋</button>
              <select
                className="sb-view"
                value={archivedView}
                title="视图选项"
                onChange={e => setArchivedView(e.target.value as ArchivedView)}
              >
                {(Object.keys(VIEW_LABEL) as ArchivedView[]).map(v => (
                  <option key={v} value={v}>{VIEW_LABEL[v]}</option>
                ))}
              </select>
            </span>
          </div>
          <div className="sb-scroll">
            {groups.ordered.length === 0 && groups.ungrouped.length === 0 && (
              <div className="sb-hint">{archivedView === 'only' ? '暂无已归档会话' : '还没有会话'}</div>
            )}
            {groups.ordered.map(({ project, rows }) => renderGroup(`p:${project.id}`, project.title, rows, project))}
            {renderGroup('ungrouped', '未分组', groups.ungrouped)}
          </div>
          <div className="sb-foot">
            <button className="sb-row sb-settings" onClick={props.onOpenLibrary}>
              <span className="sb-slot" aria-hidden="true">▤</span>
              <span className="sb-title">文档素材库</span>
            </button>
            <button className="sb-row sb-settings" onClick={props.onOpenSettings}>
              <span className="sb-slot" aria-hidden="true">⚙</span>
              <span className="sb-title">设置</span>
            </button>
          </div>
        </>
      )}

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} />
          <div className="float-menu" style={{ left: Math.max(8, menu.at.x - 132), top: menu.at.y }}>
            {menu.session.cwd && (
              <button
                className="menu-item"
                onClick={() => {
                  const p = menu.session.cwd!
                  setMenu(null)
                  api.explorerOpen(p).catch((e: any) => onToast(`打开失败：${e.message}`))
                }}
              >在资源管理器中打开</button>
            )}
            <div className="menu-label">移入项目</div>
            {projects.filter(p => p.id !== menu.session.projectId).map(p => (
              <button key={p.id} className="menu-item" onClick={() => { void moveTo(menu.session, p.id) }}>
                {p.title}
              </button>
            ))}
            {menu.session.projectId && (
              <button className="menu-item" onClick={() => { void moveTo(menu.session) }}>移出到未分组</button>
            )}
            {!projects.length && !menu.session.projectId && <div className="menu-empty dim">还没有项目</div>}
            {menu.session.mode !== 'subagent' && (
              <button
                className="menu-item"
                onClick={() => {
                  const s = menu.session
                  setMenu(null)
                  if (s.archived) { onToast('已归档对话不能改绑定目录'); return }
                  void pickDir('session', s)
                }}
              >{menu.session.cwd ? '更改绑定目录' : '绑定工作目录'}</button>
            )}
            <div className="menu-sep" />
            {menu.session.archived ? (
              <button className="menu-item" onClick={() => { const s = menu.session; setMenu(null); void restore(s) }}>
                取消归档
              </button>
            ) : (
              <button className="menu-item danger" onClick={() => { const s = menu.session; setMenu(null); void archive(s) }}>
                归档会话
              </button>
            )}
          </div>
        </>
      )}

      {projectMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setProjectMenu(null)} />
          <div className="float-menu" style={{ left: Math.max(8, projectMenu.at.x - 132), top: projectMenu.at.y }}>
            {projectMenu.project.cwd && (
              <button
                className="menu-item"
                onClick={() => {
                  const p = projectMenu.project.cwd!
                  setProjectMenu(null)
                  api.explorerOpen(p).catch((e: any) => onToast(`打开失败：${e.message}`))
                }}
              >在资源管理器中打开</button>
            )}
            <button
              className="menu-item"
              onClick={() => {
                setRenaming({ id: projectMenu.project.id, title: projectMenu.project.title })
                setProjectMenu(null)
              }}
            >重命名项目</button>
            <button
              className="menu-item"
              onClick={() => {
                const p = projectMenu.project
                setProjectMenu(null)
                void pickDir('new-project', undefined, p.id, p.cwd || undefined)
              }}
            >{projectMenu.project.cwd ? '更改关联文件夹' : '关联文件夹'}</button>
            {projectMenu.project.cwd && (
              <button
                className="menu-item"
                onClick={() => {
                  const p = projectMenu.project
                  setProjectMenu(null)
                  void api.setProjectCwd(p.id, '').then(reload).then(() => onToast('已解除分组目录关联')).catch((e: any) => onToast(e.message))
                }}
              >解除关联</button>
            )}
            <button
              className="menu-item danger"
              onClick={() => { setConfirmDelete(projectMenu.project); setProjectMenu(null) }}
            >删除项目</button>
          </div>
        </>
      )}

      {confirmDelete && (
        <div className="dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-title">删除项目？</div>
            <div className="dialog-body">
              将把「{confirmDelete.title}」从项目列表中移除。会话记录与会话中的画布都会保留，
              其会话将显示在「未分组」下。
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="dialog-btn danger" onClick={() => { void deleteProject() }}>删除项目</button>
            </div>
          </div>
        </div>
      )}

      {confirmArchive && (
        <div className="dialog-backdrop" onClick={() => setConfirmArchive(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-title">停止并归档此会话？</div>
            <div className="dialog-body">
              「{confirmArchive.session.title || confirmArchive.session.id}」仍有正在进行的工作。
              归档会先停止这些工作；之后可在「仅已归档」里恢复会话，被停止的工作不会自动继续。
            </div>
            <ul className="dialog-list">
              {confirmArchive.activity.map((a: any, i: number) => (
                <li key={i}>
                  {a.kind === 'turn'
                    ? '进行中的回合'
                    : `${a.items?.length ?? 0} 个运行中的子智能体：${(a.items ?? []).map((x: any) => x.label ?? x.id).join('、')}`}
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setConfirmArchive(null)}>取消</button>
              <button className="dialog-btn danger" onClick={() => { void stopAndArchive() }}>停止并归档</button>
            </div>
          </div>
        </div>
      )}
      {/* 新建分组弹窗（对齐 dsh/WorkBuddy：名称 + 说明 + 关联文件夹 + 取消/保存） */}
      {creating && (
        <div className="dialog-backdrop" onClick={() => setCreating(false)}>
          <div className="dialog new-group-dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-title-row">
              <div className="dialog-title">新建分组</div>
              <button className="dialog-x" title="关闭" onClick={() => setCreating(false)}>×</button>
            </div>
            <input
              autoFocus
              className="dialog-input"
              placeholder="输入分组名称"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newTitle.trim()) void createProject()
                if (e.key === 'Escape') setCreating(false)
              }}
            />
            <div className="dialog-hint">
              分组可用于整理你的任务列表，还可{' '}
              <button className="inline-link" onClick={() => void pickDir('new-project', undefined, undefined, newCwd || undefined)}>
                <span aria-hidden="true">▣</span> {newCwd ? '更换关联文件夹' : '关联电脑上的文件夹'}
              </button>
              ，让 WorkBuddy 参考已有资料，并优先将生成的产物文件保存到关联文件夹内
            </div>
            {newCwd && (
              <div className="group-cwd-row" title={newCwd}>
                <span className="group-cwd-icon" aria-hidden="true">▣</span>
                <span className="group-cwd-path">{newCwd}</span>
                <button
                  className="group-cwd-clear"
                  title="解除关联"
                  onClick={() => setNewCwd('')}
                >×</button>
              </div>
            )}
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setCreating(false)}>取消</button>
              <button className="dialog-btn primary" disabled={!newTitle.trim()} onClick={() => void createProject()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
