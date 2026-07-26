import { Archive, ChevronLeft, ChevronRight, RefreshCw, ShieldCheck, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'

const TEAM_PAGE_SIZE = 20

type TeamState = {
  revision: number
  team: { id: string; name: string } | null
  counts: { workspaces: number; projects: number; environments: number; activeMembers: number; activeDevices: number; policyPacks: number; exceptions: number }
  lastCollectorAt: string | null
  capabilities: { deployment: string; networkApi: boolean; sso: boolean; scim: boolean }
  templateAdoption: { totalProjects: number; adoptedProjects: number; currentProjects: number; driftedProjects: number; pendingUpgradeProjects: number; adoptionRatePct: number }
}

type CatalogItem = {
  artifactVersionId: string
  artifactId: string
  version: string
  contentHash: string
  source: string
  lifecycleStatus: string
  owner: string | null
  usedByProjectIds: string[]
  evidenceHash: string | null
}

type ApprovalItem = { capabilityId: string; artifactId: string; owner: string; evidenceHash: string | null }
type ReleaseItem = { capabilityId: string; artifactId: string; stage: string; targetSkeleton: string }

type PageEnvelope<T> = {
  items: T[]
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasPrevious: boolean
  hasNext: boolean
  revision: number
}

function emptyPage<T>(): PageEnvelope<T> {
  return { items: [], page: 1, pageSize: TEAM_PAGE_SIZE, totalItems: 0, totalPages: 0, hasPrevious: false, hasNext: false, revision: 0 }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json() as T & { error?: string | { message?: string } }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || `HTTP ${response.status}`)
  return body
}

