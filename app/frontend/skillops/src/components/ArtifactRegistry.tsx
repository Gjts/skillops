import { Boxes, ChevronLeft, ChevronRight, GitCompareArrows, GitCommit, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import type {
  ArtifactKind,
  ArtifactRegistrySnapshot,
  ArtifactSource,
  ArtifactStatus,
  ArtifactVersionRecord,
  Runtime,
} from '../types'

interface VersionDiff {
  artifactId: string
  changed: boolean
  changedFields: string[]
  fields: Record<string, { left: unknown; right: unknown }>
}

interface ImportPreview {
  mode: 'preview'
  persisted: false
  version: ArtifactVersionRecord
  currentVersionIds: string[]
  diff: VersionDiff | null
}

interface ArtifactRegistryProps {
  refreshToken?: string
}

const kindKeys = {
  skill: 'governance.kind.skill',
  prompt: 'governance.kind.prompt',
  workflow: 'governance.kind.workflow',
  rules: 'governance.kind.rules',
  agent: 'governance.kind.agent',
  'evaluation-suite': 'governance.kind.evaluationSuite',
  'policy-pack': 'governance.kind.policyPack',
} as const satisfies Record<ArtifactKind, MessageKey>

const statusKeys = {
  draft: 'registry.artifactStatus.draft',
  candidate: 'governance.stage.candidate',
  ready: 'governance.stage.ready',
  canary: 'governance.stage.canary',
  stable: 'governance.stage.stable',
  deprecated: 'registry.artifactStatus.deprecated',
  blocked: 'governance.stage.blocked',
} as const satisfies Record<ArtifactStatus, MessageKey>

const installationStateKeys = {
  present: 'registry.installationState.present',
  missing: 'registry.installationState.missing',
  drifted: 'registry.installationState.drifted',
  unmanaged: 'registry.installationState.unmanaged',
} as const satisfies Record<ArtifactRegistrySnapshot['installations'][number]['observedState'], MessageKey>

const desiredStateKeys = {
  present: 'registry.installationState.present',
  absent: 'registry.installationState.absent',
  unmanaged: 'registry.installationState.unmanaged',
} as const satisfies Record<ArtifactRegistrySnapshot['installations'][number]['desiredState'], MessageKey>

const compatibilityKeys = {
  supported: 'registry.compatibility.supported',
  preview: 'registry.compatibility.preview',
  unsupported: 'registry.compatibility.unsupported',
} as const satisfies Record<ArtifactVersionRecord['compatibility'][Runtime], MessageKey>

async function request<T>(pathname: string, body?: object): Promise<T> {
  const response = await fetch(pathname, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json() as T & { error?: string | { message?: string } }
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || `Request failed (${response.status})`)
  return payload
}

function short(value: string | null | undefined, length = 12) {
  return value ? value.slice(0, length) : '—'
}

function diffValue(value: unknown) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  return JSON.stringify(value) ?? String(value)
}

function statusClass(status: string) {
  return `artifact-state artifact-state-${status.replaceAll('_', '-')}`
}

const kinds: Array<ArtifactKind | 'all'> = ['all', 'skill', 'prompt', 'workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack']
const statuses: Array<ArtifactStatus | 'all'> = ['all', 'draft', 'candidate', 'ready', 'canary', 'stable', 'deprecated', 'blocked']
const runtimeTargets: Runtime[] = ['codex', 'claude-code', 'cursor']
const runtimes: Array<Runtime | 'all'> = ['all', ...runtimeTargets]
const PAGE_SIZE = 50
const artifactKinds = new Set(kinds)
const artifactSources = new Set<ArtifactSource | 'all'>(['all', 'local-scan', 'git', 'github', 'prompt-registry', 'prompthub'])
const artifactStatuses = new Set(statuses)
const artifactRuntimes = new Set(runtimes)

