import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import type { Runtime } from '../types'

const REFRESH_MS = 3_000

export interface CommandCenterIssue {
  id: string
  priority: number
  severity: 'high' | 'medium' | 'low'
  href: string
  data: Record<string, unknown>
}

export interface CommandCenterSnapshot {
  generatedAt: string
  scope: { runtime: Runtime | 'all'; days: number }
  sources: Record<'events' | 'connections' | 'provider', 'ok' | 'partial' | 'unavailable'>
  readiness: {
    level: 'ready' | 'attention' | 'setup'
    verifiedRuntimes: Runtime[]
    installedRuntimes: Runtime[]
    providerConfigured: boolean
  }
  metrics: {
    runs: number
    knownOutcomes: number
    unknownOutcomes: number
    successRate: number | null
    activeSkills: number
    costUsd: number | null
    costReportedRuns: number
    costCoverage: number | null
  }
  metricDefinitions: Record<'runs' | 'successRate' | 'activeSkills' | 'costUsd' | 'costCoverage', string>
  issues: CommandCenterIssue[]
  nextActions: CommandCenterIssue[]
  recentActivity: Array<{
    id: string
    event: string
    runtime: Runtime
    timestamp: string
    skillId?: string
    outcome?: string
    durationMs?: number
    costUsd?: number
  }>
}

const actionKeys: Record<string, MessageKey> = {
  'source-unavailable': 'cc.action.source-unavailable',
  'repair-runtime': 'cc.action.repair-runtime',
  'verify-runtime': 'cc.action.verify-runtime',
  'connect-runtime': 'cc.action.connect-runtime',
  'review-failures': 'cc.action.review-failures',
  'review-unknown-outcomes': 'cc.action.review-unknown-outcomes',
  'review-cost-coverage': 'cc.action.review-cost-coverage',
  'configure-provider': 'cc.action.configure-provider',
}

function demoSnapshot(): CommandCenterSnapshot {
  const generatedAt = new Date().toISOString()
  const issues: CommandCenterIssue[] = [
    { id: 'review-failures', priority: 90, severity: 'high', href: '/activity?tab=runs&outcome=failed', data: { count: 1 } },
    { id: 'configure-provider', priority: 40, severity: 'low', href: '/benchmarks?tab=suites&configure=provider', data: {} },
  ]
  return {
    generatedAt,
    scope: { runtime: 'all', days: 7 },
    sources: { events: 'ok', connections: 'ok', provider: 'ok' },
    readiness: { level: 'ready', verifiedRuntimes: ['codex'], installedRuntimes: ['codex'], providerConfigured: false },
    metrics: { runs: 1_284, knownOutcomes: 1_160, unknownOutcomes: 124, successRate: 91.2, activeSkills: 42, costUsd: 12.84, costReportedRuns: 802, costCoverage: 62.5 },
    metricDefinitions: { runs: '', successRate: '', activeSkills: '', costUsd: '', costCoverage: '' },
    issues,
    nextActions: issues,
    recentActivity: [
      { id: 'demo-run-1', event: 'skill.completed', runtime: 'codex', timestamp: generatedAt, skillId: 'code-review', outcome: 'success' },
      { id: 'demo-run-2', event: 'skill.failed', runtime: 'claude-code', timestamp: generatedAt, skillId: 'test-generator', outcome: 'failed' },
    ],
  }
}

function validSnapshot(value: unknown): value is CommandCenterSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CommandCenterSnapshot>
  return Boolean(candidate.metrics && candidate.readiness && candidate.sources && Array.isArray(candidate.nextActions) && Array.isArray(candidate.issues) && Array.isArray(candidate.recentActivity))
}

interface CommandCenterProps {
  runtime: Runtime | 'all'
  days: number
  onOpen: (href: string) => void
  onModeChange?: (mode: 'loading' | 'local' | 'demo', error?: string) => void
}

