// bb-tools 插件：建模工具集。几何体在服务端 bbmodel 文档上变更，
// 每次变更后编译并写入会话状态（server 负责 SSE 推送画布更新）。
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { Plugin, ToolExecContext, ToolDef, ToolResult } from '@openmods/plugin-kit'
import { WORKSPACE_TOOL_NAMES } from '@openmods/plugin-kit'
import { createDoc, addCube, addGroup, findGroup, docCounts, outlineText, type BbDoc, type BbGroup, type BbAnimation, type BbAnimKeyframe } from './bbmodel.js'
import { materialListForPrompt, resolveColor } from './materials.js'
import { solidPngDataUrl } from './png.js'

// 画布统一由 CanvasService 持有：插件只按 sessionId 读/提交，不接触存储与广播
function getDoc(ctx: ToolExecContext): BbDoc {
  return ctx.canvas.ensure(ctx.sessionId) as BbDoc
}

function groupNames(doc: BbDoc): string[] {
  const names: string[] = []
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (typeof n !== 'string') { names.push(n.name); walk(n.children) }
    }
  }
  walk(doc.outliner)
  return names
}

function sync(ctx: ToolExecContext, doc: BbDoc) {
  // 编译、广播、原子落盘都在服务里完成（同一会话树的其它 agent 会实时收到）
  ctx.canvas.commit(ctx.sessionId, doc)
}

function texFor(doc: BbDoc, color: string): string {
  const key = `mat_${color.replace('#', '')}`
  let tex = doc.textures.find(t => t.name === key)
  if (!tex) {
    tex = {
      uuid: randomUUID(),
      name: key,
      id: String(doc.textures.length),
      width: 64,
      height: 64,
      source: solidPngDataUrl(color),
      saved: false,
      mode: 'bitmap',
    }
    doc.textures.push(tex)
  }
  return tex.uuid
}

function collectGroupUuids(g: { uuid: string; children: any[] }, set: Set<string>) {
  set.add(g.uuid)
  for (const child of g.children) {
    if (typeof child === 'string') set.add(child)
    else collectGroupUuids(child, set)
  }
}

function ok(forModel: string): ToolResult {
  return { forModel }
}

