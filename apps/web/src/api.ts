// 后端 API 封装 + POST SSE 流解析
import type {
  ArchivedView, FeaturesDto, ModelInfoDto, PrefsDto, ProjectBaselineDto, ProjectDto,
  SessionInfoDto, SessionSummaryDto, SettingsDto, StatsFrameDto, LibraryAssetDto, CanvasTreeDto,
  LibraryJarItemDto, McTestJarSelectionDto, McTestStatusDto, LogsDto, BuildLogMetaDto,
  UpdateStatusDto, UpdateApplyDto, EnvStatusDto, VendorDownloadDto,
} from './types.js'

export interface SseFrame {
  topic: string
  [key: string]: any
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

/**
 * 上传用的 content-type：服务端只把这些 MIME 注册成原始字节解析器。
 * 不能直接用 File.type（.json/.md 会命中 Fastify 的文本/JSON 解析器，body 就不是 Buffer 了）。
 */
function bufferMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'jar') return 'application/java-archive'
  if (ext === 'zip') return 'application/zip'
  return 'application/octet-stream'
}

function uploadBytes(url: string, file: File): Promise<{ asset: LibraryAssetDto }> {
  return jfetch<{ asset: LibraryAssetDto }>(url, {
    method: 'POST',
    headers: { 'content-type': bufferMime(file.name) },
    body: file,
  })
}

