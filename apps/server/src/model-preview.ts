// 模型缩略图：把 bbmodel 快照渲染成等距 3D 预览 PNG（无第三方依赖）。
// 为什么不用贴图：卡片要能一眼看出模型长什么样，第一张贴图往往只是调色板/局部纹理。
// 这里做的是"预览"而不是精确渲染：只画每个方块的可见面（按材质色 + 面朝向明暗），
// 用画家算法排序；分组旋转/动画姿态不参与（静态预览够用）。
import { deflateSync, inflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** RGBA PNG（filter 0，无交错） */
function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1)
    raw[row] = 0
    raw.set(rgba.subarray(y * stride, y * stride + stride), row + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

type RGB = [number, number, number]
type Vec3 = [number, number, number]

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 取 PNG 的平均不透明颜色（8bit，非交错；调色板图按 PLTE 展开） */
function averagePngColor(buf: Buffer): RGB | undefined {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return undefined
  let off = 8
  let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0
  let palette: Buffer | undefined
  const idat: Buffer[] = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]; interlace = data[10]
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (!w || !h || depth !== 8 || interlace !== 0) return undefined
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (!channels) return undefined
  if (colorType === 3 && !palette) return undefined
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(idat)) } catch { return undefined }
  const stride = w * channels
  if (raw.length < (stride + 1) * h) return undefined
  const px = Buffer.alloc(stride * h)
  const bpp = channels
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0
      const b = y > 0 ? px[dst - stride + x] : 0
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0
      let v = raw[src + x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[dst + x] = v & 0xff
    }
  }
  // 最多采样约 1024 个点，避免大贴图拖慢缩略图
  const step = Math.max(1, Math.floor((w * h) / 1024))
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < w * h; i += step) {
    const p = i * channels
    let cr: number, cg: number, cb: number, alpha = 255
    if (colorType === 3) {
      const idx = px[p] * 3
      if (idx + 2 >= palette!.length) continue
      cr = palette![idx]; cg = palette![idx + 1]; cb = palette![idx + 2]
    } else if (colorType === 0 || colorType === 4) {
      cr = cg = cb = px[p]
      if (colorType === 4) alpha = px[p + 1]
    } else {
      cr = px[p]; cg = px[p + 1]; cb = px[p + 2]
      if (colorType === 6) alpha = px[p + 3]
    }
    if (alpha < 16) continue
    r += cr; g += cg; b += cb; n++
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : undefined
}

