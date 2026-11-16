// 离线 Mock LLM：脚本化的"冰晶法杖"建模序列，无需 API key 即可演示全流程
import type { ChatMessage, LlmAdapter, LlmChatOptions, LlmResult } from './types.js'
import { estimateMessages, estimateToolDefs } from './token-estimate.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function countUserTurns(messages: ChatMessage[]): number {
  return messages.filter(m => m.role === 'user' && typeof m.content === 'string' && !String(m.content).startsWith('<compacted-summary>')).length
}

const STAFF_CUBES = [
  // 银色握柄（分三段，有节奏感）
  { name: 'handle_low', from: [-1, 0, -1], to: [1, 14, 1], material: 'silver' },
  { name: 'handle_ring_1', from: [-1.5, 5, -1.5], to: [1.5, 7, 1.5], material: 'gold' },
  { name: 'handle_mid', from: [-1, 14, -1], to: [1, 26, 1], material: 'silver' },
  { name: 'handle_ring_2', from: [-1.5, 19, -1.5], to: [1.5, 21, 1.5], material: 'gold' },
  // 金色箭扣
  { name: 'ferrule', from: [-1.75, 26, -1.75], to: [1.75, 28, 1.75], material: 'gold' },
  // 蓝色水晶主体（两段收分）
  { name: 'crystal_base', from: [-3, 28, -3], to: [3, 38, 3], material: 'crystal' },
  { name: 'crystal_top', from: [-2, 38, -2], to: [2, 46, 2], material: 'crystal' },
  // 两侧悬浮晶片
  { name: 'crystal_shard_left', from: [-5.5, 30, -1.5], to: [-3, 40, 1.5], material: 'crystal' },
  { name: 'crystal_shard_right', from: [3, 30, -1.5], to: [5.5, 40, 1.5], material: 'crystal' },
]

const FLOAT_SHARDS = [
  { name: 'float_shard_north', from: [-1, 47, -5], to: [1, 51, -3], material: 'crystal' },
  { name: 'float_shard_south', from: [-1, 47, 3], to: [1, 51, 5], material: 'crystal' },
  { name: 'float_shard_east', from: [3, 45, -1], to: [5, 49, 1], material: 'crystal' },
  { name: 'float_shard_west', from: [-5, 45, -1], to: [-3, 49, 1], material: 'crystal' },
]

const TURN1_TEXT = '冰晶法杖建好了 🪄 银色握柄配金色箍环，杖顶是一颗收分的蓝色水晶主体，两侧各一片悬浮晶片。想要更长的握柄、更大的水晶或者加走路动画，直接说就行。'

const TURN2_TEXT = '顶部又加了一圈悬浮碎晶，磁悬浮的感觉出来了。可以继续说"加光点粒子"或者调水晶颜色。'

const GENERIC_TEXT = '收到！继续告诉我想改哪里：加细节、换配色、加动画都可以。'

// 思考过程样本：真实链路里由 delta.reasoning_content 流式下发，MOCK 用来验证"思考态可见"
const MOCK_REASONING = '先把需求拆开看：参考图是二头身方块角色，配色低饱和冰蓝＋金，关键特征是三片头发、宽衣摆、条纹长袜。\n计划：先定 body 根组和整体高度，再分头发/衣摆/四肢各自成组，最后统一贴图；这一轮先把方块落准，形状确认后再补细节。'

const MOCK_SUMMARY = `## 主要诉求与意图
此前对话：用户要求搭建方块风格模型（已完成：冰晶法杖——银柄金箍、蓝色收分水晶、悬浮晶片）。
## 关键技术概念
openmods 工具流：create_model / place_cubes（from-to 角点，Y 向上）/ modify_cube / list_outline；材质关键字映射纯色贴图。
## 文件与代码
无本地文件；模型为服务端 bbmodel 文档（free 格式）。
## 错误与修复
无。
## 待办事项
按用户新指示继续修改模型。
## 当前工作
上一轮建模工具调用已完成并同步到只读画布。
## 下一步
处理本轮用户的新请求。
## 关键上下文
材质前缀命名约定；画布只读；本条即压缩检查点的产物。`

async function streamText(text: string, opts: LlmChatOptions): Promise<LlmResult> {
  for (let i = 0; i < text.length; i += 8) {
    if (opts.signal?.aborted) break
    opts.onTextDelta?.(text.slice(i, i + 8))
    await sleep(28)
  }
  const messages = opts.messages
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: {
      promptTokens: estimateMessages(messages) + estimateToolDefs(opts.tools ?? []),
      outputTokens: Math.ceil(text.length / 4) + 4,
      cachedTokens: Math.floor(messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 200), 0) / 8),
      ttftMs: 140,
      modelMs: 900 + Math.floor(text.length * 6),
    },
  }
}

