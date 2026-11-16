// 目录型技能提供器：skills/<name>/SKILL.md 即技能（可插拔、热扫描、按需读取）
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
}
