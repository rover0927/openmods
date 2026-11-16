// 服务端 bbmodel 文档：内存中的模型文档 + 编译为 Blockbench 可加载的 bbmodel JSON
// 格式参照本地 blockbench 源码 js/formats/bbmodel.js 的 compile()（free 通用模型格式）
import { randomUUID } from 'node:crypto'
import { resolveColor } from './materials.js'
import { solidPngDataUrl } from './png.js'

export interface BbFace { uv: [number, number, number, number]; texture: string }

export interface BbElement {
  name: string
  uuid: string
  type: 'cube'
  from: number[]
  to: number[]
  origin: number[]
  rotation?: number[]
  autouv: 1
  color: number
  faces: Record<'north' | 'south' | 'east' | 'west' | 'up' | 'down', BbFace>
}

export interface BbGroup {
  name: string
  uuid: string
  origin: number[]
  children: (string | BbGroup)[]
}

export interface BbTexture {
  uuid: string
  name: string
  id: string
  width: number
  height: number
  source: string // dataURL
  saved: false
  mode: 'bitmap'
}

/** 动画关键帧：time 秒；rotation 度数；position 单位与方块一致 */
export interface BbAnimKeyframe {
  time: number
  rotation?: [number, number, number]
  position?: [number, number, number]
}

/** 骨骼动画：bones 的键必须是模型里已存在的分组（骨骼）名 */
export interface BbAnimation {
  name: string
  length: number
  loop: 'loop' | 'once' | 'hold'
  bones: Record<string, BbAnimKeyframe[]>
}

export interface BbDoc {
  name: string
  elements: BbElement[]
  outliner: (string | BbGroup)[]
  textures: BbTexture[]
  animations: BbAnimation[]
  view: '3d' | 'front' | 'side' | 'back'
}

export function createDoc(name: string): BbDoc {
  return { name, elements: [], outliner: [], textures: [], animations: [], view: '3d' }
}

function texIdFor(doc: BbDoc, color: string): string {
  const key = `mat_${color.replace('#', '')}`
  let tex = doc.textures.find(t => t.name === key)
  if (!tex) {
    tex = {
      uuid: randomUUID(),
      name: key,
      id: String(doc.textures.length),
      width: 64,
      height: 64,
      source: solidPngDataUrl(color),
      saved: false,
      mode: 'bitmap',
    }
    doc.textures.push(tex)
  }
  return tex.uuid
}

const ALL_FACES = ['north', 'south', 'east', 'west', 'up', 'down'] as const

export function addCube(doc: BbDoc, spec: { name: string; from: number[]; to: number[]; material?: string; parent?: string }): BbElement {
  // 名字去重
  let name = spec.name || 'cube'
  let n = 2
  while (doc.elements.some(e => e.name === name)) name = `${spec.name}_${n++}`

  const color = resolveColor(spec.material)
  const texUuid = texIdFor(doc, color)
  const el: BbElement = {
    name,
    uuid: randomUUID(),
    type: 'cube',
    from: spec.from.map(Number),
    to: spec.to.map(Number),
    origin: [0, 0, 0],
    autouv: 1,
    color: 0,
    faces: Object.fromEntries(ALL_FACES.map(f => [f, { uv: [0, 0, 16, 16], texture: texUuid }])) as BbElement['faces'],
  }
  doc.elements.push(el)

  const parent = spec.parent && spec.parent !== 'root' ? findGroup(doc, spec.parent) : undefined
  if (parent) parent.children.push(el.uuid)
  else doc.outliner.push(el.uuid)
  return el
}

export function findGroup(doc: BbDoc, nameOrUuid: string): BbGroup | undefined {
  const walk = (nodes: (string | BbGroup)[]): BbGroup | undefined => {
    for (const node of nodes) {
      if (typeof node === 'string') continue
      if (node.uuid === nameOrUuid || node.name === nameOrUuid) return node
      const found = walk(node.children)
      if (found) return found
    }
  }
  return walk(doc.outliner)
}

export function addGroup(doc: BbDoc, name: string, parent?: string, origin: number[] = [0, 0, 0]): BbGroup {
  const group: BbGroup = { name, uuid: randomUUID(), origin, children: [] }
  const parentNode = parent && parent !== 'root' ? findGroup(doc, parent) : undefined
  if (parentNode) parentNode.children.push(group)
  else doc.outliner.push(group)
  return group
}

/** 编译为 Blockbench 可加载的 bbmodel JSON（free 通用模型格式，含骨骼动画） */
export function compile(doc: BbDoc): any {
  const animations = (doc.animations ?? []).map(a => ({
    uuid: randomUUID(),
    name: a.name.includes('.') ? a.name : `animation.${doc.name}.${a.name}`,
    loop: a.loop,
    length: a.length,
    snapping: 24,
    animators: Object.fromEntries(
      Object.entries(a.bones).map(([bone, keyframes]) => {
        const kf: any[] = []
        for (const k of keyframes) {
          if (k.rotation) kf.push({
            channel: 'rotation',
            data_points: [{ x: k.rotation[0], y: k.rotation[1], z: k.rotation[2] }],
            time: k.time,
            interpolation: 'linear',
            color: -1,
          })
          if (k.position) kf.push({
            channel: 'position',
            data_points: [{ x: k.position[0], y: k.position[1], z: k.position[2] }],
            time: k.time,
            interpolation: 'linear',
            color: -1,
          })
        }
        return [bone, { name: bone, type: 'bone', keyframes: kf }]
      }),
    ),
  }))
  return {
    meta: {
      format_version: '4.10',
      model_format: 'free',
      box_uv: false,
      name: doc.name,
    },
    name: doc.name,
    model_identifier: doc.name,
    elements: doc.elements,
    outliner: doc.outliner,
    textures: doc.textures,
    animations,
    display: {},
  }
}

export function docCounts(doc: BbDoc): { elements: number; textures: number } {
  return { elements: doc.elements.length, textures: doc.textures.length }
}

/** 大纲树文本（给模型看的紧凑形式） */
export function outlineText(doc: BbDoc): string {
  if (!doc.elements.length) return '（画布为空）'
  const size = (e: BbElement) =>
    `[${e.from.map(v => +v.toFixed(2)).join(',')}] → [${e.to.map(v => +v.toFixed(2)).join(',')}]`
  const lines: string[] = []
  const walk = (nodes: (string | BbGroup)[], indent: string) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const el = doc.elements.find(e => e.uuid === node)
        if (el) lines.push(`${indent}- cube ${el.name} ${size(el)}`)
      } else {
        lines.push(`${indent}+ group ${node.name} (origin ${node.origin.join(',')}) [${node.children.length}]`)
        walk(node.children, indent + '  ')
      }
    }
  }
  walk(doc.outliner, '')
  lines.push(`共 ${doc.elements.length} 个部件 / ${doc.textures.length} 张贴图`)
  return lines.join('\n')
}
