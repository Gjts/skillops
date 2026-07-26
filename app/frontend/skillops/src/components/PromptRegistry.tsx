import { CheckCircle2, ChevronLeft, ChevronRight, GitBranch, GitCompareArrows, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'

type RegistryStatus = {
  available: boolean
  workspace: string
  promptDirectory: string
  currentBranch: string
  commit: string
  branches: string[]
  branchesPage: {
    page: number
    pageSize: number
    totalItems: number
    totalPages: number
    hasPrevious: boolean
    hasNext: boolean
  }
  persistence: 'git-source-only'
}

type PromptRecord = {
  artifact: { artifactId: string; sourceRef: string; contentHash: string; version: string }
  id: string
  name: string
  description?: string
  relativePath: string
  commit: string
  provider: string
  model: string
  variables: string[]
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json() as T & { error?: string | { message?: string } }
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    throw new Error(message || `Prompt Registry request failed (${response.status}).`)
  }
  return body
}

function post<T>(url: string, body: object) {
  return request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export function PromptRegistryBrowser({ baselineRef, candidateRef, onBaseline, onCandidate, onModelHint }: {
  baselineRef: string
  candidateRef: string
  onBaseline: (sourceRef: string) => void
  onCandidate: (sourceRef: string) => void
  onModelHint?: (hint: { provider: string; model: string }) => void
}) {
  const { formatNumber, t } = useI18n()
  const [status, setStatus] = useState<RegistryStatus | null>(null)
  const [revision, setRevision] = useState('HEAD')
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [items, setItems] = useState<PromptRecord[]>([])
  const [warningCount, setWarningCount] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [targetSkeleton, setTargetSkeleton] = useState('')
  const [projectId, setProjectId] = useState('')
  const [comparison, setComparison] = useState<{ changed: boolean; changedFields: string[] } | null>(null)
  const [nomination, setNomination] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPrompts = useCallback(async (selectedRevision = revision, selectedPage = page) => {
    setBusy(true)
    setError(null)
    try {
      const result = await post<{ items: PromptRecord[]; warningCount: number; page: number; totalPages: number }>('/api/prompt-registry/prompts', {
        revision: selectedRevision, search: search.trim() || undefined, provider: provider.trim() || undefined, model: model.trim() || undefined,
        page: selectedPage, pageSize: 50,
      })
      setItems(result.items)
      setWarningCount(result.warningCount)
      setPage(result.page)
      setTotalPages(result.totalPages)
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('promptRegistry.failed')) } finally { setBusy(false) }
  }, [model, page, provider, revision, search, t])

  const loadBranchPage = async (selectedPage: number) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await request<RegistryStatus>(`/api/prompt-registry/status?page=${selectedPage}&pageSize=50`))
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('promptRegistry.failed')) } finally { setBusy(false) }
  }

  useEffect(() => {
    let live = true
    request<RegistryStatus>('/api/prompt-registry/status?page=1&pageSize=50').then((next) => {
      if (!live) return
      setStatus(next)
      setRevision(next.currentBranch)
      return loadPrompts(next.currentBranch, 1)
    }).catch((caught) => { if (live) setError(caught instanceof Error ? caught.message : t('promptRegistry.failed')) })
    return () => { live = false }
  }, []) // The initial snapshot intentionally uses the branch returned by status.

  const selectedCandidate = useMemo(() => items.find((item) => item.artifact.sourceRef === candidateRef) || null, [candidateRef, items])

  const compare = async () => {
    if (!baselineRef.startsWith('prompt-registry:') || !candidateRef.startsWith('prompt-registry:')) return
    setBusy(true); setError(null)
    try { setComparison(await post('/api/prompt-registry/compare', { leftRef: baselineRef, rightRef: candidateRef })) }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('promptRegistry.failed')) } finally { setBusy(false) }
  }

  const nominate = async () => {
    if (!candidateRef.startsWith('prompt-registry:')) return
    setBusy(true); setError(null)
    try {
      const result = await post<{ capability: { id: string } }>('/api/prompt-registry/nominate', {
        sourceRef: candidateRef,
        targetSkeleton: targetSkeleton.trim(),
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
      })
      setNomination(result.capability.id)
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('promptRegistry.failed')) } finally { setBusy(false) }
  }

  return <section className="panel prompt-registry" aria-labelledby="prompt-registry-title">
    <header className="panel-header"><div><h2 id="prompt-registry-title">{t('promptRegistry.title')}</h2><span>{t('promptRegistry.description')}</span></div><GitBranch size={18} /></header>
    {status && <div className="prompt-registry-status"><span><strong>{status.workspace}</strong><small>{status.promptDirectory}</small></span><code>{status.commit.slice(0, 12)}</code><b>{status.currentBranch}</b></div>}
    <div className="prompt-registry-filters">
      <label><span>{t('promptRegistry.branch')}</span><input list="prompt-registry-revisions" value={revision} onChange={(event) => setRevision(event.target.value)} /><datalist id="prompt-registry-revisions">{(status?.branches || ['HEAD']).map((branch) => <option value={branch} key={branch} />)}</datalist></label>
      <label><span>{t('promptRegistry.search')}</span><input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label><span>{t('common.provider')}</span><input value={provider} onChange={(event) => setProvider(event.target.value)} /></label>
      <label><span>{t('common.model')}</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <button className="button secondary" type="button" disabled={busy} onClick={() => void loadPrompts(revision, 1)}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t('promptRegistry.load')}</button>
    </div>
    {status && status.branchesPage.totalPages > 1 && <nav className="runs-pagination-bar registry-pagination" aria-label={t('promptRegistry.branch')}>
      <div className="pagination-controls">
        <button type="button" aria-label={t('common.previousPage')} disabled={busy || !status.branchesPage.hasPrevious} onClick={() => void loadBranchPage(status.branchesPage.page - 1)}><ChevronLeft size={15} /></button>
        <span role="status">{t('common.pageOf', { page: formatNumber(status.branchesPage.page), count: formatNumber(status.branchesPage.totalPages) })}</span>
        <button type="button" aria-label={t('common.nextPage')} disabled={busy || !status.branchesPage.hasNext} onClick={() => void loadBranchPage(status.branchesPage.page + 1)}><ChevronRight size={15} /></button>
      </div>
    </nav>}
    {error && <div className="evaluation-error" role="alert">{error}</div>}
    <div className="prompt-registry-list">
      {items.map((item) => <article key={item.artifact.sourceRef} className={item.artifact.sourceRef === candidateRef ? 'is-selected' : ''}>
        <div><strong>{item.name}</strong><small>{item.description || item.relativePath}</small><code>{item.commit.slice(0, 12)} · {item.artifact.contentHash.slice(0, 12)}</code></div>
        <span><b>{item.provider || '—'}</b><small>{item.model || '—'}</small><small>{item.variables.join(', ') || t('promptRegistry.noVariables')}</small></span>
        <div className="prompt-registry-actions">
          <button className="button secondary" type="button" onClick={() => onBaseline(item.artifact.sourceRef)}>{t('promptRegistry.useBaseline')}</button>
          <button className="button primary" type="button" onClick={() => onCandidate(item.artifact.sourceRef)}>{t('promptRegistry.useCandidate')}</button>
          {onModelHint && item.provider && item.model && <button className="button secondary" type="button" onClick={() => onModelHint({ provider: item.provider, model: item.model })}>{t('promptRegistry.useModel')}</button>}
        </div>
      </article>)}
      {!items.length && <p>{t('promptRegistry.empty')}</p>}
    </div>
    {totalPages > 1 && <nav className="runs-pagination-bar registry-pagination" aria-label={t('common.pageOf', { page: formatNumber(page), count: formatNumber(totalPages) })}>
      <div className="pagination-controls">
        <button type="button" aria-label={t('common.previousPage')} disabled={busy || page === 1} onClick={() => void loadPrompts(revision, page - 1)}><ChevronLeft size={15} /></button>
        <span role="status">{t('common.pageOf', { page: formatNumber(page), count: formatNumber(totalPages) })}</span>
        <button type="button" aria-label={t('common.nextPage')} disabled={busy || page === totalPages} onClick={() => void loadPrompts(revision, page + 1)}><ChevronRight size={15} /></button>
      </div>
    </nav>}
    {warningCount > 0 && <div className="data-warning" role="status">{t('promptRegistry.invalidFiles', { count: warningCount })}</div>}
    <div className="prompt-registry-workflow">
      <button className="button secondary" type="button" disabled={busy || !baselineRef.startsWith('prompt-registry:') || !candidateRef.startsWith('prompt-registry:')} onClick={() => void compare()}><GitCompareArrows size={14} />{t('promptRegistry.compare')}</button>
      {comparison && <p role="status">{comparison.changed ? t('promptRegistry.changedFields', { fields: comparison.changedFields.join(', ') }) : t('promptRegistry.unchanged')}</p>}
      <label><span>{t('governance.targetSkeleton')}</span><input value={targetSkeleton} onChange={(event) => setTargetSkeleton(event.target.value)} placeholder={selectedCandidate ? `prompt:${selectedCandidate.id}` : t('promptRegistry.defaultTarget')} /></label>
      <label><span>{t('governance.projectId')}</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="project-a" /></label>
      <button className="button primary" type="button" disabled={busy || !candidateRef.startsWith('prompt-registry:') || !targetSkeleton.trim()} onClick={() => void nominate()}><CheckCircle2 size={14} />{t('promptRegistry.nominate')}</button>
    </div>
    {nomination && <p className="prompt-registry-nomination" role="status">{t('promptRegistry.nominated')} <code>{nomination}</code></p>}
    <p className="result-boundary"><ShieldCheck size={13} />{t('promptRegistry.privacy')}</p>
  </section>
}
