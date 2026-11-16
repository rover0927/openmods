# openmods

> 本地 AI 工作台：dsh 式主界面（三栏 + 状态条）+ **并发建模子代理**（同一会话共享画布 + 对话内活动条）+ **无头 Blockbench 画布** + **Minecraft 1.20.1 模组开发闭环**（建模 → 导出 → 构建 → 一键进游戏测试 → jar 导出）+ 可插拔工具/插件 + 自定义供应商 + 省 token 压缩 + 用量看板。
>
> 全栈 TypeScript（Fastify + React + Vite，零框架级依赖）；画布基于 Blockbench 5.2.2（GPL-3.0）。参考本地 `deepseek-harness/`（dsh）源码实现界面与交互语义。
>
> **功能速览**
> - 🤖 主代理全能力：权限审批、计划模式、询问用户、拉起/结束终端、文件读写、并发子代理
> - 🎨 建模工作流：画布快照素材库（引用到新会话继续改 / 原地改 / 子代理改动自动回写）
> - ⛏️ MC 开发：`mc_scaffold` 建工程 → 建模子代理出模型 → `mc_gradle build` → 标题栏「▶ 测试 Mod」进游戏 → 「jar ⤓」导出（Forge 1.20.1 / 国内镜像 / 离线构建包）
> - 📊 上下文面板：分段占用、工具用量、耗时分布；设置系统复刻 dsh（providers / bridge / prefs 同一条 revision）
>
> 详细架构与实现文档见本仓库下半部分与 [docs/](docs/)。

---

## 快速开始

```bash
npm install
npm run build:bbcanvas   # 从 ../blockbench 构建无头画布（开发机只需一次；仓库已带构建产物，跳过亦可）
npm run build            # 前端产物 → apps/web/dist
cp .env.example .env     # 按需修改
npm start                # 或 npm run dev（tsx watch + vite）
```

访问 `http://127.0.0.1:8787` → 左栏「＋ 新会话」→ 右 dock 点建议 chip 或中央输入框发消息。

**模式**：
- `MOCK=0`（默认）：真实 LLM——模型来自设置系统（供应商 + key），按请求解析
- `MOCK=1`：离线演示——脚本化假 LLM（冰晶法杖流程），无需任何 key

## 离线构建包（vendor，重要）

`plugins/mcdev/vendor/`（约 243M：Gradle 8.8 发行版 + ForgeGradle `maven_downloader` 全量快照）**不进 git**，两种获取方式：

