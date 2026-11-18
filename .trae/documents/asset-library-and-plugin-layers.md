# 素材库 v2 + 插件化分层 + coding 模式

## Context

现状：素材库只能存「画布模型快照 + 顺带一个 jar」，存储是 `data/library/<id>.{meta.json,doc.json,png,jar}` 的扁平结构；代理角色（lead / mcmod / modeling）、MC 提示词、技能分配全部硬编码在 `apps/server/src/index.ts`；插件目录可加载但没有启用/禁用开关，前端 MC 按钮、画布、素材库入口也无法隐藏。结果是：想当纯 coding agent 用时，仍会被 MC/建模的提示词与 UI 干扰；jar、bbmodel、贴图等文件也没有正规的归档入口。

本次按用户决策重做：

1. 素材库 = **统一多文件资产**（模型快照 / jar / 图片 / 其它文件），支持浏览器上传+拖拽、从工作目录导入，保留画布截取与会话画布自动归档。
2. 分层 = **彻底插件化**：角色（profile）由插件注册，功能开关落到设置里，前端按 `/api/features` 动态渲染。
3. 新增独立 **coding** 角色：只开放文件/搜索/终端/计划/待办，不注入 MC、画布提示。

边界（刻意不做）：素材库不塞进插件体系——`plugin-kit` 没有 HTTP 路由面，素材库属于服务端基础设施，只用 feature 开关门控；v1 不引入通用 `spawn_subagent`（建模子代理只在 canvas 启用时暴露）；不新增 npm 依赖（无 `@fastify/multipart`，用 `addContentTypeParser(parseAs:'buffer')` 接收原始字节）；不改 MC 平台版本与构建配置。

## P1 资产 v2 存储与迁移（apps/server/src/library.ts）

数据结构：

```ts
type AssetFileKind = 'model' | 'image' | 'jar' | 'archive' | 'text' | 'other'
interface AssetFile { id: string; name: string; rel: string; size: number; mime: string; kind: AssetFileKind; sha256: string; createdAt: number }
interface LibraryAsset {
  schema: 2
  id: string; name: string; createdAt: number; updatedAt: number; version: number
  sessionId?: string; canvasId?: string; editingSessionId?: string; auto?: boolean
  source: { provider: 'canvas' | 'auto' | 'upload' | 'cwd' | 'legacy'; sessionId?: string; path?: string }
  files: AssetFile[]
  /** 模型类资产（有画布快照才有）：docFileId 指向 files 里的快照 JSON */
  model?: { docFileId: string; elementCount: number; textureCount: number; resolution: { width: number; height: number }; palette?: string[]; thumbFileId?: string }
  /** 构建产物（jar 或 zip 归档） */
  jar?: { fileId: string; name: string; size: number }
}
```

布局：`data/library/<id>/meta.json`、`data/library/<id>/files/f_<6位>_<安全原名>`、`data/library/<id>/thumbs/<fileId>.png`。

- `kind` 判定：扩展名 + magic（`PK\x03\x04` → jar/zip；PNG/JPEG/GIF/WEBP 头 → image；`.json/.bbmodel` → model/text）。
- `capture()` / `upsertByCanvas()` 改写成 v2（快照写成一个 file + thumb）；保留 `findLatestJar` 与 jar 归档行为。旧字段 `elementCount/textureCount/resolution/palette/hasThumb` 仍派生输出，前端旧代码不受影响。
- `migrateLegacy()`：启动时试跑一次，`list()/get()` 也懒调用。按顶层 `*.meta.json` 实际 id 迁移（保留大小写，不改 id）：mkdir → `renameSync` 移 doc/png/jar（EXDEV/EPERM 回退 copy+unlink）→ 原子写 `meta.json` → 删旧 meta。可重入；迁移失败时 `readDoc/readThumb/readJar` 保留旧扁平文件回退。`remove()` 改 `rmSync(dir,{recursive:true})` 并兼容清理旧文件。
- 新增：`addFile(id, {name, data|path, mime})`、`importFiles(opts)`、`readFile(id, fileId)`、`updateMeta(id, {name})`。

## P2 素材 API（apps/server/src/index.ts，替换 L2306-2450 区块）

零新依赖：

