import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, GitCompareArrows, GitPullRequest, History, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import type { Capability, CapabilityStage, EvaluationRunSummary, SkeletonChangePreview } from '../types'

const pipeline: Array<{ stage: CapabilityStage | 'monitor'; label: MessageKey }> = [
  { stage: 'candidate', label: 'governance.pipelineCandidate' },
  { stage: 'evaluating', label: 'governance.pipelineEvaluate' },
  { stage: 'ready', label: 'governance.pipelineApprove' },
  { stage: 'canary', label: 'governance.pipelineCanary' },
  { stage: 'stable', label: 'governance.pipelineStable' },
  { stage: 'monitor', label: 'governance.pipelineMonitor' },
]

type ReleaseKind = 'canary' | 'install' | 'promote' | 'deprecate' | 'rollback'

const releaseLabels: Record<ReleaseKind, { confirm: MessageKey; apply: MessageKey; danger: boolean }> = {
  canary: { confirm: 'governance.confirmCanary', apply: 'governance.applyCanary', danger: false },
  install: { confirm: 'governance.confirmInstall', apply: 'governance.applyInstall', danger: false },
  promote: { confirm: 'governance.confirmStable', apply: 'governance.applyStable', danger: false },
  deprecate: { confirm: 'governance.confirmDeprecation', apply: 'governance.applyDeprecation', danger: true },
  rollback: { confirm: 'governance.confirmRollback', apply: 'governance.applyRollback', danger: true },
}

type ReleaseEvidenceRun = EvaluationRunSummary & { evidenceFresh?: boolean | null }
type GovernanceAuditEntry = {
  id: string
  action: string
  actor: string
  capabilityId: string
  outcome: 'pending' | 'committed' | 'failed'
  fromStage: CapabilityStage | null
  toStage: CapabilityStage
  at: string
}
type PageState = {
  page: number
  totalItems: number
  totalPages: number
  hasPrevious: boolean
  hasNext: boolean
}
type PageResponse<T> = Partial<PageState> & { items: T[]; sourceStatus?: 'ok' | 'partial' }

const auditActionKeys: Record<string, MessageKey> = {
  'candidate.nominated': 'governance.audit.candidateNominated',
  'candidate.retracted': 'governance.audit.candidateRetracted',
  'evidence.bound': 'governance.audit.evidenceBound',
  'approval.decided': 'governance.audit.approvalDecided',
  'canary.started': 'governance.audit.canaryStarted',
  'stable.installed': 'governance.audit.stableInstalled',
  'stable.promoted': 'governance.audit.stablePromoted',
  'stable.deprecated': 'governance.audit.stableDeprecated',
  'stable.superseded': 'governance.audit.stableSuperseded',
  'stable.rolled-back': 'governance.audit.stableRolledBack',
  'stable.restored': 'governance.audit.stableRestored',
}

const stageOrder: Record<CapabilityStage, number> = {
  candidate: 0,
  evaluating: 1,
  blocked: 1,
  ready: 2,
  approved: 2,
  canary: 3,
  stable: 4,
  deprecated: 5,
  superseded: 5,
  'rolled-back': 5,
}

const stageKeys: Record<CapabilityStage, MessageKey> = {
  candidate: 'governance.stage.candidate',
  evaluating: 'governance.stage.evaluating',
  blocked: 'governance.stage.blocked',
  ready: 'governance.stage.ready',
  approved: 'governance.stage.approved',
  canary: 'governance.stage.canary',
  stable: 'governance.stage.stable',
  deprecated: 'governance.stage.deprecated',
  superseded: 'governance.stage.superseded',
  'rolled-back': 'governance.stage.rolledBack',
}

const kindKeys = {
  skill: 'governance.kind.skill',
  prompt: 'governance.kind.prompt',
  workflow: 'governance.kind.workflow',
  rules: 'governance.kind.rules',
  agent: 'governance.kind.agent',
  'evaluation-suite': 'governance.kind.evaluationSuite',
  'policy-pack': 'governance.kind.policyPack',
} as const satisfies Record<Capability['artifact']['kind'], MessageKey>

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const result = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(result.error?.message || `Request failed (${response.status})`)
  return result
}

function shortHash(value?: string | null) {
  return value ? value.slice(0, 12) : '—'
}