const tools: ToolDef[] = [
  {
    name: 'create_model',
    mutates: true,
    description: '创建新的空白模型项目（清空**当前会话的活跃画布**）；画布已有部件时默认拒绝，确需清空重做要显式传 reset:true。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '模型/项目名，建议英文小写+下划线' },
        reset: { type: 'boolean', description: '画布已有部件时是否强制清空（默认 false）' },
      },
      required: ['name'],
    },
    async execute(args, ctx) {
      const existing = ctx.canvas.read(ctx.sessionId) as BbDoc | undefined
      const count = existing?.elements.length ?? 0
      if (count > 0 && args.reset !== true) {
        return {
          forModel: `当前活跃画布已有 ${count} 个部件。继续增量建模即可（先 list_outline 看结构）；确实要清空重做，请带 reset:true 再调用。`,
          isError: true,
        }
      }
      const doc = createDoc(String(args.name ?? 'model'))
      ctx.canvas.commit(ctx.sessionId, doc)
      return ok(`已创建项目 "${doc.name}"（free 通用模型格式，画布已清空）。现在可以用 place_cubes 搭几何体。`)
    },
  },
  {
    name: 'place_cubes',
    mutates: true,
    description: '批量放置立方体（只读画布自动更新）。from/to 为 [x,y,z] 角点，Y 向上。每个元素可带 rotation（角度 [x,y,z]）、origin（枢轴 [x,y,z]）和 group（覆盖调用级 group），因此**一次调用尽量批量放置带旋转的部件**（如 11 段弧线棱柱），不要先放置再逐件 modify_cube。建议先搭大轮廓再补细节；部件名用材质前缀。',
    parameters: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          description: '立方体数组，一次调用尽量批量放置（可同时写入旋转/枢轴/分组）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              from: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
              to: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
              material: { type: 'string', description: '材质关键字或 #RRGGBB' },
              rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '可选：旋转角度 [x,y,z]，缺省不旋转' },
              origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '可选：枢轴 [x,y,z]，缺省原点' },
              group: { type: 'string', description: '可选：该元素的分组名，优先于调用级 group' },
            },
            required: ['name', 'from', 'to'],
          },
        },
        group: { type: 'string', description: '可选：默认分组名（root=顶层）；元素的 group 可覆盖它' },
      },
      required: ['elements'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      const list = Array.isArray(args.elements) ? args.elements : []
      if (!list.length) return { forModel: 'elements 为空', isError: true }
      for (const spec of list) {
        addCube(doc, {
          name: String(spec.name),
          from: spec.from,
          to: spec.to,
          material: spec.material,
          parent: args.group,
          group: spec.group,
          rotation: spec.rotation,
          origin: spec.origin,
        })
      }
      sync(ctx, doc)
      return ok(`已放置 ${list.length} 个立方体，共 ${docCounts(doc).elements} 个。`)
    },
  },
  {
    name: 'modify_cube',
    mutates: true,
    description: '修改已有立方体（按名称或 UUID 匹配）。可改 from/to（移动/缩放）、rotation、origin（枢轴）、material。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '部件名或 UUID' },
        from: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        to: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        material: { type: 'string' },
      },
      required: ['id'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      const el = doc.elements.find(e => e.name === args.id || e.uuid === args.id)
      if (!el) return { forModel: `找不到部件 "${args.id}"（用 list_outline 查看现有部件）`, isError: true }
      if (args.from) el.from = args.from.map(Number)
      if (args.to) el.to = args.to.map(Number)
      if (args.rotation) el.rotation = args.rotation.map(Number)
      if (args.origin) el.origin = args.origin.map(Number)
      if (args.material) el.faces = Object.fromEntries(
        Object.entries(el.faces).map(([f, v]) => [f, { ...v, texture: texFor(doc, resolveColor(args.material)) }]),
      ) as BbDoc['elements'][0]['faces']
      sync(ctx, doc)
      return ok(`已修改 ${el.name}。`)
    },
  },
  {
    name: 'delete_elements',
    mutates: true,
    description: '删除部件或分组（按名称/UUID，支持数组）。',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: '部件/分组名或 UUID 列表' } },
      required: ['ids'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      const ids: string[] = args.ids ?? []
      let removed = 0
      const removeUuids = new Set<string>()
      for (const id of ids) {
        const el = doc.elements.find(e => e.name === id || e.uuid === id)
        if (el) { removeUuids.add(el.uuid); removed++; continue }
        const g = findGroup(doc, id)
        if (g) { collectGroupUuids(g, removeUuids); removed++ }
      }
      doc.elements = doc.elements.filter(e => !removeUuids.has(e.uuid))
      const prune = (nodes: any[]): any[] => nodes
        .filter(n => typeof n === 'string' ? !removeUuids.has(n) : !removeUuids.has(n.uuid))
        .map(n => typeof n === 'string' ? n : { ...n, children: prune(n.children) })
      doc.outliner = prune(doc.outliner)
      sync(ctx, doc)
      return ok(`已删除 ${removed} 项，剩余 ${docCounts(doc).elements} 个部件。`)
    },
  },
  {
    name: 'add_group',
    mutates: true,
    description: '创建分组/骨骼（可嵌套，origin 为枢轴）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parent: { type: 'string', description: '父分组名，缺省为顶层' },
        origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      },
      required: ['name'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      const g = addGroup(doc, String(args.name), args.parent, args.origin ?? [0, 0, 0])
      sync(ctx, doc)
      return ok(`已创建分组 ${g.name}。`)
    },
  },
  {
    name: 'add_groups',
    mutates: true,
    description: '一次创建多个分组/骨骼（按数组顺序创建，origin 为枢轴）。前面的分组可以作后面分组的 parent；需要多根骨骼时优先用本工具而不是多次 add_group。',
    parameters: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          description: '分组数组，按顺序创建（父分组需先于子分组出现）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              parent: { type: 'string', description: '父分组名，缺省为顶层' },
              origin: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            },
            required: ['name'],
          },
        },
      },
      required: ['groups'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      const list = Array.isArray(args.groups) ? args.groups : []
      if (!list.length) return { forModel: 'groups 为空', isError: true }
      // 先校验再创建，避免中途失败留下半截分组
      const specs = list.map((spec: any) => ({
        name: String(spec?.name ?? '').trim(),
        parent: spec?.parent,
        origin: spec?.origin ?? [0, 0, 0],
      }))
      if (specs.some((s: any) => !s.name)) return { forModel: 'groups 中存在缺少 name 的项', isError: true }
      for (const spec of specs) addGroup(doc, spec.name, spec.parent, spec.origin)
      sync(ctx, doc)
      return ok(`已创建 ${specs.length} 个分组：${specs.map((s: any) => s.name).join('、')}。`)
    },
  },
  {
    name: 'list_outline',
    description: '查看当前模型大纲（分组树 + 部件名 + 坐标范围）。',
    parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      return ok(outlineText(getDoc(ctx)))
    },
  },
  {
    name: 'set_camera_view',
    description: '设置只读画布相机视角：3d / front / side / back。',
    parameters: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['3d', 'front', 'side', 'back'] } },
      required: ['view'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      doc.view = args.view
      ctx.canvas.setView(ctx.sessionId, doc.view)
      return ok(`视角已切换为 ${doc.view}。`)
    },
  },
  {
    name: 'set_animation',
    mutates: true,
    description: '为模型添加/替换一个骨骼动画（走路、扇动、浮动等）。bones 的键必须是已存在的分组（骨骼）名——没有就先 add_group；keyframes 按 time 升序（秒）；rotation 为角度 [x,y,z]。loop 建议循环动作用 loop。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '动画短名，如 walk / flap' },
        length: { type: 'number', description: '动画总时长（秒）' },
        loop: { type: 'string', enum: ['loop', 'once', 'hold'], description: '缺省 loop' },
        bones: {
          type: 'object',
          description: '骨骼名 → 关键帧数组（time 升序）',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                time: { type: 'number' },
                rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '角度 [x,y,z]' },
                position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '位移 [x,y,z]' },
              },
              required: ['time'],
              additionalProperties: false,
            },
          },
        },
      },
      required: ['name', 'length', 'bones'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      doc.animations = doc.animations ?? []
      const bones: Record<string, BbAnimKeyframe[]> = {}
      const groups = groupNames(doc)
      for (const [bone, kfs] of Object.entries(args.bones ?? {})) {
        if (!findGroup(doc, bone)) {
          return { forModel: `骨骼 "${bone}" 不存在（骨骼=分组名）。可用骨骼: ${groups.join(', ') || '无——先用 add_group 创建'}；或者告诉我想要的动画效果，我创建合适的分组结构。`, isError: true }
        }
        bones[bone] = ((kfs as any[]) ?? [])
          .map(k => ({ time: Number(k?.time) || 0, rotation: k.rotation, position: k.position }))
          .sort((a, b) => a.time - b.time)
        if (!bones[bone].length) return { forModel: `骨骼 "${bone}" 的关键帧为空`, isError: true }
      }
      const name = String(args.name ?? '').trim()
      if (!name) return { forModel: '缺少动画名', isError: true }
      const anim: BbAnimation = {
        name,
        length: Math.max(0.1, Number(args.length) || 1),
        loop: args.loop === 'once' || args.loop === 'hold' ? args.loop : 'loop',
        bones,
      }
      const idx = doc.animations.findIndex(a => a.name === name)
      if (idx >= 0) doc.animations[idx] = anim
      else doc.animations.push(anim)
      sync(ctx, doc)
      return ok(`动画 "${name}" 已保存（${Object.keys(bones).length} 根骨骼 / ${anim.length}s / ${anim.loop}）。用户可在右侧面板点击播放。`)
    },
  },
  {
    name: 'remove_animation',
    mutates: true,
    description: '删除一个动画（按名称）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async execute(args, ctx) {
      const doc = getDoc(ctx)
      const before = doc.animations?.length ?? 0
      doc.animations = (doc.animations ?? []).filter(a => a.name !== args.name)
      sync(ctx, doc)
      return ok(`已删除 ${before - doc.animations.length} 个动画，剩余 ${doc.animations.length} 个。`)
    },
  },
  {
    name: 'list_animations',
    description: '查看模型上已有的动画列表（名称/时长/循环模式/骨骼数）。',
    parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      const doc = getDoc(ctx)
      const list = doc.animations ?? []
      if (!list.length) return ok('模型上还没有动画。可用 set_animation 添加。')
      return ok(list.map(a => `- ${a.name}：${a.length}s，${a.loop}，${Object.keys(a.bones).length} 根骨骼`).join('\n'))
    },
  },
  {
    name: 'canvas_export',
    description: '把画布的完整工程导出为 Blockbench 项目 JSON 写入会话工作目录：全部分组骨骼与 pivot、每个方块的 from/to/rotation/UV、全部贴图（dataURL）、全部动画关键帧——与用户在画布上看到的 100% 一致。可传 canvas 指定子代理名或画布 id；省略时导出当前活跃画布（若当前主画布为空且会话树下有唯一的非空子代理画布，则自动导出该子代理画布）。导出后用脚本解析这个 JSON 生成模型类/贴图即可。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '目标文件（相对会话工作目录），默认 canvas-export/<模型名>.json' },
        canvas: { type: 'string', description: '可选：要导出的子代理名、画布名或画布 id（如 wolf）；省略则导出当前活跃画布或唯一非空子代理画布' },
      },
    },
    mutates: true,
    async execute(args, exec) {
      let doc = getDoc(exec)
      const targetKey = String(args.canvas ?? '').trim()
      if (targetKey) {
        const tree = exec.canvas.listTree(exec.sessionId)
        const hit = tree.find(c =>
          c.canvasId === targetKey
          || c.ownerName === targetKey
          || c.name === targetKey
          || c.ownerSessionId === targetKey,
        )
        if (!hit) {
          const available = tree.map(c => `${c.ownerName}(${c.canvasId})`).join('、') || '无'
          return { forModel: `未找到画布 "${targetKey}"。会话树可用画布：${available}`, isError: true }
        }
        const foundDoc = exec.canvas.readCanvas(hit.canvasId) as BbDoc | undefined
        if (foundDoc) doc = foundDoc
      } else if (!doc.elements.length && !(doc.animations ?? []).length) {
        const nonEmpty = exec.canvas.listTree(exec.sessionId).filter(c => c.hasModel)
        if (nonEmpty.length === 1) {
          const autoDoc = exec.canvas.readCanvas(nonEmpty[0].canvasId) as BbDoc | undefined
          if (autoDoc) doc = autoDoc
        } else if (nonEmpty.length > 1) {
          const available = nonEmpty.map(c => `${c.ownerName}(canvas: "${c.canvasId}", 模型: "${c.name}")`).join('、')
          return {
            forModel: `当前活跃画布为空，而会话树下有多块非空子代理画布：${available}。请传 canvas 参数（子代理名或画布 id）指定要导出哪一块。`,
            isError: true,
          }
        }
      }
      if (!doc.elements.length && !(doc.animations ?? []).length) {
        return { forModel: '当前画布为空，请先 spawn_modeling_subagent 建模并验收', isError: true }
      }
      const cwd = exec.session.cwd ?? process.cwd()
      const defName = `canvas-export/${String(doc.name ?? 'model').replace(/[^\w-]+/g, '_')}.json`
      const rel = String(args.file_path ?? '').trim() || defName
      const abs = resolve(cwd, rel)
      if (!abs.startsWith(resolve(cwd) + sep) && abs !== resolve(cwd)) {
        return { forModel: `file_path 必须在会话工作目录内（${cwd}）的相对路径。`, isError: true }
      }
      mkdirSync(dirname(abs), { recursive: true })
      const json = JSON.stringify(doc, null, 2)
      writeFileSync(abs, json, 'utf8')
      const groups: string[] = []
      const walk = (nodes: any[]) => { for (const n of nodes) if (typeof n !== 'string') { groups.push(n.name); walk(n.children ?? []) } }
      walk(doc.outliner ?? [])
      const kb = Math.round(Buffer.byteLength(json) / 1024)
      return ok([
        `已导出画布工程 → ${rel}（${kb} KB）`,
        `内容：${doc.elements.length} 个方块、${groups.length} 个分组骨骼、${doc.textures.length} 张贴图（dataURL 内嵌）、${doc.animations.length} 套动画关键帧。`,
        `骨骼树（outliner）、每块的 from/to/rotation、贴图引用与 UV、动画 bones 关键帧全部在内，与画布所见一致。直接解析此文件生成模型/贴图，不要再派子代理读画布。`,
      ].join('\n'))
    },
  },
  {
    name: 'create_canvas',
    mutates: true,
    description: '在当前会话新建一块空白画布（默认切换为活跃画布）。用户能在右侧画布页签看到并切换；需要把现有模型分开放时，配合 split_canvas_group 把顶层分组迁进去。不要用它复制模型。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '画布名称，默认「新画布」' },
        activate: { type: 'boolean', description: '是否切换为活跃画布，默认 true' },
      },
    },
    async execute(args, ctx) {
      const name = String(args.name ?? '').trim() || '新画布'
      const activate = args.activate !== false
      const canvasId = ctx.canvas.createCanvas(ctx.sessionId, { name, activate })
      const doc = ctx.canvas.readCanvas(canvasId)
      // 新建画布本身不触发提交广播：提交一次空文档，前端画布页签立即出现
      if (doc) ctx.canvas.commitCanvas(canvasId, doc, ctx.sessionId)
      return ok(`已新建画布「${name}」（${canvasId}）${activate ? '，并设为活跃画布' : '，未切换活跃画布'}。当前会话共 ${ctx.canvas.listOf(ctx.sessionId).length} 块画布，右侧画布页签可查看。`)
    },
  },
  {
    name: 'split_canvas_group',
    mutates: true,
    description: '把当前活跃画布上的一个**顶层分组**（含子树）迁到另一块画布，并把几何平移到原点。默认在当前会话**新建一块画布**（不切换活跃画布），用于把同一画布上的多个模型拆开；也可用 target_canvas 指定本会话已有的空画布，或用 target_session 迁给直属子代理（兼容旧共享画布场景）。动画不随分组迁移。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '当前活跃画布上的顶层分组名' },
        target_canvas: { type: 'string', description: '目标画布 id 或名称（当前会话已有画布）；省略则新建一块画布' },
        target_session: { type: 'string', description: '目标直属子代理会话 id（可选；迁给子代理时用 list_subagents 查）' },
        name: { type: 'string', description: '新建画布的名称，默认用分组名' },
        activate: { type: 'boolean', description: '新建画布后是否切换为活跃画布，默认 false（保持源画布活跃，方便连续拆）' },
      },
      required: ['group'],
    },
    async execute(args, ctx) {
      const sourceSession = ctx.sessionId
      const sourceCanvas = ctx.canvas.idOf(sourceSession)
      const targetSession = String(args.target_session ?? '').trim()
      const groupName = String(args.group ?? '').trim()
      if (!groupName) return { forModel: '缺少 group（顶层分组名）。', isError: true }

      const doc = ctx.canvas.read(sourceSession) as BbDoc | undefined
      if (!doc) return { forModel: '当前活跃画布还没有内容。', isError: true }
      // 只认顶层分组：顶层字符串项是元素，嵌套分组要迁移得先把它提到顶层
      const node = (doc.outliner ?? []).find(n => typeof n !== 'string' && n.name === groupName) as BbGroup | undefined
      if (!node) {
        const tops = (doc.outliner ?? []).filter((n): n is BbGroup => typeof n !== 'string').map(n => n.name)
        return { forModel: `顶层分组 "${groupName}" 不存在（只能迁移顶层分组）。现有顶层分组：${tops.join('、') || '无——先用 list_outline 查看结构'}。`, isError: true }
      }

      let targetCanvasId: string
      let targetDoc: BbDoc
      let created = false
      let toChild = false
      if (targetSession && targetSession !== sourceSession) {
        toChild = true
        const treeIds = new Set(ctx.canvas.listTree(sourceSession).map(c => c.canvasId))
        const targetActive = ctx.canvas.idOf(targetSession)
        if (!treeIds.has(targetActive)) {
          return { forModel: 'target_session 不是本会话的直属子代理（用 list_subagents 查子代理 id）。', isError: true }
        }
        if (targetActive === sourceCanvas) {
          // 旧共享画布：给该子代理新建一块独立画布并设为活跃
          created = true
          targetCanvasId = ctx.canvas.createCanvas(targetSession, { name: groupName, activate: true })
          targetDoc = ctx.canvas.readCanvas(targetCanvasId) as BbDoc
        } else {
          targetCanvasId = targetActive
          const existing = ctx.canvas.readCanvas(targetCanvasId) as BbDoc | null
          if ((existing?.elements?.length ?? 0) > 0) {
            return { forModel: '目标子代理的画布不是空的（已有部件）。换一个空画布的子代理，或先清空它的画布。', isError: true }
          }
          targetDoc = existing ?? createDoc('未命名模型')
        }
      } else {
        const requested = String(args.target_canvas ?? '').trim()
        if (requested) {
          const ids = ctx.canvas.listOf(sourceSession)
          let id = ids.includes(requested) ? requested : undefined
          if (!id) {
            for (const cid of ids) {
              const d = ctx.canvas.readCanvas(cid) as BbDoc | null
              if (d?.name === requested) { id = cid; break }
            }
          }
          if (!id) {
            const names = ids.map(cid => (ctx.canvas.readCanvas(cid) as BbDoc | null)?.name).filter(Boolean)
            return { forModel: `当前会话没有名为 "${requested}" 的画布。现有画布：${names.join('、') || '无'}。`, isError: true }
          }
          if (id === sourceCanvas) {
            return { forModel: 'target_canvas 不能是源画布（当前活跃画布）。', isError: true }
          }
          targetCanvasId = id
          const existing = ctx.canvas.readCanvas(id) as BbDoc | null
          if ((existing?.elements?.length ?? 0) > 0) {
            return { forModel: '目标画布不是空的（已有部件）。换一块空画布，或省略 target_canvas 让工具新建。', isError: true }
          }
          targetDoc = existing ?? createDoc('未命名模型')
        } else {
          created = true
          const canvasName = String(args.name ?? '').trim() || groupName
          targetCanvasId = ctx.canvas.createCanvas(sourceSession, { name: canvasName, activate: args.activate === true })
          targetDoc = (ctx.canvas.readCanvas(targetCanvasId) as BbDoc | null) ?? createDoc(canvasName)
        }
      }

      const uuids = new Set<string>()
      collectGroupUuids(node, uuids)
      const moving = (doc.elements ?? []).filter(e => uuids.has(e.uuid))

      // 平移量 = 被迁移元素每轴最小坐标（空分组取分组 origin），迁移时每轴减去它
      const shift = [0, 0, 0]
      if (moving.length) {
        for (let axis = 0; axis < 3; axis++) {
          const values = moving.flatMap(e => [Number(e.from[axis]) || 0, Number(e.to[axis]) || 0])
          shift[axis] = Math.min(...values)
        }
      } else {
        for (let axis = 0; axis < 3; axis++) shift[axis] = Number(node.origin?.[axis] ?? 0) || 0
      }

      const moved = moving.map(e => {
        const el = structuredClone(e)
        el.from = el.from.map((v, axis) => Number(v) - shift[axis])
        el.to = el.to.map((v, axis) => Number(v) - shift[axis])
        return el
      })
      const copyGroup = (g: BbGroup): BbGroup => ({
        name: g.name,
        uuid: g.uuid,
        origin: (g.origin ?? [0, 0, 0]).map((v, axis) => Number(v) - shift[axis]),
        children: g.children.map(c => (typeof c === 'string' ? c : copyGroup(c))),
      })

      // 贴图按 uuid 一起搬过去，避免目标画布丢材质
      const texIds = new Set(targetDoc.textures.map(t => t.uuid))
      for (const el of moved) {
        for (const face of Object.values(el.faces ?? {})) {
          const texId = (face as any)?.texture
          if (!texId || texIds.has(texId)) continue
          const tex = (doc.textures ?? []).find(t => t.uuid === texId)
          if (!tex) continue
          targetDoc.textures.push(structuredClone(tex))
          texIds.add(texId)
        }
      }

      targetDoc.elements.push(...moved)
      targetDoc.outliner.push(copyGroup(node))
      if (targetDoc.name === '未命名模型') targetDoc.name = groupName

      doc.elements = (doc.elements ?? []).filter(e => !uuids.has(e.uuid))
      doc.outliner = (doc.outliner ?? []).filter(n => (typeof n === 'string' ? !uuids.has(n) : n.uuid !== node.uuid))
      ctx.canvas.commit(sourceSession, doc)
      ctx.canvas.commitCanvas(targetCanvasId, targetDoc, toChild ? targetSession : sourceSession)

      const boneNames = new Set<string>()
      const walkBones = (g: BbGroup) => {
        boneNames.add(g.name)
        for (const c of g.children) if (typeof c !== 'string') walkBones(c)
      }
      walkBones(node)
      const stuckAnims = (doc.animations ?? []).filter(a => Object.keys(a.bones ?? {}).some(b => boneNames.has(b)))

      const offset = shift.map(v => -v)
      const lines: string[] = []
      if (toChild) {
        lines.push(`已把顶层分组 "${groupName}" 迁移到子代理画布：${moved.length} 个方块，平移量 [${offset.map(v => +(Number(v) || 0).toFixed(2)).join(', ')}]。`)
        lines.push(`目标会话：${targetSession} · 目标画布：${targetCanvasId}${created ? '（旧共享画布场景：已为它新建独立画布并设为活跃）' : ''}`)
        lines.push(`源画布剩余 ${doc.elements.length} 个部件。目标子代理画布已置为活跃，可在右侧拓展的画布页签查看。`)
      } else {
        lines.push(`已把顶层分组 "${groupName}" 迁到${created ? `新建画布「${targetDoc.name}」` : `画布「${targetDoc.name}」`}：${moved.length} 个方块，平移量 [${offset.map(v => +(Number(v) || 0).toFixed(2)).join(', ')}]。`)
        lines.push(`目标画布：${targetCanvasId}${created ? (args.activate === true ? '（已设为活跃画布）' : '（未切换活跃画布，方便继续拆）') : ''}；源画布剩余 ${doc.elements.length} 个部件。`)
        lines.push('用户可在右侧画布页签查看和切换这些画布。')
      }
      if (stuckAnims.length) {
        lines.push(`注意：动画 ${stuckAnims.map(a => a.name).join('、')} 仍引用被迁移的骨骼名，相关动画仍留在源画布。`)
      }
      return ok(lines.join('\n'))
    },
  },
]