1. **推荐**：到 [Releases](https://github.com/rover0927/openmods/releases) 下载 `openmods-vendor.zip`，解压到 `plugins/mcdev/vendor/`。解压后新机器/全新 `GRADLE_USER_HOME` 构建零下载（wrapper 免下 Gradle、FG 直连缓存免镜像）。
2. **不下载也能跑**：首次构建时 `mc_gradle` 会自动走国内镜像（USTC bmclapi）补齐缓存，只是慢几分钟且需要联网。

---

# 开发与实现文档（接手文档）


> automods.cn/hx 建模页的本地复刻：dsh 式主界面（三栏 + 状态条）+ 并发建模子代理（同一会话共享画布 + 对话内活动条）+ 无头 Blockbench 预览画布 + 可插拔技能/插件 + 自定义供应商设置 + 省 token 压缩 + 用量看板。
> 全栈 TypeScript，参考本地 `deepseek-harness/`（dsh）与 `blockbench/`（Blockbench 5.2.2）源码实现。
>
> **界面与设置直接照 dsh 重排**：色板/圆角/字号取自 dsh `design-platform.css` 的 dark token（§9）；设置面板复刻 dsh SettingsRoot（800×800、188px 导航、通用/模型/子代理/自动化四页，§8）；右侧拓展改为**可多开、可切换、可关闭的标签页**，并支持 **AI 自己唤醒画布**（§10）。

---

## 1. 快速上手

```bash
cd F:\Project\tscode-ts\openmods
npm install
npm run build:bbcanvas   # 从 ../blockbench 构建 /bb/ 无头画布静态资源（只需一次）
cp .env.example .env     # 按需修改
npm run dev              # server :8787（tsx watch）+ web :5173（vite，仅开发用）
```

**生产形态**：`npm run build`（web 构建到 `apps/web/dist`）后只需 server 一个进程——`http://127.0.0.1:8787` 同时托管前端、API、`/bb/` 画布。**vite dev 可选**（改前端热更新用）。

访问 `http://127.0.0.1:8787` → 左栏「＋ 新会话」→ 右 dock 点建议 chip 或中央输入框发消息。

**模式**：
- `MOCK=0`（默认）：真实 LLM——模型来自设置系统（供应商 + key），按请求解析
- `MOCK=1`：离线演示——脚本化假 LLM（冰晶法杖流程），无需任何 key

---

## 2. 目录结构

```
openmods/
├── apps/
│   ├── server/src/          Fastify：REST + SSE + 静态托管（web dist、/bb/）
│   │   ├── index.ts         主文件：路由、会话管理、插件装配、SSE、子代理生命周期
│   │   ├── session-store.ts 会话磁盘层：目录扫描重建、meta/doc 原子读写、id 校验
│   │   ├── canvas.ts        CanvasService：画布归属（canvasId）+ 载入/提交/广播（dsh workingDirectory 对应物）
│   │   ├── project-store.ts ProjectStore：项目分组 + 全局归档集合（dsh workspace registry 对应物）
│   │   ├── settings.ts      SettingsStore：providers/bridge/prefs/credentials 持久化 + redact + normalizePrefs
│   │   ├── attachments.ts   图片附件：魔数判型 + sha256 内容寻址落盘（日志只存引用）
│   │   ├── files.ts         工作区文件浏览：逐层列目录 + 文本/图片读取（路径锁在 ROOT 内）
│   │   ├── webview.ts       网页标签：嵌入性探测（XFO/CSP）+ 同源代理渲染（注入 <base>）
│   │   └── skills.ts        目录型技能提供器（skills/<name>/SKILL.md）
│   └── web/src/             React + Vite 前端
│       ├── styles.css       全量 dsh dark token（§9）；--content-font 由设置写入
│       ├── markdown.tsx     零依赖 Markdown 渲染（先转义 + 标签白名单）
│       └── components/      LeftSidebar / MainPanel / RightDock / SessionView /
│                           SubagentActivity / StatsTab / ModelPicker / SettingsWindow /
│                           SettingsPage / CanvasPane / DockPreview / Lightbox / ContextMeter
├── packages/
│   ├── agent-core/          无 UI 的 agent 内核
│   │   ├── runtime.ts       SessionRuntime + runTurn + buildSystemPrompt（profile 支持）
│   │   ├── session-log.ts   JSONL 事件日志（append-only）+ surface 重建（压缩感知）
│   │   ├── surface.ts       surface → OpenAI messages + 可注册变换（工具结果裁剪）
│   │   ├── llm.ts           OpenAI 兼容流式适配器（SSE 解析 + 重试）
│   │   ├── mock-llm.ts      离线演示脚本
│   │   └── token-estimate.ts dsh 式 token 估算（4 字符/Token）
│   └── plugin-kit/          插件契约（ToolDef/PluginContext）+ 目录加载器
├── plugins/                 可插拔插件（bb-tools / compaction / stats / mcdev / fs-tools / shell-tools / interaction-tools）
│   ├── bb-tools/            建模工具集（create_model/place_cubes/…/set_animation）+ bbmodel 编译器
│   ├── compaction/          省 token（阈值触发→八段式检查点摘要；工具结果免费裁剪）
│   ├── stats/               看板投影（日志折叠 → 轮/步/token/耗时统计）
│   ├── mcdev/               MC 1.20.1 工程面（scaffold/文件/gradle/日志/模型导出 + MDK 模板）
│   ├── fs-tools/            工作台文件读写（read/write/edit/list_dir/glob/grep，越界需授权）
│   ├── shell-tools/         命令与终端（bash/terminal_open|list|read|send|kill，执行需授权）
│   └── interaction-tools/   人机交互（ask_user_question/todo_write/exit_plan_mode）
├── skills/                  可插拔技能目录（blockbench-* + minecraft-forge-1.20.1）
├── bbcanvas/                无头 Blockbench：dist（web 构建+补丁）+ bb-bridge.js 桥接插件
├── data/                    运行时数据（gitignore）：sessions/*.jsonl、*.meta.json、*.bbdoc.json、projects.json、settings.json、credentials.json
├── scripts/build-bbcanvas.mjs  bbcanvas 构建脚本
├── .env                     运行配置（MOCK/PORT/LLM_*/COMPACTION_*）
└── README.md                本文档
```

同级参考仓库（不在 openmods 内）：`../deepseek-harness/`（dsh 源码）、`../blockbench/`（Blockbench 源码）、`../minecraft-dev/`（dsh 插件范本）。

---

## 3. Agent 架构

### 3.1 会话运行时（packages/agent-core/runtime.ts）

- **事件日志**：每会话一个 `data/sessions/<id>.jsonl`，append-only。事件：`turn/start|end`、`user/message`、`assistant/message`、`tool/call|result`、`llm/usage`、`step/start|end`、`compaction/start|summary|end`、`model/updated`。**回放即状态**（压缩不篡改历史，影子化由 `compaction/summary` 事件表达）。
- **会话持久化**：`data/sessions/` 是唯一事实来源（`<id>.jsonl` 事件 / `<id>.meta.json` 模型选择+创建时间+标题 / `<id>.bbdoc.json` 画布快照）。内存 `sessions` Map 只是热缓存：`GET /api/sessions` 每次扫描目录重建列表，新会话建好即落 meta+空日志，因此刷新/重启后会话、标题、模型选择、画布都不丢。所有 JSON 落盘走 tmp+rename 原子写。标题推导按**完整行**扫描日志（首条消息带 base64 附图时可能接近 1MB），超长行会兜底从半截 JSON 里抠 `text`，不会出现"有内容的会话显示新会话"。**画布按会话树归属**：`<id>.meta.json` 里的 `canvasId` 是 durable 字段（根=自己，子代理=父会话的值），画布服务按它读写——子代理不会产生 `<childId>.bbdoc.json`，也没有合并两块画布这种运行时逻辑。
- **runTurn 流程**：图片链路（见 §5）→ 逐 step：压缩钩子 → build surface（系统提示 + 未影子化条目，工具结果过裁剪变换）→ `llm.chat` 流式 → tool_calls 则逐个执行并落日志 → 无 tool_calls 则收尾。`MAX_STEPS=12`；`AbortController` 支持"停止"。**每个工具调用前过两道内核闸**：① 计划模式下 `def.mutates` 一律拦截（插件无需各自实现）；② `guardApproval()` 处理 `def.requiresApproval`（授权策略 `auto`/白名单放行，否则经 `approval.request` 阻塞等待用户弹窗答复）。
- **profile（代理角色）**：`AGENT_PROFILES`（server/index.ts）定义 `lead`（主代理：完整工作台 + 委派 + 汇总，见 §3.4）、`mcmod`（Minecraft 1.20.1 模组开发主代理，工程工具 + 完整工作台 + 委派）与 `modeling`（建模子代理：建模工具全集，`toolExclude` 掉工作台与 spawn/list）。用户消息默认走 `lead`；显式 `profile` 覆盖。`toolFilter`（白名单）/`toolExclude`（排除）双机制；`WORKSPACE_TOOLS` 常量统一列出工作台工具，主代理档案直接展开它。

### 3.4 主代理工作台（对标 dsh 主 agent 的全能力）

对标 dsh 主 agent，主代理 `lead` / `mcmod` 拥有完整工作台能力；建模子代理 `modeling` 被排除（无人值守，不能等待弹窗）。

- **文件读写（plugins/fs-tools）**：`read`（行号化分段读）、`write`（创建/整体覆盖）、`edit`（字面量唯一命中替换）、`list_dir`、`glob`（零依赖 **/*/?/{a,b}）、`grep`。路径一律相对**会话工作目录** `SessionMeta.cwd`（左栏可改，子代理继承）；读写工作目录外的路径时 `requiresApproval` 动态判定 → 弹窗请求授权。
- **命令与终端（plugins/shell-tools + apps/server/src/terminals.ts）**：`bash`（前台等待 120s / `run_in_background` 转后台）、`terminal_open|list|read|send|kill`。终端用 `child_process` 管道实现（保留输出环形缓冲、状态、退出码、stdin 写入、进程树终止），Windows 优先 Git Bash、退化为 cmd，可用 `OPENMODS_SHELL` 覆盖。`bash`/`terminal_open` 带 `requiresApproval`，执行前请求授权。右侧「终端」标签实时显示输出、支持用户接手输入；终端事件 `terminal/open|data|exit` 走 SSE，打开会话时从 `GET /api/terminals` 恢复列表与最近输出。
- **人机交互（plugins/interaction-tools + apps/server/src/interaction.ts）**：`ask_user_question`（结构化多选/单选/文本提问）、`todo_write`（整表替换任务清单）、`exit_plan_mode`（提交方案评审）。工具在服务端 `await` 用户答复，弹窗提交后同一回合自动继续；未答问题 durable 存 meta，刷新/重连后补弹窗。
- **计划模式（dsh `/plan`）**：输入区「☰ 计划」开关或右侧「计划」标签切换。开启后所有 `mutates` 工具在运行时统一拦截，AI 只能只读调研 + `todo_write` 列步骤 + `exit_plan_mode` 提交方案；用户批准后自动退出计划模式。状态（planMode / todos / permission / 总是允许的白名单）全部 durable 到 meta。
- **授权策略**：输入区「授权·询问 / 授权·自动」开关切换（会话级）。`ask`=写/命令/越界文件操作弹窗询问（可"总是允许"此工具），`auto`=本会话自动放行。运行时 `approval` 端口统一裁决，`guardApproval()` 落 `approval/asked|decided` 日志。
- **实测**（MOCK 离线模式）：HTTP 能力测试 18/18 通过（计划模式开关与 durable 回读、授权切换/非法值拒绝、终端拉起/回显/输入/kill/列表、会话协作字段），CDP 截图确认输入区两个开关 + dock「终端」「计划」标签 + 终端面板空状态与新建终端输入框均正常渲染。

### 3.2 子代理（复刻 dsh `ui-subagent` / `subagent` 核心语义）

**一句话**：子代理是**当前会话里临时启用的并行 agent**——有独立对话与上下文，但**共享主会话的画布**；并发运行。派发后主会话进入**等待态**（会话没结束，但用户不能插话），全部子代理结算后**自动开一轮汇总回合**做核对与验收。

> **与 dsh 的对应（这是本节的实现依据）**
> dsh 的「工作区」不是一个可以传递的对象，而是会话头部的 `cwd`：`childSessionMeta()` 让子会话继承 `parentHeader.cwd`，`WorkingDirectoryService` 按 session 解析目录、`ctx.fs` 是唯一读写入口，变更经 `systemPrompt.context` 与会话事件传播。openmods 把「工作区」映射成**画布**，照同一套结构实现：
> - `canvasId` 是会话的 **durable 字段**（写进 `<id>.meta.json`），子代理创建时继承父会话的值——等价于 dsh 把 cwd 钉进子会话 header；
> - `CanvasService`（`apps/server/src/canvas.ts`）是唯一读写入口，运行时/插件只拿到 `CanvasPort`（`idOf/read/ensure/commit/setView/contextText`），**没有人传递 state、没有人手动广播**；
> - `contextText()` 每轮作为 `[当前会话]` 注入系统提示——对应 dsh `workingDirectory` 的 contextText 贡献；
> - 变更通过 `onChange` 订阅传播，每条 SSE 连接按自己的 `canvasId` 过滤——对应 dsh 事件总线 + 会话投影。

- **派发**：主代理工具 **`spawn_modeling_subagent({description, prompt, name?})`** 立即返回 `started subagent <name>（<id>，共享当前画布）`，服务端随即 `createSession({parentId, canvasId, agentName, description})`、登记到父会话的 `waiting` 集合，并后台 `runSessionTurn(child, {profile:'modeling'})`——与 dsh `startActivation()` 一致：立即返回句柄，完成由运行时通知。
- **等待 → 自动汇总（复刻 dsh 的 settlement → 新回合）**：
  - **等待态**：`SessionEntry.waiting: Set<childId>` 是「这次派发还没回来」的唯一事实源。lead 回合结束后若有等待中的子代理，会话进入 `waiting`：**不是 idle**（会话没结束），但 `/chat` 返回 `409 session-waiting`，前端锁输入（textarea `readOnly`）、顶部显示 `⏳ 等待 N 个子代理完成`、按钮变为「取消等待」。此时 `open` 帧与 `GET /api/sessions/:id` 都带 `waiting: [{id,name,description,status}]`。
  - **结算**：子代理回合收尾调 `settleChild()`——出等待集合、进结算收件箱 `parent.settlements`；最后一只落地时 `maybeAutoContinue()` 自动开一轮汇总。
  - **汇总回合的输入由 runtime 投递**（不是用户手打）：`user/message` 带 `source: { kind:'subagent-settled', form:'notice', settled:[…] }`，正文照 dsh `createSettlementMessage()`——`Background subagent X finished and will do no further work unless you send it more.` + `Its closing message:`，多个子代理合并进同一条；末尾接一段 runtime 验收要求（`list_outline`/`list_animations` 核对、只补缺口、汇报最终状态）。前端按 `form:'notice'` 渲染成**通知行**（`TurnCard` 的 `notices`），不会显示成绿色用户气泡。
  - **忙时排队**：dsh 在父会话忙时用 `steer` 把结算塞进当前回合；openmods 没有 steer 通道，所以结算先留在收件箱，由回合收尾 `afterRootTurn()` 再启动；汇总回合**运行期间**新到的批次由 `maybeAutoContinue` 的 `finally` 复查补发，不会被静默吞掉。
  - **不误唤醒**：用户手动给某个子代理派活（不在 `waiting` 里）时，它的结算仍只落一条独立 `subagent/notice` 事件，主会话不会被自动唤醒——那是「人和子代理的对话」。
  - **取消**：等待中 `POST /api/sessions/:id/stop` = 中止整批子代理 + 清空收件箱 + 解锁，不会再自动汇总（返回 `{ok, cancelled:n}`）。归档（`stopSessionWork`）同样清空等待集合与收件箱，归档会话不会被自动唤醒。
- **共享画布**：子代理的 bb-tools 提交到 `canvasId` 指向的那份文档（= 根会话的 `<canvasId>.bbdoc.json`），主会话与所有子代理读到的永远是同一份。`CanvasService.commit()` 一次完成「编译 bbmodel → 原子落盘 → 广播 `model_update`（带 `originId`/`agentName`）」，因此主会话画布能实时显示 `staff-1` 正在搭的部件。**子会话不会产生自己的 `.bbdoc.json`**。
- **并发**：`MAX_ACTIVE_SUBAGENTS`（env，默认 4）限制同时运行数；每个子代理有独立 `SessionLog` / `SseWriter` / `AbortController`，互不阻塞。**深度恒为 1**：子代理的 `toolExclude` 掉 `spawn_modeling_subagent` 与 `list_subagents`。
- **共享画布防冲突**：
  - `CanvasService.contextText()` 每轮注入 `[当前会话] 画布已有 N 个部件，分组：…`，子代理知道工程已存在、该往哪个骨骼里加。
  - `create_model` 在画布已有部件时**默认拒绝**（需显式 `reset:true` 才清空），避免并发子代理把别人的成果洗掉。
  - 建模 profile 明确要求「先 `list_outline`、增量追加、复用同名骨骼、不要重建」。
- **命名**：`/^[a-z][a-z0-9-]{0,31}$/`、非保留名 `lead`、同级唯一；缺省自动 `agent-1`、`agent-2`…
- **观测**：
  - `GET /api/sessions/:id/subagents` 返回目录（`agentName`/`description`/`status`/`lastText`/`durationMs`/`outputTokens`），运行中状态仅存内存，非 running 结果落 `<id>.meta.json` 供重启恢复。
  - `GET /api/sessions/:id/stream` 统一事件流（EventSource，`id:` 帧序号 + `Last-Event-ID`/`since` 补发）。连上先发一帧**画布快照**，之后订阅 `CanvasService.onChange` 并按 `canvasId` 过滤——主会话与子代理的视图因此始终同步。
  - `GET /api/sessions/:id` 返回 `canvasId`；`GET /api/sessions/:id/bbmodel` 对子代理 id 也返回同一块画布，`PUT` 同样写回它（`canvas.commit`）。
  - `list_subagents` 供汇总回合里核对各子代理的汇报原文（**推一次结算，拉细节**；运行中不必轮询）。
- **信息边界**：主会话日志里，批次的结算会变成**汇总回合的 user 消息**（带 `source`，进 surface——模型必须看到结果才能验收）；非批次的结算只落一条 `subagent/notice` 事件（字段照抄 dsh `SubagentSettledMessageSource`：`{ kind:'subagent-settled', form:'notice', summary, stopReason, senderSessionId }`，不进 surface）。子代理的中间步骤仍只在其自身对话可见（画布变化是共享的）。
  > 与 dsh 的唯一结构差异：dsh 的父会话等待期间仍可接受用户输入（结算用 `steer` 挤进当前回合）；openmods 明确锁输入，因为共享画布上「用户新指令」与「子代理并行改动」会互相踩，等结算完再说话更安全。
- **前端**：header `👥 运行数/总数` 触发 360px 下拉目录（`SubagentMenu`，复刻 dsh `SubagentHeaderLineage`：状态点 + 描述为主标题 + agentName 次行 + token/时长 + 行内 ■ Stop）；点条目打开该子代理的对话（顶部仍显示根会话 id + 子代理徽标），**右侧画布不变**，dock 头显示「共享画布 · 最近改动的 agent」；聊天区只留一行紧凑通知 + 「对话」按钮。切换主/子视图时同一块画布不重载（`loadCanvas` 按 canvasId 去重）。
- **历史数据**：早期版本子代理各自持有一块画布（根反而没有快照）。这批数据已用一次性脚本迁移：按 parentId 链算出每个会话的 `canvasId` 写回 meta，根缺快照时认领最早创建的子会话快照，子会话遗留的 `.bbdoc.json` 移入 `data/sessions/_archive-20261114/`。运行时代码里**没有**合并/迁移分支——`5b4e556a` 的 192 部件菲比就是这样恢复的。

**扩展**：新增子代理角色 = `AGENT_PROFILES` 加一条（prompt + toolFilter）+ 如需专属工具注册新插件。`spawn_modeling_subagent` 的 `profile` 由调用点固定为 `modeling`，要换角色在此处传参。

**截图**（`docs/screenshots/`，MOCK 实测）：`shared-canvas-root.png` 主会话视图——两条紧凑通知 + 👥2 + 右侧共享画布（26 部件，dock 头「共享画布 · staff-2」）、`subagent-menu.png` 下拉目录（同类会话语义文案）、`subagent-session.png` 子代理对话（顶部仍是根会话 id，右侧同一块 26 部件画布，输入框提示「画布与主会话共用」）、`sessions-after-cleanup.png` 归档测试会话后的真实会话列表、`settings-model-capabilities.png` 设置页模型能力（flash 已勾视觉、窗口 1048576）。

### 3.3 LLM 适配器（packages/agent-core/llm.ts）
- OpenAI 兼容 `/chat/completions` 流式；解析 delta/tool_calls/usage（含 `cached_tokens`）。
- **推理模型的思考流**：`delta.reasoning_content`（兼容 `reasoning` / `reasoning_text`）单独累积，经 `onReasoningDelta` → SSE `assistant/reasoning` → 前端「思考过程」块；**只展示、不写回下一轮 messages**（DeepSeek 明确拒绝回传）。首字延迟按"第一个 token（思考或正文）"计，避免纯思考步骤看起来没开始。
- **重试**（复刻 dsh llm-retry）：网络层失败 / 5xx / 429 自动重试最多 3 次（800ms×attempt 退避）；流已开始后不重试。
- **per-request 供应商解析**（复刻 llm-pi-ai）：`model` 传 `"providerRoute/llmModel"` 复合串，server 端适配器每次现查 SettingsStore 取 baseURL/key → **下一轮生效**，无 key 供应商也放行（匿名端点可用，401 由端点明确报出）。
- 可选代理：`.env` 设 `HTTPS_PROXY` → undici ProxyAgent 全局接管。

### 3.4 项目分组与归档（复刻 dsh `workspace` registry）

**一句话**：会话按「项目」分组，没归属的落在**未分组**（默认目录）；归档是**全局软删除**——隐藏、可筛选、可撤销，归档的会话不接受新回合，但会话记录与画布都还在。

> **与 dsh 的对应（本节的实现依据）**
> dsh 的 `dsh-workspace` 把「项目」建成一条 durable 记录 `{ id, path, title, sessionIds }`（`WorkspaceView`），注册表是单文件 durable 状态（projects + `archivedSessionIds` + `pinnedSessionIds`），所有写操作走一条串行链（`enqueueOperation`）以杜绝 check-then-write 交错；归档是 **registry-global 集合**，**不动 `sessionIds` 记账**，所以取消归档能回到原位；归档时「还有活没停」由 `workspace/session-activity` waterfall 探测，`stopActivity:true` 才先落归档再停工作；归档后的会话由 `archived-session-gate` 在 `agent/pre-step` 拒绝运行；删除工作区只删注册（dsh 文案：文件夹与会话记录会保留，其会话将显示在“未分组”下）。
> openmods 逐条对应：
> - `ProjectStore`（`apps/server/src/project-store.ts`）= `WorkspaceRegistry`；状态落 `data/projects.json`，三段 `projects` / `membership` / `archivedSessionIds`，tmp+rename 原子写，写操作串行；
> - `project.sessionIds` = 手动顺序记账：attach 置顶，聊天活动**不重排**；
> - 归档集合跨所有分组面生效；`GET /api/sessions?archived=hide|all|only` 对应 `viewOptions.hideArchived / showArchived / onlyArchived`；
> - `POST /api/sessions/:id/archive` 在会话仍在跑时回 **409 + activity**（`turn` / `subagent`），前端据此弹「停止并归档」——对应 dsh 的 `workspace/session-active` 与归档确认框；
> - 门控：`/chat` 与 `spawn_modeling_subagent` 都走 `isArchivedLineage()`（沿 parentId 回溯），归档主会话 = 整棵子代理树停摆——对应 dsh `underArchivedSession`；
> - 删除项目 = 删注册 + 清记账，会话回落未分组，日志与画布分毫不动。

- **两种「删除」要分清**：**归档会话**（软删除，可撤销，进 `archivedSessionIds`）与**删除项目**（只注销分组，会话变未分组）。dsh 同样没有会话硬删除——要彻底清掉，按 §16 把三个文件移进 `_archive-<日期>/`。
- **归属**：`POST /api/sessions {projectId}`（或在侧栏项目头点 `＋`）在该项目下新建；已有会话用行内 `⋯ → 移入项目` 调整。一个会话只属于一个项目，移入即从原项目摘除。
- **前端**（`LeftSidebar`）：项目组 / 未分组两级列表；组头可折叠、可重命名、可删除；行内 `⋯` 菜单含「移入项目 / 归档会话」；归档成功弹 8 秒 toast 带**撤销**（dsh `toast.archivedUndo`）；已归档行置灰+删除线，点击提示「已归档对话暂时无法查看，请取消归档后查看」（dsh 同款文案）。
- **分组可关联一个主机目录**（dsh Workspace 的 `path`，这里叫 `cwd`）：新建分组时绑定，该分组下**新建**的会话继承它作为工作目录；会话仍可单独改绑。详见 §12.3。
- **与 dsh 的差异（有意放宽）**：dsh 的 Workspace **必须**指向一个已存在的主机目录（`realpath` 校验），且 attach 时会话 `cwd` **必须等于**该目录。openmods 允许分组**不关联**任何目录（画布才是主要工作产物），关联时也只作为**新建会话的默认值**——会话随后可以单独改绑到别的目录，dsh 的等值约束没有照搬。

---

### 3.5 思考过程与消息渲染

**问题原状**：DeepSeek 这类推理模型把"想什么"放在 `delta.reasoning_content`，把"说什么"放在 `delta.content`。适配器原来只认后者，于是**纯工具调用步骤的全部输出都被丢掉**——`dbc353ce` 这个会话里 6 个回合的 6 个工具步骤，`outputTokens` 分别是 1676 / 325 / 5988 / 992 / 1269 / 729，而落库正文全是 0 字符；界面上只剩运行横幅的「已想 0 字」一直挂着。

现在这条链路是：

| 环节 | 实现 |
|---|---|
| 适配器 | `llm.ts` 累积 `reasoning_content`（兼容 `reasoning` / `reasoning_text`），返回 `LlmResult.reasoning` |
| 运行时 | `onReasoningDelta` → SSE `assistant/reasoning`；`assistant/message` 事件落 `reasoning`（单步上限 64k 字符） |
| 上下文 | **不回放**：`buildSurface` 不读 reasoning，不算 token，也不进下一轮 messages（DeepSeek 回传会 400） |
| 运行态 | 横幅「AI 正在思考 · 已想 N 字」（N 同时计思考与正文）+ 第二行滚动显示思考流末尾 240 字 |
| 结算后 | 每条回合一个折叠块「思考过程 · N 字」，默认收起（`openThink ?? streaming && 无正文`），展开后是弱化色正文 + 左侧细边 |

**为什么正文里会露出 `**`**：助手回复是 Markdown（标题/列表/加粗/代码块)，原来按 `white-space: pre-wrap` 原样输出。新增 `apps/web/src/markdown.tsx`（无第三方依赖）：先整体 HTML 转义，再只放行自己生成的 `strong/em/code/pre/ul/ol/li/blockquote/a`，链接只允许 `http(s)`，所以模型输出里的任何 HTML 都当纯文本。用户气泡不渲染 Markdown（用户打什么就显示什么）。

**验证**：真实端点（`api.deepseek.com` / `deepseek-flash`）实测 delta 里只有 `reasoning_content`（64 个分片、无 content），与本修复前的 0 字现象完全对应；MOCK 层现在也会先流一段思考，CDP 实测「已想 564 字」「思考过程 224 字」、展开有内容、0 page error。

### 3.6 上下文占用与图形化面板（复刻 dsh `ui-conversation/ContextMeter`）

composer dock 里的环是**常驻**的（`.ctx-meter`，不因占用为 0 而消失）：分子取 `estimateContextTokens()`（`llm/usage.promptTokens` 作锚点 + 锚点之后新增 surface 的启发式，压缩后锚点失效回落全量估算），分母取当前模型的 `contextWindow`。点一下环弹出 264px 面板：

| 部分 | 来源 |
|---|---|
| 头部 | `上下文已用 N%` + `~已用 / 窗口`（k / M 压缩，`tabular-nums`） |
| 分段条 | 4px 高、圆角、1px 间隙，按三段**比例**分配百分比总长（dsh 同款取舍：总量是 provider 口径，比例是启发式） |
| 图例 | 系统提示词 `--meter-system` / 工具定义 `--meter-tools` / 对话 `--meter-messages`，各带 8px 色块与 `~tokens` |

三段里**只有系统提示词与工具定义单独估算**（`estimateText(systemPrompt)` / `estimateToolDefs`），
「对话」= 总量 − 这两段 —— 三项之和**恒等于环上的分子**，不会出现「1% 却 336k tok」这种自相矛盾。
图片按引用计价、不还原 base64：`estimateContextTokens` 的启发式分支与 `contextBreakdown` 都不传 `resolveImage`
（dsh `estimateStructuralBlock` 对 image 只算引用 JSON；一张图的 data URL 能把占用虚报成几十万 token）。

数据通路：`runtime.contextBreakdown(total?)` → `contextFigures(s)`（`apps/server/src/index.ts`）→
`GET /api/sessions/:id`、`GET /api/sessions/:id/stats`、每次 `stats` SSE 帧都带 `contextBreakdown`；
前端 `ctxBreakdown` 状态透传 `MainPanel → SessionView → ComposerDock → ContextMeter`。
Esc 或面板外 `pointerdown` 关闭；`aria-haspopup="dialog"` / `aria-expanded` 齐全。

### 3.7 Minecraft 1.20.1 模组开发代理（mcmod + plugins/mcdev）

composer 的模型 chip 左边多了一个**代理角色**下拉（`GET /api/profiles`，选择存 `localStorage openmods.profile`，
并随会话 meta 持久化）。两个角色：

| 角色 | 定位 |
|---|---|
| `lead`（默认） | 原来的主代理：对话 + 建模委派 |
| `mcmod` | **只做 Java + MC 1.20.1 + Forge 47.x** 的模组开发主代理 |

`mcmod` 的工具面来自 `plugins/mcdev`（新插件，`ctx.tools.register`）：

| 工具 | 作用 |
|---|---|
| `mc_scaffold` | 从 `plugins/mcdev/template/forge-1.20.1`（官方 MDK 47.4.10 快照）建工程：替换包名/modid/主类、写 `gradle.properties`、生成 ruby 示例的物品模型/贴图/语言文件 |
| `mc_list` / `mc_read` / `mc_write` | 工程内文件读写；路径 `realpath` 前缀校验，`../../evil.txt` 会被拒 |
| `mc_gradle` | 在工程里跑 `gradlew`；普通任务同步等（默认 600s，返回尾部 8k 输出），`background=true` 立即返回 pid（`runClient` 用），控制台写 `run-console.log`。**跑之前自动播种离线缓存**：vendor 快照补 `maven_downloader`（`seedMavenCache`）+ vendor 发行版种 wrapper dists 免下载（`seedWrapperDist`），镜像只做兜底 |
| `mc_log` | 读 `run/logs/latest.log` 尾部 + 启动标记（`Sound engine started` / `Forge mod loading` / `Backend library: LWJGL`）+ 崩溃提示 |
| `mc_export_model` | 把画布上的 bbmodel 转成 Java 版 `models/item/<name>.json`（Blockbench 中心原点 → Java 0..16）并把画布贴图（或纯色）写成 16×16 PNG |

技能 `skills/minecraft-forge-1.20.1/SKILL.md` 是这套东西的知识面：版本钉选、`DeferredRegister`、双事件总线、
资源三件套、构建/启动命令、国内镜像、常见坑；精确签名在 `references/forge-1.20.1-api.md`。

**镜像（实测，2026-11）**：首选 `https://unicom.mirrors.ustc.edu.cn/bmclapi/`（直连、无跳转、6MB/s），
`bmclapi2.bangbang93.com/maven/` 是 302→cernet→ustc 的链，偶发 404/半截，只作备选；
`libraries.minecraft.net`（1MB/s）与 `resources.download.minecraft.net`（2.3MB/s）保持官方即可。
ForgeGradle 有两类下载链路要分别处理：

1. **走 Gradle 仓库的**：模板 `settings.gradle` 用 `gradle.beforeProject { … whenObjectAdded { … } }`
   在仓库刚被加进来时就把 `maven.minecraftforge.net` 改写成镜像（放到 `projectsEvaluated` 已经太晚，
   配置阶段就开始解析了）；`gradle-wrapper.properties` 指向腾讯云的 Gradle 8.8。
2. **拿编译期常量直连的**（`Utils.FORGE_MAVEN` 是 `static final String`，会内联，运行期改不了）：
   只能预先把文件摆进 `<GRADLE_USER_HOME>/caches/forge_gradle/maven_downloader/`。
   已由 `mc_gradle` 自动完成，清单见 SKILL.md §7.2（installertools / mergetool / renamer /
   mcp_config 的两个版本号 / forge 的 installer·universal·userdev·sources）。
3. **必须关开机自检**：`systemProp.net.minecraftforge.gradle.check.certs=false`。`UserDevPlugin.apply`
   会拿 `HttpURLConnection` 去官方源做 SSL 握手自检且**没有超时**，线路一卡构建就无声挂起
   （日志停在 `Daemon will be stopped…` 之后，`jstack` 能看到卡在 `EnvironmentChecks.testServerConnection`）。

**离线构建包（`plugins/mcdev/vendor/`，约 243M，随项目走）**：新机器/新 `GRADLE_USER_HOME`
不再从零起步——

- `vendor/gradle-8.8/`：解压好的 Gradle 8.8 发行版。`seedWrapperDist` 按工程
  `gradle-wrapper.properties` 的 `distributionUrl` 算 wrapper 缓存 key（URL 的 MD5 → base36，
  与 Java wrapper 同一算法），复制成 `wrapper/dists/gradle-8.8-bin/<key>/` 并落 `.ok` 标记，
  gradlew 视为已安装、免联网下载。
- `vendor/fg-maven/`：FG `maven_downloader` 全量快照（96M，除 FG_SEED 清单外还含 runClient
  要的 moang 库 authlib/brigadier/fastutil…，全部带 `.md5`）。`seedMavenCache` 先整树补缺
  （只补缺失不覆盖），快照没盖住的才走镜像兜底。
- 播种时机：`mc_gradle`（前台/后台）、UI「测试 Mod」按钮，均跑在 `runGradle`/启动器路径上。
- 边界：仍需网络的部分是 FG 插件本体与 Gradle 依赖解析（走 settings.gradle 的镜像改写）和
  runClient 的 assets（633MB，`resources.download.minecraft.net` 官方源）。

实测基准：缓存预热后 `build` 2m50s、`runClient` 到主菜单约 25s；assets 633MB 首次约 4 分钟。
官方 `-Xmx3G` 在空闲内存不足的机器上会让 daemon 被系统静默杀掉（`daemon has disappeared`），模板已降到 `-Xmx2G`。

建模衔接：造型派给 `spawn_modeling_subagent`（共用当前画布），汇总回合再 `mc_export_model` 落到
`src/main/resources/assets/<modid>/`；Java 物品模型只支持单轴 rotation，旋转不导出。

---

## 4. 插件系统（packages/plugin-kit）

```ts
interface Plugin { name: string; config?: object; apply(ctx: PluginContext, config): void }
interface PluginContext {
  tools: { register(def) }                    // 工具（LLM function calling）
  skills: { registerProvider(p) }             // 技能提供器
  events: { on/emit }                         // 内部总线（server 桥接为 SSE）
  hooks: { beforeStep, onOverflow,            // 压缩挂载点
           registerSurfaceTransform,          // 发送前变换（如裁剪）
           registerSystemSection }            // 系统提示附加段
  llm: { complete({messages, modelId}) }      // 插件用 LLM 调用（如压缩摘要）
  env
}
```

加载：`loadPlugins('plugins/', ctx)` 逐目录 `import index.ts`（tsx 运行时编译），失败跳过。现有插件：

| 插件 | 职责 |
|---|---|
| **bb-tools** | 建模工具：`create_model / place_cubes / modify_cube / delete_elements / add_group / list_outline / set_camera_view / set_animation / remove_animation / list_animations`；每次变更 `sync()` → `canvas.commit()`（编译 bbmodel + 原子写 + 广播，全在 CanvasService 内，插件不碰存储与 SSE） |
| **compaction** | 省 token（§11） |
| **stats** | `projectStats(events)` 纯函数投影（看板数据源） |

---

## 5. 图片输入（复刻 dsh `attachment/*` + `llm/content.ts`）

**模型能力标记**（搬运 dsh `llm-deepseek/src/models.ts` + `model-info.ts`）：
- 事实源是条目的 `inputModalities`（`['text','image']` 才收图）；`vision` 只是它的派生/兼容字段。
- **未逐个声明的模型自动回落到内置官方目录**：`deepseek-flash` = text+image、`deepseek-v4-pro` = text-only，两者上下文窗口均 **1,048,576**（官方 `/models` 声明值）。所以只写 `{id,name}` 的 settings.json 也能正确收图，不必手勾。
- 未在目录里声明的自定义模型按 **text-only** 处理（dsh 注释原话：声明未经验证的图像能力会让宿主持久化端点可能拒绝的输入）；要收图就在设置页勾 👁，或让 `⟳ 自动获取` 读到端点的 `input_modalities`。

**发送带图消息**（`runTurn` 内，每轮实时读取模型能力）。dsh 没有“转述模型”这一层，openmods 也已删掉它：

| 当前模型 | 行为 |
|---|---|
| 收图（`inputModalities` 含 image） | 图片按引用取回字节 → `image_url` parts **直发上游** |
| 不收图（纯文本路由） | 图片**不发出**；当日消息末尾追加一行确定性占位文本 `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`（与 dsh `projectImagesForTextModel` 逐字同构），`imagesOmitted=true` |

- **客户端**只发 `{type:'image', dataUrl, name}`；**服务端** `/chat` 先准入再发布（`apps/server/src/attachments.ts`）：魔数判型（只认 png/jpeg/webp/gif）→ sha256 → 落 `data/attachments/<digest>.<ext>`（相同字节只存一份）→ 日志与 SSE 里换成 `{type:'image', attachment:{attachmentId, mediaType, bytes, name?}}`。
- **会话日志不含 base64**（与 dsh 一致）：`GET /api/attachments/:id` 是唯一出口，前端 `<img>` 与「图片」标签都走它；历史遗留的 data URL 仍可读（只兼容，不迁移）。
- 准入限制：单条 ≤20 张、单张 ≤50 MiB（dsh attachment-local 默认值）；超出直接 400，不会写出半截文件。
- **前端入口**：中央 composer `＋`/**Ctrl+V 粘贴**、右 dock「三视图」——共享同一条待发队列（缩略图预览 + hover ✕），发完可在右侧「图片」标签回看全部参考图。
- **消息列表直接显示参考图**：用户气泡里铺缩略图（单张 176×132 `object-fit:contain` 不裁切，多张 76px 网格），点击开灯箱（`components/Lightbox.tsx`，与右侧「图片」标签共用同一个组件）。纯文本模型那轮图片没发出去时，缩略图照常显示并补一行说明——图是用户自己贴的，看不看得见不该取决于模型能力。

**与 dsh 的差异（明确的简化）**：dsh 还会按模型路由二次重编码（长边 ≤2048 / 4 MiB 质量梯）并在超预算时把最老的图换成带只读路径的文本句柄（`compaction-image-offload`）；openmods 目前直接原字节发送、靠模型端点自己缩放，也没有 image/offload。需要时按 `readImageRequest` 的位置补即可。

**验证**：MOCK 实测——带图直发时模型收到 `image_url`（mock 回复“参考图描述：…”）；切到 `deepseek-v4-pro` 再发同一张图，日志里 `imagesOmitted=true` 且正文尾部是那行占位文本；`<id>.jsonl` 里 `data:image` 出现次数为 0，`data/attachments/` 下一个 `<digest>.png`，`GET /api/attachments/sha256:<digest>` 返回 200 + image/png。

---

## 6. 动画（set_animation）

- 服务端文档模型 `BbAnimation`：`{name, length, loop: 'loop'|'once'|'hold', bones: {骨骼名: [{time, rotation?, position?}]}}`——骨骼名必须是已存在分组（`findGroup` 校验，缺失时报出可用列表）。
- 编译输出 Blockbench 格式（animators/keyframes/data_points，rotation 值为文件格式坐标，Blockbench parse 会自行转内部约定）。
- **播放**（bb-bridge.js）：
  1. `Modes.options.animate.select()`（渲染循环只在 `Animator.open` 时驱动时间轴——**关键坑**）
  2. `anim.select()` → `Timeline.setTime(0)` → `Timeline.start()`
  3. **独立定时器驱动**（`__bbAnimDriver` setInterval 30fps 调 `Timeline.loop()`）——iframe 的 rAF 会被宿主节流，这是调试中发现的最深坑
  4. 前端动作条：右 dock 画布下方，chips 点击播放/再点停止，播放中高亮 + 「■ 停止」；状态经 `animation_state` postMessage 回传

---

## 7. 无头 Blockbench 画布（bbcanvas/）

- 构建：`npm run build:bbcanvas` → 复用/重建 `../blockbench` 的 web target（esbuild，`dist/bundle.js`）→ 拷贝运行时资源 → 补丁 index.html（head 注入：**噪音屏蔽 stub**（SW register no-op、blckbn.ch fetch/XHR 短路）+ 错误收集器；body 尾注入 bb-bridge.js；写空 `service_worker.js`）。
- **bb-bridge.js**（GPL-3.0 注记，修改版构建产物需同 GPL 开源）：
  - kiosk 模式（`html.bb-kiosk` 类）：隐藏全部编辑 UI（header/toolbars/bars/panels/**timeline 面板**/start_screen）+ 强制 `#preview` 铺满（`!important` 压过 Blockbench 写入的内联 height——**播放动画时画布缩小的修复点**）+ grid 模板改单列
  - postMessage 桥：`load_bbmodel`（setupProject + Codecs.project.parse）/ `set_view` / `play_animation` / `stop_animation` / 回传 `bb_ready`、`bb_loaded`
  - 后台渲染：`settings.background_rendering.value = true`（dock 无焦点时渲染循环不停）
- 已移除：编辑模式切换（用户明确不要——右面板是纯预览）。

---

## 8. 设置系统（复刻 dsh SettingsRoot / ui-settings）

- **置顶子窗口**（`SettingsWindow.tsx`）：overlay + mask + **800×800 居中面板**——`grid-template-columns: 188px minmax(0,1fr)`、`areas: 'title header' / 'nav options'`、`border-radius: 28px`；nav cell 40px 高 r12，options 区 `padding: 0 24px 24px` 独立滚动；<768px 面板铺满 + 横向导航。右上「打开配置文件」下载 settings.json + ✕ + Esc 关闭。
- **五个分区**（按 dsh ui-settings 的粒度收敛，`SettingsPage.tsx` 内 `SettingsSectionId`）：

  | 分区 | 内容 |
  |---|---|
  | 通用 `general` | 主题（深色 / 浅色暂禁用）、字号（小 13 / 标准 14 / 大 15）、发送键（Enter 发送 / ⌘Ctrl+Enter 发送）、Mod 构建输出目录、revision + 打开配置文件 |
  | 模型 `models` | 供应商卡片（显示名 / Base URL / key write-only / 模型行编辑器）+ ⟳ 自动获取 + 桥接模型；保存按钮只在本页 |
  | 代理与技能 `agents` | 三个角色（lead / mcmod / modeling）的可调用工具 chips 与技能勾选分配（`PATCH /api/agents/:id/skills`，覆盖写 `data/agent-skills.json`）；技能库列表 + **自注入**（新建/编辑/删除 SKILL.md，热扫描下个会话生效） |
  | 子代理 `subagent` | 并发上限 Stepper（1–8）、结算后自动唤醒、对话里显示运行状态 |
  | 自动化 `automation` | 画布自动唤醒开关 + **最近的唤醒**列表（时刻 + 原因，数据来自 §10 的 `wakeLog`） |

- **数据**：`data/settings.json`（`providers` / `bridge` / `prefs` 三段同住一个文档，**共用一条 `revision` 乐观锁**）+ `data/credentials.json`（API key 分离存储）。
- **prefs（行为开关，不是装饰）**：

  | 字段 | 默认 | 作用 |
  |---|---|---|
  | `fontSize` | 14 | 写 `--content-font`，正文与输入框字号（12–18 夹取） |
  | `enterToSend` | true | 发送键语义：Enter 直发，或 ⌘/Ctrl+Enter 才发 |
  | `maxActiveSubagents` | 4（`.env MAX_ACTIVE_SUBAGENTS` 兜底） | 同一会话并发子代理上限 |
  | `autoWake` | true | 子代理结算后自动开汇总回合；关掉只落 `subagent/notice`，不唤醒 lead |
  | `canvasAutoWake` | true | AI 能否自己把右侧画布唤醒/切回建模标签（见 §10） |
  | `inlineSubagents` | true | 对话内是否显示子代理运行活动条 |
  | `modOutput` | '' | **mod-output：jar 导出保存目录**。标题栏「jar ⤓」把最新构建产物复制到这里（`POST /api/mc/export`，`resolveDir` 校验目录存在）；留空时按钮回退为浏览器下载 |

- **即时保存**：设置面板除模型页外没有「保存」按钮——开关一动就 `PUT /api/settings {prefs, expectedRevision}`；成功回填 `res.prefs`，409/失败则**回滚到改动前的值**并 toast。服务端 `normalizePrefs()` 做容错 + 区间夹取，老 settings.json（还没有 prefs 字段）在构造时补默认，不需要迁移脚本。
- **API**：`GET /api/settings`（redacted：key 只回 `{set}` 槽位，含 `prefs`）、`PUT /api/settings`（`{providers?, bridge?, prefs?, expectedRevision}`——三者任选、共用一次 revision 递增，`saveProviders()` 是它的薄包装）、`PUT /api/settings/credentials/:route`；代理与技能：`GET /api/agents/detail`、`PATCH /api/agents/:id/skills`、`GET/PUT/DELETE /api/skills(/:name)`（PUT = 自注入，写 `skills/<name>/SKILL.md`，custom 标记存 `data/custom-skills.json`）。
- **模型目录**：所有 provider 的 models 展开为复合 id `"<route>/<modelId>"`；无 key 置灰（MOCK 下放开）。字段解析顺序复刻 dsh `modelInfo()`：**条目显式值 → 内置官方目录（deepseek-flash/v4-pro）→ provider `defaultContextWindow` → `DEFAULT_CONTEXT_WINDOW`（1,000,000）**，所以 `contextWindow` 永远有值，压缩不会因为"没填窗口"而瞎猜。
- **模型页 UI**：供应商卡片（显示名/Base URL/API key write-only/模型行编辑器：id、显示名、上下文窗口、👁视觉、需会员/删除）+「⟳ 自动获取」+「桥接模型」卡片（开关+模型下拉）。进设置时会用 `/api/models` 的**生效值**回填 vision/上下文/显示名，所见即真正生效的能力。
- **自动获取（复刻 dsh pi-ai discovery + `llm-deepseek/src/listing.ts`）**：解析端点 `{baseURL}/models`，接受 `data` 数组或 `models` map；上下文窗口别名 `context_window / context_length / max_input_tokens / max_context_length / max_model_len / top_provider.context_length`；输出上限别名 `max_output_tokens / max_tokens / top_provider.max_completion_tokens`；模态读 `input_modalities / architecture.input_modalities / input / supports_vision / capabilities.vision` → 直接填好 `contextWindow` 与 👁，保存后即用于图片判定与压缩阈值。

---

## 9. 外观：全量照搬 dsh design-platform token

`apps/web/src/styles.css` 整份重写，色板/圆角/字号全部取自 `../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css` 的 **dark** 分支——中性偏蓝的深色底、层级表面、白色 label 三阶，deepseek 蓝是唯一强调色。

| 类别 | token | dark 值 |
|---|---|---|
| 底 | `--bg-base` / `--sidebar-fill` | `rgb(21,21,23)` / `rgb(27,27,28)` |
| 表面 | `--bg-layer-1/2/3` | `rgb(35,35,36)` / `rgb(44,44,46)` / `rgb(53,54,56)` |
| 描边 | `--border-l1..l4` | 白 6% / 12% / 16% / 20% |
| 文字 | `--label-primary/secondary/tertiary/caption` | `249,250,251` / `207,211,214` / `173,178,184` / `129,133,140` |
| 强调 | `--accent` / `--accent-hover` | `rgb(122,170,255)` / `rgb(86,134,254)` |
| 语义 | `--success` / `--warn` / `--danger` | `78,209,126` / `247,173,49` / `242,90,90` |
| 圆角 | `--radius-xs/sm/md/lg/panel` | 4 / 8 / 12 / 16 / 28 |

**排版轴**：`--rail-w: 240px`（左栏）、`--content-w: 748px`（对话与输入卡同轴居中）、`--content-font: 14px`（设置 → 通用 → 字号会写 `document.documentElement.style`，实时生效，无需刷新）。

**结构对照**（都是 dsh 的对应物）：

- 主区 56px 页头：`.chat-title`（会话标题，子代理显示 `agentName`）+ `.chat-sub`（主会话 = sessionId，子代理 = description · parentId），右侧状态 badge；子代理时左侧多一个「← 主会话」。
- 输入卡 `.input-card`：`border-radius: var(--radius-panel)`（28px）、`max-width: var(--content-w)`；发送键 34px 蓝色圆形（`--accent`）；下方 22px `.composer-dock` 状态行（轮/步、tok、缓存、画布就绪、上下文环、MOCK）。上下文环只在 `ctxTokens > 0` 时出现。
- 消息：用户气泡右对齐、`--bg-layer-2` 底、`max-width: min(70%, 560px)`；助手正文**不上卡片**（透明无边框，纯排版）。
- `.run-banner`（原通栏 streaming-bar）改为内容轴内的一行提示，等待态 `.run-banner.waiting` 变 emphasized。
- `.toast` 从右上角挪到**底部居中**（`bottom: 24px`，`rgb(67,69,74)` 底），不再遮住页头按钮。
- 兼容层：`--bg / --panel / --panel-2 / --border / --text / --muted / --green / --red` 都指向新 token，画布区（`CanvasPane`）与看板（`StatsTab`）里沿用旧变量名的规则不用改也能跟着变。

---

## 10. 右侧拓展：多标签 / 可关闭 / AI 自动唤醒

右侧 dock 从「一个固定面板」变成**标签容器**，里面的建模画布内容一点没改（画布 iframe + 建议 chip + 导出 bbmodel + 快捷视图）。

### 10.1 标签页

- `DockTabId = 'canvas' | 'subagents' | 'stats'`（建模 / 子代理 / 看板），`TAB_META` 给出 label 与图标。
- 三个状态：`dockTabs: DockTabId[]`（**数组顺序即标签顺序**）、`dockTab`（当前激活）、`dockCollapsed`。
- 全部持久化到 localStorage（`openmods.dockTabs` / `openmods.dockTab` / `openmods.dockCollapsed`）——刷新后标签集合、顺序、激活项、折叠态都还在；`dockTabs` 读入时会 filter 掉不认识的旧值。
- `＋` 按钮打开菜单：列出**当前关掉的**标签（点即 `openDockTab`）+「关闭全部标签」。
- 每个标签右侧 `✕`（`.dock-tab-close`，hover 才显形）——关掉当前激活的那个会自动落到 `dockTabs[0]`；全关只剩 `＋`。
- 建模标签独占的能力（owner 徽标、下载 bbmodel）只在 `active === 'canvas'` 时渲染；子代理标签是 `.dock-subagents / .ds-row`（状态点、token、时长、`停止`、`对话`）；看板标签直接复用 `StatsTab`。

### 10.2 AI 自动唤醒

前端 `wakeCanvas(reason)`（`App.tsx`）是唯一入口，三个 SSE 事件会调它：

| 事件 | 触发条件 | 理由文案 |
|---|---|---|
| `model_update` | 画布快照变化（主会话或任子代理提交） | `画布已更新` / `<agentName> 更新了画布` |
| `subagent/updated` | `status === 'running'` | `<name> 开始建模` |
| `subagent/notice` | 子代理结算 | `<name> 已完成` |

它做三件事：保证 `canvas` 在 `dockTabs` 里（不在就 `['canvas', ...prev]` 插到最前）→ `setDockTab('canvas')` → `setDockCollapsed(false)`；同时往 `wakeLog` 写一条 `{at, reason}`（**1.5s 内相同触发去重**，只留最近 20 条），设置 → 自动化页的「最近的唤醒」就渲染这个列表。

- 开关是 `prefs.canvasAutoWake`：关掉后 AI 完全不抢你的标签/折叠状态（`wakeCanvas` 第一行直接 return），但画布内容照旧更新。
- 与 `prefs.autoWake` 分工：`autoWake` 管**对话回合**（结算后是否自动汇总），`canvasAutoWake` 管**右侧 UI**（是否抢焦点）。两个都关 = 完全静默。
- 唤起时不会丢失你手写的输入：`wakeCanvas` 只动 dock 的三个状态。

### 10.3 对话内的子代理活动条

`SubagentActivity.tsx` 渲染在输入卡正上方（`.composer-wrap` 里），把 `subagents[]` 与 `waiting[]` 合并去重、running 优先排序：

- **只在有 running 时渲染**（`if (!all.some(s => s.status === 'running')) return null`）——结算后活动条立即消失，避免和下面几行「已完成」通知重复。
- 每行：`.sa-spinner`（running 转环 / done 绿点 / err 红点）+ 名称 + 描述 + shimmer 文案（`正在建模…`）+ 右侧 `停止` / `对话`。
- 为什么不做右上角浮层：原来的 `SubagentMenu.tsx`（header `👥` 下拉）已删除——子代理的状态属于**这一段对话**，放当前会话里比放全局角落更符合 dsh 的 `ui-subagent` 语义，也不用移视线。
- `prefs.inlineSubagents = false` 时不渲染活动条，只剩结算通知行（适合觉得吵的时候）。

---

### 10.4 预览标签：图片 / 文件 / 网页

标签类型共六种：`canvas | images | files | web | subagents | stats`（`DOCK_TABS` 决定 `＋` 菜单顺序）。后三种对应 dsh 的 `ui-attachment` / `ui-sidebar-files`+`ui-sidebar-documentpreview` / `ui-sidebar-browser`：

| 标签 | 数据源 | 内容 |
|---|---|---|
| 图片 `▦` | 本会话所有 `user/message` 的附件引用 → `GET /api/attachments/:id` | 缩略图网格 + 灯箱（← → 翻页、⤢ 新窗口、✕ / Esc 关闭） |
| 文件 `▣` | `GET /api/fs?path=`、`/api/fs/text`、`/api/fs/raw` | 逐层目录（`node_modules`/`.git` 跳过）+ 文本预览（>512 KB 截断）+ 图片预览 + 面包屑 |
| 网页 `◫` | 用户输入的 http(s) URL + `GET /api/web/probe` | dsh `ui-sidebar-browser` 的 Web 形态：工具栏（‹ › ⟳ 地址 打开 代理 ⤢）+ 开始页（说明 + 最近访问）+ iframe 直连；站点禁止嵌入时说明原因并可一键走 `/api/web/proxy` 代理渲染；切标签只隐藏不卸载（keepMounted） |

- 文件接口的路径一律先 `realpath` 再校验前缀，越界返回 403（`apps/server/src/files.ts`），只能读 `ROOT` 内的东西。
- **修掉一个真 bug**：`.dock-menu` 的 `z-index` 原来是 30，而 `.menu-backdrop` 是 70——遮罩盖在菜单上面，`＋` 菜单“能打开但点不动”。现在菜单 71、遮罩 70，点击正常。
- **网页标签为什么曾经“只能显示当前页面”**：老实现把 `location.origin` 当默认地址（iframe 里永远套着 openmods 自己），而且地址栏要求显式 `http(s)://`——输入 `example.com` 直接被静默忽略，看起来就是“怎么点都还是这一页”。现在：
  - 地址解析（`parseAddress`，对齐 dsh `parseBrowserAddress`）：不带 scheme 时补全（回环/内网补 `http`，其余 `https`）、拒绝内嵌凭据、**拒绝当前应用自身 origin**（提示“本地服务请换一个端口”）；
  - 打开前先 `GET /api/web/probe`：服务端看目标响应头，`X-Frame-Options: DENY/SAMEORIGIN` 或 CSP `frame-ancestors` 不允许时**直接说清原因**（不再靠 2.5s 超时猜，也不把“探测中”一直挂着）；
  - 用户点「代理」才走 `GET /api/web/proxy`：本机转发 HTML、注入 `<base>` 让相对资源仍指向原站、移除原页面的 CSP meta、单页上限 8 MB；
  - iframe 保活：`web` 标签常驻渲染，切走只 `display:none`，页面/历史不重载。
- **代理模式的 sandbox 故意少一项**：代理页与父页面同源，所以**不给** `allow-same-origin`（只 `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox`），防止被转发的第三方脚本读本应用的 storage；直连模式仍按 dsh 的默认集（含 `allow-same-origin`）。

---

## 11. 省 token（compaction 插件）

移植 dsh compaction-basic + tool-result-pruner 算法：

- **上下文占用取模型自己报的数**（移植 dsh token-meter 的 anchor 语义）：`estimateContextTokens()` 优先用最近一次 `llm/usage.promptTokens` 作为锚点，只把它之后新增的 surface 用启发式补上；一旦发生 `compaction/summary` 锚点即失效，回落全量估算。于是"涨到 80%"是按 provider 实际计费口径算的，不是纯估算。
- 触发：每步模型调用前压力检查（`threshold = min(window×thresholdRatio, budget−headroom)`）；`window` 来自模型目录（见 §8，恒有值）。一次压不干净会按 `compactionRetries`（默认 2）继续压；上下文超限错误绕过阈值最大化收缩重试一次。
- 区域选择：surface 按块划分（assistant 工具调用与其结果永不拆散），从尾保留 `retainRatio×budget`，其余影子化。
- 摘要：单独一次 LLM 调用（重放 system+影子消息保证缓存前缀），输出八段式检查点包 `<compacted-summary>` 替换区间；影子内容保留在 JSONL。
- 免费前置：工具结果 >8192 字符裁成头 4096+尾 1024（`registerSurfaceTransform`），仅裁剪达标则跳过摘要。
- 按模型覆盖（dsh `modelPolicies`）：`modelPolicies: { '<route>/<modelId>': { thresholdRatio, retainRatio } }`——一个后端服务多种上下文大小的模型时分别设阈值。
- `.env`：`COMPACTION_THRESHOLD_RATIO / _HEADROOM_TOKENS / _RETAIN_RATIO / _MIN_SHADOWED / _RETRIES / _CONTEXT_WINDOW`（默认 0.8/65536/0.16/1200/2/取模型目录）。**演示压缩**：`COMPACTION_THRESHOLD_RATIO=0.02` + `COMPACTION_RETAIN_RATIO=0.02`。

## 12. 上下文面板（stats 插件）

- `projectStats(events)` 纯函数折叠出两块：
  - `totals`：轮/步行（上下文、输出、缓存命中、TTFT、tok/s、模型/工具耗时）、压缩合成行（影子 N → 摘要 M，省下 X）。
  - `context`：段次/步/消息/工具/思考/压缩计数、**工具用量**（按 `tool/call` 的 name 聚合次数与耗时、失败数）、**命令排行**（`mc_gradle` 还原成 `gradle <task>`、shell 取首词）、**token 构成**、**耗时分布**、**每步时间轴**。
- 右侧「上下文」tab（原「看板」，按 dsh-context 的版式重排）自上而下十块：
  1. 上下文统计（段次/步数/压缩/工具调用四宫格）
  2. 输入输出（用户/模型/工具/思考 计数）
  3. 工具用量（横向条形 + 失败次数）
  4. 命令排行
  5. 编队（主代理 / 子代理累计输出；子代理走 `sessionStore.list()`，重启后账还在）
  6. Token 统计（`conic-gradient` 环形：系统提示词 / 工具定义 / 对话内容）
  7. 耗时分布（环形：首字等待 / 模型生成 / 工具执行 / 回合空档）
  8. 每步输出（最近 80 步柱状色带，峰值高亮）
  9. 预算（缓存命中、压缩省下、模型/工具耗时 + 压缩明细）
  10. 每轮明细（折叠表 + **上下文增量开关**，负值 = 压缩省下）
- **唯一需要服务端回填的量**：`system` / `tools` 两段 token 不在日志里，由 `/stats` 用
  `runtime.contextBreakdown()` 写入，保证环上三段之和 == 上下文总量。
- **思考段数**取 `assistant/message.reasoning`（单步截 64k 落盘）；流式的 `assistant/reasoning`
  只走 SSE、不进日志，不能拿它统计。
- **回合空档**只算每个回合首末事件之间扣掉模型/工具的时间，用户关掉页面过夜那段不计入。
- 数据：SSE `stats` 帧（chat 结束/压缩完成时推送）+ 面板挂载时主动 GET。

---

## 12.1 会话工作目录（cwd）

- `SessionMeta.cwd` 是 durable 字段（等价 dsh `session.header.cwd`），与 `canvasId` 是两件事：
  `canvasId` = 同一块画布，`cwd` = 磁盘上的哪个工程目录。子代理创建时继承父会话的 cwd。
- 左栏会话行第二行显示目录名（`▹ projects`），点它打开目录选择器即可改绑；历史会话没有
  `meta.cwd` 时列表按 `DEFAULT_CWD` 回显，真正绑定在下次打开/改绑时落盘。
- mcdev 的工程类工具全部改走 `rootOf(exec) = exec.session.cwd ?? MC_ROOT`：裸工程名解析到
  会话目录下，`GRADLE_USER_HOME` 缺省也用会话目录下的 `.gradle-home`。因此一个服务端可以同时
  开多个工程会话，各自的 `mc_scaffold` / `mc_list` 互不干扰。

## 12.2 文档素材库（左栏「文档素材库」）

- 定位：**从建模画布截取快照归档**，不做自动保存（避免目录里堆满中间态）。
- 存法 `data/library/`：`<id>.meta.json`（列表用，小）、`<id>.doc.json`（`{resolution, elements, textures}`，
  贴图是 dataURL 可能很大）、`<id>.png`（第一张 PNG 贴图的缩略图）。
- 抽屉里每张卡片：缩略图、名字、`元素数 · 分辨率 · 时间`、「送入画布」「删除」。
- 「送入画布」是覆盖式写入（几何 + 贴图 + 分辨率），走 `canvas.commit`，服务仍是唯一写入口。

## 12.3 分组关联目录（左栏「新建分组」/ 分组菜单）

**要解决的问题**：以前「新建项目」只是标题栏里一个内联输入框，起个名字就完事——分组和磁盘上的任何东西都没有关系。现在按 dsh 的做法，点「新建分组」弹的是**完整对话框**，并且可以给分组挂一个真实的主机目录。

- **新建分组对话框**（`LeftSidebar.tsx` 的 `new-group-dialog`）：标题 + 右上角 `×`、名称输入框、说明文字（内含「关联电脑上的文件夹」入口）、已关联路径的行、取消/保存。
- **目录浏览器**（`dir-dialog`）：面包屑（当前绝对路径 + `↑` 回上级）+ 子目录逐层列表 + 「选择此文件夹」。
  两种用途共用同一个浮层：`session`（改绑某会话的工作目录）与 `new-project`（给分组关联目录）。
  **只浏览已有目录，不做真实 mkdir**——没有「新建文件夹」按钮，也不会在磁盘上凭空造目录。
- **继承链**：分组 `cwd` → 该分组下**新建**的会话继承它（`POST /api/sessions` 在没有显式 `cwd` 时取项目 `cwd`）；显式传 `cwd` 优先；会话之后仍可单独改绑，**互不影响**。改分组的 `cwd` 只影响之后新建的会话，已有会话的 `cwd` 不动。
- **校验**：分组与会话共用同一个 `resolveDir()`（`realpathSync` + `statSync().isDirectory()`），非法目录一律 `400`。
- **解除关联**：分组菜单「解除关联」（`PATCH {cwd: ''}`）；已关联时菜单项文案变成「更改关联文件夹」。

**验证**：API 11 项全绿（建分组带 cwd / 列表回读 / 会话继承 / 显式覆盖 / 改后新会话生效 / 旧会话不受影响 / 解除关联 / 非法目录 400 / 改名不受影响）；
CDP 实测全流程（弹框 → 选目录 → 进子目录 → 回填路径 → 填名保存 → 分组出现在侧栏），0 page error。

---

## 13. API 一览

```
GET  /api/health                       {ok, mock, plugins}
GET  /api/models                       模型目录（settings 动态合成，含 vision/inputModalities/contextWindow/disabled）
GET  /api/settings                     {providers(redacted), bridge, prefs:{fontSize,enterToSend,maxActiveSubagents,autoWake,canvasAutoWake,inlineSubagents}, revision}
PUT  /api/settings                     body {providers?, bridge?, prefs?, expectedRevision?} → {revision, …}；三者任选共用一次 version 递增；revision 不符 → 409
GET  /api/settings/file                下载原始 settings.json
GET  /api/attachments/:id              图片字节（内容寻址，immutable 缓存；右侧「图片」标签与历史回看）
GET  /api/fs?path=                     工作区目录一层（root/path/entries；限制在 ROOT 内）
GET  /api/fs/text?path=                文本预览（>512KB 截断，返回 truncated）
GET  /api/fs/raw?path=                 图片原始字节（<img> 直接引用）
GET  /api/web/probe?url=               目标页嵌入性探测 {ok,finalUrl,status,contentType,embeddable,reason,error}
GET  /api/web/proxy?url=               同源代理渲染（注入 <base>、去 CSP meta、<8MB）；响应头 x-openmods-final-url / -truncated
PUT  /api/settings/credentials/:route  写 API key
POST /api/settings/discover-models     探测 {baseURL}/models → {id,name,contextWindow,maxOutputTokens,inputModalities}
POST /api/sessions                     建会话（body: projectId? / cwd? → 顺手归入该项目并绑定工作目录）
GET  /api/sessions                     会话列表（不含子代理；archived=hide|all|only，默认 hide）
GET  /api/sessions/:id                 回放事件 + 会话信息（mode/parentId/canvasId/cwd/agentName/status/busy/title/waiting[{…}] + contextTokens/modelWindow/contextBreakdown）
PUT  /api/sessions/:id/cwd             切换工作目录（只接受存在的目录；写 meta + 下发 session/cwd）
GET  /api/fs/browse?path=              目录浏览（只列子目录，选择工作目录用）{path,parent,dirs,defaultRoot}
POST /api/sessions/:id/archive         归档（body: stopActivity?；仍在跑 → 409 + activity[{kind,items}]）
POST /api/sessions/:id/unarchive       取消归档（记账没动过，回到原分组与位置）
GET  /api/projects                     基线：{projects:[{id,title,cwd?,sessionIds,...}], archivedSessionIds}
POST /api/projects                     建分组 {title, cwd?}（cwd 给了就必须是已存在目录，存 realpath 绝对路径）
PATCH /api/projects/:pid               改分组 {title?} / {cwd?}（cwd 传空串 = 解除关联；不影响已有会话）
DELETE /api/projects/:pid              删项目 = 只删注册 → {deleted, movedSessionIds}（会话回落未分组）
POST /api/projects/:pid/sessions       会话移入项目 {sessionId}（置顶，且从原项目摘除）
DELETE /api/projects/:pid/sessions/:sid 会话移出到未分组
GET  /api/sessions/:id/subagents       子代理目录（agentName/description/status/duration/tokens/lastText）
GET  /api/sessions/:id/stream          SSE 统一事件流（open + 画布快照 + Last-Event-ID/?since= 补发 + canvas 变更订阅）
PUT  /api/sessions/:id/model           持久化会话级模型选择
POST /api/sessions/:id/chat            提交回合 → 202（body: text/modelId/mode/attachments）；等待子代理中 → 409 {code:'session-waiting'}
POST /api/sessions/:id/stop            中止（同一 controller 对子代理同样有效）；等待态下 = 取消整批 → {ok, cancelled:n}
GET  /api/sessions/:id/stats           {stats(totals+context), contextTokens, modelWindow, contextBreakdown, fleet{main,subagents,subagentCount}}
PUT  /api/sessions/:id/plan            计划模式开关 {active} → {ok,active}（写操作运行时拦截；归档会话 409）
PUT  /api/sessions/:id/permissions     授权策略 {policy:ask|auto, resetAllowed?} → {ok,policy,allowedTools}
POST /api/sessions/:id/interactions/:reqId  回答提问/方案评审/授权（工具在服务端 await）
GET  /api/terminals?sessionId=         终端列表 {terminals,shell}（打开会话时恢复用）
POST /api/terminals                    拉起终端 {sessionId,command?,cwd?,title?}（无 command = 交互 shell）→ {terminal}
GET  /api/terminals/:tid/output?sessionId=&tail=  读输出 {terminal,output}
POST /api/terminals/:tid/input         写 stdin {sessionId,text,submit?}
POST /api/terminals/:tid/kill          结束终端（进程树）{sessionId} → {ok,terminal}
GET  /api/library                      素材库列表 {assets:[…]}
POST /api/library/capture              从画布截取快照 {sessionId,name?} → {asset}
GET  /api/library/:id/thumb            素材缩略图（image/png，immutable）
POST /api/library/:id/to-canvas        把素材覆盖写回某会话画布 {sessionId}
DELETE /api/library/:id                删除素材（meta + doc + thumb 三个文件）
GET  /api/sessions/:id/bbmodel         下载 bbmodel（任一会话 id → 其 canvasId 那份；响应头 x-canvas-session）
PUT  /api/sessions/:id/bbmodel         画布编辑同步（canvas.commit：写 canvasId 快照 + 广播 model_update）
PUT  /api/sessions/:id/bbmodel         手动编辑同步回服务端文档
```

SSE 帧：`{id, topic, ...}`，topic：`open`（带 `waiting`）、`turn/start`、`user/message`（自动汇总回合带 `source:{kind:'subagent-settled',form:'notice',settled:[…]}`）、`assistant/delta`、`tool/call`、`tool/result`、`llm/usage`、`step/start|end`、`turn/end`、`session/waiting`（`{waiting:[…]}`，空数组 = 解锁）、`model_update`、`model/selected`、`view_update`、`stats`、`compaction`、`settings/updated`（带 `prefs`，改了设置的其他标签页即时同步）、`models/updated`、`credentials/updated`、`subagent/notice`、`subagent/updated`、`bridge/working|done`、`error`、`done`。

右侧标签页的自动唤醒只订阅上表已有的三个 topic（`model_update` / `subagent/updated` / `subagent/notice`），没有为 UI 新增服务端事件。

---

## 14. 验收状态（全部通过）

- ✅ MOCK 离线全流程（chips→建模→画布→下载 bbmodel）
- ✅ 真实 DeepSeek（用户 key）：对话、建模（河马 36 部件）、动画（walk/idle）、图片桥接转述→委派建模
- ✅ 主/子代理协作：`spawn_modeling_subagent` 立即返回 → 子代理在同一会话里并发建模、**共享主画布**（工具结果里能看到累计部件数）→ 主会话进入等待态
- ✅ 等待 → 自动汇总（dsh settlement 同构，MOCK + CDP 实测）：派发 2 个子代理后会话进入 `waiting`（`GET` 带 `waiting:[staff-1,staff-2]`、顶部 `⏳ 等待 2 个子代理完成`、textarea `readOnly`、按钮变「取消等待」、dock 显示「等待 2 个子代理…」）；等待中 `/chat` → `409 session-waiting`；两只结算后**合并成一条** `source:subagent-settled` 的 user 消息、自动开汇总回合（lead 调 `list_subagents` 再汇报）；汇总回合在 UI 上开头是两行通知（staff-1/staff-2 已完成 + 「对话」按钮），**不是用户气泡**；重启后回放仍是通知行
- ✅ 等待态可取消：`POST /stop` → `{ok, cancelled:2}`，子代理中止、收件箱清空、输入解锁，且**不会**再自动汇总
- ✅ 非批次结算不误唤醒：手动给某个子代理派活，父会话 turn 数不变（只多一条 `subagent/notice`）
- ✅ 共享画布实时可见：`CanvasService.commit()` 广播一次，主会话与**兄弟子会话**的流都按 `canvasId` 收到（`model_update.originId/agentName`）；主会话画布在子代理工作时就更新，不用等完成（CDP 实测：0→9→13→22→26 部件逐帧可见）
- ✅ 子代理目录：header `👥` 下拉（状态点/描述/token/时长/行内 Stop）、点条目看子代理对话（顶部仍是根会话 id）、右侧画布不切换、重启后目录从 meta 恢复
- ✅ 共享画布防冲突：`create_model` 在非空画布上拒绝（`reset:true` 才清空）；系统提示注入 `[当前会话] 画布已有 N 个部件/分组`
- ✅ 画布归属 durable：每个 meta 都有 `canvasId`（子代理 = 父会话），重启后子代理 id 直接解析到同一块画布，无需先恢复父会话
- ✅ 旧数据迁移：`5b4e556a`（菲比三视图）两个子代理各自 86 + 106 部件的画布，由一次性脚本合并回主会话（192 部件，两个 `head` 合并为一个骨骼）；`dba0e6b4` 认领最早子会话的法杖（13 部件）
- ✅ 桥接转述→委派建模 组合链路；桥接关闭的诚实提示路径
- ✅ 视觉直连：`deepseek-flash` 按内置目录判定为 text+image，带图消息 `transcribed=false`、图片以 `image_url` 直达模型（MOCK 实测模型收到图）；`deepseek-v4-pro` 仍走诚实提示
- ✅ 上下文窗口自动化：目录合并后 `/api/models` 恒有 `contextWindow`（flash/v4-pro = 1,048,576），压缩日志 `window=1048576 threshold=838860`；`⟳ 自动获取` 能从 `context_length / max_model_len / architecture.input_modalities / supports_vision` 解析出窗口与模态（假端点实测）
- ✅ 上下文占用按 provider 口径：`llm/usage.promptTokens` 作锚点 + 尾增启发式，压缩后锚点失效回落估算
- ✅ 动画播放：模式切换+独立驱动，time 推进、姿态变化、画布不压缩
- ✅ 设置持久化：providers/credentials/bridge 落盘、redact、revision 冲突、模型目录即时刷新、会话级模型选择持久化
- ✅ prefs 打通（新增）：`GET /api/settings` 带六项开关；`PUT {prefs}` 落盘 `data/settings.json` 并广播 `settings/updated{prefs}`；`maxActiveSubagents` 真的改了并发闸门；关掉 `autoWake` 后派两只 → `turns=1 notices=2 auto=0`（只落通知，不开汇总回合）；`inlineSubagents=false` 刷新后活动条不再出现；老 settings.json 无 prefs 时自动补默认
- ✅ dsh 式视觉（新增，CDP 1440×900 实测无 JS 异常）：侧栏 `--sidebar-fill` + 品牌渐变块、主区 56px 页头（标题 + 会话 id 副标题）、中轴 748px、用户气泡右对齐 70% 上限、助手正文无卡片、composer 28px 圆角 + 34px 蓝色圆发送键 + 22px 状态行、toast 底部居中
- ✅ 右侧多标签（新增）：`＋` 菜单列出已关闭的「子代理 / 看板 / 关闭全部标签」；打开看板 → `tabs:['◧建模','▤看板'] active:看板`，关闭后回落「建模」；关掉建模只剩「子代理 2」；重开后顺序为 `['◉子代理 2','◧建模']`；**刷新后标签集合/顺序/激活项全部记住**
- ✅ AI 自动唤醒（新增）：手动折叠右侧 → 发消息派两只子代理 → 3s 后 `collapsed:false, tabs:['◧建模'], active:'◧建模'`，设置 → 自动化页出现「staff-1 开始建模」唤醒记录；三个触发点（`model_update` / `subagent/updated(running)` / `subagent/notice`）都实测命中
- ✅ 对话内子代理活动条（新增）：running 时 `activity:2 spinners:2 locked:true`；结算后 `activity:0 / activityCard:false / notices:2 / locked:false / banner:null` —— 活动条与通知行不再重复
- ✅ 设置四页（新增，面板宽 800）：导航 `通用/模型/子代理/自动化`，通用页 主题/字号/发送键/配置文件、子代理页 Stepper=4 + 两开关、自动化页 1 开关 + 唤醒记录、模型页 provider 卡片 + 桥接 + 保存，均无溢出错位；开关即时保存 + 失败回滚
- ✅ 会话持久化：重启后列表从 `data/sessions/` 重建（标题/时间/模型/画布全恢复）；新建空会话刷新/重启不丢；模型切换即时落盘
- ✅ 项目分组与归档（dsh workspace 同构）：侧栏分「项目 / 未分组」两级、组头计数与折叠、`＋` 在项目下新建、`⋯` 移入项目；归档即时隐藏（计数 2→1）并可撤销；`仅已归档` 视图能看到归档行、点击提示需先取消归档；重启后 `projects.json` 的项目、归属、归档集合全部还原（实测 17 根会话+项目+归档跨重启一致）
- ✅ 压缩：真实触发（影子 4.7k → 摘要 82，省 4.6k）、看板压缩行与负增量
- ✅ 控制台噪音清零（SW/blckbn.ch/插件市场）
- ✅ 图片输入改成 dsh 语义（新增）：带图直发时模型确实收到 `image_url`；切纯文本模型后日志 `imagesOmitted=true` 且正文是 `[image omitted because this model accepts text only; attachment sha256:c414cd0e]`；`<id>.jsonl` 里 `data:image` 计数为 0；`data/attachments/c414cd0e….png` 70 字节，`GET /api/attachments/sha256:<digest>` → 200 image/png
- ✅ 上下文监控常驻（新增）：从磁盘打开会话时即渲染 `.ctx-meter`（`上下文占用 943 / 1024.0k tokens（0%）`），不再等下一轮 stats 帧
- ✅ 右侧预览标签（新增，CDP 实测）：`＋` 菜单可点（z-index 修复）；「图片」1 个缩略图 + 灯箱 1/1；「文件」列出工作区、进入子目录后面包屑为 `‹ 工作区 .wb-p4 ⟳`；「网页」见下一条（开始页 → 探测 → 直连/代理）
- ✅ 思考过程可见（CDP + 真实端点实测）：`assistant/message.reasoning` 落库；折叠块「思考过程 · N 字」可展开；运行横幅从「已想 0 字」变为实时增长（实测 564 字）+ 思考尾巴滚动；`api.deepseek.com` 实探 delta 只有 `reasoning_content`
- ✅ 消息列表参考图缩略图（CDP 实测）：`msg-img` 1 格、单张 `contain` 不裁切、点击开灯箱 `1 / 1 · ref.png`、src 为 `/api/attachments/sha256%3A…`
- ✅ 助手正文 Markdown 渲染：`**加粗**` / `- 列表` / 围栏代码块不再原样露出；零依赖、先转义后白名单
- ✅ 上下文图形化面板（CDP 实测）：点 `.ctx-meter` 弹出 264px 面板（`上下文已用 1%` / `~13.4k / 1.0M`，三段 `759 + 1.2k + 11.4k = 13.4k` 与环一致，色块 `rgb(173,178,184) / rgb(167,139,250) / rgb(122,170,255)`），Esc 关闭
- ✅ 网页标签可用（CDP 实测）：开始页 → 输入 `example.com`（无 scheme）补成 `https://example.com/` 并渲染；`github.com` → 提示 `X-Frame-Options: DENY` + 遮罩；点「用代理打开」→ `src=/api/web/proxy?url=…`、黄字代理提示、sandbox 无 `allow-same-origin`；切到「图片」再切回 iframe 仍在；`127.0.0.1:8787` → 自身 origin 被拒
- ✅ 左侧侧栏照 dsh（新增，CDP 实测）：品牌行 60px（mark 22 + name 18px/600）、新会话 38px 圆角 12、`会话` 段头、项目行/会话行 **32px**、会话缩进 34px、相对时间（`刚刚 / n 分钟前 / 47 分钟前`）、hover 才出 `＋ ⋯`、底部设置常驻；收起后 `--rail-w=56px`、只剩 mark 与图标按钮

---

## 15. 已知边界与注意事项

1. **模型选择跨刷新持久**：已修复——切换模型即 `PUT /api/sessions/:id/model` 写入 `<id>.meta.json`，刷新/重启由 `createSession` 恢复；仅当该模型已从设置中删除时才回落默认。
2. **动画数据曾丢失的教训**：bbdoc 快照恢复+原子写已加固；若历史快照缺 `animations` 字段，恢复时会规整为空——**旧丢失的数据无法找回**，需让 AI 重加。
3. **AI 偶尔忘记加动画**（建完模型不调 set_animation）——再发一句"加动画"即可；如频繁可在系统提示强化。
4. **共享画布的并发写入**：同一会话并发两个 chat 仍被 busy gate 挡住（等待子代理期间是 waiting gate，返回 `session-waiting`）；子代理之间是**同一份 bbdoc 的并发追加**——`CanvasService.commit()` 同步完成（tmp+rename 原子写），不会写出半截文件，但两个子代理仍可能同时给同一个骨骼加部件（结构冲突由模型自己按 `[当前会话]` 简报避让）。`create_model` 默认拒绝清空非空画布，防止互相覆盖。
5. **子代理目录不跨浏览器同步语义**：`status` 在 running 时仅存内存（进程重启后回落为 `idle`，但 `lastText`/`durationMs`/`outputTokens`/`lastStatus` 已落 meta，历史结果不丢）。
6. **子代理深度恒为 1**：subagent 不能再派发 subagent；需要更多并行请一次多派几个，或调大 `MAX_ACTIVE_SUBAGENTS`。
7. **bbcanvas 修改版**基于 GPL-3.0 的 Blockbench，构建产物需同 GPL 开源（本地内部使用无碍）。
8. **vite dev（:5173）可选**——生产用 8787 单进程；dev 只用于前端热更新。
9. **自动获取模型**依赖端点支持 OpenAI 兼容 `GET /models`；不兼容的端点手动添加模型行。
10. **项目没有磁盘目录**：dsh 的 Workspace 绑定一个真实目录（attach 时要校验会话 `cwd`），openmods 的项目只是命名分组——所以不要指望「删除项目」会动文件，它连会话都不动（见 §3.4）。会话真正落盘的位置永远是 `data/sessions/`。
11. **没有会话硬删除**（与 dsh 一致）：归档是软删除，`archivedSessionIds` 里的会话仍在磁盘上。彻底清理走 §16 的手工归档目录。
12. **归档门控是服务端的**：即使前端把归档行点开，`/chat` 也会 409 `session-archived`，`spawn_modeling_subagent` 同样拒绝——不要只靠 UI 隐藏来保证语义。
13. **等待态只存内存**：`waiting` / `settlements` 不落盘（子代理回合本身也随进程结束）。重启后不会卡在等待态，但那次派发**不会有自动汇总**——重新发起即可。等待中的会话在侧栏仍是普通行，没有额外的「等待中」标记。
14. **等待期间不能插话是主动选择**：dsh 的父会话在等待时仍接受输入，结算用 `steer` 挤进当前回合的下一步；openmods 没有 steer 通道，且共享画布上「用户新指令」与「子代理并行改动」容易互相踩，所以显式锁输入（`409 session-waiting` + textarea `readOnly`），要打断只能「取消等待」。
15. **prefs 与 providers 共用 revision**：改字号也会递增 `settings.json` 的 `revision`——两个标签页同时开设置时，后提交的那个会拿到 409 并回滚，属预期行为（不是并发 bug）。prefs 在**服务端**生效（并发闸门、自动汇总）也在前端生效（字号/发送键/活动条），所以改完别的标签页要刷新才会同步前端表现（`settings/updated{prefs}` 只能同步已经连上的页面）。
16. **右侧标签页是浏览器本地状态**：`dockTabs` / `dockTab` / `dockCollapsed` 存在 localStorage，不进 `data/`、不跨设备同步——同一台机器换浏览器会看到默认的「只有建模」。
17. **AI 自动唤醒会抢焦点**：`canvasAutoWake=true` 时，子代理每提交一次画布都可能把右侧切回「建模」标签（1.5s 内去重，仅去重同一次突发）。如果你正在看「看板」或「子代理」标签，被切走是这个开关的预期行为；嫌烦就关掉它，唤醒记录仍会留在自动化页（关掉后不再记录）。
18. **旧会话的思考过程找不回来**：修复前 `reasoning_content` 从未落盘（`dbc353ce` 的 6 个工具步骤正文全是 0 字符），只有这一版之后新产生的回合才有思考记录。历史回合只能靠 `llm/usage.outputTokens` 推断"当时想了多少"。
19. **网页标签的代理模式不是浏览器能力**：它只是本机转发 HTML，脚本、登录（opaque origin 下没有 cookie/storage）、站内跳转都可能失效，复杂 SPA 尤其明显；直连模式仍受站点 `X-Frame-Options` / CSP 约束（这是 iframe 的硬限制，dsh 的 Web 版同样如此，只有 Electron 的 `<webview>` 能绕开）。`/api/web/proxy` 会把任意 http(s) 地址转发一遍，所以 **8787 只能监听 127.0.0.1**，别暴露到公网。
20. **`contextBreakdown` 的「对话」是倒推值**（总量 − 系统提示词 − 工具定义），系统/工具两段用 chars/4 启发式（CJK 偏低估）；换模型只会改百分比，分项数字不变属正常。
21. **思考块不去重**：多步回合按 `\n\n` 拼接各步 reasoning；模型每步都想同一段时会看着像重复（MOCK 就是这样），不去重是刻意的——真实模型的逐步思考本来就是不同内容。

---

## 16. 常见接手任务速查

| 任务 | 做法 |
|---|---|
| 加建模工具 | `plugins/bb-tools/index.ts` tools 数组加 ToolDef；复杂逻辑放 bbmodel.ts |
| 加子代理角色 | server `AGENT_PROFILES` 加条目（prompt/toolFilter）；`spawn_modeling_subagent` 调用处传 `profile` |
| 改画布归属 | `CanvasService.idOf()`（meta.canvasId → 父链回溯）；子代理在 `createSession({canvasId})` 继承，运行时不传 state |
| 加技能 | `skills/<name>/SKILL.md`（frontmatter name/description + 正文），零代码 |
| 调压缩 | `.env` COMPACTION_*（见 §11 表）；看板实时验证 |
| 改画布行为 | `bbcanvas/bb-bridge.js` → `cp` 到 dist → 刷新页面（无需重启 server） |
| 换 LLM 端点 | 设置 → 模型 → 供应商 Base URL/API key（或 .env LLM_*） |
| 看 token 去向 | 右 dock → 看板标签（`＋` 里能重新打开）+ `data/sessions/<id>.jsonl` 的 llm/usage 与 compaction/summary 事件 |
| 改配色/圆角/字号 | `apps/web/src/styles.css` 的 `:root` —— 值照 dsh `design-platform.css` 抄，别在组件里写死颜色 |
| 加一个右侧标签 | `RightDock.tsx` 的 `DockTabId` + `TAB_META` 加分支 → `App.tsx` 的 `dockTabs` 初始值与 localStorage 白名单（旧值会被 filter 掉） |
| 调 AI 自动唤醒 | `App.tsx` 的 `wakeCanvas(reason)`；触发点搜 `wakeRef.current(`（model_update / subagent/updated / subagent/notice）；开关是 `prefs.canvasAutoWake` |
| 加一个设置开关 | server `settings.ts`（`PrefsConfig` + `DEFAULT_PREFS` + `normalizePrefs` 夹取）→ `web/types.ts` 的 `PrefsDto` → `SettingsPage.tsx` 对应分区加一行 `Switch`/`Seg`，用 `patchPrefs` 即时保存 |
| 改子代理活动条 | `SubagentActivity.tsx`（务必保住「只在有 running 时渲染」这条收口，否则会和结算通知行重复）；开关是 `prefs.inlineSubagents` |
| 调试前端 SSE | App.tsx handleEvent 是唯一事件入口；`data/sessions/*.jsonl` 是权威日志 |
| 改等待/自动汇总 | `index.ts`：`waiting`/`settlements` 字段 + `settleChild()` + `maybeAutoContinue()` + `formatSettlementPrompt()`；回合收尾在 `afterRootTurn()`，前端订阅 `session/waiting` |
| 改会话分组/归档 | `apps/server/src/project-store.ts`（projects/membership/archivedSessionIds）；门控在 `index.ts` 的 `isArchivedLineage()` |
| 加会话到某项目 | `POST /api/projects/:pid/sessions` 或侧栏 `⋯ → 移入项目`；新建时传 `projectId` |
| 彻底删一个会话 | 没有硬删除接口：把 `<id>.jsonl`/`.meta.json`/`.bbdoc.json` 移进 `data/sessions/_archive-<日期>/`（列表只扫目录内 `.jsonl`，子目录自动忽略），再重启 server |

## 17. 数据流图

```
用户输入（中央 composer / 右 dock chips）
   │ POST /chat → 202（后台 runSessionTurn，前端订阅 SSE）
   ▼
runSessionTurn（root，profile=lead）
   │ 图片? → vision 判定 → [桥接模型转述] → transcribed
   │ 建模任务? → spawn_modeling_subagent ──┐（立即返回 started，不阻塞本回合）
   ▼                                      │
llm.chat（OpenAI 兼容流式，per-request provider 解析，重试）
   │ tool_calls                          │
   ▼                                      ▼
bb-tools（只拿 CanvasPort）          createSession(child, {parentId, canvasId})
   │ canvas.commit(sessionId, doc)        │ 独立 SessionLog / SseWriter / AbortController
   │  ↓ CanvasService（唯一权威）          │ canvasId 继承父会话 → 同一块画布
   │    编译 bbmodel + 原子写              │ void runSessionTurn(child, {profile:'modeling'})
   │    <canvasId>.bbdoc.json              │   （系统提示带「画布已有 N 个部件」）
   │    onChange({canvasId, originId,…})   │
   ▼                                      │ 完成后：写 meta(status/duration/tokens)
SSE 连接按自己的 canvasId 过滤 ◄──────────┘        → subagent/updated ──► 前端目录刷新
   │  连上先发快照，之后逐次 model_update          → settleChild(parent)
   │──► 前端 postMessage ──► iframe 桥              ├ waiting.delete(child)、settlements.push
   │        （Blockbench 只读画布渲染）              ├ sse: session/waiting（等待条刷新）
   │                                                └ waiting 空 → maybeAutoContinue(parent)
   └── 每步前 compaction 钩子（超阈值→影子化+八段式摘要）
       每事件落 JSONL → stats 投影 → SSE stats ──► 看板（右 dock → 看板标签）

前端收到的每个 SSE 帧有三条并行去向（App.tsx handleEvent 是唯一入口）：
   ① 会话正文    assistant/delta / tool/* / user/message → .chat-column（通知行不画用户气泡）
   ② 对话内活动条 subagent/updated|notice + waiting[] → SubagentActivity（仅 running 时出现）
   ③ 右侧 dock   model_update / subagent/updated(running) / subagent/notice
                 → wakeCanvas(reason)（受 prefs.canvasAutoWake 约束）
                    ├ 保证 'canvas' 在 dockTabs 里（不在就插到最前）
                    ├ setDockTab('canvas') + setDockCollapsed(false)
                    └ wakeLog 追加 {at, reason} → 设置 → 自动化页「最近的唤醒」
                 （dockTabs / dockTab / dockCollapsed 三个都持久化到 localStorage）

                                                               ▼
                                      lead 回合结束后若有等待 → 会话处于 waiting
                                        （/chat 409 session-waiting，前端锁输入）
                                                               │ 最后一只结算
                                                               ▼
                                      runSessionTurn(parent, {source:{kind:'subagent-settled'}})
                                        → user/message 带 source（合并整批 + 验收要求）
                                        → UI 渲染成通知行（不是用户气泡）
                                        → lead 调 list_outline / list_animations 核对后汇报

订阅：GET /api/sessions/:id/stream（EventSource，id: 帧序号，Last-Event-ID/since 补发）
     每条连接 = 本会话回合事件 + 所属 canvasId 的画布事件（主会话与子代理天然同屏）
     GET /api/sessions 不列子代理，目录走 /subagents；bbmodel 一律读写会话的 canvasId
```
