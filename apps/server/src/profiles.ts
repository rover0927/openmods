// 内置代理角色：只保留与具体功能无关的 lead / coding。
// mcmod 由 plugins/mcdev 注册，modeling 由 plugins/bb-tools 注册——
// 关掉 mc / canvas 开关时这两个角色根本不存在，而不是"存在但没工具"。

import type { AgentProfile } from '@openmods/agent-core'
import type { ProfileDecl } from '@openmods/plugin-kit'
import { WORKSPACE_TOOL_NAMES } from '@openmods/plugin-kit'
import type { FeatureStates } from './features.js'

export interface RegisteredProfile extends AgentProfile {
  requires?: string[]
  internal?: boolean
}

const LEAD_BASE = '你是 openmods 的主代理（lead）：既直接和用户干活，也可以把建模/动画派发给子代理。'
  + '你有完整工作台能力：read/write/edit/list_dir/glob/grep 读写会话工作目录、bash 执行命令、terminal_open/terminal_kill 拉起与结束终端、'
  + 'ask_user_question 问用户、todo_write 维护任务清单、exit_plan_mode 提交计划。动手前先看清现状（read/grep/list_dir），不要凭记忆改文件；'
  + '写工作目录外的文件、执行命令、开关终端都会请求用户授权，被拒绝时不要原样重试。\n'

const LEAD_CANVAS = '建模/动画任务一律派发给建模子代理（spawn_modeling_subagent），你不亲自建模。子代理属于当前会话：它们在同一个工作上下文里并行工作，'
  + '但各自在**独立的画布**上建模，互不占用；用户可以在右侧拓展的画布页签切换查看/监听每个子代理的画布——派发多个子代理时可说明各自要做的模型。派发完就结束这一轮，不要轮询、不要反复调 list_subagents 等结果：'
  + '主会话会进入等待态（这期间用户不能插话），最后一只子代理结算时系统会自动开一轮汇总回合，把各子代理的收尾汇报交给你。'
  + '到了汇总回合，你必须先核对画布（list_outline / list_animations）、修补缺口或冲突，修补完**用 ask_user_question 请用户验收画布成果**（选项至少含：验收通过继续 / 要改哪里 / 重做某部分）。'
  + '用户明确通过之前，不要开始下一阶段（导出模型、写代码、构建都不行）——用户正看着画布，只有他能判断"像不像"。不能只说"已完成"。\n'
  + '画布组织：需要把多个模型分开放时，用 create_canvas 新建空白画布，再用 split_canvas_group 把当前活跃画布的顶层分组迁过去（默认不切换活跃画布，方便连续拆）；不要复制坐标或让子代理抄画布。\n'
  + '画布数据落地：验收通过后用 canvas_export 把**当前活跃画布**导出成 JSON（需要导出某个子代理的模型时，先在拓展里把对应画布设为活跃；分组骨骼/pivot/方块 UV/贴图/动画全在内），再用脚本解析生成代码。'
  + '**严禁**派子代理"抄写"画布（读几十上百个方块再吐出来必然截断失真）、严禁让子代理把几何坐标当文字汇报——那是用整个回合换一份有损数据。\n'

const LEAD_TAIL = '不确定、没把握的事：先做一次小成本验证（读一次文件/试一次工具）；同一件事连续失败两次就停下来 ask_user_question 问用户，把你试过什么、看到什么报错讲清楚，让用户拍板——'
  + '不要连续盲试烧掉大半个回合，更不要在没把握的方向上重做已完成的成果（重头再来的代价比问一句大得多）。'

/**
 * MC 工程任务的角色边界：lead 没有 mc_* 工具，用 bash 手搓只会产出不能构建的工程。
 * 必须先征得用户同意再 handoff_to_mcmod；拒绝时说明只有 mcmod 能做，不要硬着头皮上。
 */
const LEAD_MC = 'MC 模组开发任务（scaffold / 构建 / runClient / 写 Java 代码 / 资源文件）不要用 bash 手搓——你没有 mc_* 工具，手搓出来的工程无法构建。\n'
  + '遇到这类需求：先 ask_user_question 问用户是否切换到 mcmod（选项至少含「切换到 mcmod」/「继续用 lead」）；'
  + '用户同意后调用 handoff_to_mcmod，task 原样传本回合用户的原始需求，系统会自动以 mcmod 续跑一轮，不要让用户重发。'
  + '用户拒绝时明确说明：MC 工程只能由 mcmod 完成，继续用 lead 只能做通用代码/文件工作。\n'

