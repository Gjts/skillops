import { Ban, BrainCircuit, CheckCircle2, Clock3, Download, ExternalLink, FlaskConical, History, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { activeProviderRequest, AI_PROVIDERS, createDefaultAiSettings, providerIsConfigured, type AiSettings } from '../lib/ai-settings'
import type { EvaluationRunSummary, EvaluationSuiteMetadata } from '../types'
import { AiSettingsModal } from './AiSettingsModal'
import { PromptRegistryBrowser } from './PromptRegistry'

type ManagedTab = 'suites' | 'history'
type EvaluationCase = {
  id: string
  caseId: string
  matrixId?: string
  model?: string
  baseline: EvaluationCaseVariant
  candidate: EvaluationCaseVariant
}
type EvaluationCaseVariant = {
  pass: boolean
  score: number | null
  assertions?: Array<{ label: string; type: string; blocking: boolean; pass: boolean; score: number | null }>
}

const statusKeys: Record<EvaluationRunSummary['status'], MessageKey> = {
  queued: 'evaluations.status.queued', running: 'evaluations.status.running', completed: 'evaluations.status.completed',
  failed: 'evaluations.status.failed', cancelled: 'evaluations.status.cancelled', interrupted: 'evaluations.status.interrupted',
}
const gateKeys: Record<'passed' | 'failed' | 'not-available', MessageKey> = {
  passed: 'evaluations.gate.passed', failed: 'evaluations.gate.failed', 'not-available': 'evaluations.gate.notAvailable',
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const result = await response.json() as T & { error?: string | { message?: string } }
  if (!response.ok) {
    const message = typeof result.error === 'string' ? result.error : result.error?.message
    throw new Error(message || `Local API returned ${response.status}.`)
  }
  return result
}

function metric(value: number | null | undefined, suffix: string, notAvailable: string, digits = 1) {
  return value === null || value === undefined ? notAvailable : `${value.toFixed(digits)}${suffix}`
}

function runIsActive(run: EvaluationRunSummary | null) {
  return run?.status === 'queued' || run?.status === 'running'
}

export function ManagedEvaluations({ tab }: { tab: ManagedTab }) {
  const { t, formatDateTime, formatNumber } = useI18n()
  const [settings, setSettings] = useState<AiSettings>(createDefaultAiSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [suites, setSuites] = useState<EvaluationSuiteMetadata[]>([])
  const [runs, setRuns] = useState<EvaluationRunSummary[]>([])
  const [selectedSuiteId, setSelectedSuiteId] = useState('')
  const [baselineRef, setBaselineRef] = useState('')
  const [candidateRef, setCandidateRef] = useState('')
  const [candidateSource, setCandidateSource] = useState<'github' | 'prompt-registry'>('github')
  const [requestedBy, setRequestedBy] = useState('local-user')
  const [currentRun, setCurrentRun] = useState<EvaluationRunSummary | null>(null)
  const [cases, setCases] = useState<EvaluationCase[]>([])
  const [caseFilter, setCaseFilter] = useState<'all' | 'passed' | 'failed'>('all')
  const [caseQuery, setCaseQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerDefinition = AI_PROVIDERS.find((provider) => provider.id === settings.activeProvider)!
  const selectedSuite = suites.find((suite) => suite.id === selectedSuiteId)

  const usePromptModelHint = (hint: { provider: string; model: string }) => {
    const normalized = hint.provider.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    const matched = AI_PROVIDERS.find((provider) => provider.id.replace(/[^a-z0-9]/g, '') === normalized || provider.label.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized)
    if (matched) {
      setSettings((current) => ({
        ...current,
        activeProvider: matched.id,
        providers: { ...current.providers, [matched.id]: { ...current.providers[matched.id], model: hint.model } },
      }))
    }
    setSettingsOpen(true)
  }

  const loadHistory = useCallback(async () => {
    const result = await apiJson<{ items: EvaluationRunSummary[] }>('/api/evaluation-runs?limit=50')
    setRuns(result.items)
  }, [])

  useEffect(() => {
    let live = true
    Promise.all([
      apiJson<{ items: EvaluationSuiteMetadata[] }>('/api/evaluation-suites'),
      apiJson<{ items: EvaluationRunSummary[] }>('/api/evaluation-runs?limit=50'),
    ]).then(([suiteResult, runResult]) => {
      if (!live) return
      setSuites(suiteResult.items)
      setRuns(runResult.items)
      setSelectedSuiteId((current) => current || suiteResult.items[0]?.id || '')
    }).catch((problem) => {
      if (live) setError(problem instanceof Error ? problem.message : t('evaluations.managedLoadError'))
    }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [t])

  const loadCases = useCallback(async (runId: string) => {
    const result = await apiJson<{ items: EvaluationCase[] }>(`/api/evaluation-runs/${encodeURIComponent(runId)}/cases?limit=100`)
    setCases(result.items)
  }, [])

  useEffect(() => {
    if (!runIsActive(currentRun)) return
    const runId = currentRun!.id
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await apiJson<EvaluationRunSummary>(`/api/evaluation-runs/${encodeURIComponent(runId)}`)
        if (stopped) return
        setCurrentRun(next)
        if (runIsActive(next)) {
          timer = setTimeout(poll, document.visibilityState === 'hidden' ? 5_000 : 1_000)
        } else {
          await Promise.all([loadHistory(), loadCases(next.id)])
        }
      } catch (problem) {
        if (!stopped) setError(problem instanceof Error ? problem.message : t('evaluations.managedLoadError'))
      }
    }
    timer = setTimeout(poll, document.visibilityState === 'hidden' ? 5_000 : 1_000)
    const visibility = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(poll, document.visibilityState === 'hidden' ? 5_000 : 1_000)
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [currentRun?.id, currentRun?.status, loadCases, loadHistory, t])

  const startRun = async () => {
    if (!selectedSuite || !baselineRef.trim() || !candidateRef.trim() || submitting) return
    if (!providerIsConfigured(settings)) {
      setSettingsOpen(true)
      return
    }
    setSubmitting(true)
    setError(null)
    setCases([])
    try {
      const result = await apiJson<{ run: EvaluationRunSummary }>('/api/evaluation-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          suiteId: selectedSuite.id,
          baselineRef: baselineRef.trim(),
          candidateRef: candidateRef.trim(),
          provider: activeProviderRequest(settings),
          requestedBy: requestedBy.trim() || 'local-user',
          clientRequestId: crypto.randomUUID(),
        }),
      })
      setCurrentRun(result.run)
      setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)])
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('evaluations.managedRunError'))
    } finally {
      setSubmitting(false)
    }
  }

  const cancelRun = async () => {
    if (!currentRun || !runIsActive(currentRun)) return
    try {
      const result = await apiJson<{ summary: EvaluationRunSummary }>(`/api/evaluation-runs/${encodeURIComponent(currentRun.id)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      setCurrentRun(result.summary)
      await loadHistory()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('evaluations.managedCancelError'))
    }
  }

  const openRun = async (run: EvaluationRunSummary) => {
    setCurrentRun(run)
    setCases([])
    if (!runIsActive(run)) {
      try { await loadCases(run.id) } catch (problem) {
        setError(problem instanceof Error ? problem.message : t('evaluations.managedLoadError'))
      }
    }
  }

  const filteredCases = useMemo(() => cases.filter((item) => {
    if (caseFilter === 'passed' && !item.candidate.pass) return false
    if (caseFilter === 'failed' && item.candidate.pass) return false
    const query = caseQuery.trim().toLowerCase()
    if (!query) return true
    const labels = [item.baseline, item.candidate]
      .flatMap((variant) => variant.assertions?.map((assertion) => assertion.label) || [])
      .join(' ')
    return `${item.caseId} ${labels}`.toLowerCase().includes(query)
  }), [caseFilter, caseQuery, cases])

  if (loading) return <section className="panel managed-evaluation-empty"><LoaderCircle className="spin" size={18} />{t('evaluations.loading')}</section>

  return (
    <div className="managed-evaluations">
      {error && <div className="evaluation-error" role="alert">{error}</div>}
      {tab === 'suites' && (
        <>
          <section className="panel managed-suite-panel" aria-labelledby="managed-suite-title">
            <header className="panel-header"><div><h2 id="managed-suite-title">{t('evaluations.suitesTitle')}</h2><span>{t('evaluations.suitesDescription')}</span></div><ShieldCheck size={18} /></header>
            {suites.length ? <div className="managed-suite-grid">{suites.map((item) => (
              <button key={item.id} type="button" className={selectedSuiteId === item.id ? 'managed-suite-card selected' : 'managed-suite-card'} onClick={() => setSelectedSuiteId(item.id)}>
                <span><strong>{item.name}</strong><small>{item.version}</small></span>
                <p>{item.owner} · {formatNumber(item.caseCount)} {t('evaluations.cases')} · {item.sensitivity}</p>
                <code>{item.suiteHash.slice(0, 12)}</code>
              </button>
            ))}</div> : <p className="managed-empty-copy">{t('evaluations.noSuites')}</p>}
          </section>

          {selectedSuite && <section className="panel managed-run-form" aria-labelledby="managed-run-title">
            <header className="panel-header"><div><h2 id="managed-run-title">{t('evaluations.runSuiteTitle')}</h2><span>{t('evaluations.runSuiteDescription')}</span></div><FlaskConical size={18} /></header>
            <div className="candidate-source-tabs" role="group" aria-label={t('promptRegistry.candidateSource')}><button type="button" className={candidateSource === 'github' ? 'is-selected' : ''} onClick={() => setCandidateSource('github')}>{t('promptRegistry.githubSkill')}</button><button type="button" className={candidateSource === 'prompt-registry' ? 'is-selected' : ''} onClick={() => setCandidateSource('prompt-registry')}>{t('promptRegistry.localPrompt')}</button></div>
            <div className="managed-run-fields">
              <label><span>{t('evaluations.baselineRef')}</span><input value={baselineRef} onChange={(event) => setBaselineRef(event.target.value)} placeholder="local-scan:…" /></label>
              <label><span>{t('evaluations.candidateRef')}</span><input value={candidateRef} onChange={(event) => setCandidateRef(event.target.value)} placeholder="github:…#SKILL.md" /></label>
              <label><span>{t('evaluations.requestedBy')}</span><input value={requestedBy} onChange={(event) => setRequestedBy(event.target.value)} /></label>
            </div>
            <div className="managed-run-actions">
              <p><LockKeyhole size={14} />{t('evaluations.summaryPrivacy')}</p>
              <button className="button ai-outline" type="button" disabled={submitting} onClick={() => setSettingsOpen(true)}><BrainCircuit size={15} />{providerIsConfigured(settings) ? `${providerDefinition.label} · ${settings.providers[settings.activeProvider].model}` : t('evaluations.configureAi')}</button>
              <button className="button primary" type="button" disabled={!baselineRef.trim() || !candidateRef.trim() || submitting} onClick={() => void startRun()}>{submitting ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}{submitting ? t('evaluations.starting') : t('evaluations.startRun')}</button>
            </div>
          </section>}
          {selectedSuite && candidateSource === 'prompt-registry' && <PromptRegistryBrowser baselineRef={baselineRef} candidateRef={candidateRef} onBaseline={setBaselineRef} onCandidate={setCandidateRef} onModelHint={usePromptModelHint} />}
        </>
      )}

      {tab === 'history' && <section className="panel managed-history" aria-labelledby="managed-history-title">
        <header className="panel-header"><div><h2 id="managed-history-title">{t('evaluations.historyTitle')}</h2><span>{t('evaluations.historyDescription')}</span></div><History size={18} /></header>
        {runs.length ? <div className="managed-history-list">{runs.map((run) => (
          <button key={run.id} type="button" className={currentRun?.id === run.id ? 'managed-history-row selected' : 'managed-history-row'} onClick={() => void openRun(run)}>
            <span className={`managed-status ${run.status}`}>{runIsActive(run) ? <Clock3 size={13} /> : run.status === 'completed' ? <CheckCircle2 size={13} /> : <Ban size={13} />}{t(statusKeys[run.status])}</span>
            <strong>{run.suiteId || run.mode}</strong><span>{run.candidate.artifactId} · {run.candidate.version}</span><small>{formatDateTime(run.requestedAt)}</small>
          </button>
        ))}</div> : <p className="managed-empty-copy">{t('evaluations.noHistory')}</p>}
      </section>}

      {currentRun && <section className="panel managed-run-result" aria-labelledby="managed-result-title">
        <header className="panel-header"><div><h2 id="managed-result-title">{t('evaluations.runResult')}</h2><span>{currentRun.id} · {currentRun.engine.name} {currentRun.engine.version}</span></div><span className={`managed-status ${currentRun.status}`}>{t(statusKeys[currentRun.status])}</span></header>
        {!runIsActive(currentRun) && <div className="managed-run-actions">
          <a className="button secondary" href={`/api/evaluation-runs/${encodeURIComponent(currentRun.id)}/report?format=json`} download="skillops-evaluation-report.json"><Download size={14} />{t('evaluations.downloadJsonReport')}</a>
          <a className="button secondary" href={`/api/evaluation-runs/${encodeURIComponent(currentRun.id)}/report?format=html`} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t('evaluations.openHtmlReport')}</a>
        </div>}
        {runIsActive(currentRun) && <div className="managed-progress"><LoaderCircle className="spin" size={18} /><p>{t('evaluations.polling')}</p><button className="button danger" type="button" onClick={() => void cancelRun()}>{t('common.cancel')}</button></div>}
        {currentRun.metrics && <div className="managed-metrics">
          <article><span>{t('evaluations.candidateScore')}</span><strong>{metric(currentRun.metrics.candidateScore, '', t('evaluations.notAvailable'))}</strong></article>
          <article><span>{t('evaluations.passRate')}</span><strong>{metric(currentRun.metrics.passRatePct, '%', t('evaluations.notAvailable'))}</strong></article>
          <article><span>{t('evaluations.regressionRate')}</span><strong>{metric(currentRun.metrics.regressionRatePct, '%', t('evaluations.notAvailable'))}</strong></article>
          <article><span>{t('evaluations.sampleSize')}</span><strong>{formatNumber(currentRun.metrics.casesTotal)}</strong></article>
          <article><span>{t('evaluations.outcomeCoverage')}</span><strong>{formatNumber(currentRun.metrics.casesPassed)} / {formatNumber(currentRun.metrics.casesTotal)}</strong></article>
          <article><span>{t('common.tokens')}</span><strong>{currentRun.metrics.candidateTokens === null ? t('evaluations.notAvailable') : formatNumber(currentRun.metrics.candidateTokens)}</strong></article>
          <article><span>{t('common.cost')}</span><strong>{metric(currentRun.metrics.candidateCostUsd, ' USD', t('evaluations.notAvailable'), 4)}</strong></article>
          <article><span>{t('evaluations.p95Latency')}</span><strong>{metric(currentRun.metrics.candidateP95LatencyMs, ' ms', t('evaluations.notAvailable'), 0)}</strong></article>
        </div>}
        {currentRun.gates.length > 0 && <div className="managed-gates"><strong>{t('evaluations.gates')}</strong>{currentRun.gates.map((gate) => <span key={gate.id} className={gate.status}>{gate.id}: {t(gateKeys[gate.status])}</span>)}</div>}
        {cases.length > 0 && <div className="managed-case-results">
          <div className="managed-case-toolbar"><strong>{t('evaluations.caseResults')}</strong><input aria-label={t('evaluations.filterCases')} placeholder={t('evaluations.filterCases')} value={caseQuery} onChange={(event) => setCaseQuery(event.target.value)} /><select aria-label={t('evaluations.caseStatus')} value={caseFilter} onChange={(event) => setCaseFilter(event.target.value as typeof caseFilter)}><option value="all">{t('common.all')}</option><option value="passed">{t('evaluations.passed')}</option><option value="failed">{t('evaluations.failed')}</option></select></div>
          <div className="managed-case-list">{filteredCases.map((item) => <article key={item.id}>
            <span className={item.candidate.pass ? 'passed' : 'failed'}>{item.candidate.pass ? t('evaluations.passed') : t('evaluations.failed')}</span>
            <strong>{item.caseId}</strong>
            <small>{[item.model, ...new Set([item.baseline, item.candidate].flatMap((variant) => variant.assertions?.map((assertion) => assertion.label) || []))].filter(Boolean).join(' · ')}</small>
            <dl className="managed-case-scores">
              <div><dt>{t('common.current')}</dt><dd>{metric(item.baseline.score, '', t('evaluations.notAvailable'))}</dd></div>
              <div><dt>{t('common.candidate')}</dt><dd>{metric(item.candidate.score, '', t('evaluations.notAvailable'))}</dd></div>
            </dl>
          </article>)}</div>
        </div>}
        <p className="result-boundary"><LockKeyhole size={13} />{t('evaluations.noRawOutput')}</p>
      </section>}

      <AiSettingsModal open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onSave={(next) => { setSettings(next); setSettingsOpen(false) }} />
    </div>
  )
}
