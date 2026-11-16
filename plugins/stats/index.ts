// stats 插件：看板投影（对整条会话日志折叠出统计）。
// server 的 /stats 接口与 SSE 刷新直接调用 projectStats —— 投影是无状态纯函数，
// 数据全部来自 durable log，翻页/压缩后重算依然正确（dsh-session-stats 同思路）。
import type { Plugin } from '@openmods/plugin-kit'

const plugin: Plugin = {
  name: 'stats',
  apply(_ctx) {
    // 投影逻辑在 ./projection.ts，由 server 静态引用；插件本体负责演示"可插拔"生命周期。
  },
}

export { projectStats } from './projection.js'
export default plugin
