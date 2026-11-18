# Tasks

- [x] Task 1: 服务端环境检测与配置存储
  - [x] SubTask 1.1: `settings.ts` 增加 `environment` 配置（`setupDone` / `javaHome` / `gradleHome` / `gitPath`），补默认值与容错归一化，随 `/api/settings` 返回
  - [x] SubTask 1.2: 新增 `apps/server/src/env-check.ts`：Java 候选与版本解析；Gradle 缓存来源检测（vendor、错位目录、MC_ROOT/.gradle-home、GRADLE_USER_HOME、~/.gradle）；Git 版本检测
  - [x] SubTask 1.3: `index.ts` 增加 `GET /api/env/status`、`POST /api/env/apply`；保存配置并设置 `OPENMODS_JAVA_HOME` / `OPENMODS_GRADLE_HOME` / `OPENMODS_GIT`
  - [x] SubTask 1.4: 支持「整理 vendor」：把 `plugins/mcdev/gradle-8.8`、`fg-maven` 移到 `plugins/mcdev/vendor/`，操作前校验目标为空

- [x] Task 2: lead / mcmod 角色关系
  - [x] SubTask 2.1: `profiles.ts` 明确 lead 提示词：MC 开发任务先询问用户，确认后调用 `handoff_to_mcmod`，不得用 bash 手搓 MC 工程
  - [x] SubTask 2.2: `index.ts` 注册 `handoff_to_mcmod`（仅 lead + MC 功能开启）：持久化 `profile=mcmod`、广播角色更新，并在当前回合结束后用本回合用户任务自动续跑一轮 mcmod
  - [x] SubTask 2.3: 新会话默认角色按绑定目录判断：Forge 工程标记 → `mcmod`，否则 `lead`；显式选择的角色优先
  - [x] SubTask 2.4: `plugins/mcdev` 强化 mcmod 提示词：造型需求必须先派 `spawn_modeling_subagent`；`canvas_export` 空画布错误改为「当前画布为空，请先 spawn_modeling_subagent 建模并验收」，不再让模型改用手搓

- [x] Task 3: 构建/测试/更新链路接入环境配置
  - [x] SubTask 3.1: `mc_gradle` 优先使用 `OPENMODS_JAVA_HOME` / `OPENMODS_GRADLE_HOME`；启动前检查 Java 17 与缓存，失败返回可操作中文错误；结果里打印使用的 Java 与缓存来源
  - [x] SubTask 3.2: `mc-test-client.ts` 的 `javaExe` 使用 `OPENMODS_JAVA_HOME`，缺失时给出「设置 → 环境」提示
  - [x] SubTask 3.3: `update.ts` 的 `git` 调用使用 `OPENMODS_GIT`，Git 缺失时返回可读错误

- [x] Task 4: 前端首次运行环境向导
  - [x] SubTask 4.1: `api.ts` / `types.ts` 增加环境状态、候选、应用配置的 DTO 与请求方法
  - [x] SubTask 4.2: 新增 `components/EnvSetupDialog.tsx`：三张检测卡片（Java / 缓存 / Git）、候选选择、自定义目录、重新检测、整理 vendor、保存与稍后配置
  - [x] SubTask 4.3: `App.tsx` 首次加载时请求 `/api/env/status`，未配置则弹出向导；保存或跳过后不再自动弹出

- [x] Task 5: 设置 → 环境分区
  - [x] SubTask 5.1: `SettingsWindow.tsx` 增加「环境」入口；`SettingsPage.tsx` 复用环境面板，支持重新检测与保存
  - [x] SubTask 5.2: `styles.css` 增加向导/环境卡片的 MC 像素风样式，与现有设置页一致

- [x] Task 6: 验证
  - [x] SubTask 6.1: `npm run build` 通过
  - [x] SubTask 6.2: 构造三种场景验证 API：无 Java 17、vendor 完整、vendor 错位（模拟 `2121e7e7` 的目录布局）
  - [x] SubTask 6.3: 浏览器验证首次向导、设置 → 环境、重新检测与整理 vendor
  - [x] SubTask 6.4: 验证 lead 移交：在 lead 会话提出 MC 需求 → 确认移交 → 自动以 mcmod 续跑；验证 mcmod 空画布 `canvas_export` 提示先派建模子代理
  - [x] SubTask 6.5: 用 `mc_gradle task=build` 验证命中选定缓存且无需联网下载 Gradle；缺少 Java 时返回可操作错误

# Task Dependencies
- Task 3、Task 4、Task 5 依赖 Task 1 的配置与 API
- Task 2 与 Task 1 独立，可并行
- Task 3 依赖 Task 1 完成
- Task 4 与 Task 5 可并行（共用环境面板组件）
- Task 6 依赖 Task 1–5 全部完成
