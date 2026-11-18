# 画布动画、子代理提示与终端/工程隔离修复 Spec

## Why
用户在实际使用（会话 `15e2907e`）中遇到一组相互关联的问题：素材库模型打开后看不到动画播放控件、播放按钮时灵时不灵；子代理会话里同一条任务提示重复出现；主对话每条 `bash` 都堆积一个 `tty-*` 终端且终端中文乱码；不同会话共用同一套 mdk 工程目录导致产物互相覆盖，素材库也没有归档构建出的 jar。

## What Changes
- 左栏会话行不再显示工作目录 chip；空对话推荐区新增「绑定工作目录」入口（系统原生选择目录）。
- 右侧画布（拓展）的动画条对「素材库打开的标签」同样生效，并修复播放按钮不可点/无反馈的问题。
- 子代理会话中同一条任务提示只出现一次。
- 终端生命周期：前台命令结束/进程退出即从终端列表移除；后台终端保留并可手动关闭，不再出现 tty 堆积。
- 终端编码统一 UTF-8（cmd `chcp 65001`、Java/Python 输出编码环境变量、输出解码兜底），消除 javac 中文告警乱码。
- mdk 工程按会话隔离：未绑定目录的会话使用独立工作区；子代理继承父会话工作区。
- 素材库条目同时归档模型素材与构建出的 jar，并提供下载。

## Impact
- Affected specs: 画布动画播放、子代理会话展示、终端管理、Minecraft 工程工作区、素材库归档
- Affected code:
  - 前端：`apps/web/src/App.tsx`、`components/RightDock.tsx`、`components/SessionView.tsx`、`components/LeftSidebar.tsx`、`components/TerminalPane.tsx`、`styles.css`
  - 服务端：`apps/server/src/index.ts`、`terminals.ts`、`library.ts`
  - 插件/模板：`plugins/mcdev/index.ts`
  - 数据：`data/sessions/15e2907e.*`（验证用）、`data/library/`、新增会话工作区目录

## ADDED Requirements

### Requirement: 空对话的目录绑定入口
系统 SHALL 在空对话（`turns.length === 0`）的欢迎/推荐区提供「绑定工作目录」入口，显示当前目录名并调起系统原生目录选择器。

#### Scenario: 新会话绑定目录
- **WHEN** 用户打开一个没有消息的会话，点击推荐区的「绑定工作目录」
- **THEN** 弹出 Windows 原生文件夹选择框；选中后会话 `cwd` 更新、入口显示新目录名，无需刷新页面

#### Scenario: 左栏不再展示目录
- **WHEN** 查看左栏会话列表
- **THEN** 每一行不再渲染目录 chip；切换目录只通过会话菜单或空对话入口完成

### Requirement: 素材库标签的动画播放
系统 SHALL 在任意画布标签（会话画布或素材库标签）存在动画时显示动画条，并允许播放/停止。

#### Scenario: 从素材库打开带动画的模型
- **WHEN** 用户从素材库打开一个含动画的模型
- **THEN** 画布加载完成后动画条立即出现，列出该模型动画；点击可播放，再点可停止

#### Scenario: 播放按钮反馈
- **WHEN** 当前模型有动画且已加载完成
- **THEN** 播放按钮可点击并有明确选中/播放中状态；不会因为 AI 回合进行中而整体禁用到无法点击
- **AND** 播放失败（桥接层报错）时自动重载一次并重试，仍失败则给出可见提示

### Requirement: 终端自动清理
系统 SHALL 在前台命令结束或终端进程退出后立即从终端列表移除该终端；后台终端保留直到被终止或会话结束。

#### Scenario: 主对话连续执行命令
- **WHEN** 主对话连续调用 `bash` 执行 10 条前台命令
- **THEN** 终端面板最多只显示仍在运行的终端，不出现 10 个已退出的 `tty-*` 标签

#### Scenario: 手动关闭
- **WHEN** 用户点击终端标签上的关闭按钮
- **THEN** 该终端进程被终止并从列表消失

### Requirement: 终端 UTF-8 编码
系统 SHALL 让终端输出按 UTF-8 解码，并让常见工具链以 UTF-8 产出中文。

#### Scenario: javac 中文告警
- **WHEN** 在终端执行会输出中文告警的 `javac` 命令
- **THEN** 面板显示正常中文（如「警告: [removal] ... 已过时」），不是乱码/方块

### Requirement: 会话级 mdk 工作区
系统 SHALL 为每个会话树（root 会话及其子代理）提供独立的 Minecraft 工程根目录，避免不同会话共用同一套 mdk 工程。

#### Scenario: 两个会话各自 scaffold
- **WHEN** 会话 A 与会话 B 各自执行 `mc_scaffold`
- **THEN** 两个工程落在各自的工作区目录；构建产物（`build/libs/*.jar`）互不覆盖

#### Scenario: 子代理协作
- **WHEN** 同一 root 会话派发多个子代理
- **THEN** 子代理继承同一工作区，能共同构建同一个模组

### Requirement: 素材库归档 jar
系统 SHALL 在素材入库时同时保存模型素材与可用的构建 jar。

#### Scenario: 入库带构建产物的模型
- **WHEN** 从已有 mdk 工程构建产物的会话把模型存入素材库
- **THEN** 素材条目包含模型快照（doc/png）与 jar 文件，卡片提供「下载 jar」；无构建产物时该操作不可用

## MODIFIED Requirements

### Requirement: 子代理任务提示展示
子代理会话中，派发时的任务提示 SHALL 只出现一次（当前问题：同一提示重复显示为两条用户消息）。

#### Scenario: 打开子代理会话
- **WHEN** 用户在子代理面板打开任一派发出来的子代理
- **THEN** 会话里只有一条该任务的任务提示，不重复、不因重连/回放而叠加

## REMOVED Requirements

### Requirement: 左栏会话行目录 chip
**Reason**: 目录入口过多且每行都展示默认目录，噪音大；改由空对话推荐区统一承载。
**Migration**: 会话菜单中的「更改绑定目录」与空对话推荐入口保留同等能力。
