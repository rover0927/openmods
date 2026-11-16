// 最小 PNG 编码器：生成纯色 RGB PNG（贴图用），无第三方依赖
import { deflateSync } from 'node:zlib'

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

/** 生成 w×h 的纯色 PNG Buffer（RGB，filter 0） */
export function solidPng(hex: string, w = 64, h = 64): Buffer {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  const int = m ? parseInt(m[1], 16) : 0xb4b4b4
  const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  // 10-12: compression/filter/interlace = 0

  const stride = w * 3
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter none
    for (let x = 0; x < w; x++) {
      const p = rowStart + 1 + x * 3
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function solidPngDataUrl(hex: string, w = 64, h = 64): string {
  return `data:image/png;base64,${solidPng(hex, w, h).toString('base64')}`
}