function hexColor(name: string): RGB | undefined {
  const m = /^mat_([0-9a-f]{6})$/i.exec(name)
  if (!m) return undefined
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function textureColors(textures: any[]): Map<string, RGB> {
  const map = new Map<string, RGB>()
  for (const t of textures) {
    if (!t || typeof t !== 'object') continue
    const byName = hexColor(String(t.name ?? ''))
    if (byName) { map.set(String(t.uuid ?? ''), byName); if (t.id != null) map.set(String(t.id), byName); continue }
    const src = typeof t.source === 'string' ? t.source : ''
    if (!src.startsWith('data:image/png;base64,')) continue
    try {
      const rgb = averagePngColor(Buffer.from(src.slice('data:image/png;base64,'.length), 'base64'))
      if (rgb) { map.set(String(t.uuid ?? ''), rgb); if (t.id != null) map.set(String(t.id), rgb) }
    } catch { /* 贴图解析失败就用默认灰 */ }
  }
  return map
}

/** 面 → bbmodel 的 faces 键名 */
const FACE_KEY = ['north', 'south', 'east', 'west', 'up', 'down'] as const
/** 每个面的顶点下标（顺序即绕序） */
const FACE_VERTS: number[][] = [
  [0, 1, 2, 3], // north (-Z)
  [5, 4, 7, 6], // south (+Z)
  [1, 5, 6, 2], // east (+X)
  [4, 0, 3, 7], // west (-X)
  [3, 2, 6, 7], // up (+Y)
  [0, 4, 5, 1], // down (-Y)
]
/** 面朝向明暗：顶面最亮，侧面次之，底面最暗 */
const FACE_SHADE = [0.9, 0.74, 0.82, 0.66, 1, 0.5]

function rotPoint(p: Vec3, origin: Vec3, rot: Vec3): Vec3 {
  const [rx, ry, rz] = rot.map(d => (d * Math.PI) / 180) as Vec3
  const x = p[0] - origin[0], y = p[1] - origin[1], z = p[2] - origin[2]
  // Rx → Ry → Rz（Blockbench 的常见欧拉顺序，预览足够）
  const y1 = y * Math.cos(rx) - z * Math.sin(rx)
  const z1 = y * Math.sin(rx) + z * Math.cos(rx)
  const x2 = x * Math.cos(ry) + z1 * Math.sin(ry)
  const z2 = -x * Math.sin(ry) + z1 * Math.cos(ry)
  const x3 = x2 * Math.cos(rz) - y1 * Math.sin(rz)
  const y3 = x2 * Math.sin(rz) + y1 * Math.cos(rz)
  return [origin[0] + x3, origin[1] + y3, origin[2] + z2]
}

interface Face {
  pts: { x: number; y: number }[]
  depth: number
  rgb: RGB
}

/**
 * 把画布/素材快照渲染成等距预览 PNG。没有元素时返回 undefined（调用方回退到贴图）。
 */
export function renderModelPreview(doc: { elements?: any[]; textures?: any[] }, size = 256): Buffer | undefined {
  const elements = Array.isArray(doc?.elements) ? doc.elements : []
  if (!elements.length) return undefined
  const colors = textureColors(Array.isArray(doc?.textures) ? doc.textures : [])

  const faces: Face[] = []
  const projected: { x: number; y: number }[] = []
  const COS30 = Math.cos(Math.PI / 6)
  const SIN30 = 0.5
  const view: Vec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]

  for (const el of elements) {
    if (!el || !Array.isArray(el.from) || !Array.isArray(el.to)) continue
    const from = el.from.map(Number), to = el.to.map(Number)
    if (from.some((v: number) => !Number.isFinite(v)) || to.some((v: number) => !Number.isFinite(v))) continue
    const x0 = Math.min(from[0], to[0]), x1 = Math.max(from[0], to[0])
    const y0 = Math.min(from[1], to[1]), y1 = Math.max(from[1], to[1])
    const z0 = Math.min(from[2], to[2]), z1 = Math.max(from[2], to[2])
    if (x1 - x0 < 1e-6 && y1 - y0 < 1e-6 && z1 - z0 < 1e-6) continue
    const corners: Vec3[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ]
    const origin = Array.isArray(el.origin) && el.origin.length === 3
      ? el.origin.map(Number) as Vec3
      : [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] as Vec3
    const rot = Array.isArray(el.rotation) && el.rotation.length === 3
      ? el.rotation.map(Number) as Vec3
      : [0, 0, 0] as Vec3
    const moved = rot[0] || rot[1] || rot[2]
      ? corners.map(p => rotPoint(p, origin, rot))
      : corners

    for (let f = 0; f < 6; f++) {
      const idx = FACE_VERTS[f]
      const a = moved[idx[0]], b = moved[idx[1]], c = moved[idx[2]]
      // 法线 = (b-a) × (c-a)
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const n: Vec3 = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      if (n[0] * view[0] + n[1] * view[1] + n[2] * view[2] <= 1e-6) continue // 背面剔除

      const key = FACE_KEY[f]
      const tex = el.faces?.[key]?.texture
      const base = (tex != null ? colors.get(String(tex)) : undefined) ?? [150, 150, 150] as RGB
      const shade = FACE_SHADE[f]
      const rgb: RGB = [
        Math.min(255, Math.round(base[0] * shade)),
        Math.min(255, Math.round(base[1] * shade)),
        Math.min(255, Math.round(base[2] * shade)),
      ]
      const pts = idx.map(i => {
        const p = moved[i]
        return { x: (p[0] - p[2]) * COS30, y: (p[0] + p[2]) * SIN30 - p[1] }
      })
      projected.push(...pts)
      const depth = idx.reduce((s, i) => s + moved[i][0] + moved[i][1] + moved[i][2], 0) / 4
      faces.push({ pts, depth, rgb })
    }
  }
  if (!faces.length) return undefined

  // 取景：所有投影点缩放到画布内（留边），再按深度从远到近画
  const xs = projected.map(p => p.x), ys = projected.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6)
  const margin = size * 0.1
  const scale = (size - margin * 2) / Math.max(spanX, spanY)
  const cx = size / 2 - ((minX + maxX) / 2) * scale
  // 投影后的 y 已经是"屏幕向下为正"（等距公式里的 -y 项），换算像素时不要再取反，
  // 否则整张预览会上下颠倒
  const cy = size / 2 - ((minY + maxY) / 2) * scale

  const SS = 2 // 2x 超采样，边缘更干净
  const W = size * SS
  const rgba = new Uint8Array(W * W * 4)
  const toPixel = (p: { x: number; y: number }) => [p.x * scale * SS + cx * SS, p.y * scale * SS + cy * SS] as [number, number]

  faces.sort((a, b) => a.depth - b.depth)
  for (const f of faces) {
    const quad = f.pts.map(toPixel)
    fillQuad(rgba, W, W, quad, f.rgb)
  }

  // 下采样 + 透明度阈值
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const p = ((y * SS + dy) * W + (x * SS + dx)) * 4
          const aa = rgba[p + 3]
          if (!aa) continue
          r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; a += aa
        }
      }
      const q = (y * size + x) * 4
      if (a > 0) {
        const n = a / 255
        out[q] = Math.round(r / n); out[q + 1] = Math.round(g / n); out[q + 2] = Math.round(b / n)
        out[q + 3] = Math.min(255, Math.round(a / (SS * SS)))
      }
    }
  }
  return encodePng(out, size, size)
}

/** 凸四边形填充（扫描线 + 半平面测试） */
function fillQuad(rgba: Uint8Array, w: number, h: number, quad: [number, number][], rgb: RGB) {
  const xs = quad.map(p => p[0]), ys = quad.map(p => p[1])
  const minX = Math.max(0, Math.floor(Math.min(...xs)))
  const maxX = Math.min(w - 1, Math.ceil(Math.max(...xs)))
  const minY = Math.max(0, Math.floor(Math.min(...ys)))
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...ys)))
  if (minX > maxX || minY > maxY) return
  let area = 0
  for (let i = 0; i < 4; i++) {
    const p = quad[i], q = quad[(i + 1) % 4]
    area += p[0] * q[1] - q[0] * p[1]
  }
  const sign = area >= 0 ? 1 : -1
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      let inside = true
      for (let i = 0; i < 4; i++) {
        const p = quad[i], q = quad[(i + 1) % 4]
        const cross = (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])
        if (cross * sign < -1e-6) { inside = false; break }
      }
      if (!inside) continue
      const o = (y * w + x) * 4
      rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255
    }
  }
}
