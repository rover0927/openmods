// 设置存储：providers（data/settings.json）+ credentials（data/credentials.json）分离持久化，
// 复刻 dsh 的 "profile patch YAML + .credentials.yaml" 分离语义：
// - 设置页可热编辑 providers（volatile 字段），revision 乐观锁防并发覆盖
// - API key 单独存储、读取时 redact（只回 {set:true|false} 槽位，绝不回明文）
// - llm 适配器每次请求现解析 provider（下一轮生效，无需重启）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo } from '@openmods/agent-core'

export interface ProviderModel {
  id: string
  name: string
  contextWindow?: number
  badge?: string
  badgeType?: 'price' | 'peak'
  desc?: string
  memberOnly?: boolean
  /** 该模型是否支持视觉（图片）输入（派生字段；inputModalities 才是事实源） */
  vision?: boolean
  /** 输入模态，复刻 dsh `DeepSeekCatalogModel.inputModalities`（缺省 ['text']） */
  inputModalities?: string[]
  /** 单请求输出上限（dsh `maxTokens`） */
  maxOutputTokens?: number
}

export interface ProviderProfile {
  displayName: string
  baseURL: string
  models: ProviderModel[]
  /** 未逐个声明 contextWindow 的模型统一兜底（dsh pi-ai `defaultContextWindow`） */
  defaultContextWindow?: number
}

/**
 * DeepSeek 官方模型目录 —— 从 dsh `packages/llm/llm-deepseek/src/models.ts` 原样搬运：
 * 两个官方模型共享 1,048,576 上下文窗口（官方 /models 声明），只有 deepseek-flash 收图。
 */
export const DEEPSEEK_DEFAULT_MODELS: ProviderModel[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1_048_576,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    desc: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: 1_048_576,
    inputModalities: ['text'],
  },
]

/** dsh `DEFAULT_CONTEXT_WINDOW`：完全无可依据信息时的上下文窗口兜底 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

export interface BridgeConfig {
  enabled: boolean
  /** @deprecated 桥接转述已移除（图片改为按 dsh 语义直发）；字段仅为兼容旧 settings.json 保留 */
  modelId?: string
}

/**
 * 偏好：对应 dsh 设置里那些"行为开关"（general / subagent / 自动唤醒）。
 * 与 providers 分开存，但同一条 revision 乐观锁——一次保存是一个事务。
 */
export interface PrefsConfig {
  /** 对话正文字号（dsh ui-theme FontSizeRow）：13 / 14 / 15 */
  fontSize: number
  /** 发送键（dsh EnterBehaviorRow）：true = Enter 发送、Shift+Enter 换行 */
  enterToSend: boolean
  /** 同时运行的子代理上限（dsh SubagentLimitsFields） */
  maxActiveSubagents: number
  /** 子代理全部结算后自动唤醒主会话做汇总验收（dsh settlement → 新回合） */
  autoWake: boolean
  /** 画布自动唤醒：AI 改动画布 / 子任务结算时自动展开右侧拓展 */
  canvasAutoWake: boolean
  /** 把运行中的子代理显示在当前对话里（而不是右上角浮层） */
  inlineSubagents: boolean
  /** mod-output：jar 导出保存目录（构建产物一键复制到这里；空 = 未配置，走浏览器下载） */
  modOutput: string
}

export const DEFAULT_PREFS: PrefsConfig = {
  fontSize: 14,
  enterToSend: true,
  maxActiveSubagents: 4,
  autoWake: true,
  canvasAutoWake: true,
  inlineSubagents: true,
  modOutput: '',
}

export interface SettingsDoc {
  revision: number
  providers: Record<string, ProviderProfile>
  bridge: BridgeConfig
  prefs: PrefsConfig
}

/** 容错：手改/半截 prefs 不应让设置页炸掉；越界值夹到合法区间 */
export function normalizePrefs(raw: any): PrefsConfig {
  const p = raw && typeof raw === 'object' ? raw : {}
  const num = (v: any, lo: number, hi: number, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback
  }
  return {
    fontSize: num(p.fontSize, 12, 18, DEFAULT_PREFS.fontSize),
    enterToSend: typeof p.enterToSend === 'boolean' ? p.enterToSend : DEFAULT_PREFS.enterToSend,
    maxActiveSubagents: num(p.maxActiveSubagents, 1, 8, DEFAULT_PREFS.maxActiveSubagents),
    autoWake: typeof p.autoWake === 'boolean' ? p.autoWake : DEFAULT_PREFS.autoWake,
    canvasAutoWake: typeof p.canvasAutoWake === 'boolean' ? p.canvasAutoWake : DEFAULT_PREFS.canvasAutoWake,
    inlineSubagents: typeof p.inlineSubagents === 'boolean' ? p.inlineSubagents : DEFAULT_PREFS.inlineSubagents,
    modOutput: typeof p.modOutput === 'string' ? p.modOutput.trim().slice(0, 500) : DEFAULT_PREFS.modOutput,
  }
}

