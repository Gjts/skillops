import { Ban, BrainCircuit, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Download, ExternalLink, FlaskConical, History, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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


type ManagedRun = EvaluationRunSummary & { evidenceFresh?: boolean | null }
type ManagedSuite = EvaluationSuiteMetadata & { policyHash?: string }
type ManagedSuitePage = {
  items: ManagedSuite[]
  page?: number
  totalItems?: number
  totalPages?: number
  hasPrevious?: boolean
  hasNext?: boolean
}
type ManagedRunPage = { items: ManagedRun[]; nextCursor?: string | null; sourceStatus?: 'ok' | 'partial' }
type ManagedDecisionValue = 'create-candidate' | 'keep-baseline' | 'reject-candidate' | 'collect-more-evidence'
export type ManagedEvaluationDraft = { baselineRef: string; candidateRef: string }
type ManagedDecision = {
  decisionId: string
  evaluationRunId: string
  artifactId: string
  candidateRefHash: string
  decision: ManagedDecisionValue
  recordedAt: string
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

function eligibleCases(suite: ManagedSuite | undefined) {
  return suite ? suite.caseCount * suite.repeats * (suite.matrix?.models.length || 1) : 0
}

function inferredTarget(reference: string | undefined) {
  return reference && /^local-scan:[^:]+:(?!sha256:)/.test(reference) ? reference : ''
}

export function ManagedEvaluations({ tab, draft, configureProvider = false }: { tab: ManagedTab; draft?: ManagedEvaluationDraft | null; configureProvider?: boolean }) {
  const { t, formatDateTime, formatNumber } = useI18n()
  const [settings, setSettings] = useState<AiSettings>(createDefaultAiSettings)
  const [settingsOpen, setSettingsOpen] = useState(configureProvider)
  const [suites, setSuites] = useState<ManagedSuite[]>([])
  const [suitePage, setSuitePage] = useState(1)
  const [suitePageState, setSuitePageState] = useState({ page: 1, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false })
  const [runs, setRuns] = useState<ManagedRun[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyCursors, setHistoryCursors] = useState<Array<string | null>>([])
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(null)
  const [historySourceStatus, setHistorySourceStatus] = useState<'ok' | 'partial'>('ok')
  const [historyPaging, setHistoryPaging] = useState(false)
  const [selectedSuiteId, setSelectedSuiteId] = useState('')
  const [baselineRef, setBaselineRef] = useState('')
  const [candidateRef, setCandidateRef] = useState('')
  const [candidateSource, setCandidateSource] = useState<'github' | 'prompt-registry'>('github')
  const [requestedBy, setRequestedBy] = useState('local-user')
  const [currentRun, setCurrentRun] = useState<ManagedRun | null>(null)
  const [cases, setCases] = useState<EvaluationCase[]>([])
  const [caseFilter, setCaseFilter] = useState<'all' | 'passed' | 'failed'>('all')
  const [caseQuery, setCaseQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preflight, setPreflight] = useState(false)
  const [decision, setDecision] = useState<ManagedDecision | null>(null)
  const [decisionRunId, setDecisionRunId] = useState<string | null>(null)
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [targetSkeleton, setTargetSkeleton] = useState('')
  const [candidateCapabilityId, setCandidateCapabilityId] = useState<string | null>(null)
  const [candidateEvidenceBound, setCandidateEvidenceBound] = useState(false)
  const [candidateConflict, setCandidateConflict] = useState(false)
  const selectedRun = useRef({ runId: null as string | null, generation: 0 })
  const historyNavigationInFlight = useRef(false)

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
    try {
      const result = await apiJson<ManagedRunPage>(`/api/evaluation-runs?limit=50${historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ''}`)
      if (!Array.isArray(result.items)) throw new Error('Managed evaluation history response is invalid.')
      setRuns(result.items)
      setHistoryNextCursor(result.nextCursor || null)
      setHistorySourceStatus(result.sourceStatus || 'ok')
    } catch {
      setHistorySourceStatus('partial')
    }
  }, [historyCursor])

  const changeHistoryPage = (cursor: string | null, cursors: Array<string | null>) => {
    if (historyNavigationInFlight.current) return
    historyNavigationInFlight.current = true
    setHistoryPaging(true)
    setHistoryCursors(cursors)
    setHistoryCursor(cursor)
  }

  useEffect(() => {
    let live = true
    Promise.allSettled([
      apiJson<ManagedSuitePage>(suitePage === 1 ? '/api/evaluation-suites' : `/api/evaluation-suites?page=${suitePage}&pageSize=50`),
      apiJson<ManagedRunPage>(`/api/evaluation-runs?limit=50${historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : ''}`),
    ]).then(([suiteResult, runResult]) => {
      if (!live) return
      if (suiteResult.status === 'fulfilled' && Array.isArray(suiteResult.value.items)) {
        const value = suiteResult.value
        setSuites(value.items)
        setSuitePageState({
          page: value.page ?? suitePage,
          totalItems: value.totalItems ?? value.items.length,
          totalPages: value.totalPages ?? (value.items.length ? 1 : 0),
          hasPrevious: value.hasPrevious ?? suitePage > 1,
          hasNext: value.hasNext ?? false,
        })
        setSelectedSuiteId((current) => value.items.some((item) => item.id === current) ? current : value.items[0]?.id || '')
      } else {
        setError(suiteResult.status === 'rejected' && suiteResult.reason instanceof Error ? suiteResult.reason.message : t('evaluations.managedLoadError'))
      }
      if (runResult.status === 'fulfilled' && Array.isArray(runResult.value.items)) {
        setRuns(runResult.value.items)
        setHistoryNextCursor(runResult.value.nextCursor || null)
        setHistorySourceStatus(runResult.value.sourceStatus || 'ok')
      } else {
        setHistorySourceStatus('partial')
      }
    }).finally(() => {
      if (!live) return
      historyNavigationInFlight.current = false
      setHistoryPaging(false)
      setLoading(false)
    })
    return () => { live = false }
  }, [historyCursor, suitePage, t])

  useEffect(() => {
    if (!draft) return
    setBaselineRef(draft.baselineRef)
    setCandidateRef(draft.candidateRef)
    setCandidateSource('github')
    setPreflight(false)
  }, [draft])

  const loadCases = useCallback(async (runId: string) => {
    const selection = selectedRun.current
    const items: EvaluationCase[] = []
    let cursor: string | null = null
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const result: { items: EvaluationCase[]; nextCursor?: string | null } = await apiJson(`/api/evaluation-runs/${encodeURIComponent(runId)}/cases?limit=100${suffix}`)
      items.push(...result.items)
      cursor = result.nextCursor || null
    } while (cursor && items.length < 1_000)
    if (selectedRun.current === selection && selection.runId === runId) setCases(items)
  }, [])

  const loadDecision = useCallback(async (runId: string) => {
    const selection = selectedRun.current
    const result = await apiJson<{ decision: ManagedDecision | null }>(`/api/evaluations/${encodeURIComponent(runId)}/decision`)
    if (result.decision?.decision === 'create-candidate') {
      const capabilities = await apiJson<{ items: Array<{ id: string; targetSkeleton?: string; originEvaluationRunId?: string | null; latestEvidenceRunId?: string | null }> }>(`/api/capabilities?evaluationRunId=${encodeURIComponent(runId)}&pageSize=20`)
      if (selectedRun.current !== selection || selection.runId !== runId) return
      const matches = capabilities.items.filter((item) => item.originEvaluationRunId === runId || item.latestEvidenceRunId === runId)
      const capability = matches.length === 1 ? matches[0] : null
      setDecision(result.decision)
      setDecisionRunId(runId)
      setCandidateCapabilityId(capability?.id || null)
      setCandidateEvidenceBound(Boolean(capability?.latestEvidenceRunId))
      setCandidateConflict(matches.length > 1)
      if (capability?.targetSkeleton) setTargetSkeleton(capability.targetSkeleton)
    } else {
      if (selectedRun.current !== selection || selection.runId !== runId) return
      setDecision(result.decision)
      setDecisionRunId(runId)
      setCandidateCapabilityId(null)
      setCandidateEvidenceBound(false)
      setCandidateConflict(false)
    }
  }, [])

  useEffect(() => {
    if (!runIsActive(currentRun)) return
    const runId = currentRun!.id
    const selection = selectedRun.current
    if (selection.runId !== runId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await apiJson<ManagedRun>(`/api/evaluation-runs/${encodeURIComponent(runId)}`)
        if (stopped || selectedRun.current !== selection) return
        setCurrentRun(next)
        if (runIsActive(next)) {
          timer = setTimeout(poll, document.visibilityState === 'hidden' ? 5_000 : 1_000)
        } else {
          await Promise.all([loadHistory(), loadCases(next.id), loadDecision(next.id)])
        }
      } catch (problem) {
        if (!stopped && selectedRun.current === selection) {
          setError(problem instanceof Error ? problem.message : t('evaluations.managedLoadError'))
        }
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
  }, [currentRun?.id, currentRun?.status, loadCases, loadDecision, loadHistory, t])

  const startRun = async () => {
    if (!selectedSuite || !baselineRef.trim() || !candidateRef.trim() || submitting) return
    if (!providerIsConfigured(settings)) {
      setSettingsOpen(true)
      return
    }
    const selection = { runId: null as string | null, generation: selectedRun.current.generation + 1 }
    selectedRun.current = selection
    setSubmitting(true)
    setError(null)
    setCases([])
    setDecision(null)
    setDecisionRunId(null)
    setCandidateCapabilityId(null)
    setCandidateEvidenceBound(false)
    setCandidateConflict(false)
    setTargetSkeleton(inferredTarget(baselineRef.trim()))
    setPreflight(false)
    try {
      const result = await apiJson<{ run: ManagedRun }>('/api/evaluation-runs', {
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
      if (selectedRun.current !== selection) return
      selectedRun.current = { runId: result.run.id, generation: selection.generation }
      setCurrentRun(result.run)
      setHistoryCursor(null)
      setHistoryCursors([])
      setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)])
    } catch (problem) {
      if (selectedRun.current === selection) {
        setError(problem instanceof Error ? problem.message : t('evaluations.managedRunError'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const cancelRun = async () => {
    const run = currentRun
    const selection = selectedRun.current
    if (!run || !runIsActive(run) || selection.runId !== run.id) return
    try {
      const result = await apiJson<{ summary: ManagedRun }>(`/api/evaluation-runs/${encodeURIComponent(run.id)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      if (selectedRun.current !== selection) return
      setCurrentRun(result.summary)
      await loadHistory()
    } catch (problem) {
      if (selectedRun.current === selection) {
        setError(problem instanceof Error ? problem.message : t('evaluations.managedCancelError'))
      }
    }
  }

  const openRun = async (run: ManagedRun) => {
    const selection = { runId: run.id, generation: selectedRun.current.generation + 1 }
    selectedRun.current = selection
    setCurrentRun(run)
    setCases([])
    setDecision(null)
    setDecisionRunId(null)
    setCandidateCapabilityId(null)
    setCandidateEvidenceBound(false)
    setCandidateConflict(false)
    setTargetSkeleton(inferredTarget(run.baseline.sourceRef))
    if (!runIsActive(run)) {
      try { await Promise.all([loadCases(run.id), loadDecision(run.id)]) } catch (problem) {
        if (selectedRun.current === selection) {
          setError(problem instanceof Error ? problem.message : t('evaluations.managedLoadError'))
        }
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

  const evaluated = currentRun?.metrics?.casesTotal || 0
  const eligible = currentRun?.metrics?.eligibleCases || 0
  const suiteCaseCoverage = currentRun?.metrics?.suiteCaseCoveragePct ?? null
  const regressions = cases.filter((item) => item.baseline.pass && !item.candidate.pass)
  const requiredEvidenceGatesPassed = ['sample-size', 'suite-case-coverage'].every((gateId) =>
    currentRun?.gates.some((gate) => gate.id === gateId && gate.blocking && gate.status === 'passed'),
  )
  const evidenceSufficient = currentRun?.status === 'completed'
    && currentRun.gateResult === 'passed'
    && currentRun.evidenceFresh === true
    && evaluated > 0
    && requiredEvidenceGatesPassed

  const saveDecision = async (runId: string, value: ManagedDecisionValue) => {
    return apiJson<{ decision: ManagedDecision }>(`/api/evaluations/${encodeURIComponent(runId)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: value }),
    })
  }

  const recordDecision = async (value: Exclude<ManagedDecisionValue, 'create-candidate'>) => {
    const runId = currentRun?.id
    const selection = selectedRun.current
    if (decisionBusy || !runId || decisionRunId !== runId || selection.runId !== runId) return
    setDecisionBusy(true)
    setError(null)
    setCandidateCapabilityId(null)
    setCandidateEvidenceBound(false)
    setCandidateConflict(false)
    try {
      const recorded = (await saveDecision(runId, value)).decision
      if (selectedRun.current === selection) setDecision(recorded)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('evaluations.managedRunError'))
    } finally {
      setDecisionBusy(false)
    }
  }

  const createCandidate = async () => {
    const run = currentRun
    const selection = selectedRun.current
    if (!run || !evidenceSufficient || selection.runId !== run.id || decisionRunId !== run.id || !targetSkeleton.trim() || decisionBusy || candidateConflict
      || (candidateCapabilityId && candidateEvidenceBound)
      || (decision && (decision.evaluationRunId !== run.id || decision.decision !== 'create-candidate'))) return
    setDecisionBusy(true)
    setError(null)
    try {
      const recorded = await saveDecision(run.id, 'create-candidate')
      const capability = candidateCapabilityId
        ? { id: candidateCapabilityId, latestEvidenceRunId: candidateEvidenceBound ? run.id : null }
        : (await apiJson<{ capability: { id: string; latestEvidenceRunId?: string | null } }>('/api/capabilities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              artifact: run.candidate,
              baseline: run.baseline,
              targetSkeleton: targetSkeleton.trim(),
              evaluationRunId: run.id,
            }),
          })).capability
      if (capability.latestEvidenceRunId !== run.id) {
        await apiJson(`/api/capabilities/${encodeURIComponent(capability.id)}/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: run.id }),
        })
      }
      if (selectedRun.current !== selection) return
      setDecision(recorded.decision)
      setCandidateCapabilityId(capability.id)
      setCandidateEvidenceBound(true)
      setCandidateConflict(false)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t('evaluations.managedRunError'))
    } finally {
      setDecisionBusy(false)
    }
  }

  if (loading) return <section className="panel managed-evaluation-empty" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="spin" size={18} />{t('evaluations.loading')}</section>

  return (
    <div className="managed-evaluations">
      {error && <div className="evaluation-error" role="alert">{error}</div>}
      {tab === 'suites' && (
        <>
          <section className="panel managed-suite-panel" aria-labelledby="managed-suite-title">
            <header className="panel-header"><div><h2 id="managed-suite-title">{t('evaluations.suitesTitle')}</h2><span>{t('evaluations.suitesDescription')}</span></div><ShieldCheck size={18} /></header>
            {suites.length ? <div className="managed-suite-grid">{suites.map((item) => (
              <button key={item.id} type="button" className={selectedSuiteId === item.id ? 'managed-suite-card selected' : 'managed-suite-card'} onClick={() => { setSelectedSuiteId(item.id); setPreflight(false) }}>
                <span><strong>{item.name}</strong><small>{item.version}</small></span>
                <p>{item.owner} · {formatNumber(item.caseCount)} {t('evaluations.cases')} · {item.sensitivity}</p>
                <code>{item.suiteHash.slice(0, 12)}</code>
              </button>
            ))}</div> : <p className="managed-empty-copy" role="status">{t('evaluations.noSuites')}</p>}
            {suitePageState.totalPages > 1 && <nav className="runs-pagination-bar registry-pagination" aria-label={t('common.pageOf', { page: formatNumber(suitePageState.page), count: formatNumber(suitePageState.totalPages) })}>
              <div className="pagination-controls">
                <button type="button" aria-label={t('common.previousPage')} disabled={!suitePageState.hasPrevious} onClick={() => setSuitePage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button>
                <span role="status" aria-live="polite">{t('common.pageOf', { page: formatNumber(suitePageState.page), count: formatNumber(suitePageState.totalPages) })}</span>
                <button type="button" aria-label={t('common.nextPage')} disabled={!suitePageState.hasNext} onClick={() => setSuitePage((value) => Math.min(suitePageState.totalPages, value + 1))}><ChevronRight size={15} /></button>
              </div>
            </nav>}
          </section>

          {selectedSuite && <section className="panel managed-run-form" aria-labelledby="managed-run-title">
            <header className="panel-header"><div><h2 id="managed-run-title">{t('evaluations.runSuiteTitle')}</h2><span>{t('evaluations.runSuiteDescription')}</span></div><FlaskConical size={18} /></header>
            <div className="candidate-source-tabs" role="group" aria-label={t('promptRegistry.candidateSource')}><button type="button" className={candidateSource === 'github' ? 'is-selected' : ''} onClick={() => { setCandidateSource('github'); setPreflight(false) }}>{t('promptRegistry.githubSkill')}</button><button type="button" className={candidateSource === 'prompt-registry' ? 'is-selected' : ''} onClick={() => { setCandidateSource('prompt-registry'); setPreflight(false) }}>{t('promptRegistry.localPrompt')}</button></div>
            {draft && <p className="managed-draft-boundary"><LockKeyhole size={14} />{t('evaluations.candidateDraftMemory')}</p>}
            <div className="managed-run-fields">
              <label><span>{t('evaluations.baselineRef')}</span><input value={baselineRef} onChange={(event) => { setBaselineRef(event.target.value); setPreflight(false) }} placeholder="local-scan:…" /></label>
              <label><span>{t('evaluations.candidateRef')}</span><input value={candidateRef} onChange={(event) => { setCandidateRef(event.target.value); setPreflight(false) }} placeholder="github:…#SKILL.md" /></label>
              <label><span>{t('evaluations.requestedBy')}</span><input value={requestedBy} onChange={(event) => { setRequestedBy(event.target.value); setPreflight(false) }} /></label>
            </div>
            {preflight && <section className="managed-preflight" role="region" aria-label={t('evaluations.preflightTitle')}>
              <h3>{t('evaluations.preflightTitle')}</h3>
              <dl>
                <div><dt>{t('evaluations.providerStatus')}</dt><dd>{providerIsConfigured(settings) ? `${providerDefinition.label} · ${settings.providers[settings.activeProvider].model}` : t('assistant.providerNotConfigured')}</dd></div>
                <div><dt>{t('evaluations.baselineRef')}</dt><dd><code>{baselineRef.trim()}</code></dd></div>
                <div><dt>{t('evaluations.candidateRef')}</dt><dd><code>{candidateRef.trim()}</code></dd></div>
                <div><dt>{t('evaluations.suiteHash')}</dt><dd><code>{selectedSuite.suiteHash}</code></dd></div>
                <div><dt>{t('evaluations.datasetHash')}</dt><dd><code>{selectedSuite.datasetHash || t('evaluations.notAvailable')}</code></dd></div>
                <div><dt>{t('evaluations.policyHash')}</dt><dd><code>{selectedSuite.policyHash || t('evaluations.notAvailable')}</code></dd></div>
                <div><dt>{t('evaluations.eligibleCases')}</dt><dd>{t('evaluations.eligibleCaseCount', { count: formatNumber(eligibleCases(selectedSuite)) })}</dd></div>
                <div><dt>{t('evaluations.providerData')}</dt><dd>{t('evaluations.providerDataCategories')}</dd></div>
              </dl>
              <p><LockKeyhole size={14} />{t('evaluations.preflightCancellation')}</p>
            </section>}
            <div className="managed-run-actions">
              <p><LockKeyhole size={14} />{t('evaluations.summaryPrivacy')}</p>
              <button className="button ai-outline" type="button" disabled={submitting} onClick={() => setSettingsOpen(true)}><BrainCircuit size={15} />{providerIsConfigured(settings) ? `${providerDefinition.label} · ${settings.providers[settings.activeProvider].model}` : t('evaluations.configureAi')}</button>
              {!preflight
                ? <button className="button primary" type="button" disabled={!baselineRef.trim() || !candidateRef.trim() || submitting} onClick={() => setPreflight(true)}><ShieldCheck size={15} />{t('evaluations.reviewPreflight')}</button>
                : <button className="button primary" type="button" disabled={submitting} onClick={() => void startRun()}>{submitting ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}{submitting ? t('evaluations.starting') : t('evaluations.startRun')}</button>}
            </div>
          </section>}
          {selectedSuite && candidateSource === 'prompt-registry' && <PromptRegistryBrowser baselineRef={baselineRef} candidateRef={candidateRef} onBaseline={(value) => { setBaselineRef(value); setPreflight(false) }} onCandidate={(value) => { setCandidateRef(value); setPreflight(false) }} onModelHint={usePromptModelHint} />}
        </>
      )}

      {tab === 'history' && <section className="panel managed-history" aria-labelledby="managed-history-title">
        <header className="panel-header"><div><h2 id="managed-history-title">{t('evaluations.historyTitle')}</h2><span>{t('evaluations.historyDescription')}</span></div><History size={18} /></header>
        {historySourceStatus === 'partial' && <div className="data-warning" role="alert">{t('cc.partial')}</div>}
        {runs.length ? <div className="managed-history-list">{runs.map((run) => (
          <button key={run.id} type="button" className={currentRun?.id === run.id ? 'managed-history-row selected' : 'managed-history-row'} onClick={() => void openRun(run)}>
            <span className={`managed-status ${run.status}`}>{runIsActive(run) ? <Clock3 size={13} /> : run.status === 'completed' ? <CheckCircle2 size={13} /> : <Ban size={13} />}{t(statusKeys[run.status])}</span>
            <strong>{run.suiteId || run.mode}</strong><span>{run.candidate.artifactId} · {run.candidate.version}</span><small>{formatDateTime(run.requestedAt)}</small>
          </button>
        ))}</div> : <p className="managed-empty-copy" role="status">{t('evaluations.noHistory')}</p>}
        {(historyCursors.length > 0 || historyNextCursor) && <nav className="runs-pagination-bar registry-pagination" aria-label={t('evaluations.historyTitle')} aria-busy={historyPaging}>
          <div className="pagination-controls">
            <button type="button" aria-label={t('common.previousPage')} disabled={historyPaging || !historyCursors.length} onClick={() => {
              const previous = historyCursors.at(-1) ?? null
              changeHistoryPage(previous, historyCursors.slice(0, -1))
            }}><ChevronLeft size={15} /></button>
            <span role="status" aria-live="polite">{t('common.pageOf', {
              page: formatNumber(historyCursors.length + 1),
              count: historyNextCursor ? `${formatNumber(historyCursors.length + 2)}+` : formatNumber(historyCursors.length + 1),
            })}</span>
            <button type="button" aria-label={t('common.nextPage')} disabled={historyPaging || !historyNextCursor} onClick={() => {
              if (!historyNextCursor) return
              changeHistoryPage(historyNextCursor, [...historyCursors, historyCursor])
            }}><ChevronRight size={15} /></button>
          </div>
        </nav>}
      </section>}

      {currentRun && <section className="panel managed-run-result" aria-labelledby="managed-result-title">
        <header className="panel-header"><div><h2 id="managed-result-title">{t('evaluations.runResult')}</h2><span>{currentRun.id} · {currentRun.engine.name} {currentRun.engine.version}</span></div><span className={`managed-status ${currentRun.status}`}>{t(statusKeys[currentRun.status])}</span></header>
        {!runIsActive(currentRun) && <div className="managed-run-actions">
          <a className="button secondary" href={`/api/evaluation-runs/${encodeURIComponent(currentRun.id)}/report?format=json`} download="skillops-evaluation-report.json"><Download size={14} />{t('evaluations.downloadJsonReport')}</a>
          <a className="button secondary" href={`/api/evaluation-runs/${encodeURIComponent(currentRun.id)}/report?format=html`} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t('evaluations.openHtmlReport')}</a>
        </div>}
        {runIsActive(currentRun) && <div className="managed-progress"><LoaderCircle className="spin" size={18} /><p>{t('evaluations.polling')}</p><button className="button danger" type="button" onClick={() => void cancelRun()}>{t('common.cancel')}</button></div>}
        {currentRun.metrics && <dl className="managed-artifact-summary">
          <div><dt>{t('common.current')}</dt><dd>{currentRun.baseline.artifactId} · {currentRun.baseline.version}</dd></div>
          <div><dt>{t('common.candidate')}</dt><dd>{currentRun.candidate.artifactId} · {currentRun.candidate.version}</dd></div>
          <div><dt>{t('evaluations.evaluatedAt')}</dt><dd>{currentRun.completedAt ? formatDateTime(currentRun.completedAt) : t('evaluations.notAvailable')}</dd></div>
        </dl>}
        {currentRun.metrics && <div className="managed-metrics">
          <article><span>{t('evaluations.candidateScore')}</span><strong>{metric(currentRun.metrics.candidateScore, '', t('evaluations.notAvailable'))}</strong></article>
          <article><span>{t('evaluations.scoreDelta')}</span><strong>{currentRun.metrics.scoreDeltaPp === null ? t('evaluations.notAvailable') : `${currentRun.metrics.scoreDeltaPp >= 0 ? '+' : ''}${currentRun.metrics.scoreDeltaPp.toFixed(1)} pp`}</strong></article>
          <article><span>{t('evaluations.sampleSize')}</span><strong>{formatNumber(currentRun.metrics.casesTotal)}</strong></article>
          <article><span>{t('evaluations.passRate')}</span><strong>{metric(currentRun.metrics.passRatePct, '%', t('evaluations.notAvailable'))}</strong></article>
          <article><span>{t('evaluations.regressionRate')}</span><strong>{metric(currentRun.metrics.regressionRatePct, '%', t('evaluations.notAvailable'))}</strong></article>
          <article><span>{t('evaluations.suiteCaseCoverage')}</span><strong>{suiteCaseCoverage === null ? t('evaluations.notAvailable') : `${formatNumber(evaluated)} / ${formatNumber(eligible)} (${suiteCaseCoverage.toFixed(1)}%)`}</strong></article>
          <article className="managed-outcomes"><span>{t('evaluations.caseOutcomes')}</span><strong>{t('evaluations.caseOutcomeCounts', { passed: formatNumber(currentRun.metrics.casesPassed), failed: formatNumber(currentRun.metrics.casesTotal - currentRun.metrics.casesPassed), errors: '0', skipped: '0' })}</strong></article>
          <article><span>{t('common.tokens')}</span><strong>{currentRun.metrics.candidateTokens === null ? t('evaluations.notAvailable') : formatNumber(currentRun.metrics.candidateTokens)}</strong></article>
          <article><span>{t('common.cost')}</span><strong>{metric(currentRun.metrics.candidateCostUsd, ' USD', t('evaluations.notAvailable'), 4)}</strong></article>
          <article><span>{t('evaluations.p95Latency')}</span><strong>{metric(currentRun.metrics.candidateP95LatencyMs, ' ms', t('evaluations.notAvailable'), 0)}</strong></article>
        </div>}
        {currentRun.gates.length > 0 && <div className="managed-gates"><strong>{t('evaluations.gates')}</strong>{currentRun.gates.map((gate) => <span key={gate.id} className={gate.status}>{gate.id}: {t(gateKeys[gate.status])}</span>)}</div>}
        {currentRun.metrics && <section className={`managed-evidence ${evidenceSufficient ? 'sufficient' : 'insufficient'}`} aria-label={t('evaluations.evidenceSummary')}>
          <div>
            <strong>{currentRun.evidenceFresh === true ? t('evaluations.evidenceCurrent') : currentRun.evidenceFresh === false ? t('evaluations.evidenceStale') : t('evaluations.evidenceUnknown')}</strong>
            <span>{currentRun.gateResult === 'passed' ? t('evaluations.gatePassed') : currentRun.gateResult === 'failed' ? t('evaluations.gateFailed') : t('evaluations.gateNotEvaluated')}</span>
          </div>
          <p>{evidenceSufficient ? t('evaluations.sufficientEvidence') : t('evaluations.insufficientEvidence')}</p>
          <div className="managed-regressions">
            <strong>{t('evaluations.regressionCount', { count: formatNumber(regressions.length) })}</strong>
            {regressions.map((item) => <button className="text-button" type="button" key={item.id} onClick={() => { setCaseFilter('failed'); setCaseQuery(item.caseId) }}>{item.caseId}</button>)}
          </div>
        </section>}
        {currentRun.mode === 'suite' && currentRun.status === 'completed' && currentRun.evidenceHash && <section className="managed-decision" aria-labelledby="managed-decision-title">
          <h3 id="managed-decision-title">{t('evaluations.decisionTitle')}</h3>
          <label><span>{t('evaluations.targetSkeleton')}</span><input value={targetSkeleton} onChange={(event) => setTargetSkeleton(event.target.value)} placeholder="local-scan:codex:…/SKILL.md" /></label>
          <div>
            <button className="button primary" type="button" disabled={!evidenceSufficient || decisionRunId !== currentRun.id || decisionBusy || !targetSkeleton.trim() || candidateConflict || Boolean(candidateCapabilityId && candidateEvidenceBound) || Boolean(decision && decision.decision !== 'create-candidate')} onClick={() => void createCandidate()}>{candidateCapabilityId && !candidateEvidenceBound ? t('evaluations.continueCandidate') : t('evaluations.createCandidate')}</button>
            <button className="button secondary" type="button" disabled={decisionRunId !== currentRun.id || decisionBusy || Boolean(decision)} onClick={() => void recordDecision('keep-baseline')}>{t('evaluations.keepBaseline')}</button>
            <button className="button secondary" type="button" disabled={decisionRunId !== currentRun.id || decisionBusy || Boolean(decision)} onClick={() => void recordDecision('reject-candidate')}>{t('evaluations.rejectCandidate')}</button>
            <button className="button secondary" type="button" disabled={decisionRunId !== currentRun.id || decisionBusy || Boolean(decision)} onClick={() => void recordDecision('collect-more-evidence')}>{t('evaluations.collectMoreEvidence')}</button>
          </div>
          {decision && <p role="status">{t('evaluations.decisionRecorded', {
            decision: decision.decision === 'create-candidate'
              ? t('evaluations.createCandidate')
              : decision.decision === 'keep-baseline'
                ? t('evaluations.keepBaseline')
                : decision.decision === 'reject-candidate'
                  ? t('evaluations.rejectCandidate')
                  : t('evaluations.collectMoreEvidence'),
          })}</p>}
          {candidateConflict && <p className="evaluation-error" role="alert">{t('evaluations.candidateConflict')}</p>}
          {candidateCapabilityId && candidateEvidenceBound && <a className="button secondary" href={`/releases?capability=${encodeURIComponent(candidateCapabilityId)}`}>{t('evaluations.openReleases')}</a>}
        </section>}
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

      <AiSettingsModal open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onSave={(next) => { setSettings(next); setPreflight(false); setSettingsOpen(false) }} />
    </div>
  )
}
