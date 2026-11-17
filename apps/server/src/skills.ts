// 目录型技能提供器：skills/<name>/SKILL.md 即技能（可插拔、热扫描、按需读取）
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { SkillMeta, SkillProvider } from '@openmods/plugin-kit'

export class DirSkillProvider implements SkillProvider {
  id = 'dir-skills'
  constructor(private skillsDir: string) {}

  private scan(): { name: string; dir: string; description: string }[] {
    if (!existsSync(this.skillsDir)) return []
    const out: { name: string; dir: string; description: string }[] = []
    for (const d of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const file = join(this.skillsDir, d.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const raw = readFileSync(file, 'utf8')
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
      const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? d.name
      const description = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
      out.push({ name, dir: join(this.skillsDir, d.name), description })
    }
    return out
  }

  list(): SkillMeta[] {
    return this.scan().map(s => ({ name: s.name, description: s.description }))
  }

  async load(name: string): Promise<string> {
    const found = this.scan().find(s => s.name === name)
    if (!found) throw new Error(`技能不存在: ${name}（可用: ${this.scan().map(s => s.name).join(', ') || '无'}）`)
    return readFileSync(join(found.dir, 'SKILL.md'), 'utf8')
  }

  dirOf(name: string): string | null {
    return this.scan().find(s => s.name === name)?.dir ?? null
  }

  async read(name: string, file: string): Promise<string> {
    const found = this.scan().find(s => s.name === name)
    if (!found) throw new Error(`技能不存在: ${name}（可用: ${this.scan().map(s => s.name).join(', ') || '无'}）`)
    // 只允许技能目录内的文件，避免 file=../../.env 这类越界读取
    const base = resolve(found.dir)
    const abs = resolve(base, file)
    if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`file 必须位于技能目录内：${file}`)
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`技能文件不存在：${file}`)
    return readFileSync(abs, 'utf8')
  }
}

/**
 * 技能门控包装：功能插件被跳过（如关闭 canvas/mc）时，它声明的技能从列表与 load_skill 一起消失，
 * 避免系统提示/工具/前端看到"还在但不能用"的技能。
 */
export class FilteredSkillProvider implements SkillProvider {
  constructor(private inner: SkillProvider, private hidden: Set<string>) {}
  get id() { return this.inner.id }
  list(): SkillMeta[] {
    return this.inner.list().filter(s => !this.hidden.has(s.name))
  }
  async load(name: string): Promise<string> {
    if (this.hidden.has(name)) throw new Error(`技能不存在: ${name}（所属功能已关闭）`)
    return this.inner.load(name)
  }

  dirOf(name: string): string | null {
    if (this.hidden.has(name)) return null
    return this.inner.dirOf?.(name) ?? null
  }

  async read(name: string, file: string): Promise<string> {
    if (this.hidden.has(name)) throw new Error(`技能不存在: ${name}（所属功能已关闭）`)
    if (!this.inner.read) throw new Error(`技能 ${name} 不支持读取附加文件`)
    return this.inner.read(name, file)
  }
}