/** modeling 子代理的提示词归画布插件：关掉 canvas 开关后画布工具与角色一起消失 */
const MODELING_PROMPT = '你是建模子代理（modeling）：执行方案代理派发的建模/动画任务。你拥有本次建模的**独立画布**（本会话的活跃画布），不与方案代理或其它子代理共用，你的每次修改都会实时显示给用户。'
  + '通常画布是空的，直接 create_model 建工程，从**原点**开始搭建；不要为了避让他人做 X/Y/Z 偏移。'
  + '若画布已有内容（用户预置或上一步留下的，包括 resume_subagent 续作微调），先 list_outline 核对，用 modify_cube / place_cubes 的 group 参数增量修改或追加：已有同名骨骼（如 head、body）就直接往里加，确实需要新骨骼时才 add_group；只有任务要求重做时才 create_model（会清空**当前活跃画布**）。'
  + '无论是首次建模还是续作修改，收尾前都必须调用一次 canvas_export 把最新画布导出到工作目录（如 canvas-export/<模型名>.json），确保磁盘上的导出文件与当前画布完全同步。'
  + '收尾一次简短总结（你新增/修改了什么、部件数、导出文件路径、画布现状），不与用户寒暄，不派发任务。'
  + '总结最后一行固定写「验收点：……」——列出你最没把握、最需要用户亲自确认的部位/动画/比例，供方案代理在向用户请求验收时转述；'
  + '自己拿不准的设计决定不要硬猜，在总结里写成待确认项。'