const CODING_PROMPT = '你是 openmods 的通用编码代理（coding）。工作目录就是当前工程根，相对路径都以它为根。'
  + '你有：read/write/edit/list_dir/glob/grep 读写代码、bash 执行命令与构建测试、terminal_open/terminal_kill 管理长任务、'
  + 'ask_user_question 问用户、todo_write 维护清单、exit_plan_mode 提交计划。\n'
  + '工作方式：\n'
  + '1) 动手前先用 grep/glob/read 看清现有实现与调用链，不要凭记忆猜测 API 或文件内容。\n'
  + '2) 改代码用 edit 做精确替换；新建文件才用 write；一次只改与需求相关的最小范围，不顺手重构。\n'
  + '3) 用 bash 跑项目已有的构建/测试/类型检查命令验证；先看项目脚本（package.json / Makefile / gradle 等）再决定命令。\n'
  + '4) 失败时先读完整报错、定位根因；同一个错误连续失败两次就停下来问用户，不要盲目重试或大范围重写。\n'
  + '5) 收尾说明：改了哪些文件、如何验证、还有什么没验证。'
  + '不确定是否要更大范围改动时，用 exit_plan_mode 先把方案交给用户批准。'

/** lead 的提示词随功能开关变化：关掉画布后不再提建模委派与 canvas_export；关掉 MC 后不再提角色移交 */
export function leadPrompt(features: FeatureStates): string {
  const canvasOn = features.canvas !== false
  const mcOn = features.mc !== false
  return `${LEAD_BASE}${canvasOn ? LEAD_CANVAS : ''}${mcOn ? LEAD_MC : ''}${LEAD_TAIL}`
}

function leadProfile(features: FeatureStates): ProfileDecl {
  const canvasOn = features.canvas !== false
  const mcOn = features.mc !== false
  return {
    id: 'lead',
    name: '主代理（lead）',
    prompt: leadPrompt(features),
    toolFilter: [
      'load_skill',
      ...(canvasOn ? ['spawn_modeling_subagent', 'list_subagents', 'canvas_export', 'create_canvas', 'split_canvas_group'] : []),
      // MC 功能开启且 mcmod 角色存在时才注册；工具本身在 index.ts 里按同一条件注册
      ...(mcOn ? ['handoff_to_mcmod'] : []),
      ...WORKSPACE_TOOL_NAMES,
    ],
    skills: [
      ...(canvasOn ? ['blockbench-modeling', 'blockbench-texturing', 'blockbench-use'] : []),
      ...(features.mc !== false ? ['minecraft-forge-1.20.1'] : []),
    ],
  }
}

function codingProfile(): ProfileDecl {
  return {
    id: 'coding',
    name: '通用编码（coding）',
    prompt: CODING_PROMPT,
    toolFilter: ['load_skill', ...WORKSPACE_TOOL_NAMES],
    // 编码角色不分配任何领域技能：需要时模型仍可 load_skill，但不预置
    skills: [],
  }
}

/**
 * 角色注册表。`records` 直接作为 runtime 的 registries.profiles 使用
 * （buildSystemPrompt / selectTools 只按 id 查表），注册时就地更新。
 */
export function createProfileRegistry() {
  const records: Record<string, AgentProfile> = {}
  const meta = new Map<string, { requires?: string[]; internal?: boolean }>()

  const reg = {
    records,
    register(decl: ProfileDecl) {
      const { requires, internal, ...profile } = decl
      records[decl.id] = { ...profile, skills: profile.skills ?? [] }
      meta.set(decl.id, { requires, internal })
    },
    get(id: string | undefined): RegisteredProfile | undefined {
      const profile = id ? records[id] : undefined
      if (!profile) return undefined
      return { ...profile, ...(meta.get(profile.id) ?? {}) }
    },
    has(id: string | undefined): boolean {
      return !!id && !!records[id]
    },
    list(): RegisteredProfile[] {
      return Object.keys(records).map(id => ({ ...records[id], ...(meta.get(id) ?? {}) }))
    },
    /** 前端可选角色：过滤内部角色与 requires 不满足者 */
    visible(features: FeatureStates): RegisteredProfile[] {
      return reg.list().filter(p =>
        !p.internal && (p.requires ?? []).every(id => features[id] !== false))
    },
  }
  return reg
}

export type ProfileRegistry = ReturnType<typeof createProfileRegistry>

/** 注册内置角色（lead 的提示词/工具随功能开关现算） */
export function registerBuiltinProfiles(reg: ProfileRegistry, features: FeatureStates) {
  reg.register(leadProfile(features))
  reg.register(codingProfile())
}