export function CommandCenter({ runtime, days, onOpen, onModeChange }: CommandCenterProps) {
  const { formatDateTime, formatNumber, formatUsd, t } = useI18n()
  const [snapshot, setSnapshot] = useState<CommandCenterSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [demo, setDemo] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setDemo(false)
    if (!snapshot) onModeChange?.('loading')
    void (async () => {
      try {
        const params = new URLSearchParams({ runtime, window: `${days}d` })
        const response = await fetch(`/api/command-center?${params}`, { signal: controller.signal })
        const body = await response.json()
        performance.clearMarks('skillops:data-received')
        performance.clearMarks('skillops:primary-content-ready')
        performance.clearMeasures('skillops:primary-content')
        performance.mark('skillops:data-received')
        if (!response.ok) {
          const message = typeof body?.error?.message === 'string' ? body.error.message : `Local API returned ${response.status}.`
          throw new Error(message)
        }
        if (!validSnapshot(body)) throw new Error('Command Center API returned an invalid response.')
        if (cancelled) return
        setSnapshot(body)
        setError(null)
        onModeChange?.('local')
      } catch (loadError) {
        if (cancelled || controller.signal.aborted) return
        const message = loadError instanceof Error ? loadError.message : 'Local aggregate unavailable.'
        setError(message)
        if (!snapshot) onModeChange?.('loading', message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [attempt, days, onModeChange, runtime])

  useEffect(() => {
    if (demo) return
    const interval = window.setInterval(() => setAttempt((value) => value + 1), REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [demo])
  useEffect(() => {
    if (!snapshot || loading) return
    const frame = requestAnimationFrame(() => {
      performance.mark('skillops:primary-content-ready')
      performance.measure('skillops:primary-content', 'skillops:data-received', 'skillops:primary-content-ready')
    })
    return () => cancelAnimationFrame(frame)
  }, [loading, snapshot])

  const useDemo = () => {
    setSnapshot(demoSnapshot())
    setDemo(true)
    onModeChange?.('demo')
  }

  if (!snapshot && loading) return <section className="cc-state" role="status" aria-live="polite" aria-busy="true"><RefreshCw className="spin" size={18} />{t('mode.loadingEvents')}</section>
  if (!snapshot) {
    return (
      <section className="cc-state cc-error">
        <div role="alert"><AlertTriangle size={18} /><span>{t('cc.loadFailed', { error: error || 'Unknown error' })}</span></div>
        <div><button className="button secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>{t('cc.retry')}</button><button className="button primary" type="button" onClick={useDemo}>{t('cc.useDemo')}</button></div>
      </section>
    )
  }

  const partial = Object.values(snapshot.sources).some((status) => status !== 'ok')
  const readinessText = snapshot.readiness.level === 'ready' ? t('cc.ready') : snapshot.readiness.level === 'attention' ? t('cc.attention') : t('cc.setup')
  const actionLabel = (issue: CommandCenterIssue) => t(actionKeys[issue.id] ?? 'cc.action.source-unavailable')
  const metricCards = [
    { id: 'runs', label: t('kpi.skillRuns'), value: formatNumber(snapshot.metrics.runs), basis: t('cc.runsBasis') },
    { id: 'successRate', label: t('kpi.reportedOutcomeRate'), value: snapshot.metrics.successRate === null ? t('cc.notAvailable') : `${formatNumber(snapshot.metrics.successRate, { maximumFractionDigits: 1 })}%`, basis: t('cc.successBasis') },
    { id: 'activeSkills', label: t('kpi.activeSkills'), value: formatNumber(snapshot.metrics.activeSkills), basis: t('cc.activeBasis') },
    { id: 'costUsd', label: t('kpi.reportedCost'), value: snapshot.metrics.costUsd === null ? '—' : formatUsd(snapshot.metrics.costUsd), basis: t('cc.costBasis') },
  ]

  return (
    <div className="command-center-grid">
      {demo && <div className="cc-demo" role="status"><strong>{t('mode.demoDataset')}</strong><span>{t('cc.demoNotice')}</span></div>}
      {partial && <div className="data-warning" role="alert">{t('cc.partial')}</div>}
      {error && <div className="data-warning" role="alert">{t('cc.loadFailed', { error })}</div>}

      <section className={`cc-readiness ${snapshot.readiness.level}`}>
        <header><div><h2>{t('cc.readiness')}</h2><p>{readinessText}</p></div>{snapshot.readiness.level === 'ready' ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}</header>
        <small>{formatDateTime(snapshot.generatedAt)}</small>
        <small>{t('activity.refresh')}</small>
        <button className="button secondary" type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><RefreshCw className={loading ? 'spin' : ''} size={14} />{t('cc.retry')}</button>
      </section>

      <section className="cc-actions" aria-label={t('cc.nextActions')}>
        <h2>{t('cc.nextActions')}</h2>
        {snapshot.nextActions.slice(0, 3).length ? snapshot.nextActions.slice(0, 3).map((action) => (
          <button key={action.id} className={`cc-action ${action.severity}`} type="button" onClick={() => onOpen(action.href)}><span>{actionLabel(action)}</span><strong aria-hidden="true">→</strong></button>
        )) : <p>{t('cc.noActions')}</p>}
      </section>

      <section className="cc-metrics" aria-labelledby="cc-metrics-title">
        <h2 id="cc-metrics-title">{t('cc.metrics')}</h2>
        <div>{metricCards.map((metric) => (
          <article className="kpi" data-metric={metric.label} key={metric.id}><span>{metric.label}</span><strong data-value={metric.value}>{metric.value}</strong>{metric.id === 'costUsd' && snapshot.metrics.costUsd === null && <b>{t('kpi.notReported')}</b>}{metric.id === 'costUsd' && demo && <b>{t('kpi.demoData')}</b>}<small>{metric.basis}</small>{metric.id === 'costUsd' && <small>{t('kpi.costCount', { reported: snapshot.metrics.costReportedRuns, runs: snapshot.metrics.runs })}</small>}{metric.id === 'costUsd' && snapshot.metrics.costReportedRuns > 0 && <button className="text-button" type="button" onClick={() => onOpen('/activity?tab=runs&cost=reported')}>{t('kpi.viewCostRuns')}</button>}</article>
        ))}</div>
      </section>

      <section className="cc-issues">
        <h2>{t('cc.issues')}</h2>
        {snapshot.issues.length ? <ul>{snapshot.issues.map((issue) => <li key={issue.id}><span className={`issue-dot ${issue.severity}`} /><button type="button" onClick={() => onOpen(issue.href)}>{actionLabel(issue)}</button></li>)}</ul> : <p>{t('cc.noIssues')}</p>}
      </section>

      <section className="cc-recent">
        <h2>{t('cc.recentActivity')}</h2>
        {snapshot.recentActivity.length ? <ul>{snapshot.recentActivity.map((activity) => <li key={activity.id}><div><strong>{activity.skillId || activity.event}</strong><span>{activity.runtime} · {activity.outcome || activity.event}</span></div><time dateTime={activity.timestamp}>{formatDateTime(activity.timestamp)}</time>{activity.event === 'skill.completed' || activity.event === 'skill.failed' ? <button type="button" onClick={() => onOpen(`/activity?tab=runs&run=${encodeURIComponent(activity.id)}`)}>→</button> : null}</li>)}</ul> : <p>{t('cc.noActivity')}</p>}
      </section>
    </div>
  )
}
