# Tasks

- [x] Task 1: 空对话「绑定工作目录」入口，移除左栏目录 chip
  - [x] SubTask 1.1: `SessionView` 空状态欢迎区新增「绑定工作目录」入口（显示当前目录名，点击触发目录选择）
  - [x] SubTask 1.2: `MainPanel`/`App` 透传 `onPickDir`（复用已有 `api.pickDir` + 原生文件夹对话框）
  - [x] SubTask 1.3: `LeftSidebar` 会话行移除 `sb-cwd` chip，保留会话菜单「更改绑定目录」

- [x] Task 2: 修复画布动画播放（素材库标签 + 点击）
  - [x] SubTask 2.1: 素材库标签记录并暴露该模型的 `animations`，`RightDock` 动画条不再限定 `activeCanvasTab === 'session'`
  - [x] SubTask 2.2: 播放按钮仅在模型未加载完成时禁用；命中 `bb_animation_error` 时自动重载并重试，仍失败给出 toast
  - [x] SubTask 2.3: 切换/关闭画布标签时同步清理 `playingAnim` 与动画列表，避免残留状态

- [x] Task 3: 子代理会话重复任务提示
  - [x] SubTask 3.1: 用 `data/sessions/6b5e9b75` 等子代理会话与 `15e2907e` 复现，确认重复来源（回放 + 流式重复插入 / 事件渲染两处）
  - [x] SubTask 3.2: 按 `seq`/`turnId` 对 user 回合去重，重连与回放不得叠加

- [x] Task 4: 终端生命周期清理
  - [x] SubTask 4.1: 前台 `bash` 结束（退出/超时）后自动从终端列表移除；`run_in_background` 与 `terminal_open` 保留
  - [x] SubTask 4.2: 进程退出即从列表与前端标签移除（SSE `terminal/exit` 驱动）
  - [x] SubTask 4.3: 终端标签增加关闭按钮与「全部清空」

- [x] Task 5: 终端 UTF-8 编码
  - [x] SubTask 5.1: Windows `cmd` 启动时切换 `chcp 65001`；spawn env 增加 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8`
  - [x] SubTask 5.2: 输出统一 UTF-8 解码，非法字节替换而不抛错

- [x] Task 6: mdk 工作区按会话隔离
  - [x] SubTask 6.1: 会话创建时解析工作区：显式绑定目录优先；未绑定使用独立目录（如 `data/workspaces/<rootSessionId>`）
  - [x] SubTask 6.2: 子代理继承父会话工作区；`mcdev.rootOf` 使用该工作区而非共享 `MC_ROOT`
  - [x] SubTask 6.3: 校验两个会话各自 `mc_scaffold`/构建产物互不覆盖

- [x] Task 7: 素材库归档 jar
  - [x] SubTask 7.1: 入库时定位当前工程 `build/libs` 最新 jar，复制为 `data/library/<id>.jar` 并写入 meta
  - [x] SubTask 7.2: 素材卡片增加「下载 jar」，无 jar 时隐藏/禁用

- [x] Task 8: 验证
  - [x] SubTask 8.1: `npm run build` 通过
  - [x] SubTask 8.2: 浏览器验证：空对话绑定目录、素材标签动画播放、终端标签不堆积、中文告警正常
  - [x] SubTask 8.3: 回放 `15e2907e` 子代理会话确认不重复提示
  - [x] SubTask 8.4: 修复回放去重键不一致：`replayEvents` 改用日志 `turnId`（此前用自身 seq，与 SSE `turn/start` 的 `t<seq>` 不一致导致去重失效）

# Task Dependencies
- Task 2、Task 4、Task 5 相互独立，可并行
- Task 6 依赖 Task 4 的会话目录解析改动（同属服务端会话创建链路）
- Task 7 依赖 Task 6 的工作区路径
- Task 8 依赖 Task 1–7 全部完成