export const api = {
  health: () => jfetch<{ ok: boolean; mock: boolean; plugins: string[] }>('/api/health'),
  /** 功能开关 + 当前可用角色 + 插件加载情况（画布/MC/素材库入口按它隐藏） */
  features: () => jfetch<FeaturesDto>('/api/features'),
  models: () => jfetch<{ models: ModelInfoDto[]; defaultModelId: string }>('/api/models'),
  settings: () => jfetch<{ settings: SettingsDto }>('/api/settings'),
  /** providers / bridge / prefs 都是可选的：按分区保存不会互相覆盖 */
  saveSettings: (
    patch: { providers?: any; bridge?: { enabled: boolean; modelId?: string }; prefs?: Partial<PrefsDto> },
    expectedRevision: number,
  ) =>
    jfetch<{ ok: boolean; revision: number; prefs: PrefsDto }>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...patch, expectedRevision }),
    }),
  /** 只存行为偏好（通用 / 子代理 / 自动化页的即时开关） */
  savePrefs: (prefs: Partial<PrefsDto>, expectedRevision: number) =>
    jfetch<{ ok: boolean; revision: number; prefs: PrefsDto }>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs, expectedRevision }),
    }),
  setCredential: (route: string, apiKey: string) =>
    jfetch<{ ok: boolean }>(`/api/settings/credentials/${route}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    }),
  discoverModels: (baseURL: string, opts?: { route?: string; apiKey?: string; format?: 'openai' | 'gemini' }) =>
    jfetch<{ models: { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number; inputModalities?: string[]; reasoningEfforts?: string[]; reasoningDefault?: string }[] }>('/api/settings/discover-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL, route: opts?.route, apiKey: opts?.apiKey, format: opts?.format }),
    }),
  /** 视觉能力实测：给每个模型发一张极小图片，返回 true/false/null（未知） */
  probeVision: (baseURL: string, models: string[], opts?: { route?: string; apiKey?: string; format?: 'openai' | 'gemini' }) =>
    jfetch<{ results: { id: string; vision: boolean | null; error?: string }[] }>('/api/settings/probe-vision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL, models, route: opts?.route, apiKey: opts?.apiKey, format: opts?.format }),
    }),
  createSession: (projectId?: string, cwd?: string) =>
    jfetch<{ id: string; projectId?: string; cwd?: string }>('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, cwd }),
    }),
  /** 切换会话绑定的工作目录（左栏用） */
  setSessionCwd: (id: string, cwd: string) =>
    jfetch<{ ok: boolean; cwd: string }>(`/api/sessions/${id}/cwd`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    }),
  /** 目录浏览（选工作目录用，只列子目录） */
  browseDirs: (path?: string) =>
    jfetch<{ path: string; parent: string | null; dirs: { name: string; path: string }[]; defaultRoot: string }>(
      `/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  /** 系统原生「选择文件夹」对话框（资源管理器风格）；取消返回 path: null */
  pickDir: (path?: string, title?: string) =>
    jfetch<{ path: string | null }>('/api/fs/pick-dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, title }),
    }),
  /** 打开下载区的默认落点目录（不存在时服务端先创建） */
  openDir: (kind: 'vendor' | 'test-client') =>
    jfetch<{ ok: boolean; path: string }>('/api/fs/open-dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    }),
  /** archived=hide（默认）/ all / only —— 对应 dsh 的 viewOptions 三种筛选 */
  listSessions: (archived: ArchivedView = 'hide') =>
    jfetch<{ sessions: SessionSummaryDto[]; archivedView: ArchivedView }>(`/api/sessions?archived=${archived}`),

  // ---- 项目（dsh workspace） ----
  projects: () => jfetch<ProjectBaselineDto>('/api/projects'),
  createProject: (title: string, cwd?: string) =>
    jfetch<{ project: ProjectDto }>('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, ...(cwd ? { cwd } : {}) }),
    }),
  renameProject: (id: string, title: string) =>
    jfetch<{ project: ProjectDto }>(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  /** 改分组关联的目录；cwd 传空串 = 解除关联 */
  setProjectCwd: (id: string, cwd: string) =>
    jfetch<{ project: ProjectDto }>(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    }),
  /** 只删项目注册：会话记录保留，回落「未分组」 */
  deleteProject: (id: string) =>
    jfetch<{ deleted: true; movedSessionIds: string[] }>(`/api/projects/${id}`, { method: 'DELETE' }),
  attachSession: (projectId: string, sessionId: string) =>
    jfetch<{ project: ProjectDto }>(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  detachSession: (projectId: string, sessionId: string) =>
    jfetch<{ project: ProjectDto }>(`/api/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' }),

  // ---- 归档（软删除） ----
  /**
   * 归档一个会话。会话仍在跑时服务端回 409 + activity，
   * 这里结构化返回，由 UI 决定「停止并归档」还是放弃（dsh archive 确认框）。
   */
  archiveSession: async (id: string, stopActivity = false):
    Promise<{ ok: true; archivedSessionIds: string[] } | { conflict: true; activity: any[] }> => {
    const res = await fetch(`/api/sessions/${id}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopActivity }),
    })
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}))
      return { conflict: true, activity: body.activity ?? [] }
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`)
    return res.json()
  },
  unarchiveSession: (id: string) =>
    jfetch<{ ok: boolean; archivedSessionIds: string[] }>(`/api/sessions/${id}/unarchive`, { method: 'POST' }),
  getSession: (id: string) => jfetch<SessionInfoDto>(`/api/sessions/${id}`),
  subagents: (id: string) => jfetch<{ subagents: SessionSummaryDto[] }>(`/api/sessions/${id}/subagents`),

  // ---- 会话多画布（主会话与各子代理各自一块独立画布） ----
  /** 会话树的画布列表 + 当前会话的活跃画布 */
  canvases: (id: string) => jfetch<CanvasTreeDto>(`/api/sessions/${id}/canvases`),
  /** 新建一块空白画布（activate=false 时不抢占活跃画布） */
  createCanvas: (id: string, body?: { name?: string; activate?: boolean }) =>
    jfetch<CanvasTreeDto & { canvasId: string }>(`/api/sessions/${id}/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  /** 把某块画布设为它 owner 会话的活跃画布 */
  activateCanvas: (sessionId: string, canvasId: string) =>
    jfetch<CanvasTreeDto>(`/api/sessions/${sessionId}/canvases/${encodeURIComponent(canvasId)}/activate`, {
      method: 'POST',
    }),
  /** 统一会话事件流（EventSource）；since=0 表示补发当前进行中回合的帧 */
  streamUrl: (id: string, since = -1) => `/api/sessions/${id}/stream?since=${since}`,
  setSessionModel: (id: string, modelId: string) =>
    jfetch<{ ok: boolean; modelId: string }>(`/api/sessions/${id}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId }),
    }),
  profiles: () => jfetch<{ profiles: { id: string; name: string; description?: string }[] }>('/api/profiles'),
  stats: (id: string) => jfetch<StatsFrameDto>(`/api/sessions/${id}/stats`),

  // ---- 计划模式 / 授权策略 / 人机交互 ----
  setPlanMode: (id: string, active: boolean) =>
    jfetch<{ ok: boolean; active: boolean }>(`/api/sessions/${id}/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active }),
    }),
  setPermissions: (id: string, patch: { policy?: 'ask' | 'auto'; resetAllowed?: boolean }) =>
    jfetch<{ ok: boolean; policy: 'ask' | 'auto'; allowedTools: string[] }>(`/api/sessions/${id}/permissions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  answerInteraction: (id: string, reqId: string, reply: {
    answers?: { id: string; selected: string[]; custom?: string }[]
    approved?: boolean
    feedback?: string
    decision?: 'allow' | 'deny'
    remember?: boolean
  }) =>
    jfetch<{ ok: boolean }>(`/api/sessions/${id}/interactions/${reqId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reply),
    }),

  // ---- 终端 ----
  terminals: (sessionId: string) =>
    jfetch<{ terminals: import('./types.js').TerminalDto[]; shell: string }>(`/api/terminals?sessionId=${encodeURIComponent(sessionId)}`),
  openTerminal: (sessionId: string, opts?: { command?: string; cwd?: string; title?: string }) =>
    jfetch<{ terminal: import('./types.js').TerminalDto }>('/api/terminals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...opts }),
    }),
  terminalOutput: (sessionId: string, terminalId: string, tail = 20000) =>
    jfetch<{ terminal: import('./types.js').TerminalDto; output: string }>(
      `/api/terminals/${terminalId}/output?sessionId=${encodeURIComponent(sessionId)}&tail=${tail}`,
    ),
  terminalInput: (sessionId: string, terminalId: string, text: string) =>
    jfetch<{ ok: boolean }>(`/api/terminals/${terminalId}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    }),
  killTerminal: (sessionId: string, terminalId: string) =>
    jfetch<{ ok: boolean }>(`/api/terminals/${terminalId}/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  /** 关闭（移除）一个终端条目：运行中的先收进程树，已退出的直接丢弃 */
  closeTerminal: (sessionId: string, terminalId: string) =>
    jfetch<{ ok: boolean }>(`/api/terminals/${terminalId}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  /** 清空某会话的全部终端（运行中的先结束） */
  closeAllTerminals: (sessionId: string) =>
    jfetch<{ ok: boolean; closed: number }>(`/api/terminals?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  // ---- 文档素材库（多文件资产） ----
  library: () => jfetch<{ assets: LibraryAssetDto[] }>('/api/library'),
  /** 上传一个文件新建素材（多选时其余文件走 appendLibraryFile） */
  uploadLibrary: (file: File, opts?: { title?: string; sessionId?: string }) => {
    const q = new URLSearchParams({ name: file.name })
    if (opts?.title) q.set('title', opts.title)
    if (opts?.sessionId) q.set('sessionId', opts.sessionId)
    return uploadBytes(`/api/library/upload?${q.toString()}`, file)
  },
  /** 给已有素材追加文件 */
  appendLibraryFile: (id: string, file: File) =>
    uploadBytes(`/api/library/${id}/files?name=${encodeURIComponent(file.name)}`, file),
  /** 从会话工作目录导入（每个文件单独成资产） */
  importLibraryFromCwd: (sessionId: string, paths: string[], name?: string) =>
    jfetch<{ asset: LibraryAssetDto; assets: LibraryAssetDto[] }>('/api/library/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, paths, ...(name ? { name } : {}) }),
    }),
  /** Jar 构建列表：素材库归档 + 工程 build/libs 扫描 */
  libraryJars: (sessionId?: string) =>
    jfetch<{ jars: LibraryJarItemDto[] }>(`/api/library/jars${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  /** 把工程构建 jar 归档进素材库 */
  archiveLibraryJar: (sessionId: string, path: string) =>
    jfetch<{ asset: LibraryAssetDto }>('/api/library/jars/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, path }),
    }),
  /** 统一测试启动器状态 */
  mcTestStatus: (tail = 120) => jfetch<McTestStatusDto>(`/api/mc/test?tail=${tail}`),
  mcTestRun: (jars: McTestJarSelectionDto[], sessionId?: string) =>
    jfetch<{ ok: boolean }>('/api/mc/test/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jars, sessionId }),
    }),
  mcTestStop: () =>
    jfetch<{ ok: boolean; stopped: boolean }>('/api/mc/test/stop', { method: 'POST' }),
  /** 系统日志增量拉取：after 为上次拿到的 seq */
  logs: (after = 0, limit = 300) =>
    jfetch<LogsDto>(`/api/logs?after=${after}&limit=${limit}`),
  /** 构建日志历史列表（最近 N 条，新的在前） */
  buildLogs: (limit = 30) => jfetch<{ logs: BuildLogMetaDto[] }>(`/api/build-logs?limit=${limit}`),
  /** 单条构建日志的完整文本 */
  buildLog: (id: string) =>
    jfetch<BuildLogMetaDto & { text: string }>(`/api/build-logs/${encodeURIComponent(id)}`),
  /** Java / Gradle 后台进程（Gradle daemon / 启动器 / Minecraft 客户端） */
  javaProcs: () => jfetch<import('./types.js').JavaProcsDto>('/api/procs/java'),
  /** 结束一个受监控的 Java 进程 */
  killJavaProc: (pid: number) =>
    jfetch<{ ok: boolean }>('/api/procs/java/kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid }),
    }),
  /** 批量结束：默认只结束 Gradle，includeClient 时连 Minecraft 客户端一起 */
  killAllJavaProcs: (includeClient: boolean) =>
    jfetch<{ ok: boolean; killed: number[]; failed: { pid: number; error: string }[] }>('/api/procs/java/kill-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeClient }),
    }),
  /** 自更新：检查 openmods main 与本地差异 */
  updateStatus: () => jfetch<UpdateStatusDto>('/api/update/status'),
  /** 自更新：手动确认后 git pull + 重建前端 */
  updateApply: () =>
    jfetch<UpdateApplyDto>('/api/update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),

  // ---- 环境检测（首次运行向导 / 设置 → 环境） ----
  /** 当前 Java / Gradle 缓存 / Git 三项检测结果（只读） */
  envStatus: () => jfetch<EnvStatusDto>('/api/env/status'),
  /** 保存环境配置并立即生效；fixVendorLayout=true 时先整理错位的离线包 */
  envApply: (patch: {
    javaHome?: string
    gradleHome?: string
    gitPath?: string
    setupDone?: boolean
    fixVendorLayout?: boolean
    testClientDir?: string
    testMdkDir?: string
  }) =>
    jfetch<EnvStatusDto>('/api/env/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** 在线下载离线构建包：查询状态 / 启动 / 取消 */
  envVendorStatus: () => jfetch<VendorDownloadDto>('/api/env/vendor/download'),
  envVendorStart: (source: 'official' | 'release') =>
    jfetch<{ ok: boolean }>('/api/env/vendor/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    }),
  envVendorCancel: () =>
    jfetch<{ ok: boolean }>('/api/env/vendor/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  /** 测试客户端离线包：状态 / 启动 / 取消（解压到 data/mc-test-client/.minecraft） */
  envTestClientStatus: () => jfetch<VendorDownloadDto>('/api/env/test-client/download'),
  envTestClientStart: (source: 'official' | 'release') =>
    jfetch<{ ok: boolean }>('/api/env/test-client/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    }),
  envTestClientCancel: () =>
    jfetch<{ ok: boolean }>('/api/env/test-client/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  /** 素材内文件地址：图片/文本默认内联，jar 等强制下载加 download=1 */
  libraryFileUrl: (id: string, fileId: string, download = false) =>
    `/api/library/${id}/files/${fileId}${download ? '?download=1' : ''}`,
  captureLibrary: (sessionId: string, name?: string) =>
    jfetch<{ asset: LibraryAssetDto; jarAsset?: LibraryAssetDto }>('/api/library/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, name }),
    }),
  deleteLibrary: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/library/${id}`, { method: 'DELETE' }),
  /** 引用到新会话：素材种到新会话画布，素材本身不动（副本迭代） */
  forkLibrary: (id: string, sessionId?: string) =>
    jfetch<{ sessionId: string; cwd: string; name: string }>(`/api/library/${id}/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  /** 就地改：返回这个素材绑定的编辑会话（没有就建一个，改动自动回写素材） */
  editLibrary: (id: string, sessionId?: string) =>
    jfetch<{ sessionId: string; created: boolean; name: string }>(`/api/library/${id}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  renameLibrary: (id: string, name: string) =>
    jfetch<{ asset: LibraryAssetDto }>(`/api/library/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  applyLibrary: (id: string, sessionId: string) =>
    jfetch<{ ok: boolean; elementCount: number }>(`/api/library/${id}/to-canvas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  /** 缩略图带上 updatedAt 做缓存键：就地回写后浏览器不会继续显示上一版；pv=3 让旧贴图/方向错误的预览失效 */
  libraryThumb: (id: string, version?: number) => `/api/library/${id}/thumb?pv=3${version ? `&v=${version}` : ''}`,
  /** 下载素材编译出的 jar 产物 */
  libraryJarUrl: (id: string) => `/api/library/${id}/jar`,
  /** 素材编译成 bbmodel（画布「新标签打开」用，不覆盖会话画布） */
  libraryModel: async (id: string): Promise<any> => {
    const res = await fetch(`/api/library/${id}/model`)
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '素材加载失败')
    return res.json()
  },
  stop: (id: string) => jfetch<{ ok: boolean }>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  bbmodel: async (id: string): Promise<any> => {
    const res = await fetch(`/api/sessions/${id}/bbmodel`)
    if (!res.ok) throw new Error('画布还没有模型')
    return res.json()
  },
  putBbmodel: (id: string, model: any) =>
    jfetch<{ ok: boolean; elements: number }>(`/api/sessions/${id}/bbmodel`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
  /** 上传一个聊天附件（图片或普通文件），返回可放进 chat.attachments 的引用 part */
  uploadAttachment: (file: File) =>
    jfetch<{ part: any }>(
      `/api/attachments?name=${encodeURIComponent(file.name || '附件')}`
      + `&mediaType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
      {
        method: 'POST',
        headers: { 'content-type': bufferMime(file.name) },
        body: file,
      },
    ),
  /** 异步启动一轮对话：事件走 streamUrl 的 EventSource */
  chat: (id: string, body: { text: string; modelId?: string; mode?: 'build' | 'refine'; attachments?: any[]; profile?: string; reasoningEffort?: string }) =>
    jfetch<{ ok: boolean; sessionId: string }>(`/api/sessions/${id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // ---- 资源管理器 / MC 工程状态（mcdev） ----
  /** 用 Windows 资源管理器打开一个目录（或定位一个文件） */
  explorerOpen: (path: string) =>
    jfetch<{ ok: boolean }>('/api/explorer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  /** 会话工作目录下的 MC 工程状态（构建结果 / runClient 运行中 / jar 产物） */
  mcState: (sessionId: string) =>
    jfetch<{ root: string; projects: import('./types.js').McProjectUiDto[] }>(
      `/api/mc/state?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  /** 启动 runClient 测试 mod（等价 mc_gradle task=runClient background=true） */
  mcRun: (sessionId: string, project: string) =>
    jfetch<{ ok: boolean; pid: number; logPath: string }>('/api/mc/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, project }),
    }),
  /** 停掉工程正在跑的 runClient */
  mcStop: (sessionId: string, project: string) =>
    jfetch<{ ok: boolean; stopped: boolean }>('/api/mc/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, project }),
    }),
  /** runClient 控制台日志（run-console.log 尾部，用于日志抽屉的「运行日志」） */
  mcRunLog: (sessionId: string, project: string) =>
    jfetch<import('./types.js').McRunLogDto>(
      `/api/mc/runlog?sessionId=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(project)}`,
    ),
  /** 把工程最新 jar 复制到设置里的 mod-output 目录 */
  mcExport: (sessionId: string, project: string) =>
    jfetch<{ ok: boolean; name: string; dest: string; size: number }>('/api/mc/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, project }),
    }),
  /** 下载构建出的 mod jar */
  mcJarUrl: (path: string) => `/api/mc/jar?path=${encodeURIComponent(path)}`,

  // ---- 设置 → 代理与技能 ----
  agentsDetail: () =>
    jfetch<{ agents: import('./types.js').AgentDetailDto[]; allSkills: import('./types.js').SkillMetaDto[] }>('/api/agents/detail'),
  setAgentSkills: (id: string, skills: string[]) =>
    jfetch<{ ok: boolean; skills: string[] }>(`/api/agents/${encodeURIComponent(id)}/skills`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skills }),
    }),
  skills: () => jfetch<{ skills: import('./types.js').SkillMetaDto[] }>('/api/skills'),
  skill: (name: string) =>
    jfetch<import('./types.js').SkillContentDto>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, body: { description: string; content: string }) =>
    jfetch<{ ok: boolean; name: string; description: string }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteSkill: (name: string) =>
    jfetch<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
}
