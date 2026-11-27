# Java 物品目标版本与运行能力

开工前记录：游戏版本、Java/Bedrock、物品还是方块/实体、Blockbench `format_id`、目标导出、动画驱动、是否允许客户端扩展。用户已经给出的信息不要重复问。

## 目标与合理路径

| 目标 | 合理路径 | 不能据此承诺 |
|---|---|---|
| Java 物品/方块 | `java_block`；几何 JSON＋贴图＋所需 item definition/display | Generic mesh、编辑器骨骼或预览 JS 不会自动运行 |
| BetterModel / ModelEngine 玩家或实体特效 | 对应已安装格式与导出器；保留骨骼/挂点/原动作 | 本技能的 Java 审计器不认证这些运行时；深入实体动画需专门流程 |
| Bedrock / GeckoLib | 检测相应格式/插件并按其文档处理 | Java 的发光、坐标、材质和动画契约不能照搬 |
| Hytale | 转到 Hytale 对应技能/格式 | 其密度与 UV 规则不能指导 Java 物品 |

## 审计 profile

`audit_model.py --profile` 必填，当前支持：

| profile | 覆盖范围 | 旋转规则 |
|---|---|---|
| `java-legacy` | 1.21.2–1.21.5 项目的本地结构预检 | 单轴，±45°，22.5° 步进 |
| `java-1.21.6` | 单轴、连续角度 | 单轴，±45°，连续角度 |
| `java-26.1` | 多轴/自由角度、sprite 对象；资源包打包固定核查 `pack_format: 84` | 多轴，自由角度 |
| `generic` | 有限的可编辑立方体结构检查 | 不认证 Bedrock/ModelEngine/mesh 导出 |

其他版本（包括 26.3）**不能**自动映射到 `java-26.1` 后宣称兼容。先查该版本官方说明或导出实现，补充明确 profile 和测试；报告中只能列出现有审计覆盖的共同部分，不能让它批准未知版本。

## Java 物品的硬事实

- **物品没有原生几何动画**。`java_block` 只有 display transforms、模型选择与物品定义；所谓“分帧动画”需要明确的运行时触发条件（predicate、状态或 mod），默认持有、右键使用和插件驱动是不同效果，不要自行替换。
- 任意梯形、三角形或自由网格**不会**因为放进 `.bbmodel` 就导出成 Java cuboid。斜面优先用合法旋转的长方体或封闭表面组合。
- Java 的零厚度面可以当薄片使用；负尺寸（倒置）壳依赖客户端单面剔除，不能开双面“修复”。
- JSON UV 通常位于 0–16 空间；Blockbench 可能按项目或每张纹理自己的逻辑宽高计算，不能对全部纹理统一除以 8。
- 编辑器里的 PBR、emissive、double-sided 预览开关，不等于原版客户端存在同名字段。Java 原版光照由游戏控制，颜色与明暗要画进 albedo。
- `light_emission`、`shade` 等字段必须看实际导出与目标版本；Blockbench 预览不会完整重现 Java 的最低受光。

## 资源包交付

先用当前工程重新执行目标导出器，再打包：

- `pack.mcmeta` 的 `pack_format` 与目标版本一致（`java-26.1` profile 固定核查 84）。
- 模型 JSON 的 `parent`、纹理引用、item definition 的 model 叶子引用要能解析。
- 清单里的每个文件用真实 SHA-256，拒绝过期或装错的文件；合法外部依赖逐条加入，不能批量忽略整个 `minecraft` 命名空间。
- 打包器只负责已正确导出的 JSON 与贴图，不把预览 JS 翻译成游戏动画。

## 证据边界

`get_capabilities` 只反映编辑器声明，不证明运行时兼容。若未在目标客户端实测，报告中必须明确写“游戏端未实测”，只报告实际完成的静态检查、编辑器预览与资源包校验。
