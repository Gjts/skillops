import { Bot, Box, Code2 } from 'lucide-react'
import { byDay, byRuntime, runtimeLabel } from '../lib/analytics'
import type { Runtime, SkillEvent } from '../types'

export function Sparkline({ values, tone = 'green' }: { values: number[]; tone?: 'green' | 'purple' }) {
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * 72
    const y = 28 - ((value - min) / Math.max(max - min, 1)) * 24
    return `${x},${y}`
  }).join(' ')
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 72 32" role="img" aria-label="Trend">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function niceAxisMax(value: number) {
  if (value <= 1) return 1
  if (value <= 5) return Math.ceil(value)
  if (value <= 8) return 8
  if (value <= 10) return 10
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const ceiling = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return ceiling * magnitude
}

export function RunsChart({ events, days }: { events: SkillEvent[]; days: number }) {
  const data = byDay(events, days)
  const width = 640
  const height = 230
  const pad = { left: 45, right: 18, top: 18, bottom: 36 }
  const max = Math.max(...data.map((item) => Math.max(item.success, item.failed, item.observed)), 0)
  const yMax = niceAxisMax(max)
  const point = (value: number, index: number) => ({
    x: pad.left + (index / Math.max(data.length - 1, 1)) * (width - pad.left - pad.right),
    y: pad.top + (1 - value / yMax) * (height - pad.top - pad.bottom),
  })
  const path = (key: 'success' | 'failed' | 'observed') => data.map((item, index) => {
    const coordinates = point(item[key], index)
    return `${index ? 'L' : 'M'} ${coordinates.x} ${coordinates.y}`
  }).join(' ')
  const successPath = path('success')

  return (
    <section className="panel runs-chart-panel">
      <header className="panel-header">
        <div><h2>Runs over time</h2><span>{days} day execution volume</span></div>
        <div className="legend"><span><i className="legend-dot success" />Successful</span><span><i className="legend-dot observed" />Observed</span><span><i className="legend-dot failed" />Failed</span></div>
      </header>
      <div className="chart-wrap">
        <svg className="runs-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Successful, lifecycle-only and failed Skill runs over time">
          <defs>
            <linearGradient id="successArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#59dd79" stopOpacity=".18" />
              <stop offset="1" stopColor="#59dd79" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, .25, .5, .75, 1].map((ratio) => {
            const y = pad.top + ratio * (height - pad.top - pad.bottom)
            return <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="grid-line" /><text x={pad.left - 10} y={y + 4} textAnchor="end">{Math.round(yMax * (1 - ratio))}</text></g>
          })}
          <path d={`${successPath} L ${width - pad.right} ${height - pad.bottom} L ${pad.left} ${height - pad.bottom} Z`} fill="url(#successArea)" />
          <path d={successPath} className="line-success" />
          <path d={path('observed')} className="line-observed" />
          <path d={path('failed')} className="line-failed" />
          {data.map((item, index) => {
            const success = point(item.success, index)
            const failed = point(item.failed, index)
            const observed = point(item.observed, index)
            return (
              <g key={item.key} className="chart-point-group">
                <circle cx={success.x} cy={success.y} r="4" className="point-success"><title>{`${item.label}: ${item.success} successful`}</title></circle>
                <circle cx={observed.x} cy={observed.y} r="3.5" className="point-observed"><title>{`${item.label}: ${item.observed} lifecycle-only`}</title></circle>
                <circle cx={failed.x} cy={failed.y} r="3.5" className="point-failed"><title>{`${item.label}: ${item.failed} failed`}</title></circle>
                <text x={success.x} y={height - 12} textAnchor="middle">{item.label}</text>
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}

const runtimeIcon: Record<Runtime, typeof Code2> = { codex: Code2, 'claude-code': Bot, cursor: Box }

export function RuntimeDistribution({ events }: { events: SkillEvent[] }) {
  const data = byRuntime(events)
  const total = data.reduce((sum, item) => sum + item.runs, 0)
  const max = Math.max(...data.map((item) => item.runs), 1)
  return (
    <section className="panel runtime-panel">
      <header className="panel-header"><div><h2>Runtime distribution</h2><span>Completed and failed runs</span></div><span className="mono">by runs</span></header>
      <div className="runtime-list">
        {data.map((item) => {
          const Icon = runtimeIcon[item.runtime]
          return (
            <div className="runtime-row" key={item.runtime}>
              <span className={`runtime-icon ${item.runtime}`}><Icon size={19} strokeWidth={1.7} /></span>
              <div className="runtime-bar-content">
                <div className="runtime-label"><strong>{runtimeLabel[item.runtime]}</strong><span>{item.runs.toLocaleString()} · {total ? ((item.runs / total) * 100).toFixed(1) : '0.0'}%</span></div>
                <div className="bar-track"><span style={{ width: `${(item.runs / max) * 100}%` }} /></div>
              </div>
            </div>
          )
        })}
      </div>
      <footer className="panel-total"><span>Total runs</span><strong>{total.toLocaleString()}</strong></footer>
    </section>
  )
}
