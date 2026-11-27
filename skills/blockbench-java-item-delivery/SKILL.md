---
name: blockbench-java-item-delivery
description: Java 物品模型的交付质检与优化：结构审计、成本预算、保真对照、描边发光、实时快照、离屏截图、资源包打包和版本规则。用于制作后的验收、修正、减负与交付，不覆盖通用 mesh、PBR、Bedrock/Hytale 或实体骨骼动画。
---

# Java 物品模型交付

目标不是“看起来做完了”，而是能说明：按哪个版本、花了多少成本、改了什么、证据是什么、哪些没测。制作过程用 [blockbench-modeling](../blockbench-modeling/SKILL.md) 与 [blockbench-texturing](../blockbench-texturing/SKILL.md)；本技能负责验收、修正和交付。

## 先确定交付对象

从会话与工程获取：Java/Bedrock/ModelEngine 等运行时、具体游戏版本、物品还是实体、是否允许客户端扩展、参考图/视频、需要的动画、原文件还是新文件。已知信息不要重问；只在缺失内容影响实现时澄清。先检查实际工程格式，不能把 Generic/ModelEngine 骨骼动画当作原版 Java 物品动画。

检查附近 2–4 个相关成品的几何、真实 PNG 尺寸和 UV，不只看截图。将用户对“完全不变”的要求保留为硬约束：先留基线，再做独立候选；低分辨率重绘、无损图集重排、几何重构是三种不同工作，交付时说明实际做了哪一种。

详细的版本与格式规则见 [Java 版本与运行能力](references/java-profiles.md)。

## 工具链

需要 Python 3.10+ 与 Pillow；矩阵对照需要 Node.js。所有命令里的 `$SKILL` 指本技能绝对目录。脚本对新输出拒绝覆盖，报告必须放在专用工作目录。

| 脚本 | 作用 | 副作用 |
|---|---|---|
| `bb_doctor.py` / `bb_client.py` | loopback MCP 只读诊断与协议连接 | 只读 |
| `bb_snapshot.py` | 编译当前工程，写快照与哈希清单 | 写新目录 |
| `bb_capture.py` | 创建/销毁离屏视图，多机位截图 | 写新截图目录 |
| `audit_model.py` | 审计 `.bbmodel` 或实际 Java JSON | 写报告 |
| `audit_cost.py` | 对照显式预算估算组件/面/纹理/展开成本 | 写报告 |
| `compare_renders.py` | 固定条件像素对照，支持 `--strict` | 写报告 |
| `outline_builder.py` | 生成/更新单色倒置描边壳 | 写新候选 + sidecar |
| `optimize_model.py` | 声明静态范围内的保守合并/剔除 | 写新候选 + 报告 |
| `texture_tools.py` | 确定性色板/图集/动画帧装配 | 写新目录 |
| `package_model.py` | 按显式清单与 SHA-256 打包资源包 | 写 staging + ZIP |
| `validate_motion.js` | 比较实际采样的渲染矩阵 JSON | 写报告 |
| `assets/preview_runtime.js` | Blockbench 内临时刚性预览驱动 | 仅渲染层，可恢复 |

```sh
python "$SKILL/scripts/bb_doctor.py" --output work/doctor.json
python "$SKILL/scripts/bb_snapshot.py" --project-id ACTUAL_UUID --output work/baseline
python "$SKILL/scripts/audit_model.py" work/model.bbmodel --profile java-26.1 --output work/structure.json
python "$SKILL/scripts/audit_cost.py" work/model.bbmodel --profile java-26.1 --plan work/cost-plan.json --output work/cost.json
python "$SKILL/scripts/compare_renders.py" work/before work/after --strict --background 32,39,49 --output work/diff.json
python "$SKILL/scripts/package_model.py" work/package.json --root work/export --output work/delivery
node "$SKILL/scripts/validate_motion.js" work/motion-before.json work/motion-after.json 0 work/diff.json
```

完整的参数、输入格式与适用边界见 [脚本操作](references/tools.md)。

## 交付闸门

1. **发现现场**：`get_capabilities(include_tools=true)`、`get_project_info`、`list_modes`、`list_export_formats`。mode disabled 不等于工具缺失。
2. **冻结基线**：未被保存的实时工程先用 `bb_snapshot.py` 快照；磁盘文件可能落后于屏幕。undo checkpoint 是历史标记，不是备份。
3. **结构审计**：对 `.bbmodel` 和实际导出的 Java JSON 分别执行 `audit_model.py`。退出码 0 只表示本脚本覆盖的规则未发现错误，仍须看 `dependencies_complete`、warnings 与 limitations。
4. **成本**：`audit_cost.py` 必须提供显式预算；`within_declared_budgets=null` 表示没有预算，不是通过。
5. **视觉**：固定相机、灯光、背景、视口与动画时刻截图；用 `compare_renders.py` 对照，不用空背景平均误差稀释局部错误。
6. **描边与发光**：按 [描边与外发光](references/outline-glow.md) 的倒置壳规则；`outline_builder.py` 需要专用 front-only 贴图，并保留 `.outline-map.json`。
7. **打包**：实际导出后用 `package_model.py`，清单文件哈希必须匹配；合法外部依赖逐条加入。
8. **报告**：编辑工程、导出资源、目标运行时三栏分开；未测量的项明确写“未测”。

