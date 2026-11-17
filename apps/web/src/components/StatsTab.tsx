import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { ContextBreakdownDto, StatsDto, StatsFrameDto } from '../types.js'

// 右侧「上下文」面板 —— 重排版：把最重要的「现在用了多少 / 还剩多少」做成头部主卡，
// 构成环形、工具/耗时、每轮明细依次弱化。数据源不变：
// 唯一日志里没有的量是 system / tools token 拆分（服务端 runtime.contextBreakdown() 回填）。

const CHART = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)',
]

/** 紧凑 token 数（k / M），与 ContextMeter 同一套口径 */
function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function Cell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ctx-cell">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

/** 横向条形：value / max 决定填充比例 */
function Bar({ label, value, max, text, danger }: {
  label: string
  value: number
  max: number
  text: string
  danger?: boolean
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div className="ctx-bar">
      <span className="ctx-bar-label" title={label}>{label}</span>
      <span className="ctx-bar-track">
        <span className={`ctx-bar-fill${danger ? ' err' : ''}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="ctx-bar-val">{text}</span>
    </div>
  )
}

/** 环形图：conic-gradient 拼色，中心洞留总量 */
function Donut({ items, center }: {
  items: { label: string; value: number; color: string }[]
  center: string
}) {
  const live = items.filter(i => i.value > 0)
  const total = live.reduce((s, i) => s + i.value, 0)
  if (total <= 0) {
    return (
      <div className="ctx-donut" style={{ background: 'var(--bg-layer-3)' }}>
        <div className="ctx-donut-hole">—</div>
      </div>
    )
  }
  let acc = 0
  const stops: string[] = []
  for (const it of live) {
    const from = (acc / total) * 100
    acc += it.value
    const to = (acc / total) * 100
    stops.push(`${it.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`)
  }
  return (
    <div className="ctx-donut" style={{ background: `conic-gradient(${stops.join(', ')})` }}>
      <div className="ctx-donut-hole">{center}</div>
    </div>
  )
}

/** 头部主卡：当前占用（分段大条 + 大数字 + 剩余）—— 这是面板的"一句话读数" */
function HeadlineCard({ used, win, breakdown }: {
  used: number | null
  win: number | null
  breakdown: ContextBreakdownDto | null
}) {
  const u = used ?? 0
  const w = win ?? 0
  const pct = w > 0 ? Math.min(100, (u / w) * 100) : null
  const rows = [
    { key: 'systemTokens', label: '系统提示词', cls: 'cm-system' },
    { key: 'toolsTokens', label: '工具定义', cls: 'cm-tools' },
    { key: 'messageTokens', label: '对话', cls: 'cm-messages' },
  ] as const
  const bd = breakdown
  const bdTotal = bd ? bd.systemTokens + bd.toolsTokens + bd.messageTokens : 0
  const segs = bd && bdTotal > 0 && pct !== null
    ? rows.map(r => ({ cls: r.cls, w: (pct * bd[r.key]) / bdTotal })).filter(s => s.w > 0)
    : pct !== null ? [{ cls: '', w: pct }] : []
  return (
    <div className="ctx-block ctx-headline">
      <div className="ctx-headline-top">
        <span className="ctx-headline-fig">
          <b>{pct !== null ? `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%` : '—'}</b>
          <span className="ctx-headline-sub">上下文占用</span>
        </span>
        <span className="ctx-headline-nums">
          <b>~{fmtTok(u)}</b> / {w > 0 ? fmtTok(w) : '—'} tok
          {w > 0 && <span className="ctx-headline-left"> · 剩 {fmtTok(Math.max(0, w - u))}</span>}
        </span>
      </div>
      <div className="ctx-headline-bar">
        {segs.length > 0
          ? segs.map((s, i) => <div key={i} className={`cm-seg ${s.cls}`} style={{ width: `${s.w}%` }} />)
          : <div className="cm-seg" style={{ width: `${pct ?? 0}%` }} />}
      </div>
      {bd && bdTotal > 0 && (
        <div className="ctx-headline-legend">
          {rows.map(r => (
            <span key={r.key} className="ctx-legend-row">
              <span className={`cm-swatch ${r.cls}`} aria-hidden="true" />
              {r.label} <b>~{fmtTok(bd[r.key])}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function StatsTab({ stats, sessionId, contextHint, usedTokens, contextWindow, breakdown }: {
  stats: StatsDto | null
  sessionId: string
  contextHint: string | null
  usedTokens: number | null
  contextWindow: number | null
  breakdown: ContextBreakdownDto | null
}) {
  const [frame, setFrame] = useState<StatsFrameDto | null>(null)
  const [showDelta, setShowDelta] = useState(false)
  const [openTurns, setOpenTurns] = useState<Set<string>>(new Set())

  useEffect(() => {
    // 换会话 / 换画布页时先清掉旧快照，避免新数据回来前还显示上一个会话的构成
    setFrame(null)
    if (!sessionId) return
    let cancelled = false
    api.stats(sessionId).then(r => { if (!cancelled) setFrame(r) }).catch(() => {})
    return () => { cancelled = true }
  }, [sessionId])

  // SSE 推来的帧与 /stats 的 stats 字段同形状（都带 context 块）
  const live: StatsDto | undefined = stats ?? frame?.stats

  if (!live || live.totals.steps === 0) {
    return (
      <div className="stats-tab">
        <HeadlineCard used={usedTokens} win={contextWindow} breakdown={breakdown} />
        <div className="welcome dim">还没有对话统计，发一次消息后这里会出现工具用量、耗时分布与每轮明细。</div>
      </div>
    )
  }

  const t = live.totals
  const ctx = live.context
  const fleet = frame?.fleet

  const toolMax = Math.max(1, ...ctx.tools.map(x => x.count))
  const cmdMax = Math.max(1, ...ctx.commands.map(x => x.count))

  const tokenTotal = ctx.tokenSplit.system + ctx.tokenSplit.tools + ctx.tokenSplit.message
  const tokenItems = [
    { label: '系统提示词', value: ctx.tokenSplit.system, color: CHART[0] },
    { label: '工具定义', value: ctx.tokenSplit.tools, color: CHART[3] },
    { label: '对话内容', value: ctx.tokenSplit.message, color: CHART[1] },
  ]

  const ts = ctx.timeSplit
  const timeTotal = ts.ttft + ts.generation + ts.tool + ts.idle
  const timeItems = [
    { label: '首字等待', value: ts.ttft, color: CHART[2] },
    { label: '模型生成', value: ts.generation, color: CHART[0] },
    { label: '工具执行', value: ts.tool, color: CHART[4] },
    { label: '回合空档', value: ts.idle, color: CHART[7] },
  ]

  const sparkMax = Math.max(1, ...ctx.timeline.map(x => x.output))

  return (
    <div className="ctx-panel">
      {/* 0. 头部主卡：现在用了多少 / 还剩多少（点击 composer 的环也能看到同一口径） */}
      <HeadlineCard used={usedTokens} win={contextWindow} breakdown={breakdown} />

      {/* 1. 会话活动概览（一行小格，弱化） */}
      <div className="ctx-block">
        <h4 className="ctx-h">活动</h4>
        <div className="ctx-grid4">
          <Cell label="轮" value={ctx.counts.turns} />
          <Cell label="步" value={ctx.counts.steps} />
          <Cell label="工具调用" value={ctx.counts.toolCalls} />
          <Cell label="压缩" value={ctx.counts.compactions} />
        </div>
        <div className="ctx-io dim-row">
          <span>用户 <b>{ctx.counts.userMessages}</b></span>
          <span>回复 <b>{ctx.counts.assistantMessages}</b></span>
          <span>思考 <b>{ctx.counts.reasoning}</b> 段</span>
          <span>累计输出 <b>{fmtTok(t.outputTokens)}</b> tok</span>
        </div>
      </div>

      {/* 2. 工具用量 */}
      {ctx.tools.length > 0 && (
        <div className="ctx-block">
          <h4 className="ctx-h">工具用量{ctx.commands.length > 0 ? ' / 命令' : ''}</h4>
          {ctx.tools.slice(0, 8).map(x => (
            <Bar
              key={x.name}
              label={x.name}
              value={x.count}
              max={toolMax}
              text={`${x.count}${x.errors > 0 ? ` · ${x.errors}✗` : ''}`}
              danger={x.errors > 0 && x.errors === x.count}
            />
          ))}
          {ctx.commands.slice(0, 4).map(x => (
            <Bar key={x.name} label={x.name} value={x.count} max={cmdMax} text={String(x.count)} />
          ))}
        </div>
      )}

      {/* 3. 编队（主 / 子代理输出） */}
      {fleet && (fleet.main > 0 || fleet.subagents > 0) && (
        <div className="ctx-block">
          <h4 className="ctx-h">编队</h4>
          <div className="ctx-io">
            <span>主代理 <b>{fmtTok(fleet.main)}</b></span>
            <span>子代理 <b>{fmtTok(fleet.subagents)}</b>（{fleet.subagentCount} 个）</span>
          </div>
        </div>
      )}

      {/* 4. Token 构成 */}
      <div className="ctx-block">
        <h4 className="ctx-h">Token 构成</h4>
        <div className="ctx-donut-row">
          <Donut items={tokenItems} center={fmtTok(tokenTotal)} />
          <div className="ctx-legend">
            {tokenItems.map(i => (
              <div className="ctx-legend-row" key={i.label}>
                <span className="ctx-legend-dot" style={{ background: i.color }} />
                <span className="ctx-legend-name">{i.label}</span>
                <span className="ctx-legend-val">
                  {tokenTotal > 0 ? `${Math.round((i.value / tokenTotal) * 100)}%` : '—'} · {fmtTok(i.value)}
                </span>
              </div>
            ))}
            <div className="ctx-legend-row">
              <span className="ctx-legend-dot" style={{ background: 'transparent', border: '1px solid var(--border-l2)' }} />
              <span className="ctx-legend-name">缓存读</span>
              <span className="ctx-legend-val">{fmtTok(ctx.tokenSplit.cacheRead)} · 命中 {Math.round(t.cacheHit * 100)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* 5. 耗时分布 */}
      <div className="ctx-block">
        <h4 className="ctx-h">耗时分布</h4>
        <div className="ctx-donut-row">
          <Donut items={timeItems} center={fmtDur(timeTotal)} />
          <div className="ctx-legend">
            {timeItems.map(i => (
              <div className="ctx-legend-row" key={i.label}>
                <span className="ctx-legend-dot" style={{ background: i.color }} />
                <span className="ctx-legend-name">{i.label}</span>
                <span className="ctx-legend-val">
                  {timeTotal > 0 ? `${Math.round((i.value / timeTotal) * 100)}%` : '—'} · {fmtDur(i.value)}
                </span>
              </div>
            ))}
            <div className="ctx-legend-row">
              <span className="ctx-legend-dot" style={{ background: 'transparent', border: '1px solid var(--border-l2)' }} />
              <span className="ctx-legend-name">首字 / 速度</span>
              <span className="ctx-legend-val">{t.avgTtftMs}ms · {t.tps} tok/s</span>
            </div>
          </div>
        </div>
      </div>

      {/* 6. 每步输出时间轴 */}
      {ctx.timeline.length > 0 && (
        <div className="ctx-block">
          <h4 className="ctx-h">每步输出（最近 {ctx.timeline.length} 步）</h4>
          <div className="ctx-spark">
            {ctx.timeline.map((s, i) => (
              <span
                key={`${s.stepId}-${i}`}
                className={`ctx-spark-bar${s.output >= sparkMax ? ' ctx-spark-peak' : ''}`}
                style={{ height: `${Math.max(8, Math.round((s.output / sparkMax) * 100))}%` }}
                title={`${s.model ?? '—'} · 上下文 ${fmtTok(s.context)} · 输出 ${fmtTok(s.output)} · ${s.tps} tok/s`}
              />
            ))}
          </div>
        </div>
      )}

      {/* 7. 预算与压缩 */}
      {(t.savedTokens > 0 || live.compactions.length > 0) && (
        <div className="ctx-block">
          <h4 className="ctx-h">压缩</h4>
          <div className="ctx-io">
            <span>压缩 <b>{ctx.counts.compactions}</b> 次 · 省下 <b>{fmtTok(t.savedTokens)}</b> tok</span>
            <span>模型 / 工具耗时 <b>{fmtDur(t.modelMs)} / {fmtDur(t.toolMs)}</b></span>
          </div>
          {live.compactions.length > 0 && (
            <div className="compactions">
              {live.compactions.map(c => (
                <div key={c.compactionId} className="compaction-row">
                  <span className="badge peak">压缩 · {c.reason}</span>
                  <span>影子 {fmtTok(c.shadowedTokens)} → 摘要 {fmtTok(c.summaryTokens)}</span>
                  <span className="green">省 {fmtTok(c.saved)}</span>
                  <span className="dim">{fmtDur(c.wallMs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 8. 每轮明细（默认折叠） */}
      <div className="ctx-block">
        <div className="ctx-detail-head">
          <h4 className="ctx-h">每轮明细</h4>
          <label className="delta-toggle">
            <input type="checkbox" checked={showDelta} onChange={e => setShowDelta(e.target.checked)} />
            显示增量
          </label>
        </div>
        <div className="stats-table">
          {live.turns.map(turn => {
            const open = openTurns.has(turn.turnId)
            return (
              <div key={turn.turnId} className="turn-row">
                <button
                  className="turn-head"
                  onClick={() => setOpenTurns(prev => {
                    const next = new Set(prev)
                    if (next.has(turn.turnId)) next.delete(turn.turnId)
                    else next.add(turn.turnId)
                    return next
                  })}
                >
                  <span>{open ? '▼' : '▶'} {turn.firstUserText || '(空)'}</span>
                  <span className="dim">
                    {turn.steps.length} 步 · {fmtTok(turn.steps.reduce((s, x) => s + x.contextTokens, 0))} tok
                  </span>
                </button>
                {open && turn.steps.map((s, i) => {
                  const prevStep = i > 0 ? turn.steps[i - 1] : null
                  const delta = showDelta && prevStep ? s.contextTokens - prevStep.contextTokens : null
                  return (
                    <div key={s.stepId} className="step-row">
                      <span className="dim">{s.model ?? '—'}</span>
                      <span>
                        上下文 {fmtTok(s.contextTokens)}
                        {delta !== null && (
                          <span className={delta < 0 ? 'green' : 'dim'}>
                            {' '}({delta >= 0 ? '+' : ''}{fmtTok(delta)})
                          </span>
                        )}
                      </span>
                      <span>输出 {fmtTok(s.outputTokens)}</span>
                      <span>TTFT {s.ttftMs}ms</span>
                      <span>{s.tps} tok/s</span>
                      <span className="dim">模型 {fmtDur(s.modelMs)} / 工具 {fmtDur(s.toolMs)}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      {void contextHint}
    </div>
  )
}