export function createMockLlm(): LlmAdapter {
  const base: LlmAdapter = {
    async chat(opts: LlmChatOptions): Promise<LlmResult> {
      await sleep(300)
      // MOCK 扮演“能收图的模型”：**当前这条消息**带 image_url 就回一段描述（真实的视觉路由同此）
      const lastMsg = opts.messages[opts.messages.length - 1]
      const hasImage = Array.isArray(lastMsg?.content) && lastMsg.content.some((p: any) => p.type === 'image_url')
      if (hasImage) {
        const desc = '参考图描述：一把冰晶法杖——银色三段式握柄（两道金色箍环防滑），杖头收分出一颗棱柱形蓝色水晶，顶部悬浮 4 片碎晶，整体约 48 格高、二头身比例，配色为低饱和冰蓝+金属银金。'
        return streamText(desc, opts)
      }
      const sys = typeof opts.messages[0]?.content === 'string' ? String(opts.messages[0].content) : ''
      const last = opts.messages[opts.messages.length - 1]
      const usageBase = () => ({
        promptTokens: estimateMessages(opts.messages) + estimateToolDefs(opts.tools ?? []),
        outputTokens: 0,
        cachedTokens: 0,
        ttftMs: 120,
        modelMs: 700,
      })

      // 完善想法模式：只出文字（不调工具）
      if (sys.includes('[完善想法模式]')) {
        return streamText(
          '帮你把想法打磨了一下：一把冰晶法杖——银色三段式握柄（两道金箍防滑），杖头收分出一颗棱柱形蓝色水晶，顶部悬浮 4 片碎晶微微旋转，整体 48 格高、立方体风格，贴图用低饱和冰蓝渐变。可以再指定：水晶配色（极光绿/深紫）、握柄纹路、是否要走路动画。',
          opts,
        )
      }

      // 压缩摘要调用（compaction 插件发来的检查点指令）
      const lastUser = [...opts.messages].reverse().find(m => m.role === 'user')
      if (typeof lastUser?.content === 'string' && lastUser.content.includes('[compaction]')) {
        return {
          text: MOCK_SUMMARY,
          toolCalls: [],
          finishReason: 'stop',
          usage: {
            promptTokens: estimateMessages(opts.messages),
            outputTokens: Math.ceil(MOCK_SUMMARY.length / 4),
            cachedTokens: 0,
            ttftMs: 130,
            modelMs: 800,
          },
        }
      }

      const turn = countUserTurns(opts.messages)
      // 模型是否已存在：历史里出现过 create_model 调用，或上下文里有压缩摘要
      // （压缩会把早期消息影子化，摘要检查保证压缩后不会"失忆重建"）
      const hasCreateModel = opts.messages.some(m => m.tool_calls?.some(c => c.function.name === 'create_model'))
      const hasSummary = opts.messages.some(m => typeof m.content === 'string' && m.content.includes('<compacted-summary>'))
      // 共享画布：系统提示里已告知"有 N 个部件"，说明工程已存在，别再 create_model
      const sharedCanvasNotEmpty = sys.includes('[当前会话] 画布已有')
      const modelExists = hasCreateModel || hasSummary || sharedCanvasNotEmpty

      // —— 主代理（lead）：脚本化"派发子代理"流程，便于离线验证并发子代理 ——
      if (sys.includes('主代理（lead）')) {
        if (last?.role === 'tool') {
          const toolText = typeof last.content === 'string' ? last.content : ''
          if (toolText.includes('汇报：')) {
            return streamText(
              '两个子代理都完成了，成果都在当前画布上（顶部面板可逐个查看/继续改）。它们改的是同一份工程，想调整哪个部件直接说。',
              opts,
            )
          }
          return streamText(
            '已经派给子代理了。它们在当前会话里后台建模、共用这块画布，改动会实时显示；主对话不会再自动刷消息，点顶部的子代理入口可以看进度。',
            opts,
          )
        }
        const userText = typeof lastUser?.content === 'string' ? lastUser.content : '做一把冰晶法杖'
        if (/做完|完成|结果|进度|怎么样|汇总/.test(userText)) {
          return {
            text: '',
            toolCalls: [{ id: 'mock_list_sub', name: 'list_subagents', args: '{}' }],
            finishReason: 'tool_calls',
            usage: { ...usageBase(), outputTokens: 60 },
          }
        }
        const parallel = /两个|多个|并行|同时/.test(userText)
        const calls = Array.from({ length: parallel ? 2 : 1 }, (_, i) => ({
          id: `mock_spawn_${i + 1}_${Date.now().toString(36)}`,
          name: 'spawn_modeling_subagent',
          args: JSON.stringify({
            description: parallel ? `冰晶法杖 ${i + 1}` : '冰晶法杖',
            prompt: `${userText}${parallel ? `（方案 ${i + 1}，与其它子代理互不影响）` : ''}`,
            ...(parallel ? { name: `staff-${i + 1}` } : {}),
          }),
        }))
        return {
          text: '',
          toolCalls: calls,
          finishReason: 'tool_calls',
          usage: { ...usageBase(), outputTokens: 120 },
        }
      }

      // 工具结果刚返回 → 收尾本轮，输出最终文本
      if (last?.role === 'tool') {
        return streamText(turn === 1 ? TURN1_TEXT : TURN2_TEXT, opts)
      }
      // 压缩后（读到了检查点摘要）：模型状态已知，直接文本回应，不再重建
      if (hasSummary) {
        return streamText('看过摘要了，模型状态都在：冰晶法杖已就位。告诉我这轮想加什么，我继续在画布上做。', opts)
      }

      // 共享画布已有工程（另一个子代理/主代理建的）：直接增量搭自己的部分，不重建
      if (turn <= 1 && sharedCanvasNotEmpty) {
        return {
          text: '',
          toolCalls: [
            { id: `mock_place_shared_1_${Date.now().toString(36)}`, name: 'place_cubes', args: JSON.stringify({ elements: STAFF_CUBES }) },
            { id: `mock_place_shared_2_${Date.now().toString(36)}`, name: 'place_cubes', args: JSON.stringify({ elements: FLOAT_SHARDS }) },
          ],
          finishReason: 'tool_calls',
          usage: { ...usageBase(), outputTokens: 700 },
        }
      }
      // 全新用户轮次 → 脚本化工具调用
      if (turn <= 1 && !modelExists) {
        return {
          text: '',
          toolCalls: [
            { id: 'mock_call_skill', name: 'load_skill', args: JSON.stringify({ name: 'blockbench-modeling' }) },
            { id: 'mock_call_create', name: 'create_model', args: JSON.stringify({ name: 'ice_crystal_staff' }) },
            { id: 'mock_place_1', name: 'place_cubes', args: JSON.stringify({ elements: STAFF_CUBES }) },
            { id: 'mock_place_2', name: 'place_cubes', args: JSON.stringify({ elements: FLOAT_SHARDS }) },
          ],
          finishReason: 'tool_calls',
          usage: { ...usageBase(), outputTokens: 900 },
        }
      }
      // 后续轮次：一大批装饰方块（大 args，贴近真实建模轮），触发每步前的压缩检查
      const decoCubes = Array.from({ length: 18 }, (_, i) => {
        const angle = (i / 18) * Math.PI * 2
        const cx = Math.cos(angle) * 7
        const cz = Math.sin(angle) * 7
        const y = 46 + (i % 4) * 2.5
        return {
          name: `decor_shard_${Date.now().toString(36)}_${i + 1}`,
          from: [cx - 1, y, cz - 1],
          to: [cx + 1, y + 2.5, cz + 1],
          material: i % 3 === 0 ? 'gold' : 'crystal',
        }
      })
      return {
        text: '',
        toolCalls: [
          { id: `mock_deco_${Date.now().toString(36)}`, name: 'place_cubes', args: JSON.stringify({ elements: decoCubes }) },
        ],
        finishReason: 'tool_calls',
        usage: { ...usageBase(), outputTokens: 420 },
      }
    },
  }

  // 外层：推理模型在给正文/工具调用之前会先流一段思考（只用于展示，不写回上下文）
  return {
    async chat(opts: LlmChatOptions): Promise<LlmResult> {
      const lastUser = [...opts.messages].reverse().find(m => m.role === 'user')
      const isCompaction = typeof lastUser?.content === 'string' && lastUser.content.includes('[compaction]')
      const think = isCompaction ? '' : MOCK_REASONING
      if (think) {
        for (let i = 0; i < think.length; i += 8) {
          if (opts.signal?.aborted) break
          opts.onReasoningDelta?.(think.slice(i, i + 8))
          await sleep(18)
        }
      }
      const res = await base.chat(opts)
      return think ? { ...res, reasoning: think } : res
    },
  }
}

export { TURN1_TEXT, TURN2_TEXT }
