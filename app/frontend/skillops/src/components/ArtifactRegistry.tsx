import { Boxes, GitCompareArrows, GitCommit, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { definitionKey, normalizedSkillId, type InventoryIssue } from '../lib/skill-inventory'
import type {
  ArtifactKind,
  ArtifactRecord,
  ArtifactRegistrySnapshot,
  ArtifactStatus,
  ArtifactVersionRecord,
  InstalledSkill,
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
  inventory?: InstalledSkill[]
  inventoryIssues?: Map<string, Set<InventoryIssue>>
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

const issueKeys = {
  conflict: 'registry.versionConflicts',
  duplicate: 'registry.duplicateDefinitions',
  disabled: 'registry.disabledSkills',
  missing: 'registry.missingMetadata',
} as const satisfies Record<InventoryIssue, MessageKey>

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

export function ArtifactRegistry({ inventory = [], inventoryIssues = new Map(), refreshToken = '' }: ArtifactRegistryProps) {
  const { formatNumber, t } = useI18n()
  const [snapshot, setSnapshot] = useState<ArtifactRegistrySnapshot | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ArtifactKind | 'all'>('all')
  const [source, setSource] = useState('all')
  const [status, setStatus] = useState<ArtifactStatus | 'all'>('all')
  const [runtime, setRuntime] = useState<Runtime | 'all'>('all')
  const [owner, setOwner] = useState('all')
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
  const loaded = useRef(false)
  const previousRefreshToken = useRef(refreshToken)

  const load = async (refresh = false) => {
    const requestId = ++loadRequest.current
    setBusy(true)
    setError('')
    try {
      const next = await request<ArtifactRegistrySnapshot>(refresh ? '/api/artifacts/refresh' : '/api/artifacts', refresh ? {} : undefined)
      if (!Array.isArray(next.artifacts) || !Array.isArray(next.versions) || !Array.isArray(next.installations) || !next.compatibility) {
        throw new Error(t('registry.artifactLoadFailed'))
      }
      if (requestId !== loadRequest.current) return
      compareRequest.current += 1
      setDiff(null)
      setSnapshot(next)
      setSelectedId((current) => current || next.artifacts[0]?.id || '')
    } catch (cause) {
      if (requestId === loadRequest.current) setError(cause instanceof Error ? cause.message : t('registry.artifactLoadFailed'))
    } finally {
      if (requestId === loadRequest.current) {
        loaded.current = true
        setBusy(false)
      }
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!refreshToken || refreshToken === previousRefreshToken.current) return
    previousRefreshToken.current = refreshToken
    if (loaded.current) void load(true)
  }, [refreshToken])

  const versionsByArtifact = useMemo(() => {
    const grouped = new Map<string, ArtifactVersionRecord[]>()
    for (const version of snapshot?.versions || []) grouped.set(version.artifactId, [...(grouped.get(version.artifactId) || []), version])
    return grouped
  }, [snapshot])
  const versionsById = useMemo(() => new Map((snapshot?.versions || []).map((version) => [version.id, version])), [snapshot])
  const owners = useMemo(() => [...new Set((snapshot?.artifacts || []).map((artifact) => artifact.owner))].sort(), [snapshot])
  const sources = useMemo(() => [...new Set((snapshot?.versions || []).map((version) => version.source))].sort(), [snapshot])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (snapshot?.artifacts || []).filter((artifact) => {
      const versions = versionsByArtifact.get(artifact.id) || []
      return (kind === 'all' || artifact.kind === kind)
        && (status === 'all' || artifact.status === status)
        && (owner === 'all' || artifact.owner === owner)
        && (source === 'all' || versions.some((version) => version.source === source))
        && (runtime === 'all' || versions.some((version) => version.runtimeTargets.includes(runtime)))
        && (!needle || `${artifact.id} ${artifact.name} ${artifact.description || ''} ${artifact.repository || ''}`.toLowerCase().includes(needle))
    })
  }, [kind, owner, query, runtime, snapshot, source, status, versionsByArtifact])

  useEffect(() => {
    if (!filtered.some((artifact) => artifact.id === selectedId)) setSelectedId(filtered[0]?.id || '')
  }, [filtered, selectedId])

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
  const selectedInventoryIssues = selected?.kind === 'skill'
    ? [...new Set(inventory
      .filter((row) => selected.id === `skill:${normalizedSkillId(row.skillId)}`)
      .flatMap((row) => [...(inventoryIssues.get(definitionKey(row)) || [])]))]
    : []

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

  const driftCount = snapshot?.installations.filter((item) => item.observedState === 'drifted' || item.observedState === 'missing').length || 0

  return (
    <section className="panel artifact-registry" aria-labelledby="artifact-registry-title">
      <header className="artifact-registry-header">
        <div>
          <span className="eyebrow"><Boxes size={14} /> {t('registry.artifactRegistry')}</span>
          <h3 id="artifact-registry-title">{t('registry.artifactsTitle')}</h3>
          <p>{t('registry.artifactsDescription')}</p>
        </div>
        <div className="artifact-registry-stats">
          <span><strong>{formatNumber(snapshot?.artifacts.length || 0)}</strong> {t('registry.artifacts')}</span>
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
        <label className="artifact-filter"><span>{t('registry.artifactSearch')}</span><span className="search-field"><Search size={15} /><input placeholder={t('registry.artifactSearch')} value={query} onChange={(event) => setQuery(event.target.value)} /></span></label>
        <label className="artifact-filter"><span>{t('common.type')}</span><select value={kind} onChange={(event) => setKind(event.target.value as ArtifactKind | 'all')}>{kinds.map((value) => <option key={value} value={value}>{value === 'all' ? t('common.all') : t(kindKeys[value])}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('common.source')}</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">{t('common.all')}</option>{sources.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('common.status')}</span><select value={status} onChange={(event) => setStatus(event.target.value as ArtifactStatus | 'all')}>{statuses.map((value) => <option key={value} value={value}>{value === 'all' ? t('common.all') : t(statusKeys[value])}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('common.runtime')}</span><select value={runtime} onChange={(event) => setRuntime(event.target.value as Runtime | 'all')}>{runtimes.map((value) => <option key={value} value={value}>{value === 'all' ? t('common.all') : value}</option>)}</select></label>
        <label className="artifact-filter"><span>{t('registry.owner')}</span><select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="all">{t('common.all')}</option>{owners.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>

      {error ? <div className="artifact-error" role="alert">{error}</div> : null}
      {actionError ? <div className="artifact-error" role="alert">{actionError}</div> : null}
      {snapshot?.warnings?.map((warning) => <div key={`${warning.source}:${warning.code}`} className="artifact-warning" role="status">{t('registry.promptSourceUnavailable')}</div>)}
      {busy && !snapshot ? <div className="artifact-empty" role="status">{t('registry.loadingArtifacts')}</div> : null}
      {!busy && snapshot && !filtered.length ? <div className="artifact-empty" role="status">{t('registry.noArtifacts')}</div> : null}

      {filtered.length ? (
        <div className="artifact-table-wrap">
          <table className="artifact-table">
            <thead><tr><th>{t('registry.artifact')}</th><th>{t('common.type')}</th><th>{t('registry.owner')}</th><th>{t('common.status')}</th><th>{t('common.version')}</th><th>{t('registry.installations')}</th></tr></thead>
            <tbody>{filtered.map((artifact) => {
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

      {selected ? (
        <div className="artifact-detail">
          <header><div><span className={statusClass(selected.status)}>{t(statusKeys[selected.status])}</span><h4>{selected.id}</h4></div><p>{selected.description || '—'}</p></header>
          {selectedInventoryIssues.length ? <div className="artifact-inventory-health"><strong>{t('registry.health')}</strong>{selectedInventoryIssues.map((issue) => <span key={issue} className={statusClass(issue === 'disabled' ? 'unmanaged' : 'blocked')}>{t(issueKeys[issue])}</span>)}</div> : null}
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
