# 首次运行环境检测与 lead / mcmod 角色协作 Spec

## Why
新用户第一次构建 MC 模组时，Java / Gradle 缓存 / Git 的差异会集中爆成原始报错。会话 `2121e7e7` 实测：`mc_gradle` 未识别预置缓存，重新下载 Gradle 8.8；`runClient` 起不来；该克隆把 `gradle-8.8`、`fg-maven` 解压到了 `plugins/mcdev/` 而不是 `plugins/mcdev/vendor/`；构建与测试客户端还依赖硬编码 `F:/sdk_java/jdk-17`。

同一会话还暴露了角色协作问题：前 4 轮用 `lead`，但 `lead` 没有 `mc_scaffold` / `mc_gradle` 等工具，只能靠 bash 手搓；切换到 `mcmod` 后，`mcmod` 又没有把建模派给 `spawn_modeling_subagent`，在空画布上调用 `canvas_export` 失败。需要同时明确两个角色的边界，并在安装后第一次打开工作台时检测三项环境、让用户选择配置。

## What Changes
- 明确角色边界：`lead` 负责通用任务与调度；`mcmod` 负责 MC 工程实现；`modeling` 只作为建模子代理。
- 新增 `lead` → `mcmod` 的任务移交：确认后切换会话角色，并用原任务自动续跑一轮，不需要用户重发。
- MC 工程目录里的新会话默认使用 `mcmod`；普通目录默认 `lead`。
- `mcmod` 对造型类需求必须先派 `spawn_modeling_subagent`；空画布 `canvas_export` 返回可操作提示，而不是让模型改用手搓。
- 新增首次运行环境检测：Java、Gradle 缓存、Git，向导展示结果并让用户选择配置，可跳过。
- 设置新增「环境」分区：重新检测、修改配置、整理错位的 vendor 目录。
- 环境配置持久化到 `data/settings.json`，并应用到 `mc_gradle`、测试客户端、自更新检查。
- `mc_gradle` / 测试客户端启动前做前置检查，用中文可操作错误替代原始下载/进程报错。

## Impact
- Affected specs: 角色协作、首次运行引导、MC 构建环境、设置系统、自更新
- Affected code:
  - 服务端：新增 `apps/server/src/env-check.ts`；`profiles.ts`、`index.ts`、`settings.ts`、`mc-test-client.ts`、`update.ts`
  - 插件：`plugins/mcdev/index.ts`（`mc_gradle` 的 Java / Gradle 缓存解析、`mcmod` 提示词、`canvas_export` 空画布提示）
  - 前端：`apps/web/src/api.ts`、`types.ts`、新增 `components/EnvSetupDialog.tsx`、`App.tsx`、`SettingsWindow.tsx`、`SettingsPage.tsx`、`styles.css`
  - 数据：`data/settings.json` 新增 `environment` 字段

## ADDED Requirements

### Requirement: 角色职责边界
系统 SHALL 保持三个角色的明确分工：
- `lead`：通用任务、对话、计划与验收；可派建模子代理；不直接使用 `mc_scaffold` / `mc_gradle` / `mc_log` / `mc_export_model` 做 MC 工程。
- `mcmod`：MC 1.20.1 Forge 开发主角色；拥有 `mc_*`、画布与派发建模子代理的能力；不再向下移交角色。
- `modeling`：只作为子代理运行，负责建模与动画，不派发下一层子代理。

#### Scenario: 普通任务
- **WHEN** 用户创建普通会话并询问代码/文件/画布问题
- **THEN** 默认使用 `lead`，不加载 MC 工程工具

#### Scenario: MC 工程任务
- **WHEN** 用户在 MC 工程目录里创建会话
- **THEN** 默认角色为 `mcmod`，可直接使用 `mc_scaffold` / `mc_gradle` 等工具

### Requirement: lead 向 mcmod 移交 MC 任务
系统 SHALL 为 `lead` 提供 `handoff_to_mcmod` 工具（仅在 MC 功能开启、`mcmod` 角色可用时注册）。调用前 `lead` SHALL 先用 `ask_user_question` 征得用户同意。

#### Scenario: 用户确认移交
- **WHEN** 用户在 `lead` 会话里提出 MC 模组开发需求，并在询问中选择「切换到 mcmod」
- **THEN** 会话角色持久化为 `mcmod`，界面角色选择同步更新，系统用本回合用户任务自动续跑一轮 `mcmod`，用户不需要重新发送需求

#### Scenario: 用户拒绝移交
- **WHEN** 用户选择继续用 `lead`
- **THEN** `lead` 不得用 bash 手搓 MC 工程，应说明需要切换到 `mcmod` 才能继续

#### Scenario: MC 功能关闭
- **WHEN** 设置里关闭了 MC 功能
- **THEN** `handoff_to_mcmod` 不注册；`lead` 不会尝试移交

### Requirement: mcmod 的建模委派
`mcmod` 收到物品/方块/生物外观等造型需求时 SHALL 先调用 `spawn_modeling_subagent`，等汇总回合验收画布后再导出/构建；不得在空画布上直接 `canvas_export`，也不得用手写几何替代建模子代理。

#### Scenario: 枪械/生物造型
- **WHEN** 用户要求制作枪械、生物或方块外观并开发对应模组
- **THEN** `mcmod` 首个动作是派发建模子代理；空画布 `canvas_export` 返回「当前画布为空，请先 spawn_modeling_subagent 建模并验收」并停止导出

#### Scenario: 子代理结算
- **WHEN** 建模子代理完成并触发汇总回合
- **THEN** `mcmod` 核对画布、请用户验收，验收通过后才进入导出与构建

