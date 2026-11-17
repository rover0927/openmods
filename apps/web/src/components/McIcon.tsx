import type { CSSProperties } from 'react'

/**
 * 语义 → 官方物品图标文件名（`public/mc/item/<file>.png`）。
 * 组件只引语义名，换图时只改这一张表。
 */
export const MC_ICON = {
  newGroup: 'brick',
  library: 'book',
  settings: 'clock',
  canvas: 'diamond_pickaxe',
  images: 'map',
  files: 'paper',
  web: 'ender_pearl',
  terminal: 'redstone',
  plan: 'enchanted_book',
  subagents: 'totem_of_undying',
  stats: 'ender_eye',
  send: 'arrow',
  stop: 'shears',
  attach: 'bucket',
  cwd: 'compass',
  model: 'experience_bottle',
  permissionAsk: 'iron_ingot',
  permissionAuto: 'gold_ingot',
  mcRun: 'lava_bucket',
  mcStop: 'water_bucket',
  mcJar: 'emerald',
  automation: 'flint_and_steel',
  features: 'redstone',
  agents: 'enchanted_book',
} as const

export type McIconName = keyof typeof MC_ICON

/** MC 物品图标：16×16 原始像素，按整数倍放大（图像渲染保持像素化） */
export function McIcon(props: { name: McIconName; size?: number; className?: string }) {
  const size = props.size ?? 16
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundImage: `url(/mc/item/${MC_ICON[props.name]}.png)`,
  }
  return <span className={`mc-ico ${props.className ?? ''}`} style={style} aria-hidden="true" />
}