export class SettingsConflictError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`设置已被其他窗口修改（revision ${expected} ≠ ${actual}），请刷新后重试`)
    this.name = 'SettingsConflictError'
  }
}

export class SettingsStore {
  private doc: SettingsDoc
  private credentials: Record<string, string>
  constructor(
    private dataDir: string,
    private env: Record<string, string | undefined>,
  ) {
    mkdirSync(dataDir, { recursive: true })
    this.doc = this.loadJson<SettingsDoc>(join(dataDir, 'settings.json'), this.seed())
    // 容错：手改/半截文件导致的缺字段，不应让整个模型目录炸掉
    if (!this.doc || typeof this.doc !== 'object') this.doc = this.seed()
    if (!this.doc.providers || typeof this.doc.providers !== 'object') this.doc.providers = this.seed().providers
    if (typeof this.doc.revision !== 'number' || !Number.isFinite(this.doc.revision)) this.doc.revision = 1
    if (!this.doc.bridge) this.doc.bridge = { enabled: false }
    // 老版本 settings.json 没有 prefs：补齐默认值，不报错
    this.doc.prefs = normalizePrefs(this.doc.prefs)
    const creds = this.loadJson<Record<string, string>>(join(dataDir, 'credentials.json'), {})
    this.credentials = creds && typeof creds === 'object' ? creds : {}
  }

  private seed(): SettingsDoc {
    const dsBase = this.env.LLM_BASE_URL ?? 'https://api.deepseek.com'
    const envLimit = Math.max(1, Number(this.env.MAX_ACTIVE_SUBAGENTS ?? DEFAULT_PREFS.maxActiveSubagents) || DEFAULT_PREFS.maxActiveSubagents)
    return {
      revision: 1,
      bridge: { enabled: false },
      prefs: { ...DEFAULT_PREFS, maxActiveSubagents: envLimit },
      providers: {
        deepseek: {
          displayName: 'DeepSeek 官方',
          baseURL: dsBase,
          models: [
            { id: 'deepseek-reasoner', name: 'smod4.2', badge: '单价 ×2', badgeType: 'price', desc: '建模顶尖特效拉满', contextWindow: 131072 },
            { id: 'deepseek-chat', name: 'DeepSeek 4.1', badge: '低峰 ×1.3', badgeType: 'peak', desc: '速度快 / 快速出方案', contextWindow: 131072 },
          ],
        },
        gpt6: {
          displayName: 'GPT6 系列演示',
          baseURL: 'https://api.openai.com/v1',
          models: [
            { id: 'gpt6', name: 'GPT6', badge: '单价 ×6', badgeType: 'price', desc: '金冠会员及以上可用', memberOnly: true, contextWindow: 262144 },
            { id: 'gpt6-1', name: 'GPT6.1', badge: '单价 ×3.75', badgeType: 'price', desc: '铁冠会员及以上可用', memberOnly: true, contextWindow: 262144 },
          ],
        },
      },
    }
  }

  private loadJson<T>(file: string, fallback: T): T {
    try {
      if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch { /* 损坏文件回退默认 */ }
    return fallback
  }

  private saveJson(file: string, data: unknown) {
    // 原子落盘：先写临时文件再 rename，崩溃时不会留下半截 JSON（否则下次启动回退默认配置）
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, file)
  }

  get revision(): number {
    return this.doc.revision
  }

  /** redacted 视图：key 只回 {set} 槽位（复刻 settings describe 的 redactSecrets） */
  getRedacted() {
    return {
      revision: this.doc.revision,
      bridge: this.doc.bridge,
      prefs: this.doc.prefs,
      providers: Object.fromEntries(
        Object.entries(this.doc.providers).map(([route, p]) => [route, {
          displayName: p.displayName,
          baseURL: p.baseURL,
          models: p.models,
          apiKey: { set: !!this.credentials[route] },
        }]),
      ),
    }
  }

  getBridge(): BridgeConfig {
    return this.doc.bridge ?? { enabled: false }
  }

  /** 行为偏好（每轮读取，改动下一轮生效——与 providers 的语义一致） */
  getPrefs(): PrefsConfig {
    return this.doc.prefs ?? DEFAULT_PREFS
  }