## 性能硬规则

1. **先算成本，再批量生成。** 灰模阶段按主体、装饰、描边、特效和运动轨道估算组件、面、材质及动画展开量，设定本项目预算。
2. **按结构建模，禁止无理由的碎片化。** 斜面优先旋转体块，连续表面优先连续几何；仅承担表面色差、刻线或纹理的细节用贴图。
3. **动画存运动，不能默认存整套逐帧副本。** 刚性装配优先一套几何加共享变换；纹理变化优先动画纹理。
4. **完成保守清理。** 只有证明在相关状态中不可见、且无骨骼/挂点等语义才删除；透明面、cutout 空洞、倒置壳不能当普通实心体。
5. **描边和特效也受预算约束。** 只给需要的轮廓加壳，不默认逐零件多层包壳。
6. **优化不得偷换外观和动画。** 修改前保留基线，锁定形状、配色、UV 可见结果、厚度、描边、轨迹、时序和显示变换。
7. **编辑器、导出和实际运行分别验收。** 编辑器 FPS、模板压缩和预览合批不能直接换算成游戏 FPS。
8. **禁止未审计交付。** 交付前检查实际导出及固定条件下的多视角、关键动画时刻和 Display。

执行方法、数量公式与历史案例见 [低组件建模与保真优化](references/performance-methodology.md)。

## 版本与实测兼容（2026-11-20）

本机实测为 Blockbench 5.2.2 + MCP 插件 1.8.1，技能文档的基准版本是 1.10.1。两者行为有差异：

- 原生工具按项目与模式动态注册：无项目时 `tools/list` 只有 16 个，开项目后 `get_capabilities` 显示 64 个可用。不要因为列表里暂时没有就判定工具不存在。
- 1.8.1 下离屏**正交**截图可能返回空白帧，透视正常；离屏取景还会整体水平偏移约 17%（320/480/640/800 四档复测一致）。`bb_capture.py` 只记录 requested/applied camera，不会自动校准，必须读图检查取景。
- `risky_eval` 拒绝包含注释和 `console.` 的代码；通过它修改模型时必须自己管理正确的 Undo 事务。
- `.bbmodel` 中 `face.texture` 必须是纹理 UUID；写索引 `0` 会被当作未赋值，`audit_model.py` 会报 `faceless_elements`。Java 导出的 `#0` 引用不受影响。
- BB 5.2.2 删除离屏视图可能报 `onContextMenu is not defined`；`bb_capture.py` 会复查 `list_views` 与 `Preview.all` 后才保留截图并写 `cleanup_warning`。
- Windows 上 `test_workflow.py` 的 symlink 用例需要开发者模式或管理员权限；失败属于环境限制，不是逻辑错误。
- 插件 1.10.1 才提供较多原生建模工具；1.8.1 下部分操作只能用 `risky_eval`，按 live schemas 执行，不要照搬文档中的假设工具名。

## 与 openmods 其他技能的关系

- 几何、mesh、层级与 Bedrock 图元：[blockbench-modeling](../blockbench-modeling/SKILL.md)
- UV、绘制、图层与 PBR：[blockbench-texturing](../blockbench-texturing/SKILL.md)
- 能力发现、格式选择、外观/性能偏好：[blockbench-use](../blockbench-use/SKILL.md)
- 本技能只补“验收与交付”，不重复工具手册。

## 维护自检

```sh
python "$SKILL/scripts/selftest.py"
python "$SKILL/scripts/test_workflow.py"
node "$SKILL/scripts/test_motion.js"
```

测试使用临时目录与自制几何。运行中 Blockbench 的烟测是独立可选步骤，先快照用户现场，使用临时项目，最后恢复。

## 不承诺

- 不证明 Minecraft 客户端 FPS；draw call 必须实测。
- 不认证未知版本（含 26.3）或未覆盖的运行时。
- 不把编辑器模板压缩、预览合批或 ZIP 体积当成运行时收益。
- 不把“截图看起来一样”当成结构、UV、动画全部等价。

## 来源

脚本与参考方法移植自 <https://github.com/Srar-Git/minecraft-modeling-item>。上游仓库未附 LICENSE 文件；对外分发前请确认授权与归属。