### Requirement: 首次运行环境检测
系统 SHALL 提供 `GET /api/env/status`，检测 Java、Gradle 缓存、Git，并返回结构化结果：每项包含 `status`（ok / warn / fail）、摘要、候选路径与版本信息。

#### Scenario: 首次打开工作台
- **WHEN** 用户安装后第一次打开工作台，且 `environment.setupDone` 不为 `true`
- **THEN** 前端展示环境向导，列出三项检测结果与可选项；不阻塞其他界面操作

#### Scenario: 全部就绪
- **WHEN** Java 17、Gradle 缓存、Git 均检测通过
- **THEN** 向导显示「环境已就绪」，用户确认后写入 `setupDone`，后续启动不再自动弹出

#### Scenario: 用户跳过
- **WHEN** 用户点击「稍后配置」
- **THEN** 向导关闭且不阻塞使用；`setupDone` 记为 true，设置 → 环境仍显示未解决项

### Requirement: Java 环境检测与选择
系统 SHALL 检测 `JAVA_HOME`、`PATH`、用户 `.jdks`、`.gradle/jdks` 以及常见 JDK 安装目录，解析 Java 主版本；Minecraft 1.20.1 需要 Java 17。

#### Scenario: 检测到多个 JDK
- **WHEN** 同时存在 Java 17 与 Java 22
- **THEN** 列表展示版本、厂商与路径，默认选中 Java 17；非 17 版本标注「不适用于 1.20.1」

#### Scenario: 未检测到 Java 17
- **WHEN** 所有候选都不是 Java 17
- **THEN** 向导显示 fail 与下载提示；允许手动选择 JDK 目录，保存前校验 `<home>/bin/java -version`

### Requirement: Gradle 缓存检测与选择
系统 SHALL 检测并展示以下缓存来源，并标出本次实际使用的来源：
- `plugins/mcdev/vendor/`（`gradle-8.8/bin` + `fg-maven`）
- 错位解压：`plugins/mcdev/gradle-8.8` 或 `plugins/mcdev/fg-maven`
- `MC_ROOT/.gradle-home`
- 已保存的 `environment.gradleHome`、`GRADLE_USER_HOME`、`~/.gradle`

#### Scenario: vendor 完整
- **WHEN** `plugins/mcdev/vendor/gradle-8.8/bin` 与 `vendor/fg-maven` 均存在
- **THEN** 标记「离线缓存已就绪」，默认使用该缓存，`mc_gradle` 不再联网下载 Gradle 发行版

#### Scenario: vendor 解压错位
- **WHEN** 检测到 `plugins/mcdev/gradle-8.8` 或 `plugins/mcdev/fg-maven` 不在 `vendor/` 下
- **THEN** 显示 warn 与「整理到 vendor」操作；用户确认后移动目录，重新检测变为 ok

#### Scenario: 无缓存
- **WHEN** 未检测到任何缓存
- **THEN** 允许选择「联网下载」；`mc_gradle` 继续走国内镜像兜底，并在结果中说明当前没有离线缓存

### Requirement: Git 版本检测与选择
系统 SHALL 检测 Git 可执行文件与版本（`git --version`），允许指定自定义路径；自更新功能使用该路径。

#### Scenario: Git 未安装
- **WHEN** 检测不到 Git
- **THEN** 向导显示 fail；设置 → 更新 显示「未检测到 Git」的可读提示，而不是 `spawn git ENOENT`

### Requirement: 环境配置持久化与应用
系统 SHALL 将用户选择保存到 `data/settings.json` 的 `environment` 字段，并在保存后立即应用到后续构建、测试客户端与更新进程。

#### Scenario: 保存后立即生效
- **WHEN** 用户选择 Java 17 与 vendor 缓存并保存
- **THEN** 后续 `mc_gradle build` 使用该 Java 与 Gradle 缓存，无需重启服务

### Requirement: 构建前置检查
系统 SHALL 在 `mc_gradle` 与测试客户端启动前检查 Java 17 与缓存配置；缺失时返回中文可操作错误，并指向「设置 → 环境」。

#### Scenario: 缺少 Java 17
- **WHEN** 未配置且未检测到 Java 17 时调用 `mc_gradle`
- **THEN** 返回「未找到 Java 17：请到 设置 → 环境 选择 JDK」，不启动 Gradle

#### Scenario: 选中缓存不可用
- **WHEN** 配置的 Gradle 缓存目录被删除或缺少关键文件
- **THEN** 返回明确提示并给出回退选项（重新检测 / 改用联网），不直接抛原始异常

## MODIFIED Requirements

### Requirement: 会话默认角色
新会话默认角色 SHALL 根据绑定目录判断：目录包含 Forge 工程标记（`gradle.properties` 含 `minecraft_version`，或 `build.gradle` 含 `forgegradle` / `net.minecraftforge`）时默认 `mcmod`；否则默认 `lead`。已有会话保持自身 `profile`。

### Requirement: mc_gradle 的 Java 与缓存来源
`mc_gradle` SHALL 优先使用环境配置的 Java 与 Gradle 缓存（`OPENMODS_JAVA_HOME` / `OPENMODS_GRADLE_HOME`）；仅在未配置时回落到 `JAVA_HOME`、`WARM_GRADLE_HOME` 与会话 `.gradle-home`。工具结果 SHALL 显示本次使用的 Java 与缓存来源，便于确认是否命中离线包。

### Requirement: 测试客户端 Java
`mc-test-client` SHALL 使用环境配置的 Java；仅在未配置时回落到 `JAVA_HOME` 与旧默认路径。

### Requirement: 自更新 Git
`update.ts` SHALL 使用环境配置的 Git 可执行文件；未配置时使用 `PATH` 中的 `git`，并在 Git 缺失时返回可读错误。