export function GovernancePage() {
  const { formatDateTime, formatNumber, t } = useI18n()
  const [items, setItems] = useState<Capability[]>([])
  const [capabilityPage, setCapabilityPage] = useState(1)
  const [capabilityPageState, setCapabilityPageState] = useState<PageState>({ page: 1, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false })
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('capability'))
  const [linkedCapability, setLinkedCapability] = useState<Capability | null>(null)
  const [previousStable, setPreviousStable] = useState<Capability | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceRef, setSourceRef] = useState('')
  const [targetSkeleton, setTargetSkeleton] = useState('')
  const [projectId, setProjectId] = useState('')
  const [canaryTarget, setCanaryTarget] = useState('')
  const [canaryProjectRoot, setCanaryProjectRoot] = useState('')
  const [runId, setRunId] = useState('')
  const [redteamRunId, setRedteamRunId] = useState('')
  const [reviewerToken, setReviewerToken] = useState('')
  const [auditToken, setAuditToken] = useState('')
  const [auditStatus, setAuditStatus] = useState<'locked' | 'loading' | 'loaded' | 'error'>('locked')
  const [auditSourceStatus, setAuditSourceStatus] = useState<'ok' | 'partial'>('ok')
  const [preview, setPreview] = useState<{ kind: ReleaseKind; capabilityId: string; value: SkeletonChangePreview } | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [evidenceRun, setEvidenceRun] = useState<ReleaseEvidenceRun | null>(null)
  const [audit, setAudit] = useState<GovernanceAuditEntry[]>([])
  const [auditPageState, setAuditPageState] = useState<PageState>({ page: 1, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false })
  const auditRequest = useRef(0)
  const auditCredential = useRef('')

  const load = useCallback(async () => {
    try {
      const result = await api<PageResponse<Capability>>(capabilityPage === 1 ? '/api/capabilities' : `/api/capabilities?page=${capabilityPage}&pageSize=50`)
      setItems(result.items)
      setCapabilityPageState({
        page: result.page ?? capabilityPage,
        totalItems: result.totalItems ?? result.items.length,
        totalPages: result.totalPages ?? (result.items.length ? 1 : 0),
        hasPrevious: result.hasPrevious ?? capabilityPage > 1,
        hasNext: result.hasNext ?? false,
      })
      setSelectedId((current) => current ?? result.items[0]?.id ?? null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('governance.requestFailed'))
    }
  }, [capabilityPage, t])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!selectedId || items.some((item) => item.id === selectedId)) {
      setLinkedCapability(null)
      return
    }
    let live = true
    api<Capability>(`/api/capabilities/${encodeURIComponent(selectedId)}`)
      .then((item) => { if (live && item.id === selectedId) setLinkedCapability(item) })
      .catch((caught) => { if (live) setError(caught instanceof Error ? caught.message : t('governance.requestFailed')) })
    return () => { live = false }
  }, [items, selectedId, t])
  const selected = useMemo(() => items.find((item) => item.id === selectedId)
    ?? (linkedCapability?.id === selectedId ? linkedCapability : null), [items, linkedCapability, selectedId])
  useEffect(() => {
    let live = true
    auditRequest.current += 1
    setEvidenceRun(null)
    setAudit([])
    setAuditToken('')
    auditCredential.current = ''
    setAuditStatus('locked')
    setAuditSourceStatus('ok')
    setAuditPageState({ page: 1, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false })
    if (!selected) return () => { live = false }
    const run = selected.latestEvidenceRunId
      ? api<ReleaseEvidenceRun>(`/api/evaluation-runs/${encodeURIComponent(selected.latestEvidenceRunId)}`)
      : Promise.resolve(null)
    Promise.allSettled([run]).then(([runResult]) => {
      if (!live) return
      if (runResult.status === 'fulfilled' && runResult.value?.id === selected.latestEvidenceRunId) setEvidenceRun(runResult.value)
    })
    return () => { live = false }
  }, [selected])
  const previousStableId = selected?.stage === 'stable'
    ? selected.releaseTarget?.previousStableCapabilityId
    : selected?.releaseTarget?.stableCapabilityId
  useEffect(() => {
    if (!previousStableId) {
      setPreviousStable(null)
      return
    }
    const currentPage = items.find((item) => item.id === previousStableId)
    if (currentPage) {
      setPreviousStable(currentPage)
      return
    }
    let live = true
    setPreviousStable(null)
    api<Capability>(`/api/capabilities/${encodeURIComponent(previousStableId)}`)
      .then((item) => { if (live && item.id === previousStableId) setPreviousStable(item) })
      .catch(() => {})
    return () => { live = false }
  }, [items, previousStableId])
  const latestApproval = selected?.approvals[selected.approvals.length - 1] ?? null
  const rollbackStableId = selected?.stage === 'approved' && selected.requalifiesStage === 'superseded'
    ? selected.releaseTarget?.stableCapabilityId ?? undefined
    : undefined

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      setPreview(null)
      setConfirmed(false)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('governance.requestFailed'))
    } finally { setBusy(false) }
  }

  function post<T = unknown>(path: string, body: object, token?: string) {
    return api<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  }

  const loadAudit = async (page = 1) => {
    if (!selected) return
    const token = page === 1 ? auditToken.trim() : auditCredential.current
    if (!token) return
    if (page === 1) auditCredential.current = token
    const request = ++auditRequest.current
    setAuditToken('')
    setAuditStatus('loading')
    try {
      const result = await api<PageResponse<GovernanceAuditEntry>>(page === 1
        ? `/api/capabilities/${encodeURIComponent(selected.id)}/audit`
        : `/api/capabilities/${encodeURIComponent(selected.id)}/audit?page=${page}&pageSize=50`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (request !== auditRequest.current) return
      setAudit(Array.isArray(result.items) ? result.items.filter((entry) => entry
        && typeof entry.id === 'string'
        && typeof entry.action === 'string'
        && typeof entry.actor === 'string'
        && typeof entry.at === 'string'
        && entry.capabilityId === selected.id) : [])
      setAuditPageState({
        page: result.page ?? page,
        totalItems: result.totalItems ?? result.items.length,
        totalPages: result.totalPages ?? (result.items.length ? 1 : 0),
        hasPrevious: result.hasPrevious ?? page > 1,
        hasNext: result.hasNext ?? false,
      })
      setAuditSourceStatus(result.sourceStatus || 'ok')
      setAuditStatus('loaded')
    } catch {
      if (request === auditRequest.current) {
        auditCredential.current = ''
        setAuditStatus('error')
      }
    }
  }

  const nominate = () => mutate(() => post('/api/capabilities', {
    sourceRef: sourceRef.trim(),
    targetSkeleton: targetSkeleton.trim(),
    ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
  }))
  const bindEvidence = () => selected && mutate(() => post(`/api/capabilities/${encodeURIComponent(selected.id)}/evaluate`, {
    runId: runId.trim(),
    redteamRunId: redteamRunId.trim() || undefined,
  }))
  const approve = () => {
    if (!selected) return
    const token = reviewerToken.trim()
    setReviewerToken('')
    return mutate(() => post(`/api/capabilities/${encodeURIComponent(selected.id)}/approve`, {
      decision: 'approved',
    }, token || undefined))
  }
  const requestPreview = async (kind: ReleaseKind, capabilityId = selected?.id) => {
    if (!capabilityId) return
    setBusy(true)
    setError(null)
    try {
      const value = await post<SkeletonChangePreview>(`/api/capabilities/${encodeURIComponent(capabilityId)}/${kind}`, {
        action: 'preview',
        ...(kind === 'canary' ? { targetSkeleton: canaryTarget.trim(), projectRoot: canaryProjectRoot.trim() } : {}),
      })
      setPreview({ kind, capabilityId, value })
      setConfirmed(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('governance.requestFailed'))
    } finally { setBusy(false) }
  }
  const applyPreview = () => preview && mutate(() => post(`/api/capabilities/${encodeURIComponent(preview.capabilityId)}/${preview.kind}`, {
    action: 'apply',
    previewToken: preview.value.previewToken,
    confirm: true,
    ...(preview.kind === 'canary' ? { targetSkeleton: preview.value.target, projectRoot: preview.value.projectRoot } : {}),
  }))

  return (
    <div className="single-page governance-page">
      <div className="page-intro">
        <div><h2>{t('governance.pipeline')}</h2><p>{t('governance.description')}</p></div>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={15} />{t('governance.refresh')}</button>
      </div>

      <ol className="governance-pipeline" aria-label={t('governance.pipeline')}>
        {pipeline.map((item, index) => {
          const reached = selected ? stageOrder[selected.stage] >= index : false
          return <li className={reached ? 'is-reached' : ''} key={item.stage}><span>{index + 1}</span><strong>{t(item.label)}</strong></li>
        })}
      </ol>

      {error && <div className="data-warning" role="alert"><AlertTriangle size={16} />{error}</div>}
      <details className="governance-advanced panel">
        <summary>{t('governance.advancedTools')}</summary>
        <section className="governance-nominate">
          <header><GitPullRequest size={18} /><div><h3>{t('governance.nominateTitle')}</h3><p>{t('governance.nominateDescription')}</p></div></header>
          <div className="governance-form-grid">
            <label><span>{t('governance.sourceRef')}</span><input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="github:https://github.com/org/repo#path/SKILL.md" /></label>
            <label><span>{t('governance.targetSkeleton')}</span><input value={targetSkeleton} onChange={(event) => setTargetSkeleton(event.target.value)} placeholder=".codex/skills/review/SKILL.md" /></label>
            <label><span>{t('governance.projectId')}</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="project-a" /></label>
            <button className="button primary" type="button" disabled={busy || !sourceRef.trim() || !targetSkeleton.trim()} onClick={() => void nominate()}>{t('governance.nominate')}</button>
          </div>
        </section>
      </details>

      <div className="governance-grid">
        <section className="panel capability-list" aria-label={t('governance.capabilities')}>
          <header><h3>{t('governance.capabilities')}</h3><span>{capabilityPageState.totalItems}</span></header>
          {items.map((item) => <button className={item.id === selectedId ? 'is-selected' : ''} type="button" key={item.id} onClick={() => { setLinkedCapability(null); setSelectedId(item.id); setPreview(null) }}>
            <span><strong>{item.artifact.artifactId}</strong><small>{item.artifact.version}</small></span>
            <b className={`capability-stage stage-${item.stage}`}>{t(stageKeys[item.stage])}</b>
          </button>)}
          {!items.length && <p className="governance-empty" role="status">{t('governance.empty')}</p>}
          {capabilityPageState.totalPages > 1 && <nav className="runs-pagination-bar registry-pagination" aria-label={t('common.pageOf', { page: formatNumber(capabilityPageState.page), count: formatNumber(capabilityPageState.totalPages) })}>
            <div className="pagination-controls">
              <button type="button" aria-label={t('common.previousPage')} disabled={!capabilityPageState.hasPrevious} onClick={() => { setSelectedId(null); setLinkedCapability(null); setCapabilityPage((value) => Math.max(1, value - 1)) }}><ChevronLeft size={15} /></button>
              <span role="status" aria-live="polite">{t('common.pageOf', { page: formatNumber(capabilityPageState.page), count: formatNumber(capabilityPageState.totalPages) })}</span>
              <button type="button" aria-label={t('common.nextPage')} disabled={!capabilityPageState.hasNext} onClick={() => { setSelectedId(null); setLinkedCapability(null); setCapabilityPage((value) => Math.min(capabilityPageState.totalPages, value + 1)) }}><ChevronRight size={15} /></button>
            </div>
          </nav>}
        </section>

        <section className="panel capability-detail">
          {!selected ? <p className="governance-empty">{t('governance.selectCandidate')}</p> : <>
            <header><div><span>{t(kindKeys[selected.artifact.kind])}</span><h3>{selected.artifact.artifactId}</h3><p>{selected.artifact.sourceRef}</p></div><b className={`capability-stage stage-${selected.stage}`}>{t(stageKeys[selected.stage])}</b></header>
            <section className="release-comparison" role="region" aria-label={t('governance.releaseComparison')}>
              <header><GitCompareArrows size={16} /><h4>{t('governance.releaseComparison')}</h4></header>
              <div>
                <article><span>{t('common.current')}</span>{selected.baseline
                  ? <><strong>{selected.baseline.artifactId}</strong><b>{selected.baseline.version}</b><code title={selected.baseline.sourceRef}>{selected.baseline.sourceRef}</code><small title={selected.baseline.contentHash}>{shortHash(selected.baseline.contentHash)}</small></>
                  : <strong>{t('evaluations.notAvailable')}</strong>}</article>
                <article><span>{t('common.candidate')}</span><strong>{selected.artifact.artifactId}</strong><b>{selected.artifact.version}</b><code title={selected.artifact.sourceRef}>{selected.artifact.sourceRef}</code><small title={selected.artifact.contentHash}>{shortHash(selected.artifact.contentHash)}</small></article>
              </div>
            </section>
            <dl className="governance-metadata">
              <div><dt>{t('governance.owner')}</dt><dd>{selected.owner}</dd></div>
              <div><dt>{t('governance.targetSkeleton')}</dt><dd>{selected.targetSkeleton}</dd></div>
              <div><dt>{t('governance.currentChannel')}</dt><dd>{t(stageKeys[selected.stage])}</dd></div>
              <div><dt>{t('governance.previousStable')}</dt><dd>{previousStable ? `${previousStable.artifact.artifactId} · ${previousStable.artifact.version}` : t('evaluations.notAvailable')}</dd></div>
              <div><dt>{t('governance.approvalState')}</dt><dd>{latestApproval ? `${t(latestApproval.decision === 'approved' ? 'governance.stage.approved' : 'governance.approvalRejected')} · ${latestApproval.reviewer}` : t('governance.independentReviewRequired')}</dd></div>
              <div><dt>{t('governance.contentHash')}</dt><dd className="mono" title={selected.artifact.contentHash}>{shortHash(selected.artifact.contentHash)}</dd></div>
              <div><dt>{t('governance.policyHash')}</dt><dd className="mono" title={selected.evidence?.policyHash}>{shortHash(selected.evidence?.policyHash)}</dd></div>
              <div><dt>{t('governance.suiteHash')}</dt><dd className="mono" title={selected.evidence?.suiteHash}>{shortHash(selected.evidence?.suiteHash)}</dd></div>
              <div><dt>{t('governance.evidenceHash')}</dt><dd className="mono" title={selected.evidence?.evidenceHash}>{shortHash(selected.evidence?.evidenceHash)}</dd></div>
            </dl>
            <div className={`evidence-state ${selected.evidenceStale ? 'is-stale' : ''}`}>
              {selected.evidenceStale ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
              <div><strong>{t(selected.evidenceStale ? 'governance.evidenceStale' : selected.evidence ? 'governance.evidenceFresh' : 'governance.evidenceMissing')}</strong>{selected.evidence && <span>{t('governance.boundAt', { time: formatDateTime(selected.evidence.boundAt) })}</span>}</div>
            </div>
            {evidenceRun && <section className="release-evidence-summary" aria-label={t('governance.evidenceAndGates')}>
              <h4>{t('governance.evidenceAndGates')}</h4>
              <dl>
                <div><dt>{t('governance.sample')}</dt><dd>{t('governance.evaluatedCases', { count: evidenceRun.metrics?.casesTotal ?? 0 })}</dd></div>
                <div><dt>{t('governance.gateResult')}</dt><dd>{t(evidenceRun.gateResult === 'passed' ? 'evaluations.gate.passed' : evidenceRun.gateResult === 'failed' ? 'evaluations.gate.failed' : 'evaluations.gate.notAvailable')}</dd></div>
                <div><dt>{t('governance.evidenceFreshness')}</dt><dd>{t(evidenceRun.evidenceFresh === true ? 'governance.evidenceFresh' : evidenceRun.evidenceFresh === false ? 'governance.evidenceStale' : 'evaluations.notAvailable')}</dd></div>
              </dl>
              {(evidenceRun.gates || []).length > 0 && <ul>{evidenceRun.gates.map((gate) => <li key={gate.id}><strong>{gate.id}</strong><span>{t(gate.status === 'passed' ? 'evaluations.gate.passed' : gate.status === 'failed' ? 'evaluations.gate.failed' : 'evaluations.gate.notAvailable')}</span></li>)}</ul>}
            </section>}

            {(['candidate', 'evaluating', 'blocked'].includes(selected.stage) || (selected.evidenceStale && ['ready', 'canary', 'deprecated', 'superseded'].includes(selected.stage))) && <details className="governance-advanced-action">
              <summary>{t('governance.advancedEvidence')}</summary>
              <div className="governance-action">
                <h4>{t('governance.bindEvidence')}</h4>
                <label><span>{t('governance.managedRunId')}</span><input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
                <label><span>{t('governance.redteamRunId')}</span><input value={redteamRunId} onChange={(event) => setRedteamRunId(event.target.value)} /></label>
                <button className="button primary" type="button" disabled={busy || !runId.trim()} onClick={() => void bindEvidence()}>{t('governance.evaluate')}</button>
              </div>
            </details>}

            {selected.stage === 'ready' && !selected.evidenceStale && <div className="governance-action">
              <h4>{t('governance.approve')}</h4>
              <div className="identity-warning"><ShieldCheck size={17} /><span>{t('governance.localIdentityWarning')}</span></div>
              <label><span>{t('governance.reviewerToken')}</span><input type="password" autoComplete="off" spellCheck={false} value={reviewerToken} onChange={(event) => setReviewerToken(event.target.value)} /></label>
              <button className="button primary" type="button" disabled={busy || !reviewerToken.trim()} onClick={() => void approve()}>{t('governance.approve')}</button>
            </div>}

            {selected.stage === 'approved' && !selected.requalifiesStage && <div className="governance-action"><h4>{t('governance.startCanary')}</h4><label><span>{t('governance.canaryProjectRoot')}</span><input value={canaryProjectRoot} onChange={(event) => setCanaryProjectRoot(event.target.value)} placeholder="/absolute/path/to/canary-project" /></label><label><span>{t('governance.canaryTarget')}</span><input value={canaryTarget} onChange={(event) => setCanaryTarget(event.target.value)} placeholder=".codex/skills/review/SKILL.md" /></label><button className="button primary" type="button" disabled={busy || !canaryProjectRoot.trim() || !canaryTarget.trim()} onClick={() => void requestPreview('canary')}>{t('governance.previewCanary')}</button></div>}
            {selected.stage === 'approved' && selected.requalifiesStage === 'deprecated' && <div className="governance-action"><h4>{t('governance.restoreStable')}</h4><button className="button primary" type="button" disabled={busy} onClick={() => void requestPreview('rollback')}>{t('governance.previewRestore')}</button></div>}
            {selected.stage === 'approved' && selected.requalifiesStage === 'superseded' && <div className="governance-action"><h4>{t('governance.monitorRollback')}</h4><button className="button danger" type="button" disabled={busy || !rollbackStableId} onClick={() => void requestPreview('rollback', rollbackStableId)}>{t('governance.previewRollback')}</button></div>}
            {selected.stage === 'canary' && !selected.evidenceStale && <div className="governance-action"><h4>{t('governance.promoteStable')}</h4><button className="button primary" type="button" disabled={busy} onClick={() => void requestPreview('install')}>{t('governance.previewInstall')}</button><button className="button primary" type="button" disabled={busy} onClick={() => void requestPreview('promote')}>{t('governance.previewPromotion')}</button></div>}
            {selected.stage === 'stable' && <div className="governance-action"><h4>{t('governance.monitorRollback')}</h4><button className="button danger" type="button" disabled={busy} onClick={() => void requestPreview('deprecate')}>{t('governance.previewDeprecation')}</button><button className="button danger" type="button" disabled={busy} onClick={() => void requestPreview('rollback')}>{t('governance.previewRollback')}</button></div>}
            {selected.stage === 'deprecated' && !selected.evidenceStale && <div className="governance-action"><h4>{t('governance.restoreStable')}</h4><button className="button primary" type="button" disabled={busy} onClick={() => void requestPreview('rollback')}>{t('governance.previewRestore')}</button></div>}

            <section className="release-audit" role="region" aria-label={t('governance.auditTimeline')}>
              <header><History size={16} /><h4>{t('governance.auditTimeline')}</h4></header>
              {auditStatus === 'loaded' && auditSourceStatus === 'partial' && <div className="data-warning" role="alert">{t('cc.partial')}</div>}
              {auditStatus === 'loaded' ? audit.length ? <ol>{audit.map((entry) => <li key={entry.id}>
                <strong>{auditActionKeys[entry.action] ? t(auditActionKeys[entry.action]) : entry.action}</strong>
                <span>{entry.fromStage ? `${t(stageKeys[entry.fromStage])} → ${t(stageKeys[entry.toStage])}` : t(stageKeys[entry.toStage])}</span>
                <small>{entry.actor} · {formatDateTime(entry.at)} · {t(entry.outcome === 'committed' ? 'governance.auditCommitted' : entry.outcome === 'failed' ? 'governance.auditFailed' : 'governance.auditPending')}</small>
              </li>)}</ol> : <p>{t('governance.noAudit')}</p> : <div className="governance-audit-access">
                <p role={auditStatus === 'error' ? 'alert' : 'status'}>{t(auditStatus === 'error' ? 'governance.auditUnavailable' : 'governance.auditLocked')}</p>
                <label><span>{t('governance.auditToken')}</span><input type="password" autoComplete="off" spellCheck={false} value={auditToken} onChange={(event) => setAuditToken(event.target.value)} /></label>
                <button className="button secondary" type="button" disabled={auditStatus === 'loading' || !auditToken.trim()} onClick={() => void loadAudit()}>{t(auditStatus === 'loading' ? 'common.checking' : 'governance.loadAudit')}</button>
              </div>}
              {auditStatus === 'loaded' && auditPageState.totalPages > 1 && <nav className="runs-pagination-bar registry-pagination" aria-label={t('common.pageOf', { page: formatNumber(auditPageState.page), count: formatNumber(auditPageState.totalPages) })}>
                <div className="pagination-controls">
                  <button type="button" aria-label={t('common.previousPage')} disabled={!auditPageState.hasPrevious} onClick={() => void loadAudit(Math.max(1, auditPageState.page - 1))}><ChevronLeft size={15} /></button>
                  <span role="status" aria-live="polite">{t('common.pageOf', { page: formatNumber(auditPageState.page), count: formatNumber(auditPageState.totalPages) })}</span>
                  <button type="button" aria-label={t('common.nextPage')} disabled={!auditPageState.hasNext} onClick={() => void loadAudit(Math.min(auditPageState.totalPages, auditPageState.page + 1))}><ChevronRight size={15} /></button>
                </div>
              </nav>}
            </section>
            {preview && <div className="governance-preview" role="region" aria-label={t('governance.changePreview')}>
              <h4>{t('governance.changePreview')}</h4>
              <dl>
                <div><dt>{t('governance.sourceRef')}</dt><dd title={preview.value.source}>{preview.value.source}</dd></div>
                <div><dt>{t('governance.targetSkeleton')}</dt><dd title={preview.value.target}>{preview.value.target}</dd></div>
                {preview.value.projectRoot && <div><dt>{t('governance.canaryProjectRoot')}</dt><dd title={preview.value.projectRoot}>{preview.value.projectRoot}</dd></div>}
                <div><dt>{t('governance.currentHash')}</dt><dd title={preview.value.currentHash || undefined}>{shortHash(preview.value.currentHash)}</dd></div>
                <div><dt>{t('governance.candidateHash')}</dt><dd title={preview.value.candidateHash}>{shortHash(preview.value.candidateHash)}</dd></div>
                <div><dt>{t('governance.beforeLines')}</dt><dd>{preview.value.diff.beforeLines}</dd></div>
                <div><dt>{t('governance.afterLines')}</dt><dd>{preview.value.diff.afterLines}</dd></div>
                <div><dt>{t('governance.changedLines')}</dt><dd>{preview.value.diff.changedLines}</dd></div>
                <div><dt>{t('governance.backup')}</dt><dd>{preview.value.backup}</dd></div>
                <div><dt>{t('governance.conflict')}</dt><dd>{t(preview.value.conflict ? 'governance.yes' : 'governance.no')}</dd></div>
              </dl>
              <p>{preview.value.rollbackPlan}</p>
              <label className="governance-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t(releaseLabels[preview.kind].confirm)}</span></label>
              <button className={releaseLabels[preview.kind].danger ? 'button danger' : 'button primary'} type="button" disabled={busy || !confirmed} onClick={() => void applyPreview()}>{t(releaseLabels[preview.kind].apply)}</button>
            </div>}
          </>}
        </section>
      </div>
    </div>
  )
}