```ts
app.addContentTypeParser(['application/octet-stream', 'application/java-archive', 'image/png', 'image/jpeg', 'application/zip'],
  { parseAs: 'buffer' }, (_q, body, done) => done(null, body))
```

- `POST /api/library/upload?name=&sessionId=`（`bodyLimit: 64MB`，请求体即文件字节）：一次一个文件，首个建资产；前端多选/拖拽时其余文件走追加。
- `POST /api/library/:id/files`：追加文件到已有资产。
- `POST /api/library/import`：`{ sessionId, paths: string[], name? }`，用 `sessionStore.readMeta(sessionId).cwd` 做根，`realpath` 后必须落在 cwd 内；只收普通文件，单次 ≤20 个、单文件 ≤32MB。
- `GET /api/library/:id/files/:fileId?download=1`：只按 meta 的 `fileId → rel` 取路径，`resolve` 后校验仍在资产目录内；图片 inline，文本截断 512KB，SVG/HTML 强制下载；响应头用 RFC5987 处理文件名。
- 保留旧接口：`GET /api/library`、`POST /capture`、`GET /:id/model|thumb|jar`、`POST /:id/fork|edit|to-canvas`、`PATCH /:id`、`DELETE /:id`。`to-canvas` 对无 `model` 的资产返回 400。
- 安全：`sanitizeFileName()`（basename、去控制字符/`..`/分隔符、Windows 保留名、截 120 字符）+ 扩展名白名单（png/jpg/jpeg/webp/gif/jar/zip/json/bbmodel/md/txt/java/gradle/properties/yml/yaml/toml/ts/tsx/js）+ 分档大小（图片 10MB、jar 64MB、其它 5MB）。
- 功能关闭时：`features.library === false` 的相关路由统一返回 404。

## P3 前端素材抽屉（LibraryDrawer.tsx 等）

- `types.ts`：新增 `LibraryFileDto`、v2 `LibraryAssetDto`、`FeatureDto`；`api.ts` 增 `features()`、`uploadLibrary()`、`appendLibraryFile()`、`importLibraryFromCwd()`、`libraryFileUrl()`、`updateLibrary()`。
- `LibraryDrawer.tsx`：顶部改为「类型 chips（全部/模型/jar/图片/文件）+ 搜索 + 上传按钮 + 拖拽区」；拖拽 / `<input type=file multiple>` 直接上传，另给「从工作目录导入」输入框（填相对 cwd 的路径）。卡片展示文件名列表与大小；操作按资产能力渲染：有 `model` 才有 打开画布/接着改/引用新会话/送入画布，有 `jar` 才有下载/导出，其它文件给预览/下载。保留打开期间轮询与改名/删除。
- `LeftSidebar.tsx`（L354、L383）两个素材库入口按 `features.library` 渲染；`App.tsx` 启动拉 `/api/features` 存 state 并向下传。

## P4 插件化：plugin-kit 扩展（packages/plugin-kit/index.ts）

```ts
export interface FeatureDecl { id: string; name: string; description?: string; default?: boolean }
export interface ProfileDecl { id: string; name: string; prompt: string; toolFilter?: string[]; toolExclude?: string[]; skills?: string[]; requires?: string[]; internal?: boolean }
// Plugin 增加：features?: FeatureDecl[]; requires?: string[]; skills?: string[]
// PluginContext 增加：
//   profiles: { register(p: ProfileDecl): void }
//   features: { declare(f: FeatureDecl): void; enabled(id: string): boolean }
```

`loadPlugins()` 改两段式：先 import 全部，收集 `features/requires`；再对 `requires` 全部满足的插件执行 `apply`，跳过的记入 `skippedPlugins`（供 `/api/features` 展示）。

归属改造：