const plugin: Plugin = {
  name: 'bb-tools',
  // 关闭 canvas 开关时整个插件不加载：画布/动画工具、modeling 子代理角色、建模技能一起消失
  features: [{ id: 'canvas', name: '画布与建模', description: 'Blockbench 风格画布、建模子代理与模型素材编辑。', default: true }],
  requires: ['canvas'],
  skills: ['blockbench-modeling', 'blockbench-texturing', 'blockbench-use', 'blockbench-java-item-delivery'],
  apply(ctx) {
    ctx.profiles.register({
      id: 'modeling',
      name: '建模子代理（modeling）',
      description: '建模子代理：在独立画布上完成造型与动画，收尾导出 JSON 供父会话使用。',
      prompt: MODELING_PROMPT,
      // 子代理是无人值守的画布工作者：不给它终端/授权/提问/计划，避免等待一个不会有人回答的弹窗
      toolExclude: ['spawn_modeling_subagent', 'list_subagents', 'resume_subagent', ...WORKSPACE_TOOL_NAMES],
      skills: ['blockbench-modeling', 'blockbench-texturing', 'blockbench-use'],
      requires: ['canvas'],
      internal: true,
    })
    for (const t of tools) ctx.tools.register(t)
    ctx.hooks.registerSystemSection(() =>
      `# 可用材质（place_cubes 的 material 参数）\n${materialListForPrompt()}，也可直接传十六进制 #RRGGBB。`,
    )
    ctx.hooks.registerSystemSection(() =>
      `# 动画\n用 set_animation 为分组（骨骼）添加关键帧动画：骨骼名必须是已存在的分组名（先用 add_group 创建，如 arm_left/leg_right）；循环动作用 loop:"loop"。动画保存后用户可在右侧面板点击播放，无需你再描述播放方式。`,
    )
  },
}

export default plugin
