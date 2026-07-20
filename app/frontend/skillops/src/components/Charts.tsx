import { Bot, Box, Code2 } from 'lucide-react'
import { useI18n } from '../i18n/I18nProvider'
import { byDay, byRuntime, runtimeLabel } from '../lib/analytics'
import type { Runtime, SkillEvent } from '../types'

export function Sparkline({ values, tone = 'green' }: { values: number[]; tone?: 'green' | 'purple' }) {
  const { t } = useI18n()
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * 72
    const y = 28 - ((value - min) / Math.max(max - min, 1)) * 24
    return `${x},${y}`
  }).join(' ')
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 72 32" role="img" aria-label={t('charts.trend')}>
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
  const { formatDate, formatNumber, t } = useI18n()
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
        <div><h2>{t('charts.runsOverTime')}</h2><span>{t('charts.dayVolume', { days: formatNumber(days) })}</span></div>
        <div className="legend"><span><i className="legend-dot success" />{t('charts.successful')}</span><span><i className="legend-dot observed" />{t('charts.observed')}</span><span><i className="legend-dot failed" />{t('charts.failed')}</span></div>
      </header>
      <div className="chart-wrap">
        <svg className="runs-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('charts.aria')}>
          <defs>
            <linearGradient id="successArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--success)" stopOpacity=".18" />
              <stop offset="1" stopColor="var(--success)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, .25, .5, .75, 1].map((ratio) => {
            const y = pad.top + ratio * (height - pad.top - pad.bottom)
            return <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="grid-line" /><text x={pad.left - 10} y={y + 4} textAnchor="end">{formatNumber(Math.round(yMax * (1 - ratio)))}</text></g>
          })}
          <path d={`${successPath} L ${width - pad.right} ${height - pad.bottom} L ${pad.left} ${height - pad.bottom} Z`} fill="url(#successArea)" />
          <path d={successPath} className="line-success" />
          <path d={path('observed')} className="line-observed" />
          <path d={path('failed')} className="line-failed" />
          {data.map((item, index) => {
            const success = point(item.success, index)
            const failed = point(item.failed, index)
            const observed = point(item.observed, index)
            const localizedLabel = formatDate(`${item.key}T00:00:00`, { month: 'short', day: 'numeric' })
            return (
              <g key={item.key} className="chart-point-group">
                <circle cx={success.x} cy={success.y} r="4" className="point-success"><title>{t('charts.pointSuccessful', { label: localizedLabel, count: formatNumber(item.success) })}</title></circle>
                <circle cx={observed.x} cy={observed.y} r="3.5" className="point-observed"><title>{t('charts.pointObserved', { label: localizedLabel, count: formatNumber(item.observed) })}</title></circle>
                <circle cx={failed.x} cy={failed.y} r="3.5" className="point-failed"><title>{t('charts.pointFailed', { label: localizedLabel, count: formatNumber(item.failed) })}</title></circle>
                <text x={success.x} y={height - 12} textAnchor="middle">{localizedLabel}</text>
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
  const { formatNumber, t } = useI18n()
  const data = byRuntime(events)
  const total = data.reduce((sum, item) => sum + item.runs, 0)
  const max = Math.max(...data.map((item) => item.runs), 1)
  return (
    <section className="panel runtime-panel">
      <header className="panel-header"><div><h2>{t('charts.distribution')}</h2><span>{t('charts.terminalRuns')}</span></div><span className="mono">{t('charts.byRuns')}</span></header>
      <div className="runtime-list">
        {data.map((item) => {
          const Icon = runtimeIcon[item.runtime]
          return (
            <div className="runtime-row" key={item.runtime}>
              <span className={`runtime-icon ${item.runtime}`}><Icon size={19} strokeWidth={1.7} /></span>
              <div className="runtime-bar-content">
                <div className="runtime-label"><strong>{runtimeLabel[item.runtime]}</strong><span>{formatNumber(item.runs)} · {formatNumber(total ? (item.runs / total) * 100 : 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span></div>
                <div className="bar-track"><span style={{ width: `${(item.runs / max) * 100}%` }} /></div>
              </div>
            </div>
          )
        })}
      </div>
      <footer className="panel-total"><span>{t('charts.totalRuns')}</span><strong>{formatNumber(total)}</strong></footer>
    </section>
  )
}
