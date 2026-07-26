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

type ReadinessState = 'ready' | 'attention' | 'blocked' | 'unknown'
type ActionPriority = 'blocker' | 'trust' | 'safety' | 'improvement' | 'maintenance'

interface ReadinessItem {
  id: string
  state: ReadinessState
  label: string
  reasonCode?: string
  href?: string
  checkedAt: string
  evidenceAt?: string
}

interface CommandCenterAction {
  id: string
  priority: ActionPriority
  title: string
  reason: string
  impact: string
  evidenceRefs: string[]
  href: string
  actionLabel: string
  severity?: CommandCenterIssue['severity']
  data?: Record<string, unknown>
}

interface RatioMetric {
  numerator: number
  denominator: number
  value: number | null
  label: string
}

export interface CommandCenterSnapshot {
  generatedAt: string
  window?: { from: string; to: string }
  demo?: boolean
  scope: { runtime: Runtime | 'all'; days: number }
  sources: Record<string, 'ok' | 'partial' | 'unavailable'>
  readiness: {
    level: 'ready' | 'attention' | 'setup'
    verifiedRuntimes: Runtime[]
    installedRuntimes: Runtime[]
    providerConfigured: boolean
    items?: ReadinessItem[]
  }
  metrics: {
    terminalRuns: number
    knownOutcomes: number
    successRate: RatioMetric
    runtimeOutcomeCoverage: RatioMetric
    reportedCostUsd: number | null
    costCoverage: RatioMetric
    observedAssets: number
  }
  metricDefinitions: Record<'terminalRuns' | 'knownOutcomes' | 'successRate' | 'runtimeOutcomeCoverage' | 'observedAssets' | 'reportedCostUsd' | 'costCoverage', string>
  issues: CommandCenterIssue[]
  nextActions: CommandCenterAction[]
  recentActivity: Array<{
    id: string
    event: string
    runtime: Runtime
    timestamp: string
    skillId?: string
    outcome?: string
    durationMs?: number
    costUsd?: number
    occurredAt?: string
    href?: string
    evidenceRef?: string
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
  'repair-data-directory': 'cc.action.repair-data-directory',
  'refresh-stale-evidence': 'cc.action.refresh-stale-evidence',
  'resolve-inventory-conflicts': 'cc.action.resolve-inventory-conflicts',
  'review-blocked-candidates': 'cc.action.review-blocked-candidates',
  'repair-inventory-scan': 'cc.action.repair-inventory-scan',
  'storage-warning': 'cc.action.storage-warning',
}

const actionReasonKeys: Record<string, MessageKey> = {
  'source-unavailable': 'cc.reason.source-unavailable',
  'repair-runtime': 'cc.reason.repair-runtime',
  'repair-data-directory': 'cc.reason.repair-data-directory',
  'verify-runtime': 'cc.reason.verify-runtime',
  'connect-runtime': 'cc.reason.connect-runtime',
  'review-unknown-outcomes': 'cc.reason.review-unknown-outcomes',
  'refresh-stale-evidence': 'cc.reason.refresh-stale-evidence',
  'review-failures': 'cc.reason.review-failures',
  'resolve-inventory-conflicts': 'cc.reason.resolve-inventory-conflicts',
  'review-blocked-candidates': 'cc.reason.review-blocked-candidates',
  'configure-provider': 'cc.reason.configure-provider',
  'review-cost-coverage': 'cc.reason.review-cost-coverage',
  'repair-inventory-scan': 'cc.reason.repair-inventory-scan',
  'storage-warning': 'cc.reason.storage-warning',
}

const readinessLabelKeys: Record<string, MessageKey> = {
  runtime: 'cc.readiness.runtime',
  git: 'cc.readiness.git',
  data: 'cc.readiness.data',
  inventory: 'cc.readiness.inventory',
  provider: 'cc.readiness.provider',
  evaluations: 'cc.readiness.evaluations',
  governance: 'cc.readiness.governance',
}

const readinessStateKeys: Record<ReadinessState, MessageKey> = {
  ready: 'cc.state.ready',
  attention: 'cc.state.attention',
  blocked: 'cc.state.blocked',
  unknown: 'cc.state.unknown',
}

const priorityKeys: Record<ActionPriority, MessageKey> = {
  blocker: 'cc.priority.blocker',
  trust: 'cc.priority.trust',
  safety: 'cc.priority.safety',
  improvement: 'cc.priority.improvement',
  maintenance: 'cc.priority.maintenance',
}

const actionImpactKeys: Record<ActionPriority, MessageKey> = {
  blocker: 'cc.impact.blocker',
  trust: 'cc.impact.trust',
  safety: 'cc.impact.safety',
  improvement: 'cc.impact.improvement',
  maintenance: 'cc.impact.maintenance',
}

const metricDefinitionKeys: Record<keyof CommandCenterSnapshot['metricDefinitions'], MessageKey> = {
  terminalRuns: 'cc.runsBasis',
  knownOutcomes: 'cc.knownOutcomesBasis',
  successRate: 'cc.successBasis',
  runtimeOutcomeCoverage: 'cc.outcomeCoverageBasis',
  observedAssets: 'cc.activeBasis',
  reportedCostUsd: 'cc.costBasis',
  costCoverage: 'cc.costCoverageBasis',
}

function demoSnapshot(): CommandCenterSnapshot {
  const generatedAt = new Date().toISOString()
  const issues: CommandCenterIssue[] = [
    { id: 'review-failures', priority: 90, severity: 'high', href: '/activity?tab=runs&outcome=failed', data: { count: 1 } },
  ]
  return {
    generatedAt,
    window: { from: new Date(Date.parse(generatedAt) - 7 * 86_400_000).toISOString(), to: generatedAt },
    demo: true,
    scope: { runtime: 'all', days: 7 },
    sources: { events: 'ok', connections: 'ok', provider: 'ok', git: 'ok', data: 'ok', inventory: 'ok', evaluations: 'ok', governance: 'ok' },
    readiness: {
      level: 'ready',
      verifiedRuntimes: ['codex'],
      installedRuntimes: ['codex'],
      providerConfigured: true,
      items: [
        { id: 'runtime', state: 'ready', label: 'Runtime connections', checkedAt: generatedAt, evidenceAt: generatedAt },
        { id: 'git', state: 'ready', label: 'Git', checkedAt: generatedAt },
        { id: 'data', state: 'ready', label: 'Local data', checkedAt: generatedAt },
        { id: 'inventory', state: 'ready', label: 'Inventory scan', checkedAt: generatedAt, evidenceAt: generatedAt },
        { id: 'provider', state: 'ready', label: 'AI provider', checkedAt: generatedAt },
        { id: 'evaluations', state: 'ready', label: 'Managed evaluations', checkedAt: generatedAt },
        { id: 'governance', state: 'ready', label: 'Governance', checkedAt: generatedAt },
      ],
    },
    metrics: {
      terminalRuns: 1_284,
      knownOutcomes: 1_160,
      successRate: { numerator: 1_058, denominator: 1_160, value: 91.2, label: 'Known outcomes' },
      runtimeOutcomeCoverage: { numerator: 1_160, denominator: 1_284, value: 90.3, label: 'Runtime outcome coverage' },
      reportedCostUsd: 12.84,
      costCoverage: { numerator: 802, denominator: 1_284, value: 62.5, label: 'Cost coverage' },
      observedAssets: 42,
    },
    metricDefinitions: {
      terminalRuns: 'Completed or failed Skill lifecycle runs.',
      knownOutcomes: 'Terminal runs with an explicit success or failed outcome.',
      successRate: 'Known success divided by known outcomes.',
      runtimeOutcomeCoverage: 'Known outcomes divided by terminal runs.',
      observedAssets: 'Distinct Skills with qualifying lifecycle evidence.',
      reportedCostUsd: 'Sum of finite reported cost values.',
      costCoverage: 'Runs with reported cost divided by terminal runs.',
    },
    issues,
    nextActions: [
      {
        id: 'review-failures',
        priority: 'safety',
        title: 'Review failed runs',
        reason: 'The selected window contains a known failed Skill run.',
        impact: 'May expose a known quality risk.',
        evidenceRefs: ['run-outcome:failed'],
        href: issues[0].href,
        actionLabel: 'Review failures',
        severity: 'high',
      },
    ],
    recentActivity: [
      { id: 'demo-run-1', event: 'skill.completed', runtime: 'codex', timestamp: generatedAt, skillId: 'code-review', outcome: 'success', href: '/activity?tab=runs&run=demo-run-1' },
      { id: 'demo-run-2', event: 'skill.failed', runtime: 'claude-code', timestamp: generatedAt, skillId: 'test-generator', outcome: 'failed', href: '/activity?tab=runs&run=demo-run-2' },
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
  const actionLabel = (item: { id: string }) => actionKeys[item.id] ? t(actionKeys[item.id]) : item.id
  const actionReason = (item: CommandCenterAction) => actionReasonKeys[item.id]
    ? t(actionReasonKeys[item.id])
    : t('cc.reasonFallback', { action: actionLabel(item) })
  const showingDemo = demo || snapshot.demo === true
  const eventFactsComplete = snapshot.sources.events === 'ok'
  const eventFactsUnavailable = snapshot.sources.events === 'unavailable'
  const disconnected = snapshot.sources.connections === 'ok'
    && snapshot.readiness.verifiedRuntimes.length === 0
    && snapshot.readiness.installedRuntimes.length === 0
  const empty = eventFactsComplete && disconnected && !showingDemo && snapshot.metrics.terminalRuns === 0 && snapshot.metrics.observedAssets === 0
  const quickActions = [
    { label: t('cc.quick.scan'), href: '/assets' },
    { label: t('cc.quick.verify'), href: '/settings?section=connections' },
    { label: t('cc.quick.benchmark'), href: '/benchmarks?tab=suites' },
    { label: t('cc.quick.candidate'), href: '/releases' },
    { label: t('cc.quick.export'), href: '/settings?section=data' },
  ]
  const metricCards = [
    { id: 'terminalRuns' as const, label: t('kpi.skillRuns'), value: formatNumber(snapshot.metrics.terminalRuns), basis: t('cc.runsBasis') },
    { id: 'knownOutcomes' as const, label: t('cc.knownOutcomes'), value: formatNumber(snapshot.metrics.knownOutcomes), basis: t('cc.knownOutcomesBasis') },
    { id: 'successRate' as const, label: t('kpi.reportedOutcomeRate'), value: snapshot.metrics.successRate.value === null ? t('cc.notAvailable') : `${formatNumber(snapshot.metrics.successRate.value, { maximumFractionDigits: 1 })}%`, basis: `${formatNumber(snapshot.metrics.successRate.numerator)} / ${formatNumber(snapshot.metrics.successRate.denominator)} · ${t('cc.successBasis')}` },
    { id: 'runtimeOutcomeCoverage' as const, label: t('agents.outcomeCoverage'), value: snapshot.metrics.runtimeOutcomeCoverage.value === null ? t('cc.notAvailable') : `${formatNumber(snapshot.metrics.runtimeOutcomeCoverage.value, { maximumFractionDigits: 1 })}%`, basis: `${formatNumber(snapshot.metrics.runtimeOutcomeCoverage.numerator)} / ${formatNumber(snapshot.metrics.runtimeOutcomeCoverage.denominator)}` },
    { id: 'observedAssets' as const, label: t('kpi.activeSkills'), value: formatNumber(snapshot.metrics.observedAssets), basis: t('cc.activeBasis') },
    { id: 'reportedCostUsd' as const, label: t('kpi.reportedCost'), value: snapshot.metrics.reportedCostUsd === null ? '—' : formatUsd(snapshot.metrics.reportedCostUsd), basis: `${formatNumber(snapshot.metrics.costCoverage.numerator)} / ${formatNumber(snapshot.metrics.costCoverage.denominator)} · ${t('cc.costBasis')}` },
  ]

  return (
    <div className="command-center-grid">
      {showingDemo && <div className="cc-demo" role="status"><strong>{t('mode.demoDataset')}</strong><span>{t('cc.demoNotice')}</span></div>}
      {partial && <div className="data-warning" role="alert">{t('cc.partial')}</div>}
      {error && <div className="data-warning" role="alert">{t('cc.loadFailed', { error })}</div>}

      <section className={`cc-readiness ${snapshot.readiness.level}`}>
        <header><div><h2>{t('cc.readiness')}</h2><p>{readinessText}</p></div>{snapshot.readiness.level === 'ready' ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}</header>
        {snapshot.readiness.items?.length ? <ul className="cc-readiness-list">{snapshot.readiness.items.map((item) => (
          <li key={item.id} className={item.state}>
            <div><strong>{t(readinessLabelKeys[item.id] ?? 'cc.readiness')}</strong><span>{t(readinessStateKeys[item.state])}</span></div>
            {item.reasonCode && <p>{t('cc.reasonCode', { code: item.reasonCode })}</p>}
            <small>{t('cc.checkedAt', { time: formatDateTime(item.checkedAt) })}</small>
            {item.evidenceAt && <small>{t('cc.lastEvidence', { time: formatDateTime(item.evidenceAt) })}</small>}
            {item.href && <button className="text-button" type="button" onClick={() => onOpen(item.href!)}>{t('cc.openAction')}</button>}
          </li>
        ))}</ul> : null}
        <small>{formatDateTime(snapshot.generatedAt)} · {t('activity.refresh')}</small>
        <button className="button secondary" type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><RefreshCw className={loading ? 'spin' : ''} size={14} />{t('cc.retry')}</button>
      </section>

      <section className="cc-actions" aria-label={t('cc.nextActions')}>
        <h2>{t('cc.nextActions')}</h2>
        {snapshot.nextActions.slice(0, 3).length ? snapshot.nextActions.slice(0, 3).map((action) => (
          <article key={action.id} className={`cc-action ${action.severity || ''}`}>
            <header><span>{t(priorityKeys[action.priority])}</span><h3>{actionLabel(action)}</h3></header>
            <dl>
              <div><dt>{t('cc.reason')}</dt><dd>{actionReason(action)}</dd></div>
              <div><dt>{t('cc.evidence')}</dt><dd>{action.evidenceRefs.join(' · ')}</dd></div>
              <div><dt>{t('cc.impact')}</dt><dd>{t(actionImpactKeys[action.priority])}</dd></div>
            </dl>
            <button className="button primary" type="button" onClick={() => onOpen(action.href)}>{actionLabel(action)}</button>
          </article>
        )) : <p>{t('cc.noActions')}</p>}
      </section>

      {empty && <section className="cc-empty" aria-labelledby="cc-empty-title">
        <h2 id="cc-empty-title">{t('cc.emptyTitle')}</h2>
        <p>{t('cc.emptyPrivacy')}</p>
        <h3>{t('cc.quickStart')}</h3>
        <ol><li>{t('cc.stepConnect')}</li><li>{t('cc.stepVerify')}</li><li>{t('cc.stepRun')}</li></ol>
        <button className="button primary" type="button" onClick={() => onOpen('/settings?section=connections')}>{t('cc.quick.verify')}</button>
      </section>}

      {eventFactsUnavailable && <section className="cc-state" role="status">{t('cc.metricsUnavailable')}</section>}

      {!empty && !eventFactsUnavailable && <section className="cc-metrics" aria-labelledby="cc-metrics-title">
        <h2 id="cc-metrics-title">{t('cc.metrics')}</h2>
        <div>{metricCards.map((metric) => (
          <article className="kpi" data-metric={metric.label} key={metric.id}><span>{metric.label}</span><strong data-value={metric.value}>{metric.value}</strong>{metric.id === 'reportedCostUsd' && snapshot.metrics.reportedCostUsd === null && <b>{t('kpi.notReported')}</b>}{metric.id === 'reportedCostUsd' && showingDemo && <b>{t('kpi.demoData')}</b>}<small>{metric.basis}</small>{metric.id === 'reportedCostUsd' && <small>{t('kpi.costCount', { reported: snapshot.metrics.costCoverage.numerator, runs: snapshot.metrics.costCoverage.denominator })}</small>}<details><summary>{t('cc.metricDefinition')}</summary><p>{t(metricDefinitionKeys[metric.id])}</p></details>{metric.id === 'reportedCostUsd' && snapshot.metrics.costCoverage.numerator > 0 && <button className="text-button" type="button" onClick={() => onOpen('/activity?tab=runs&cost=reported')}>{t('kpi.viewCostRuns')}</button>}</article>
        ))}</div>
      </section>}

      <section className="cc-issues">
        <h2>{t('cc.issues')}</h2>
        {snapshot.issues.length ? <ul>{snapshot.issues.map((issue) => <li key={issue.id}><span className={`issue-dot ${issue.severity}`} /><button type="button" onClick={() => onOpen(issue.href)}>{actionLabel(issue)}</button></li>)}</ul> : <p>{t('cc.noIssues')}</p>}
      </section>

      <section className="cc-recent">
        <h2>{t('cc.recentRuns')}</h2>
        {snapshot.recentActivity.length ? <ul>{snapshot.recentActivity.map((activity) => <li key={activity.id}><button className="cc-run-row" type="button" onClick={() => onOpen(activity.href || `/activity?tab=runs&run=${encodeURIComponent(activity.id)}`)}><div><strong>{activity.skillId || activity.event}</strong><span>{activity.runtime} · {activity.outcome || activity.event}</span></div><time dateTime={activity.timestamp}>{formatDateTime(activity.timestamp)}</time><strong aria-hidden="true">→</strong></button></li>)}</ul> : <p>{t(eventFactsComplete ? 'cc.noActivity' : eventFactsUnavailable ? 'cc.recentUnavailable' : 'cc.recentPartial')}</p>}
      </section>

      <section className="cc-quick-actions">
        <h2>{t('cc.quickActions')}</h2>
        <div>{quickActions.map((action) => <button className="button secondary" type="button" key={action.href} onClick={() => onOpen(action.href)}>{action.label}</button>)}</div>
      </section>
    </div>
  )
}
