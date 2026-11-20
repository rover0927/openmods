import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { AgentDetailDto, SkillMetaDto } from '../types.js'

/** 把工具入参 JSON Schema 摊平成「名 / 类型 / 是否必填 / 说明」 */
function toolParams(schema: any): { name: string; type: string; required: boolean; desc: string }[] {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return []
  const required: string[] = Array.isArray(schema.required) ? schema.required : []
  const typeOf = (s: any): string => {
    if (!s) return 'any'
    if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(' | ')
    if (s.type === 'array') return `array<${typeOf(s.items)}>`
    if (s.type === 'object') return 'object'
    return String(s.type ?? 'any')
  }
  return Object.entries(props).map(([name, s]: [string, any]) => ({
    name,
    type: typeOf(s),
    required: required.includes(name),
    desc: typeof s?.description === 'string' ? s.description : '',
  }))
}

/** 设置 → 代理与技能：三个角色各有哪些工具/技能，技能支持注入（新建/编辑/删除，热生效） */
export function AgentsSkillsPane(props: { onToast: (msg: string) => void }) {
  const [agents, setAgents] = useState<AgentDetailDto[]>([])
  const [skills, setSkills] = useState<SkillMetaDto[]>([])
  const [expanded, setExpanded] = useState<string | null>('lead')
  const [editing, setEditing] = useState<{ name: string; isNew: boolean; readOnly: boolean; description: string; content: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = () => {
    Promise.all([api.agentsDetail(), api.skills()])
      .then(([a, s]) => { setAgents(a.agents); setSkills(s.skills) })
      .catch(e => props.onToast(`加载失败：${e.message}`))
  }
  useEffect(reload, [])

  const toggleSkill = async (agentId: string, skill: string, on: boolean) => {
    const agent = agents.find(a => a.id === agentId)
    if (!agent) return
    const next = on ? [...agent.skills, skill] : agent.skills.filter(s => s !== skill)
    // 乐观更新，失败回滚
    setAgents(prev => prev.map(a => (a.id === agentId ? { ...a, skills: next } : a)))
    try {
      await api.setAgentSkills(agentId, next)
    } catch (e: any) {
      setAgents(prev => prev.map(a => (a.id === agentId ? { ...a, skills: agent.skills } : a)))
      props.onToast(`保存失败：${e.message}`)
    }
  }

  const openEdit = async (name: string, readOnly: boolean) => {
    try {
      const c = await api.skill(name)
      setEditing({ name, isNew: false, readOnly, description: c.description, content: c.content })
    } catch (e: any) {
      props.onToast(`读取失败：${e.message}`)
    }
  }

  const save = async () => {
    if (!editing) return
    if (!editing.description.trim() || !editing.content.trim()) {
      props.onToast('description 与正文都不能为空')
      return
    }
    setSaving(true)
    try {
      await api.saveSkill(editing.name, { description: editing.description.trim(), content: editing.content })
      props.onToast(`✓ 技能 ${editing.name} 已保存（下个会话生效）`)
      setEditing(null)
      reload()
    } catch (e: any) {
      props.onToast(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`删除技能「${name}」？其 SKILL.md 将被移除，各角色分配也会摘除。`)) return
    try {
      await api.deleteSkill(name)
      props.onToast(`已删除 ${name}`)
      reload()
    } catch (e: any) {
      props.onToast(`删除失败：${e.message}`)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <div>
          <div className="settings-section-title">代理与技能</div>
          <div className="settings-section-hint">每个角色能看到哪些工具与技能；技能可自行注入（写入 SKILL.md，下个会话生效）。</div>
        </div>
        <button className="btn" onClick={() => setEditing({ name: '', isNew: true, readOnly: false, description: '', content: '' })}>＋ 注入技能</button>
      </div>

      {/* 技能注入/编辑器 */}
      {editing && (
        <div className="skill-editor">
          <div className="skill-editor-head">
            <b>{editing.isNew ? '注入新技能' : editing.readOnly ? `查看技能（内置）：${editing.name}` : `编辑技能：${editing.name}`}</b>
            <button className="skill-editor-x" onClick={() => setEditing(null)} title="关闭">×</button>
          </div>
          {editing.isNew && (
            <input
              className="dialog-input"
              placeholder="技能名（小写字母/数字/连字符，如 my-java-notes）"
              value={editing.name}
              disabled={editing.readOnly}
              onChange={e => setEditing({ ...editing, name: e.target.value })}
            />
          )}
          <input
            className="dialog-input"
            placeholder="一句话描述（会进系统提示，模型靠它决定是否加载）"
            value={editing.description}
            disabled={editing.readOnly}
            onChange={e => setEditing({ ...editing, description: e.target.value })}
          />
          <textarea
            className="skill-content"
            placeholder={'# 技能正文（Markdown）\n\n用 load_skill 加载后模型会读到这里的全部内容。'}
            value={editing.content}
            disabled={editing.readOnly}
            onChange={e => setEditing({ ...editing, content: e.target.value })}
            rows={14}
          />
          <div className="skill-editor-actions">
            <button className="btn" onClick={() => setEditing(null)}>{editing.readOnly ? '关闭' : '取消'}</button>
            {!editing.readOnly && (
              <button
                className="btn primary"
                disabled={saving || !(editing.isNew ? /^[a-z0-9][a-z0-9-]{1,63}$/.test(editing.name) : true)}
                onClick={save}
              >{saving ? '保存中…' : '保存'}</button>
            )}
          </div>
        </div>
      )}

      {/* 技能清单 */}
      <div className="setting-group-title">技能库（{skills.length}）</div>
      <div className="skill-list">
        {skills.map(s => (
          <div key={s.name} className="skill-item">
            <div className="skill-item-main">
              <span className="skill-name">{s.name}</span>
              {s.custom
                ? <span className="skill-badge">自注入</span>
                : <span className="skill-badge builtin">内置</span>}
              <span className="skill-desc">{s.description}</span>
            </div>
            <div className="skill-item-actions">
              {s.custom ? (
                <>
                  <button className="btn" onClick={() => openEdit(s.name, false)}>编辑</button>
                  <button className="btn danger-link" onClick={() => remove(s.name)}>删除</button>
                </>
              ) : (
                // 内置技能只读：仅可查看，不可编辑/删除（服务端同样拦截）
                <button className="btn" onClick={() => openEdit(s.name, true)}>查看</button>
              )}
            </div>
          </div>
        ))}
        {!skills.length && <div className="settings-hint">还没有技能。</div>}
      </div>

      {/* 三个角色的工具与技能分配 */}
      <div className="setting-group-title">角色（{agents.length}）</div>
      <div className="agent-list">
        {agents.map(a => (
          <div key={a.id} className="agent-card">
            <button className="agent-head" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
              <span className={`agent-caret ${expanded === a.id ? 'open' : ''}`}>▸</span>
              <span className="agent-name">{a.name}</span>
              <span className="agent-count">{a.tools.length} 个工具 · {a.skills.length} 项技能</span>
            </button>
            {expanded === a.id && (
              <div className="agent-body">
                <div className="agent-sub">可调用工具（{a.tools.length}，点开看参数与输出）</div>
                <div className="tool-grid">
                  {a.tools.map(t => {
                    const params = toolParams(t.parameters)
                    return (
                      <details key={t.name} className="tool-item">
                        <summary className="tool-head">
                          <span className="tool-name">{t.name}</span>
                          {t.mutates && <span className="tool-badge">写操作</span>}
                          <span className="tool-summary">{t.description.split('\n')[0]}</span>
                          <span className="tool-caret">▸</span>
                        </summary>
                        <div className="tool-body">
                          <div>
                            <div className="tool-sec-title">功能</div>
                            <div className="tool-text">{t.description}</div>
                          </div>
                          <div>
                            <div className="tool-sec-title">输入参数</div>
                            {params.length === 0 ? (
                              <div className="tool-text">无参数</div>
                            ) : (
                              <div className="tool-params">
                                {params.map(p => (
                                  <div key={p.name} className="tool-param">
                                    <span className="tool-param-name">{p.name}</span>
                                    <span className="tool-param-type">{p.type}{p.required ? ' · 必填' : ' · 可选'}</span>
                                    <span className="tool-param-desc">{p.desc}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="tool-sec-title">输出格式</div>
                            <code className="tool-returns">{t.returns ?? '{ forModel: string; isError?: boolean }'}</code>
                            <div className="tool-text">forModel 是返回给模型的文本；isError=true 表示执行失败。</div>
                          </div>
                        </div>
                      </details>
                    )
                  })}
                </div>
                <div className="agent-sub">可加载技能（勾选生效，写入会话提示词）</div>
                <div className="agent-skills">
                  {skills.map(s => (
                    <label key={s.name} className="agent-skill-row" title={s.description}>
                      <input
                        type="checkbox"
                        checked={a.skills.includes(s.name)}
                        onChange={e => toggleSkill(a.id, s.name, e.target.checked)}
                      />
                      <span>{s.name}</span>
                    </label>
                  ))}
                </div>
                <details className="agent-prompt">
                  <summary>角色提示词</summary>
                  <pre>{a.prompt}</pre>
                </details>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
