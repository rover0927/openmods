// 功能开关：画布 / Minecraft / 素材库可以独立关掉。
//
// 服务端在启动时按 prefs.features 解析出"启动态"，插件按 requires 决定是否 apply，
// 角色、技能、工具、系统提示都跟着消失；前端通过 /api/features 拿到同一份事实源。
// 开关本身是 durable 的（settings.json），改动需要重启才能重新加载插件。

export interface FeatureDef {
  id: string
  name: string
  description: string
  /** 缺省是否开启 */
  default: boolean
}

export const FEATURE_DEFS: FeatureDef[] = [
  {
    id: 'canvas',
    name: '画布与建模',
    description: 'Blockbench 风格画布、建模子代理与模型素材编辑；关闭后只剩通用对话/编码能力。',
    default: true,
  },
  {
    id: 'mc',
    name: 'Minecraft 模组开发',
    description: 'MC 模组脚手架、Gradle 构建、日志与运行工具，以及 mcmod 角色。',
    default: true,
  },
  {
    id: 'library',
    name: '素材库',
    description: '模型 / jar / 图片等资产的归档入口；关闭后素材库接口与前端入口一起隐藏。',
    default: true,
  },
]

export type FeatureStates = Record<string, boolean>

/**
 * prefs.features（用户选择）→ 启动态（缺省取声明的 default）。
 *
 * defs 必须传「内置 + 插件」合并后的完整声明表：插件自带的开关 id 只有进了启动态，
 * `requires` 才可能被关掉；只按内置表解析会让插件开关变成永远无效的摆设。
 */
export function resolveFeatureStates(
  prefs?: Record<string, boolean> | null,
  defs: { id: string; default?: boolean }[] = FEATURE_DEFS,
): FeatureStates {
  const out: FeatureStates = {}
  for (const def of defs) {
    const v = prefs?.[def.id]
    out[def.id] = typeof v === 'boolean' ? v : def.default !== false
  }
  return out
}

export function isFeatureOn(states: FeatureStates, id: string | undefined): boolean {
  return !id || states[id] !== false
}
