// 材质表：place_cubes 的 material 关键字 → 颜色。LLM 用语义名，也可直接传 #RRGGBB。
export const MATERIALS: Record<string, string> = {
  default: '#B4B4B4',
  hair: '#C9E6DE', hair_dark: '#AFCFC7',
  skin: '#FDF1E7',
  white: '#FAF6EF', black: '#2A2328',
  red: '#C4453C', dark_red: '#8F2E28',
  silver: '#C9CDD4', gold: '#E8C36A', metal: '#6E7B8B', steel: '#8E9AA6',
  crystal: '#7FC8F0', crystal_light: '#A9DDF7', crystal_deep: '#4E8FC7',
  shoe: '#4C4340', tights: '#F7EEDF',
  eye_pink: '#EE9FC0', eye_blue: '#A6D8F2', mouth: '#A9645C', blush: '#F6AEC0',
  wood: '#8A6B4A', leaf: '#5E9C58', green: '#5E9C58', stone: '#7A7A7A',
  fire: '#FF7A45', glow: '#FFE082',
  fabric_blue: '#5B84C4', purple: '#8E6FB8', pink: '#F2A0BE',
}

export function resolveColor(material?: string): string {
  if (!material) return MATERIALS.default
  const key = material.toLowerCase()
  if (MATERIALS[key]) return MATERIALS[key]
  if (/^#[0-9a-f]{6}$/i.test(material)) return material
  return MATERIALS.default
}

export function materialListForPrompt(): string {
  return Object.keys(MATERIALS).join('/')
}
