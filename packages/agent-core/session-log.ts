// 会话事件日志：append-only JSONL，回放即状态（dsh durable log 同思路）。
// 压缩不篡改历史：compaction/summary 事件只把区间标记为影子并插入摘要节点，重放确定。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolCall } from './types.js'

export type SessionEvent = { seq: number; ts: number; t: string } & Record<string, any>

export interface SurfaceItem {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'summary'
  content: string | null
  toolCalls?: { id: string; name: string; args: string }[]
  toolCallId?: string
  attachments?: any[]
  /** 旧数据：图片已经过桥接模型转述，发往模型时不再附带图片 parts（新数据不再产生） */
  transcribed?: boolean
  /** 本轮图片按 dsh 语义被换成占位文本（模型不支持视觉输入） */
  imagesOmitted?: boolean
  shadowed?: boolean
}

export class SessionLog {
  private events: SessionEvent[] = []
  private seq = 0
  private file?: string

  constructor(file?: string) {
    if (file) {
      this.file = file
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file)) this.replayFromDisk(file)
    }
  }

  private replayFromDisk(file: string) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        this.events.push(ev)
        this.seq = Math.max(this.seq, ev.seq)
      } catch { /* 容忍尾行损坏 */ }
    }
  }

  append(t: string, data: Record<string, any> = {}): SessionEvent {
    const ev: SessionEvent = { seq: ++this.seq, ts: Date.now(), t, ...data }
    this.events.push(ev)
    if (this.file) appendFileSync(this.file, JSON.stringify(ev) + '\n')
    return ev
  }

  all(): SessionEvent[] {
    return this.events
  }

  /** 把日志折叠为压缩感知的 surface（system prompt 不含在内，由循环层单独拼） */
  buildSurface(): SurfaceItem[] {
    const surface: SurfaceItem[] = []
    for (const ev of this.events) {
      switch (ev.t) {
        case 'user/message':
          surface.push({
            seq: ev.seq, kind: 'user', content: ev.text,
            attachments: ev.attachments, transcribed: ev.transcribed, imagesOmitted: ev.imagesOmitted,
          })
          break
        case 'assistant/message':
          surface.push({
            seq: ev.seq, kind: 'assistant', content: ev.text ?? '',
            toolCalls: ev.toolCalls?.length ? ev.toolCalls as ToolCall[] : undefined,
          })
          break
        case 'tool/result':
          surface.push({ seq: ev.seq, kind: 'tool', content: ev.forModel, toolCallId: ev.callId })
          break
        case 'compaction/summary': {
          // 影子化区间 + 插入摘要节点（唯一允许的 surface 变更，dsh 同款事务语义）
          let shadowed = 0
          for (const item of surface) {
            if (item.seq >= ev.fromSeq && item.seq <= ev.toSeq && !item.shadowed) {
              item.shadowed = true
              shadowed++
            }
          }
          surface.push({
            seq: ev.seq, kind: 'summary',
            content: `<compacted-summary>\n${ev.summaryText}\n</compacted-summary>`,
            shadowed: false,
          })
          ev.shadowedCount = shadowed
          break
        }
      }
    }
    return surface
  }
}