  /**
   * 保存设置：providers / bridge / prefs 任选其一（缺省字段保持原值）。
   * 一个 revision 覆盖三者，避免"模型存了、开关没存"的半截状态。
   */
  save(
    patch: { providers?: Record<string, ProviderProfile>; bridge?: BridgeConfig; prefs?: Partial<PrefsConfig> },
    expectedRevision?: number,
  ): number {
    if (expectedRevision !== undefined && expectedRevision !== this.doc.revision) {
      throw new SettingsConflictError(expectedRevision, this.doc.revision)
    }
    let providers = this.doc.providers
    if (patch.providers !== undefined) {
      providers = patch.providers
    }
    for (const [route, p] of Object.entries(providers)) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route)) {
        throw new Error(`非法供应商标识 "${route}"（需小写字母开头，仅含小写字母/数字/连字符）`)
      }
      if (!p.baseURL) throw new Error(`供应商 ${route} 缺少 baseURL`)
      if (!Array.isArray(p.models) || p.models.length === 0) {
        throw new Error(`供应商 ${route} 至少需要一个模型`)
      }
    }
    const bridgeCfg: BridgeConfig = patch.bridge
      ? { enabled: !!patch.bridge.enabled, modelId: patch.bridge.modelId || undefined }
      : (this.doc.bridge ?? { enabled: false })
    if (bridgeCfg.enabled && !bridgeCfg.modelId) {
      throw new Error('桥接模型已开启但未选择模型')
    }
    const prefs = patch.prefs ? normalizePrefs({ ...this.doc.prefs, ...patch.prefs }) : this.doc.prefs
    this.doc = { revision: this.doc.revision + 1, providers, bridge: bridgeCfg, prefs }
    this.saveJson(join(this.dataDir, 'settings.json'), this.doc)
    return this.doc.revision
  }

  /** 兼容旧调用：只存 providers + bridge */
  saveProviders(
    providers: Record<string, ProviderProfile>,
    bridge: BridgeConfig | undefined,
    expectedRevision?: number,
  ): number {
    return this.save({ providers, bridge }, expectedRevision)
  }

  setCredential(route: string, apiKey: string) {
    if (apiKey) this.credentials[route] = apiKey
    else delete this.credentials[route]
    this.saveJson(join(this.dataDir, 'credentials.json'), this.credentials)
  }

  getCredential(route: string): string | undefined {
    return this.credentials[route] ?? this.env.LLM_API_KEY
  }

  getProvider(route: string): ProviderProfile | undefined {
    return this.doc.providers[route]
  }

  /** 模型目录：所有 provider 的 models 展开为复合 id "<route>/<modelId>" */
  modelDirectory(defaultDesc?: string): Record<string, ModelInfo> {
    const mock = this.env.MOCK === '1'
    const out: Record<string, ModelInfo> = {}
    for (const [route, p] of Object.entries(this.doc.providers)) {
      const hasKey = !!this.getCredential(route) || mock
      for (const m of p.models) {
        const composite = `${route}/${m.id}`
        // 复刻 dsh `modelInfo()`：目录条目优先，未声明的字段回落到官方默认目录 → provider 兜底 → 全局默认。
        // 于是用户只写 {id,name} 也能拿到 deepseek-flash 的图像能力与 1M 窗口。
        const fallback = route === 'deepseek' ? DEEPSEEK_DEFAULT_MODELS.find(d => d.id === m.id) : undefined
        const inputModalities = m.inputModalities
          ?? fallback?.inputModalities
          ?? (m.vision ? ['text', 'image'] : ['text'])
        const vision = m.vision ?? inputModalities.includes('image')
        out[composite] = {
          displayName: (m.name && m.name !== m.id) ? m.name : (fallback?.name ?? m.name ?? m.id),
          badge: m.badge ?? fallback?.badge,
          badgeType: m.badgeType ?? fallback?.badgeType,
          desc: m.desc ?? fallback?.desc ?? (route === 'deepseek' ? 'DeepSeek 官方' : p.displayName),
          llmModel: m.id,
          providerRoute: route,
          disabled: m.memberOnly ? true : (!hasKey && !mock),
          disabledReason: m.memberOnly ? '需会员' : ((!hasKey && !mock) ? '未配置 API key' : undefined),
          contextWindow: m.contextWindow ?? fallback?.contextWindow ?? p.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
          vision,
          inputModalities,
          maxOutputTokens: m.maxOutputTokens ?? fallback?.maxOutputTokens,
        }
      }
    }
    void defaultDesc
    return out
  }

  defaultModelId(): string {
    // 第一个未禁用的模型
    const dir = this.modelDirectory()
    const first = Object.entries(dir).find(([, m]) => !m.disabled)
    return first?.[0] ?? Object.keys(dir)[0] ?? 'deepseek/deepseek-reasoner'
  }
}