function readArtifactLocation() {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('artifactKind') as ArtifactKind | 'all' | null
  const source = params.get('artifactSource') as ArtifactSource | 'all' | null
  const status = params.get('artifactStatus') as ArtifactStatus | 'all' | null
  const runtime = params.get('artifactRuntime') as Runtime | 'all' | null
  const requestedPage = Number(params.get('artifactPage'))
  return {
    query: (params.get('artifactQuery') || '').slice(0, 200),
    kind: kind && artifactKinds.has(kind) ? kind : 'all' as ArtifactKind | 'all',
    source: source && artifactSources.has(source) ? source : 'all',
    status: status && artifactStatuses.has(status) ? status : 'all' as ArtifactStatus | 'all',
    runtime: runtime && artifactRuntimes.has(runtime) ? runtime : 'all' as Runtime | 'all',
    owner: (params.get('artifactOwner') || 'all').slice(0, 120),
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  }
}

export function ArtifactRegistry({ refreshToken = '' }: ArtifactRegistryProps) {
  const { formatNumber, t } = useI18n()
  const initialLocation = useMemo(readArtifactLocation, [])
  const [snapshot, setSnapshot] = useState<ArtifactRegistrySnapshot | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState(initialLocation.query)
  const [kind, setKind] = useState<ArtifactKind | 'all'>(initialLocation.kind)
  const [source, setSource] = useState(initialLocation.source)
  const [status, setStatus] = useState<ArtifactStatus | 'all'>(initialLocation.status)
  const [runtime, setRuntime] = useState<Runtime | 'all'>(initialLocation.runtime)
  const [owner, setOwner] = useState(initialLocation.owner)
  const [page, setPage] = useState(initialLocation.page)
  const [selectedId, setSelectedId] = useState('')
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const [diff, setDiff] = useState<VersionDiff | null>(null)
  const [githubUrl, setGithubUrl] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [actionError, setActionError] = useState('')
  const [compareBusy, setCompareBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const loadRequest = useRef(0)
  const compareRequest = useRef(0)
  const importRequest = useRef(0)
  const refreshOnMount = useRef(Boolean(refreshToken))
  const previousRefreshToken = useRef(refreshToken)

  const load = useCallback(async (refresh = false) => {
    const requestId = ++loadRequest.current
    setBusy(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (query.trim()) params.set('query', query.trim())
      if (kind !== 'all') params.set('kind', kind)
      if (source !== 'all') params.set('source', source)
      if (status !== 'all') params.set('status', status)
      if (runtime !== 'all') params.set('runtime', runtime)
      if (owner !== 'all') params.set('owner', owner)
      const pathname = `${refresh ? '/api/artifacts/refresh' : '/api/artifacts'}?${params}`
      const next = await request<ArtifactRegistrySnapshot>(pathname, refresh ? {} : undefined)
      if (!Array.isArray(next.artifacts) || !Array.isArray(next.versions) || !Array.isArray(next.installations)
        || !next.compatibility || !next.facets || !next.stats
        || !Number.isSafeInteger(next.page) || !Number.isSafeInteger(next.totalItems) || !Number.isSafeInteger(next.totalPages)) {
        throw new Error(t('registry.artifactLoadFailed'))
      }
      if (requestId !== loadRequest.current) return
      if (next.totalPages > 0 && page > next.totalPages) {
        setPage(next.totalPages)
        return
      }
      if (next.totalPages === 0 && page > 1) {
        setPage(1)
        return
      }
      compareRequest.current += 1
      setDiff(null)
      setSnapshot(next)
      setSelectedId((current) => current || next.artifacts[0]?.id || '')
    } catch (cause) {
      if (requestId === loadRequest.current) setError(cause instanceof Error ? cause.message : t('registry.artifactLoadFailed'))
    } finally {
      if (requestId === loadRequest.current) {
        setBusy(false)
      }
    }
  }, [kind, owner, page, query, runtime, source, status, t])

  useEffect(() => {
    const refresh = refreshOnMount.current
    refreshOnMount.current = false
    void load(refresh)
  }, [load])

  useEffect(() => {
    if (!refreshToken || refreshToken === previousRefreshToken.current) return
    previousRefreshToken.current = refreshToken
    void load(true)
  }, [load, refreshToken])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (query) params.set('artifactQuery', query)
    else params.delete('artifactQuery')
    if (kind !== 'all') params.set('artifactKind', kind)
    else params.delete('artifactKind')
    if (source !== 'all') params.set('artifactSource', source)
    else params.delete('artifactSource')
    if (status !== 'all') params.set('artifactStatus', status)
    else params.delete('artifactStatus')
    if (runtime !== 'all') params.set('artifactRuntime', runtime)
    else params.delete('artifactRuntime')
    if (owner !== 'all') params.set('artifactOwner', owner)
    else params.delete('artifactOwner')
    if (page > 1) params.set('artifactPage', String(page))
    else params.delete('artifactPage')
    const next = `${window.location.pathname}${params.size ? `?${params}` : ''}`
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState({}, '', next)
  }, [kind, owner, page, query, runtime, source, status])

  useEffect(() => {
    const restore = () => {
      const next = readArtifactLocation()
      setQuery(next.query)
      setKind(next.kind)
      setSource(next.source)
      setStatus(next.status)
      setRuntime(next.runtime)
      setOwner(next.owner)
      setPage(next.page)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])

  const versionsByArtifact = useMemo(() => {
    const grouped = new Map<string, ArtifactVersionRecord[]>()
    for (const version of snapshot?.versions || []) grouped.set(version.artifactId, [...(grouped.get(version.artifactId) || []), version])
    return grouped
  }, [snapshot])
  const versionsById = useMemo(() => new Map((snapshot?.versions || []).map((version) => [version.id, version])), [snapshot])
  const owners = snapshot?.facets.owners.map((item) => item.value) || []
  const sources = snapshot?.facets.sources.map((item) => item.value) || []
  if (source !== 'all' && !sources.includes(source)) sources.unshift(source)
  const artifacts = snapshot?.artifacts || []

  useEffect(() => {
    if (!artifacts.some((artifact) => artifact.id === selectedId)) setSelectedId(artifacts[0]?.id || '')
  }, [artifacts, selectedId])

  const selected = snapshot?.artifacts.find((artifact) => artifact.id === selectedId) || null
  const selectedVersions = selected ? versionsByArtifact.get(selected.id) || [] : []
  const selectedInstallations = selected ? snapshot?.installations.filter((item) => item.artifactId === selected.id) || [] : []
  const selectedCompatibilityVersion = selectedVersions.find((version) => version.status === selected?.status) || selectedVersions[0]

  useEffect(() => {
    compareRequest.current += 1
    setCompareBusy(false)
    setLeftId(selectedVersions[0]?.id || '')
    setRightId(selectedVersions[1]?.id || '')
    setDiff(null)
  }, [selectedId, snapshot])

  useEffect(() => {
    compareRequest.current += 1
    setCompareBusy(false)
    setDiff(null)
  }, [leftId, rightId])

  const compare = async () => {
    if (!leftId || !rightId) return
    const requestId = ++compareRequest.current
    setCompareBusy(true)
    setActionError('')
    setDiff(null)
    try {
      const result = await request<VersionDiff>('/api/artifacts/diff', { leftId, rightId })
      if (requestId === compareRequest.current) setDiff(result)
    } catch (cause) {
      if (requestId === compareRequest.current) setActionError(cause instanceof Error ? cause.message : t('registry.artifactLoadFailed'))
    } finally {
      if (requestId === compareRequest.current) setCompareBusy(false)
    }
  }

  const importCandidate = async () => {
    const requestId = ++importRequest.current
    setImportBusy(true)
    setActionError('')
    setPreview(null)
    try {
      const result = await request<ImportPreview>('/api/artifacts/import-preview', { sourceUrl: githubUrl })
      if (requestId === importRequest.current) setPreview(result)
    } catch (cause) {
      if (requestId === importRequest.current) setActionError(cause instanceof Error ? cause.message : t('registry.importFailed'))
    } finally {
      if (requestId === importRequest.current) setImportBusy(false)
    }
  }

  const driftCount = snapshot?.stats.driftedInstallations || 0

  return (
    <section className="panel artifact-registry" aria-labelledby="artifact-registry-title">
      <header className="artifact-registry-header">
        <div>
          <span className="eyebrow"><Boxes size={14} /> {t('registry.artifactRegistry')}</span>
          <h3 id="artifact-registry-title">{t('registry.artifactsTitle')}</h3>
          <p>{t('registry.artifactsDescription')}</p>
        </div>
        <div className="artifact-registry-stats">
          <span><strong>{formatNumber(snapshot?.stats.totalArtifacts || 0)}</strong> {t('registry.artifacts')}</span>
          <span className={driftCount ? 'has-drift' : ''}><strong>{formatNumber(driftCount)}</strong> {t('registry.drift')}</span>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void load(true)}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} /> {t('governance.refresh')}
          </button>
        </div>
      </header>

      <div className="artifact-import-strip">
        <label>
          <span>{t('registry.importFromGithub')}</span>
          <input
            value={githubUrl}
            onChange={(event) => {
              importRequest.current += 1
              setImportBusy(false)
              setPreview(null)
              setActionError('')
              setGithubUrl(event.target.value)
            }}
            placeholder="https://github.com/org/repo/tree/main/skills"
          />
        </label>
        <button className="button secondary" type="button" disabled={importBusy || !githubUrl.trim()} onClick={() => void importCandidate()}>
          {importBusy ? <RefreshCw size={14} className="spin" /> : null}{t('registry.previewCandidate')}
        </button>
        {preview ? <p role="status"><span className={statusClass('candidate')}>{t(statusKeys.candidate)}</span><strong>{preview.version.artifactId}</strong><code title={preview.version.gitCommit || ''}>{preview.version.gitCommit || '—'}</code>{t('registry.candidateNotPersisted')}</p> : null}
      </div>

      <div className="artifact-filters">
        <label className="artifact-filter"><span>{t('registry.artifactSearch')}</span><span className="search-field"><Search size={15} /><input placeholder={t('registry.artifactSearch')} value={query} onChange={(event) => { setPage(1); setQuery(event.target.value) }} /></span></label>
        <label className="artifact-filter"><span>{t('common.type')}</span><select value={kind} onChange={(event) => { setPage(1); setKind(event.target.value as ArtifactKind | 'all') }}>{kinds.map((value) => <option key={value} value={value}>{value === 'all' ? t('common.all') : t(kindKeys[value])}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('common.source')}</span><select value={source} onChange={(event) => { setPage(1); setSource(event.target.value as ArtifactSource | 'all') }}><option value="all">{t('common.all')}</option>{sources.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('common.status')}</span><select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ArtifactStatus | 'all') }}>{statuses.map((value) => <option key={value} value={value}>{value === 'all' ? t('common.all') : t(statusKeys[value])}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('common.runtime')}</span><select value={runtime} onChange={(event) => { setPage(1); setRuntime(event.target.value as Runtime | 'all') }}>{runtimes.map((value) => <option key={value} value={value}>{value === 'all' ? t('common.all') : value}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('registry.owner')}</span><select value={owner} onChange={(event) => { setPage(1); setOwner(event.target.value) }}><option value="all">{t('common.all')}</option>{owners.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>

      {error ? <div className="artifact-error" role="alert">{error}</div> : null}
      {actionError ? <div className="artifact-error" role="alert">{actionError}</div> : null}
      {snapshot?.sourceStatus === 'partial' ? <div className="data-warning" role="alert">{t('cc.partial')}</div> : null}
      {snapshot?.warnings?.map((warning) => <div key={`${warning.source}:${warning.code}`} className="artifact-warning" role="status">{t('registry.promptSourceUnavailable')}</div>)}
      {busy && !snapshot ? <div className="artifact-empty" role="status">{t('registry.loadingArtifacts')}</div> : null}
      {!busy && snapshot && !artifacts.length ? <div className="artifact-empty" role="status">{t('registry.noArtifacts')}</div> : null}

      {artifacts.length ? (
        <div className="artifact-table-wrap">
          <table className="artifact-table">
            <caption className="sr-only">{t('registry.artifactsTitle')}</caption>
            <thead><tr><th>{t('registry.artifact')}</th><th>{t('common.type')}</th><th>{t('registry.owner')}</th><th>{t('common.status')}</th><th>{t('common.version')}</th><th>{t('registry.installations')}</th></tr></thead>
            <tbody>{artifacts.map((artifact) => {
              const versions = versionsByArtifact.get(artifact.id) || []
              const installationRows = snapshot?.installations.filter((item) => item.artifactId === artifact.id) || []
              const latest = versions.find((version) => version.status === artifact.status) || versions[0]
              const unhealthy = installationRows.filter((item) => item.observedState === 'drifted' || item.observedState === 'missing').length
              return <tr key={artifact.id} className={selectedId === artifact.id ? 'is-selected' : ''}>
                <td><button className="artifact-row-select" type="button" aria-pressed={selectedId === artifact.id} onClick={() => setSelectedId(artifact.id)}><strong>{artifact.name}</strong><small className="mono">{artifact.id}</small></button></td>
                <td><span className="artifact-kind">{t(kindKeys[artifact.kind])}</span></td>
                <td>{artifact.owner}</td>
                <td><span className={statusClass(artifact.status)}>{t(statusKeys[artifact.status])}</span></td>
                <td><strong>{latest?.version || '—'}</strong><small className="mono">{short(latest?.contentHash)}</small></td>
                <td><span className={unhealthy ? 'artifact-drift-count' : ''}>{unhealthy ? `${unhealthy} ${t('registry.drift')}` : formatNumber(installationRows.length)}</span></td>
              </tr>
            })}</tbody>
          </table>
        </div>
      ) : null}
      {snapshot && snapshot.totalPages > 1 ? (
        <nav className="runs-pagination-bar registry-pagination" aria-label={t('common.pageOf', { page: formatNumber(snapshot.page), count: formatNumber(snapshot.totalPages) })}>
          <div className="pagination-controls">
            <button type="button" aria-label={t('common.previousPage')} disabled={busy || !snapshot.hasPrevious} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button>
            <span role="status">{t('common.pageOf', { page: formatNumber(snapshot.page), count: formatNumber(snapshot.totalPages) })}</span>
            <button type="button" aria-label={t('common.nextPage')} disabled={busy || !snapshot.hasNext} onClick={() => setPage((value) => Math.min(snapshot.totalPages, value + 1))}><ChevronRight size={15} /></button>
          </div>
        </nav>
      ) : null}

      {selected ? (
        <div className="artifact-detail">
          <header><div><span className={statusClass(selected.status)}>{t(statusKeys[selected.status])}</span><h4>{selected.id}</h4></div><p>{selected.description || '—'}</p></header>
          <div className="artifact-detail-grid">
            <section>
              <h5>{t('registry.versions')}</h5>
              <div className="artifact-version-list">{selectedVersions.map((version) => <article key={version.id}>
                <div><strong>{version.version}</strong><span className={statusClass(version.status)}>{t(statusKeys[version.status])}</span></div>
                <dl className="artifact-version-metadata">
                  <div><dt>{t('registry.gitCommit')}</dt><dd><GitCommit size={13} /><code title={version.gitCommit || ''}>{version.gitCommit || '—'}</code></dd></div>
                  <div><dt>{t('registry.contentHash')}</dt><dd><code title={version.contentHash}>{version.contentHash}</code></dd></div>
                  <div><dt>{t('registry.sourceReference')}</dt><dd><code title={version.sourceRef}>{version.sourceRef}</code></dd></div>
                  <div><dt>{t('registry.repository')}</dt><dd><code title={version.repository || ''}>{version.repository || '—'}</code></dd></div>
                  <div><dt>{t('registry.runtimeTargets')}</dt><dd>{version.runtimeTargets.length ? version.runtimeTargets.join(', ') : '—'}</dd></div>
                  <div><dt>{t('registry.dependencies')}</dt><dd>{version.dependencies.length ? <ul>{version.dependencies.map((dependency) => <li key={dependency}><code>{dependency}</code></li>)}</ul> : '—'}</dd></div>
                  <div><dt>{t('registry.componentHashes')}</dt><dd>{Object.keys(version.componentHashes || {}).length ? <ul>{Object.entries(version.componentHashes || {}).map(([name, hash]) => <li key={name}><strong>{name}</strong><code title={hash}>{hash}</code></li>)}</ul> : '—'}</dd></div>
                </dl>
              </article>)}</div>
            </section>
            <section>
              <h5>{t('registry.installations')}</h5>
              <div className="artifact-installations">{selectedInstallations.length ? selectedInstallations.map((item) => {
                const desiredVersion = item.artifactVersionId ? versionsById.get(item.artifactVersionId) : undefined
                return <article key={item.id}>
                  <div><span className={statusClass(desiredVersion?.status || item.desiredState)}>{desiredVersion ? t(statusKeys[desiredVersion.status]) : t(desiredStateKeys[item.desiredState])}</span><span className={statusClass(item.observedState)}>{t(installationStateKeys[item.observedState])}</span></div>
                  <strong>{item.runtime} · {item.scope}</strong><code title={item.targetPath}>{item.targetPath}</code>
                  <dl><div><dt>{t('registry.desiredState')}</dt><dd>{t(desiredStateKeys[item.desiredState])}</dd></div><div><dt>{t('registry.observedState')}</dt><dd>{t(installationStateKeys[item.observedState])}</dd></div><div><dt>{t('registry.desiredVersion')}</dt><dd><code title={desiredVersion?.id || item.artifactVersionId || ''}>{desiredVersion?.id || item.artifactVersionId || '—'}</code></dd></div><div><dt>{t('registry.observedHash')}</dt><dd><code title={item.observedHash || ''}>{item.observedHash || '—'}</code></dd></div></dl>
                </article>
              }) : <p>{t('registry.unmanaged')}</p>}</div>
              <h5>{t('registry.compatibility')}{selectedCompatibilityVersion ? ` · ${selectedCompatibilityVersion.version}` : ''}</h5>
              <div className="artifact-compatibility">{runtimeTargets.map((target) => {
                const compatibility = selectedCompatibilityVersion?.compatibility[target] || snapshot!.compatibility[selected.kind][target]
                return <span key={target}><strong>{target}</strong><i className={statusClass(compatibility)}>{t(compatibilityKeys[compatibility])}</i></span>
              })}</div>
            </section>
          </div>

          <div className="artifact-compare">
            <h5><GitCompareArrows size={15} /> {t('registry.compareMetadata')}</h5>
            <select aria-label={t('registry.leftVersion')} value={leftId} onChange={(event) => setLeftId(event.target.value)}>{selectedVersions.map((version) => <option key={version.id} value={version.id}>{version.version} · {short(version.gitCommit)}</option>)}</select>
            <select aria-label={t('registry.rightVersion')} value={rightId} onChange={(event) => setRightId(event.target.value)}>{selectedVersions.map((version) => <option key={version.id} value={version.id}>{version.version} · {short(version.gitCommit)}</option>)}</select>
            <button className="button secondary" type="button" disabled={compareBusy || !leftId || !rightId || leftId === rightId} onClick={() => void compare()}>{compareBusy ? <RefreshCw size={14} className="spin" /> : null}{t('insight.compare')}</button>
            {diff ? <div className="artifact-diff-result" role="status"><strong>{diff.changed ? t('registry.changed') : t('registry.unchanged')}</strong>{Object.entries(diff.fields).map(([field, values]) => <article key={field}><h6>{field}</h6><div><span>{t('registry.leftVersion')}</span><code title={diffValue(values.left)}>{diffValue(values.left)}</code></div><div><span>{t('registry.rightVersion')}</span><code title={diffValue(values.right)}>{diffValue(values.right)}</code></div></article>)}</div> : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
