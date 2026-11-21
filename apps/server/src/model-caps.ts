// 模型能力推断：端点没声明时的保守兜底（上下文窗口 / 图片输入 / 思考档位）。
// 只按模型名做常见族匹配；命中不了就返回空，交给用户在模型卡片里手填。
// 供 /api/settings/discover-models 与 settings.modelDirectory 共用，避免两处规则分叉。

export interface InferredCaps {
  contextWindow?: number
  vision?: boolean
}

export function inferModelCapabilities(id: string): InferredCaps {
  const key = String(id ?? '').toLowerCase()
  const rules: ({ test: RegExp } & InferredCaps)[] = [
    // GPT-5 / GPT-6 家族：端点通常不声明能力，按已知规格保守推断（400k 总窗口、支持图片输入）。
    // 故意不写成 1M：那只是运行时兜底，估大了会让压缩失效并触发上游 400。
    { test: /gpt-5/, contextWindow: 400000, vision: true },
    { test: /gpt-6/, contextWindow: 400000, vision: true },
    { test: /gpt-4\.1/, contextWindow: 1047576, vision: true },
    { test: /gpt-4\.5/, contextWindow: 128000, vision: true },
    { test: /gpt-4o/, contextWindow: 128000, vision: true },
    { test: /gpt-4-turbo|gpt-4-vision/, contextWindow: 128000, vision: true },
    { test: /gpt-4(?!o|-turbo|-vision)/, contextWindow: 8192, vision: false },
    { test: /gpt-3\.5/, contextWindow: 16385, vision: false },
    { test: /o[134](-|$)/, contextWindow: 200000, vision: true },
    { test: /claude/, contextWindow: 200000, vision: true },
    { test: /gemini-1\.5|gemini-2/, contextWindow: 1048576, vision: true },
    { test: /gemini-3|gemini-(flash|pro)-latest/, contextWindow: 1048576, vision: true },
    { test: /gemini/, contextWindow: 32768, vision: true },
    { test: /deepseek/, contextWindow: 65536, vision: false },
    { test: /qwen.*(vl|vision)/, contextWindow: 131072, vision: true },
    { test: /qwen/, contextWindow: 131072, vision: false },
    { test: /llama.*vision|llava/, contextWindow: 131072, vision: true },
    { test: /llama/, contextWindow: 128000, vision: false },
    { test: /pixtral/, contextWindow: 128000, vision: true },
    { test: /mistral/, contextWindow: 128000, vision: false },
    { test: /glm-4.*v/, contextWindow: 8192, vision: true },
    { test: /glm/, contextWindow: 128000, vision: false },
    { test: /kimi|moonshot/, contextWindow: 131072, vision: false },
    { test: /grok/, contextWindow: 131072, vision: true },
    { test: /doubao.*vision/, contextWindow: 32768, vision: true },
    { test: /doubao/, contextWindow: 32768, vision: false },
  ]
  const hit = rules.find(r => r.test.test(key))
  return hit ? { contextWindow: hit.contextWindow, vision: hit.vision } : {}
}

/** 端点没声明推理档位时的模型名兜底；只覆盖明确支持 reasoning_effort 的族 */
export function inferReasoningEfforts(id: string): string[] | undefined {
  const key = String(id ?? '').toLowerCase()
  if (/gpt-5/.test(key)) return ['minimal', 'low', 'medium', 'high']
  if (/gpt-6/.test(key)) return ['low', 'medium', 'high']
  if (/(^|\/)o[134](-|$)/.test(key) || /o[134]-(mini|pro)/.test(key)) return ['low', 'medium', 'high']
  if (/grok-(3-mini|4)/.test(key)) return ['low', 'high']
  if (/gemini-3/.test(key)) return ['minimal', 'low', 'medium', 'high']
  if (/gemini-2\.5/.test(key)) return ['low', 'high']
  return undefined
}
