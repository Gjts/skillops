import { AlertTriangle, CheckCircle2, GitPullRequest, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import type { Capability, CapabilityStage, SkeletonChangePreview } from '../types'

const pipeline: Array<{ stage: CapabilityStage | 'monitor'; label: MessageKey }> = [
  { stage: 'candidate', label: 'governance.pipelineCandidate' },
  { stage: 'evaluating', label: 'governance.pipelineEvaluate' },
  { stage: 'ready', label: 'governance.pipelineApprove' },
  { stage: 'canary', label: 'governance.pipelineCanary' },
  { stage: 'stable', label: 'governance.pipelineStable' },
  { stage: 'monitor', label: 'governance.pipelineMonitor' },
]

const stageOrder: Record<CapabilityStage, number> = {
  candidate: 0,
  evaluating: 1,
  blocked: 1,
  ready: 2,
  approved: 3,
  canary: 3,
  stable: 5,
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
  superseded: 'governance.stage.superseded',
  'rolled-back': 'governance.stage.rolledBack',
}

const kindKeys = {
  skill: 'governance.kind.skill',
  prompt: 'governance.kind.prompt',
  workflow: 'governance.kind.workflow',
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
  const { formatDateTime, t } = useI18n()
  const [items, setItems] = useState<Capability[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceRef, setSourceRef] = useState('')
  const [targetSkeleton, setTargetSkeleton] = useState('')
  const [owner, setOwner] = useState('local-owner')
  const [runId, setRunId] = useState('')
  const [redteamRunId, setRedteamRunId] = useState('')
  const [reviewer, setReviewer] = useState('local-reviewer')
  const [approvalNote, setApprovalNote] = useState('')
  const [preview, setPreview] = useState<{ kind: 'promote' | 'rollback'; value: SkeletonChangePreview } | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api<{ items: Capability[] }>('/api/capabilities')
      setItems(result.items)
      setSelectedId((current) => current && result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('governance.requestFailed'))
    }
  }, [t])

  useEffect(() => { void load() }, [load])
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId])

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

  function post<T = unknown>(path: string, body: object) {
    return api<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const nominate = () => mutate(() => post('/api/capabilities', {
    sourceRef: sourceRef.trim(),
    targetSkeleton: targetSkeleton.trim() || undefined,
    owner: owner.trim(),
  }))
  const bindEvidence = () => selected && mutate(() => post(`/api/capabilities/${encodeURIComponent(selected.id)}/evaluate`, {
    runId: runId.trim(),
    redteamRunId: redteamRunId.trim() || undefined,
  }))
  const approve = () => selected && mutate(() => post(`/api/capabilities/${encodeURIComponent(selected.id)}/approve`, {
    reviewer: reviewer.trim(),
    decision: 'approved',
    note: approvalNote.trim() || undefined,
  }))
  const canary = () => selected && mutate(() => post(`/api/capabilities/${encodeURIComponent(selected.id)}/canary`, {}))
  const requestPreview = async (kind: 'promote' | 'rollback') => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const value = await post<SkeletonChangePreview>(`/api/capabilities/${encodeURIComponent(selected.id)}/${kind}`, { action: 'preview' })
      setPreview({ kind, value })
      setConfirmed(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('governance.requestFailed'))
    } finally { setBusy(false) }
  }
  const applyPreview = () => selected && preview && mutate(() => post(`/api/capabilities/${encodeURIComponent(selected.id)}/${preview.kind}`, {
    action: 'apply', previewToken: preview.value.previewToken, confirm: true,
  }))

  return (
    <div className="single-page governance-page">
      <div className="page-intro">
        <div><h2>{t('governance.title')}</h2><p>{t('governance.description')}</p></div>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={15} />{t('governance.refresh')}</button>
      </div>

      <ol className="governance-pipeline" aria-label={t('governance.pipeline')}>
        {pipeline.map((item, index) => {
          const reached = selected ? stageOrder[selected.stage] >= index : false
          return <li className={reached ? 'is-reached' : ''} key={item.stage}><span>{index + 1}</span><strong>{t(item.label)}</strong></li>
        })}
      </ol>

      {error && <div className="data-warning" role="alert"><AlertTriangle size={16} />{error}</div>}
      <section className="governance-nominate panel">
        <header><GitPullRequest size={18} /><div><h3>{t('governance.nominateTitle')}</h3><p>{t('governance.nominateDescription')}</p></div></header>
        <div className="governance-form-grid">
          <label><span>{t('governance.sourceRef')}</span><input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="github:https://github.com/org/repo#path/SKILL.md" /></label>
          <label><span>{t('governance.targetSkeleton')}</span><input value={targetSkeleton} onChange={(event) => setTargetSkeleton(event.target.value)} placeholder="local-scan:codex:…" /></label>
          <label><span>{t('governance.owner')}</span><input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <button className="button primary" type="button" disabled={busy || !sourceRef.trim() || !owner.trim()} onClick={() => void nominate()}>{t('governance.nominate')}</button>
        </div>
      </section>

      <div className="governance-grid">
        <section className="panel capability-list" aria-label={t('governance.capabilities')}>
          <header><h3>{t('governance.capabilities')}</h3><span>{items.length}</span></header>
          {items.map((item) => <button className={item.id === selectedId ? 'is-selected' : ''} type="button" key={item.id} onClick={() => { setSelectedId(item.id); setPreview(null) }}>
            <span><strong>{item.artifact.artifactId}</strong><small>{item.artifact.version}</small></span>
            <b className={`capability-stage stage-${item.stage}`}>{t(stageKeys[item.stage])}</b>
          </button>)}
          {!items.length && <p className="governance-empty">{t('governance.empty')}</p>}
        </section>

        <section className="panel capability-detail">
          {!selected ? <p className="governance-empty">{t('governance.selectCandidate')}</p> : <>
            <header><div><span>{t(kindKeys[selected.artifact.kind])}</span><h3>{selected.artifact.artifactId}</h3><p>{selected.artifact.sourceRef}</p></div><b className={`capability-stage stage-${selected.stage}`}>{t(stageKeys[selected.stage])}</b></header>
            <dl className="governance-metadata">
              <div><dt>{t('governance.owner')}</dt><dd>{selected.owner}</dd></div>
              <div><dt>{t('governance.targetSkeleton')}</dt><dd>{selected.targetSkeleton}</dd></div>
              <div><dt>{t('governance.contentHash')}</dt><dd className="mono" title={selected.artifact.contentHash}>{shortHash(selected.artifact.contentHash)}</dd></div>
              <div><dt>{t('governance.policyHash')}</dt><dd className="mono" title={selected.evidence?.policyHash}>{shortHash(selected.evidence?.policyHash)}</dd></div>
              <div><dt>{t('governance.suiteHash')}</dt><dd className="mono" title={selected.evidence?.suiteHash}>{shortHash(selected.evidence?.suiteHash)}</dd></div>
              <div><dt>{t('governance.evidenceHash')}</dt><dd className="mono" title={selected.evidence?.evidenceHash}>{shortHash(selected.evidence?.evidenceHash)}</dd></div>
            </dl>
            <div className={`evidence-state ${selected.evidenceStale ? 'is-stale' : ''}`}>
              {selected.evidenceStale ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
              <div><strong>{t(selected.evidenceStale ? 'governance.evidenceStale' : selected.evidence ? 'governance.evidenceFresh' : 'governance.evidenceMissing')}</strong>{selected.evidence && <span>{t('governance.boundAt', { time: formatDateTime(selected.evidence.boundAt) })}</span>}</div>
            </div>

            {['candidate', 'evaluating', 'blocked'].includes(selected.stage) && <div className="governance-action">
              <h4>{t('governance.bindEvidence')}</h4>
              <label><span>{t('governance.managedRunId')}</span><input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
              <label><span>{t('governance.redteamRunId')}</span><input value={redteamRunId} onChange={(event) => setRedteamRunId(event.target.value)} /></label>
              <button className="button primary" type="button" disabled={busy || !runId.trim()} onClick={() => void bindEvidence()}>{t('governance.evaluate')}</button>
            </div>}

            {selected.stage === 'ready' && <div className="governance-action">
              <h4>{t('governance.approve')}</h4>
              <div className="identity-warning"><ShieldCheck size={17} /><span>{t('governance.localIdentityWarning')}</span></div>
              <label><span>{t('governance.reviewer')}</span><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} /></label>
              <label><span>{t('governance.approvalNote')}</span><input value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label>
              <button className="button primary" type="button" disabled={busy || !reviewer.trim()} onClick={() => void approve()}>{t('governance.approve')}</button>
            </div>}

            {selected.stage === 'approved' && <div className="governance-action"><h4>{t('governance.startCanary')}</h4><button className="button primary" type="button" disabled={busy} onClick={() => void canary()}>{t('governance.startCanary')}</button></div>}
            {selected.stage === 'canary' && <div className="governance-action"><h4>{t('governance.promoteStable')}</h4><button className="button primary" type="button" disabled={busy} onClick={() => void requestPreview('promote')}>{t('governance.previewPromotion')}</button></div>}
            {selected.stage === 'stable' && <div className="governance-action"><h4>{t('governance.monitorRollback')}</h4><button className="button danger" type="button" disabled={busy} onClick={() => void requestPreview('rollback')}>{t('governance.previewRollback')}</button></div>}

            {preview && <div className="governance-preview" role="region" aria-label={t('governance.changePreview')}>
              <h4>{t('governance.changePreview')}</h4>
              <dl>
                <div><dt>{t('governance.sourceRef')}</dt><dd title={preview.value.source}>{preview.value.source}</dd></div>
                <div><dt>{t('governance.targetSkeleton')}</dt><dd title={preview.value.target}>{preview.value.target}</dd></div>
                <div><dt>{t('governance.currentHash')}</dt><dd title={preview.value.currentHash || undefined}>{shortHash(preview.value.currentHash)}</dd></div>
                <div><dt>{t('governance.candidateHash')}</dt><dd title={preview.value.candidateHash}>{shortHash(preview.value.candidateHash)}</dd></div>
                <div><dt>{t('governance.beforeLines')}</dt><dd>{preview.value.diff.beforeLines}</dd></div>
                <div><dt>{t('governance.afterLines')}</dt><dd>{preview.value.diff.afterLines}</dd></div>
                <div><dt>{t('governance.changedLines')}</dt><dd>{preview.value.diff.changedLines}</dd></div>
                <div><dt>{t('governance.backup')}</dt><dd>{preview.value.backup}</dd></div>
                <div><dt>{t('governance.conflict')}</dt><dd>{t(preview.value.conflict ? 'governance.yes' : 'governance.no')}</dd></div>
              </dl>
              <p>{preview.value.rollbackPlan}</p>
              <label className="governance-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t(preview.kind === 'promote' ? 'governance.confirmStable' : 'governance.confirmRollback')}</span></label>
              <button className={preview.kind === 'rollback' ? 'button danger' : 'button primary'} type="button" disabled={busy || !confirmed} onClick={() => void applyPreview()}>{t(preview.kind === 'promote' ? 'governance.applyStable' : 'governance.applyRollback')}</button>
            </div>}
          </>}
        </section>
      </div>
    </div>
  )
}