export function TeamPage() {
  const { formatDateTime, formatNumber, t } = useI18n()
  const [state, setState] = useState<TeamState | null>(null)
  const [catalog, setCatalog] = useState<PageEnvelope<CatalogItem>>(emptyPage)
  const [approvals, setApprovals] = useState<PageEnvelope<ApprovalItem>>(emptyPage)
  const [releases, setReleases] = useState<PageEnvelope<ReleaseItem>>(emptyPage)
  const [catalogPage, setCatalogPage] = useState(1)
  const [approvalPage, setApprovalPage] = useState(1)
  const [releasePage, setReleasePage] = useState(1)
  const [teamId, setTeamId] = useState('local-team')
  const [teamName, setTeamName] = useState('Local Team')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await json<TeamState>('/api/team')
      setState(next)
      if (next.team) {
        const [catalogResult, approvalResult, releaseResult] = await Promise.all([
          json<PageEnvelope<CatalogItem>>(`/api/team/catalog?page=${catalogPage}&pageSize=${TEAM_PAGE_SIZE}`),
          json<PageEnvelope<ApprovalItem>>(`/api/team/queues?kind=approval&page=${approvalPage}&pageSize=${TEAM_PAGE_SIZE}`),
          json<PageEnvelope<ReleaseItem>>(`/api/team/queues?kind=release&page=${releasePage}&pageSize=${TEAM_PAGE_SIZE}`),
        ])
        setCatalog(catalogResult)
        setApprovals(approvalResult)
        setReleases(releaseResult)
        if (catalogResult.page > Math.max(1, catalogResult.totalPages)) setCatalogPage(Math.max(1, catalogResult.totalPages))
        if (approvalResult.page > Math.max(1, approvalResult.totalPages)) setApprovalPage(Math.max(1, approvalResult.totalPages))
        if (releaseResult.page > Math.max(1, releaseResult.totalPages)) setReleasePage(Math.max(1, releaseResult.totalPages))
      } else {
        setCatalog(emptyPage())
        setApprovals(emptyPage())
        setReleases(emptyPage())
        setCatalogPage(1)
        setApprovalPage(1)
        setReleasePage(1)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('team.loadFailed'))
    } finally { setBusy(false) }
  }, [approvalPage, catalogPage, releasePage, t])

  useEffect(() => { void load() }, [load])

  const createTeam = async () => {
    setBusy(true)
    setError(null)
    try {
      await json('/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: teamId, name: teamName }) })
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('team.createFailed'))
      setBusy(false)
    }
  }

  const backup = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await json<{ file: string }>('/api/team/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      setStatus(t('team.backupCreated', { file: result.file }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('team.backupFailed'))
    } finally { setBusy(false) }
  }

  if (busy && !state) return <div className="single-page team-page"><section className="panel governance-empty">{t('team.loading')}</section></div>

  if (!state?.team) return (
    <div className="single-page team-page">
      <div className="page-intro"><div><h2>{t('team.setupTitle')}</h2><p>{t('team.setupDescription')}</p></div></div>
      {error && <div className="data-warning" role="alert">{error}</div>}
      <section className="panel governance-nominate">
        <header><Users size={18} /><div><h3>{t('team.createTitle')}</h3><p>{t('team.localOnly')}</p></div></header>
        <div className="governance-form-grid">
          <label>{t('team.id')}<input value={teamId} onChange={(event) => setTeamId(event.target.value)} /></label>
          <label>{t('team.name')}<input value={teamName} onChange={(event) => setTeamName(event.target.value)} /></label>
          <button className="button primary" type="button" disabled={busy || !teamId.trim() || !teamName.trim()} onClick={() => void createTeam()}>{t('team.create')}</button>
        </div>
      </section>
    </div>
  )

  return (
    <div className="single-page team-page">
      <div className="page-intro">
        <div><h2>{state.team.name}</h2><p>{t('team.description', { id: state.team.id, revision: formatNumber(state.revision) })}</p></div>
        <div className="team-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => void load()}><RefreshCw size={15} />{t('team.refresh')}</button><button className="button secondary" type="button" disabled={busy} onClick={() => void backup()}><Archive size={15} />{t('team.backup')}</button></div>
      </div>
      {error && <div className="data-warning" role="alert">{error}</div>}
      {status && <div className="import-status" role="status">{status}</div>}

      <section className="registry-summary" aria-label={t('team.summary')}>
        <article className="registry-metric"><span>{t('team.assets')}</span><strong>{formatNumber(catalog.totalItems)}</strong><p>{t('team.assetsHint')}</p></article>
        <article className="registry-metric"><span>{t('team.members')}</span><strong>{formatNumber(state.counts.activeMembers)}</strong><p>{t('team.rolesHint')}</p></article>
        <article className="registry-metric"><span>{t('team.approvals')}</span><strong>{formatNumber(approvals.totalItems)}</strong><p>{t('team.approvalsHint')}</p></article>
        <article className="registry-metric"><span>{t('team.releases')}</span><strong>{formatNumber(releases.totalItems)}</strong><p>{t('team.releasesHint')}</p></article>
      </section>

      <section className="panel registry-table-wrap">
        <header className="registry-table-heading"><div><span>{t('team.catalog')}</span><h3>{t('team.assetDirectory')}</h3></div><strong>{t('team.localGit')}</strong></header>
        <div className="registry-table-scroll"><table className="registry-table team-table">
          <caption className="sr-only">{t('team.assetDirectory')}</caption>
          <thead><tr><th>{t('team.artifact')}</th><th>{t('common.version')}</th><th>{t('common.source')}</th><th>{t('common.status')}</th><th>{t('team.owner')}</th><th>{t('team.usedBy')}</th><th>{t('team.evidence')}</th></tr></thead><tbody>
          {catalog.items.map((item) => <tr key={item.artifactVersionId}><td><strong>{item.artifactId}</strong></td><td><span className="version">{item.version}</span></td><td>{item.source}</td><td><span className={`capability-stage stage-${item.lifecycleStatus}`}>{item.lifecycleStatus}</span></td><td>{item.owner || t('common.notReported')}</td><td>{item.usedByProjectIds.join(', ') || '—'}</td><td><code>{item.evidenceHash?.slice(0, 10) || '—'}</code></td></tr>)}
          {!catalog.items.length && <tr><td className="registry-empty" colSpan={7}>{t('team.noAssets')}</td></tr>}
        </tbody></table></div>
        <Pagination page={catalog.page} totalPages={catalog.totalPages} busy={busy} onPage={setCatalogPage} previousLabel={t('common.previousPage')} nextLabel={t('common.nextPage')} pageLabel={t('common.pageOf', { page: formatNumber(catalog.page), count: formatNumber(catalog.totalPages) })} />
      </section>

      <div className="team-grid">
        <Queue title={t('team.approvalInbox')} empty={t('team.noApprovals')} items={approvals.items.map((item) => ({ id: item.capabilityId, title: item.artifactId, detail: item.owner, status: item.evidenceHash ? t('team.evidenceBound') : t('team.evidenceMissing') }))} totalItems={approvals.totalItems} page={approvals.page} totalPages={approvals.totalPages} busy={busy} onPage={setApprovalPage} previousLabel={t('common.previousPage')} nextLabel={t('common.nextPage')} pageLabel={t('common.pageOf', { page: formatNumber(approvals.page), count: formatNumber(approvals.totalPages) })} />
        <Queue title={t('team.releaseQueue')} empty={t('team.noReleases')} items={releases.items.map((item) => ({ id: item.capabilityId, title: item.artifactId, detail: item.targetSkeleton, status: item.stage }))} totalItems={releases.totalItems} page={releases.page} totalPages={releases.totalPages} busy={busy} onPage={setReleasePage} previousLabel={t('common.previousPage')} nextLabel={t('common.nextPage')} pageLabel={t('common.pageOf', { page: formatNumber(releases.page), count: formatNumber(releases.totalPages) })} />
      </div>

      <section className="panel team-entities">
        <header><ShieldCheck size={18} /><div><h3>{t('team.controlPlane')}</h3><p>{t('team.controlPlaneDescription')}</p></div></header>
        <dl className="governance-metadata">
          <div><dt>{t('team.workspaces')}</dt><dd>{formatNumber(state.counts.workspaces)}</dd></div>
          <div><dt>{t('team.projects')}</dt><dd>{formatNumber(state.counts.projects)}</dd></div>
          <div><dt>{t('team.environments')}</dt><dd>{formatNumber(state.counts.environments)}</dd></div>
          <div><dt>{t('team.devices')}</dt><dd>{formatNumber(state.counts.activeDevices)}</dd></div>
          <div><dt>{t('team.policyPacks')}</dt><dd>{formatNumber(state.counts.policyPacks)}</dd></div>
          <div><dt>{t('team.exceptions')}</dt><dd>{formatNumber(state.counts.exceptions)}</dd></div>
          <div><dt>{t('team.templateAdoption')}</dt><dd>{formatNumber(state.templateAdoption.adoptionRatePct)}%</dd></div>
          <div><dt>{t('team.templateDrift')}</dt><dd>{formatNumber(state.templateAdoption.driftedProjects)}</dd></div>
          <div><dt>{t('team.templateUpgrades')}</dt><dd>{formatNumber(state.templateAdoption.pendingUpgradeProjects)}</dd></div>
        </dl>
        {state.lastCollectorAt && <p className="team-last-seen">{t('team.lastCollector', { time: formatDateTime(state.lastCollectorAt) })}</p>}
      </section>
    </div>
  )
}

