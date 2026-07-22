import { Archive, RefreshCw, ShieldCheck, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'

type TeamState = {
  revision: number
  team: { id: string; name: string } | null
  workspaces: Array<{ id: string; name: string }>
  projects: Array<{ id: string; name: string; artifactIds: string[]; template: { id: string; version: string; status: string; candidateVersion: string | null } | null }>
  environments: Array<{ id: string; name: string; channel: string }>
  members: Array<{ id: string; displayName: string; role: string; status: string }>
  devices: Array<{ id: string; name: string; status: string; lastSeenAt: string | null }>
  policyPacks: Array<{ id: string; version: string }>
  exceptions: Array<{ id: string; projectId: string; policyId: string; status: string }>
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

type TeamQueues = {
  approvalInbox: Array<{ capabilityId: string; artifactId: string; owner: string; evidenceHash: string | null }>
  releaseQueue: Array<{ capabilityId: string; artifactId: string; stage: string; targetSkeleton: string }>
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
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [queues, setQueues] = useState<TeamQueues>({ approvalInbox: [], releaseQueue: [] })
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
        const [catalogResult, queueResult] = await Promise.all([
          json<{ items: CatalogItem[] }>('/api/team/catalog'),
          json<TeamQueues>('/api/team/queues'),
        ])
        setCatalog(catalogResult.items)
        setQueues(queueResult)
      } else {
        setCatalog([])
        setQueues({ approvalInbox: [], releaseQueue: [] })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('team.loadFailed'))
    } finally { setBusy(false) }
  }, [t])

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
        <article className="registry-metric"><span>{t('team.assets')}</span><strong>{formatNumber(catalog.length)}</strong><p>{t('team.assetsHint')}</p></article>
        <article className="registry-metric"><span>{t('team.members')}</span><strong>{formatNumber(state.members.filter((item) => item.status === 'active').length)}</strong><p>{t('team.rolesHint')}</p></article>
        <article className="registry-metric"><span>{t('team.approvals')}</span><strong>{formatNumber(queues.approvalInbox.length)}</strong><p>{t('team.approvalsHint')}</p></article>
        <article className="registry-metric"><span>{t('team.releases')}</span><strong>{formatNumber(queues.releaseQueue.length)}</strong><p>{t('team.releasesHint')}</p></article>
      </section>

      <section className="panel registry-table-wrap">
        <header className="registry-table-heading"><div><span>{t('team.catalog')}</span><h3>{t('team.assetDirectory')}</h3></div><strong>{t('team.localGit')}</strong></header>
        <div className="registry-table-scroll"><table className="registry-table team-table"><thead><tr><th>{t('team.artifact')}</th><th>{t('common.version')}</th><th>{t('common.source')}</th><th>{t('common.status')}</th><th>{t('team.owner')}</th><th>{t('team.usedBy')}</th><th>{t('team.evidence')}</th></tr></thead><tbody>
          {catalog.map((item) => <tr key={item.artifactVersionId}><td><strong>{item.artifactId}</strong></td><td><span className="version">{item.version}</span></td><td>{item.source}</td><td><span className={`capability-stage stage-${item.lifecycleStatus}`}>{item.lifecycleStatus}</span></td><td>{item.owner || t('common.notReported')}</td><td>{item.usedByProjectIds.join(', ') || '—'}</td><td><code>{item.evidenceHash?.slice(0, 10) || '—'}</code></td></tr>)}
          {!catalog.length && <tr><td className="registry-empty" colSpan={7}>{t('team.noAssets')}</td></tr>}
        </tbody></table></div>
      </section>

      <div className="team-grid">
        <Queue title={t('team.approvalInbox')} empty={t('team.noApprovals')} items={queues.approvalInbox.map((item) => ({ id: item.capabilityId, title: item.artifactId, detail: item.owner, status: item.evidenceHash ? t('team.evidenceBound') : t('team.evidenceMissing') }))} />
        <Queue title={t('team.releaseQueue')} empty={t('team.noReleases')} items={queues.releaseQueue.map((item) => ({ id: item.capabilityId, title: item.artifactId, detail: item.targetSkeleton, status: item.stage }))} />
      </div>

      <section className="panel team-entities">
        <header><ShieldCheck size={18} /><div><h3>{t('team.controlPlane')}</h3><p>{t('team.controlPlaneDescription')}</p></div></header>
        <dl className="governance-metadata">
          <div><dt>{t('team.workspaces')}</dt><dd>{formatNumber(state.workspaces.length)}</dd></div>
          <div><dt>{t('team.projects')}</dt><dd>{formatNumber(state.projects.length)}</dd></div>
          <div><dt>{t('team.environments')}</dt><dd>{formatNumber(state.environments.length)}</dd></div>
          <div><dt>{t('team.devices')}</dt><dd>{formatNumber(state.devices.filter((item) => item.status === 'active').length)}</dd></div>
          <div><dt>{t('team.policyPacks')}</dt><dd>{formatNumber(state.policyPacks.length)}</dd></div>
          <div><dt>{t('team.exceptions')}</dt><dd>{formatNumber(state.exceptions.length)}</dd></div>
          <div><dt>{t('team.templateAdoption')}</dt><dd>{formatNumber(state.templateAdoption.adoptionRatePct)}%</dd></div>
          <div><dt>{t('team.templateDrift')}</dt><dd>{formatNumber(state.templateAdoption.driftedProjects)}</dd></div>
          <div><dt>{t('team.templateUpgrades')}</dt><dd>{formatNumber(state.templateAdoption.pendingUpgradeProjects)}</dd></div>
        </dl>
        {state.devices.some((item) => item.lastSeenAt) && <p className="team-last-seen">{t('team.lastCollector', { time: formatDateTime(state.devices.filter((item) => item.lastSeenAt).sort((left, right) => Date.parse(right.lastSeenAt!) - Date.parse(left.lastSeenAt!))[0].lastSeenAt!) })}</p>}
      </section>
    </div>
  )
}

function Queue({ title, empty, items }: { title: string; empty: string; items: Array<{ id: string; title: string; detail: string; status: string }> }) {
  return <section className="panel capability-list"><header><h3>{title}</h3><span>{items.length}</span></header><div>{items.map((item) => <article className="capability-item" key={item.id}><div><strong>{item.title}</strong><span>{item.detail}</span></div><span className={`capability-stage stage-${item.status}`}>{item.status}</span></article>)}{!items.length && <p className="governance-empty">{empty}</p>}</div></section>
}