- 新增 `apps/server/src/features.ts`：`FEATURE_DEFS`（`canvas` / `mc` / `library`）+ `resolveFeatureStates(prefs.features)`。
- 新增 `apps/server/src/profiles.ts`：`createProfileRegistry()`，内置 `lead` 与 `coding`。`coding` 的 `toolFilter = ['load_skill', ...WORKSPACE_TOOLS]`、`skills: []`，prompt 只描述代码/文件/命令/计划，不含画布与 MC。
- `plugins/bb-tools`：声明 `features:[{id:'canvas'}]`、`requires:['canvas']`，注册 `modeling` 角色（prompt/toolExclude 从 index.ts L266-275 迁入），`skills` 声明画布三件套。
- `plugins/mcdev`：声明 `features:[{id:'mc'}]`、`requires:['mc']`，注册 `mcmod` 角色（prompt 从 L234-265 迁入），`skills:['minecraft-forge-1.20.1']`。
- 替换 index.ts 中所有 `AGENT_PROFILES` 引用（约 L161/616/641/996/1160/1169/1191/2164）为 registry；`effectiveSkills` 改为 `override ?? profile.skills ?? []`（`data/agent-skills.json` 中失效 id 忽略）。
- `spawn_modeling_subagent` / `list_subagents` 只在 `features.canvas` 时注册；`startSubagent` 找不到 `modeling` 时返回明确错误而非 500。
- 会话恢复时若 `meta.profile` 不在 registry（如 mcmod 被禁用）回落 `lead`；`GET /api/profiles` 过滤 `internal` 与 requires 不满足者。
- 技能隐藏：用 `createFilteredSkillProvider` 包裹现有 `DirSkillProvider`，隐藏被跳过插件声明的技能，使 `load_skill`、`/api/skills`、系统提示一致。
- `apps/server/src/settings.ts`：`PrefsConfig` 增加 `features: Record<string, boolean>`，`normalizePrefs` 容错；`GET /api/features` 返回 `{ features: [{id,name,enabled,pendingRestart}], profiles: [...] }`（`pendingRestart` = 当前启动态与 prefs 不一致）。

## P5 前端功能门控

- `App.tsx`：`features` state；`features.library` 控制抽屉入口；`features.canvas` 控制画布标签/`openLibModel`/画布相关回调；`features.mc` 控制 `mcProjects` 拉取与运行配置；`agentProfile` 不在可用列表时回落 `lead`；给 LeftSidebar / RightDock / MainPanel 传 `features`。
- `RightDock.tsx`：画布 dock 标签按 `features.canvas` 过滤；`MainPanel.tsx` L129 的 MC 按钮组加 `features.mc` 判断。
- `SettingsWindow.tsx` / `SettingsPage.tsx`：新增「功能」分区，读写 `prefs.features`，保存后提示「重启生效」。

## 验证

1. `npm run build`（web tsc+vite）通过；server 用 `npx tsx apps/server/src/index.ts` 以 `PORT=8899` 起临时实例。
2. 旧数据迁移：用现有 `data/library` 启动，确认 `<id>/meta.json` 生成、旧接口（list/thumb/jar/model/to-canvas）正常，旧扁平文件被清理或回退可读。
3. 上传：`Invoke-WebRequest -Method Post -InFile <jar> -ContentType application/octet-stream` 到 `/api/library/upload`，再调 `/files/:fileId` 下载比对字节；`../` 文件名、超限文件、非法扩展名应 400。
4. 插件化：改 `data/settings.json` 的 `prefs.features.mc=false` 重启后——`/api/profiles` 无 mcmod、`/api/features` 标 `mc:false`、工具列表无 `mc_*`；`canvas=false` 同理且无建模子代理；`library=false` 时素材路由 404、前端入口消失。
5. coding 模式：新建会话选 `coding`，跑一次 read/grep/edit/bash + todo/plan，确认系统提示无 MC/画布内容。
6. 浏览器手测：抽屉拖拽上传、类型筛选、jar 下载、模型送画布/接着改、功能关闭后的 UI 隐藏（画布标签、MC 按钮、素材入口）。

## 风险

- 旧素材迁移：Windows `renameSync` 跨盘/占用需回退复制；迁移期间并发写要串行化。
- 上传安全：只信扩展名不够（校验 magic）；禁止 inline SVG/HTML；客户端文件名绝不拼进路径。
- profile 动态注册：`/api/agents/detail`、会话 `profile` 字段、子代理创建、`agent-skills.json` 覆盖都可能指向已禁用角色，全部要走 registry 校验与回落。
- 开关生效时机：`loadPlugins` 只在启动执行，必须用 `pendingRestart` 明确告知用户重启，避免"点了没反应"。
- `data/` 被 gitignore：迁移与验证不能依赖仓库内数据。