type PaginationProps = {
  page: number
  totalPages: number
  busy: boolean
  onPage: (page: number) => void
  previousLabel: string
  nextLabel: string
  pageLabel: string
}

function Pagination({ page, totalPages, busy, onPage, previousLabel, nextLabel, pageLabel }: PaginationProps) {
  if (totalPages <= 1) return null
  return <nav className="runs-pagination-bar registry-pagination" aria-label={pageLabel}><div className="pagination-controls"><button type="button" aria-label={previousLabel} disabled={busy || page <= 1} onClick={() => onPage(Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span role="status" aria-live="polite">{pageLabel}</span><button type="button" aria-label={nextLabel} disabled={busy || page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}><ChevronRight size={15} /></button></div></nav>
}

function Queue({ title, empty, items, totalItems, ...pagination }: { title: string; empty: string; items: Array<{ id: string; title: string; detail: string; status: string }>; totalItems: number } & PaginationProps) {
  return <section className="panel capability-list"><header><h3>{title}</h3><span>{totalItems}</span></header><div>{items.map((item) => <article className="capability-item" key={item.id}><div><strong>{item.title}</strong><span>{item.detail}</span></div><span className={`capability-stage stage-${item.status}`}>{item.status}</span></article>)}{!items.length && <p className="governance-empty">{empty}</p>}</div><Pagination {...pagination} /></section>
}
