import { Bot, CheckCircle2, ChevronLeft, ChevronRight, Code2, GitPullRequest, Layers3, MousePointer2, RefreshCw, Search, XCircle } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArtifactRegistry } from './ArtifactRegistry'
import { ConflictDetailPage } from './ConflictDetailPage'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { runtimeLabel } from '../lib/analytics'
import { buildInventoryIssues, countInventoryIssues, definitionKey, issuesForDefinition, normalizedSkillId, type InventoryIssue } from '../lib/skill-inventory'
import type { ConfigurationSource, DefinitionStatus, InstalledSkill, Runtime, SkillScanMetadata, SkillScanResponse } from '../types'

type AttentionFilter = 'all' | 'attention' | 'conflict' | 'duplicate' | 'disabled' | 'missing'
type RuntimeFilter = Runtime | 'all'
type SourceFilter = InstalledSkill['source'] | 'all'
type StatusFilter = 'enabled' | 'disabled' | 'all'

function nominationKey(skill: InstalledSkill) {
  return `${skill.runtime}:${skill.sourcePath}:${skill.contentHash || skill.skillVersion}`
}

const sourceLabel: Record<InstalledSkill['source'], MessageKey> = {
  global: 'registry.global',
  project: 'registry.project',
  plugin: 'registry.plugin',
}
const kindLabel: Record<InstalledSkill['kind'], MessageKey> = {
  skill: 'common.skill',
  command: 'common.command',
  rules: 'governance.kind.rules',
  agent: 'governance.kind.agent',
}

const issueLabel: Record<Exclude<AttentionFilter, 'all' | 'attention'>, MessageKey> = {
  conflict: 'registry.versionConflicts',
  duplicate: 'registry.duplicateDefinitions',
  disabled: 'common.disabled',
  missing: 'registry.missingMetadata',
}

const disabledReasonLabel: Record<NonNullable<InstalledSkill['disabledReason']>, MessageKey> = {
  plugin: 'registry.disabledByPlugin',
  'skill-config': 'registry.disabledBySkillConfig',
  'plugin-and-skill-config': 'registry.disabledByPluginAndSkillConfig',
}

const configurationSourceLabel: Record<ConfigurationSource, MessageKey> = {
  user: 'registry.configSource.user',
  project: 'registry.configSource.project',
  local: 'registry.configSource.local',
  managed: 'registry.configSource.managed',
  plugin: 'registry.configSource.plugin',
  admin: 'registry.configSource.admin',
}

const definitionStatusLabel: Record<DefinitionStatus, MessageKey> = {
  active: 'registry.definitionStatus.active',
  disabled: 'registry.definitionStatus.disabled',
  shadowed: 'registry.definitionStatus.shadowed',
  inactive: 'registry.definitionStatus.inactive',
  missing: 'registry.definitionStatus.missing',
}

const runtimeOrder: Runtime[] = ['codex', 'claude-code', 'cursor']
const sourceOrder: InstalledSkill['source'][] = ['global', 'project', 'plugin']

function RuntimeIcon({ runtime }: { runtime: Runtime | 'all' }) {
  if (runtime === 'codex') return <Code2 size={18} />
  if (runtime === 'claude-code') return <Bot size={18} />
  if (runtime === 'cursor') return <MousePointer2 size={18} />
  return <Layers3 size={18} />
}


function normalizeInstalledSkill(skill: Partial<InstalledSkill>): InstalledSkill {
  const runtime = skill.runtime ?? 'codex'
  const source = skill.source ?? 'global'
  const enabled = skill.enabled ?? true
  return {
    skillId: skill.skillId ?? 'unknown-skill',
    skillVersion: skill.skillVersion ?? 'unversioned',
    runtime,
    source,
    sourcePath: skill.sourcePath ?? 'Unknown location',
    provider: skill.provider ?? (source === 'project' ? 'Project' : runtimeLabel[runtime]),
    kind: skill.kind ?? 'skill',
    enabled,
    disabledReason: skill.disabledReason,
    status: skill.status ?? (enabled ? 'active' : 'disabled'),
    shadowedBy: skill.shadowedBy,
    configurationSource: skill.configurationSource ?? (source === 'plugin' ? 'plugin' : source === 'project' ? 'project' : 'user'),
    scope: skill.scope,
    originConfigs: skill.originConfigs,
    projectRoot: skill.projectRoot,
    contentHash: skill.contentHash,
    description: skill.description,
    tags: skill.tags,
  }
}

function countBy<T extends string>(rows: InstalledSkill[], values: T[], read: (row: InstalledSkill) => T) {
  return values.map((value) => ({ value, count: rows.filter((row) => read(row) === value).length }))
}

interface CategoryItem {
  value: string
  label: string
  count: number
  selected: boolean
  onSelect: () => void
}

function CategoryPanel({ title, items }: { title: string; items: CategoryItem[] }) {
  const { formatNumber, t } = useI18n()
  const maximum = Math.max(1, ...items.map((item) => item.count))
  return (
    <section className="panel registry-category" aria-label={t('registry.categories', { title })}>
      <h3>{title}</h3>
      <div className="registry-category-list">
        {items.map((item) => (
          <button className={item.selected ? 'is-selected' : ''} type="button" key={item.value} onClick={item.onSelect} aria-pressed={item.selected}>
            <span><strong>{item.label}</strong><b>{formatNumber(item.count)}</b></span>
            <i><span style={{ width: `${(item.count / maximum) * 100}%` }} /></i>
          </button>
        ))}
      </div>
    </section>
  )
}

const PAGE_SIZE = 50
const attentionFilters = new Set<AttentionFilter>(['all', 'attention', 'conflict', 'duplicate', 'disabled', 'missing'])
const runtimeFilters = new Set<RuntimeFilter>(['all', ...runtimeOrder])
const sourceFilters = new Set<SourceFilter>(['all', ...sourceOrder])
const statusFilters = new Set<StatusFilter>(['enabled', 'disabled', 'all'])
const registryPathnames = new Set(['/assets', '/skills', '/registry'])

function readRegistryLocation() {
  const params = new URLSearchParams(window.location.search)
  const attention = params.get('attention') as AttentionFilter | null
  const runtime = params.get('runtime') as RuntimeFilter | null
  const source = params.get('source') as SourceFilter | null
  const status = params.get('status') as StatusFilter | null
  const requestedPage = Number.parseInt(params.get('page') || '', 10)
  const resolvedAttention = attention && attentionFilters.has(attention) ? attention : 'all'
  return {
    query: (params.get('query') || '').slice(0, 120),
    runtime: runtime && runtimeFilters.has(runtime) ? runtime : 'all' as RuntimeFilter,
    source: source && sourceFilters.has(source) ? source : 'all' as SourceFilter,
    provider: (params.get('provider') || 'all').slice(0, 120),
    status: status && statusFilters.has(status) ? status : resolvedAttention === 'all' ? 'enabled' : 'all' as StatusFilter,
    attention: resolvedAttention as AttentionFilter,
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  }
}

function registryScanPath(filters: {
  query: string
  runtime: RuntimeFilter
  source: SourceFilter
  provider: string
  status: StatusFilter
  attention: AttentionFilter
  page: number
}, refresh = false) {
  const params = new URLSearchParams()
  if (filters.query) params.set('query', filters.query)
  if (filters.runtime !== 'all') params.set('runtime', filters.runtime)
  if (filters.source !== 'all') params.set('source', filters.source)
  if (filters.provider !== 'all') params.set('provider', filters.provider)
  if (filters.status !== 'enabled') params.set('status', filters.status)
  if (filters.attention !== 'all') params.set('attention', filters.attention)
  if (filters.page > 1) params.set('page', String(filters.page))
  if (refresh) params.set('refresh', '1')
  return `/api/scan${params.size ? `?${params}` : ''}`
}

export function RegistryPage() {
  const { formatNumber, t } = useI18n()
  const initialLocation = useMemo(readRegistryLocation, [])
  const displayProvider = useCallback((provider: string) => provider === 'Project' ? t('registry.project') : provider, [t])
  const [scannedSkills, setScannedSkills] = useState<InstalledSkill[] | null>(null)
  const [scanStatus, setScanStatus] = useState<'scanning' | 'complete' | 'failed'>('scanning')
  const [scanMetadata, setScanMetadata] = useState<SkillScanMetadata | null>(null)
  const [scanProjection, setScanProjection] = useState<SkillScanResponse | null>(null)
  const [query, setQuery] = useState(initialLocation.query)
  const [debouncedQuery, setDebouncedQuery] = useState(initialLocation.query)
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>(initialLocation.runtime)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(initialLocation.source)
  const [providerFilter, setProviderFilter] = useState(initialLocation.provider)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialLocation.status)
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>(initialLocation.attention)
  const [nominationStatus, setNominationStatus] = useState<Record<string, 'busy' | 'done' | 'failed'>>({})
  const [selectedConflict, setSelectedConflict] = useState<InstalledSkill | null>(null)
  const [page, setPage] = useState(initialLocation.page)
  const scanRequest = useRef(0)
  const serverDriven = useRef<boolean | null>(null)

  const nominate = async (skill: InstalledSkill) => {
    const sourceRef = `local-scan:${skill.runtime}:${skill.sourcePath}`
    const key = nominationKey(skill)
    setNominationStatus((current) => ({ ...current, [key]: 'busy' }))
    try {
      const response = await fetch('/api/capabilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRef }),
      })
      if (!response.ok) throw new Error('Nomination failed')
      setNominationStatus((current) => ({ ...current, [key]: 'done' }))
    } catch {
      setNominationStatus((current) => ({ ...current, [key]: 'failed' }))
    }
  }

  const scan = useCallback(async (refresh = false) => {
    if (!refresh && (serverDriven.current === false || query !== debouncedQuery)) return
    const requestId = ++scanRequest.current
    setScanStatus('scanning')
    try {
      const response = await fetch(serverDriven.current === false
        ? '/api/scan'
        : registryScanPath({
          query: refresh ? query : debouncedQuery,
          runtime: runtimeFilter,
          source: sourceFilter,
          provider: providerFilter,
          status: statusFilter,
          attention: attentionFilter,
          page,
        }, refresh), { method: 'POST' })
      if (!response.ok) throw new Error('Scan failed')
      const result = await response.json() as Partial<SkillScanResponse> | Array<Partial<InstalledSkill>>
      const definitions = Array.isArray(result) ? result : result.definitions
      if (!Array.isArray(definitions)) throw new Error('Scan returned an invalid response')
      if (requestId !== scanRequest.current) return
      const projected = !Array.isArray(result) && result.page && result.aggregates && result.definitionIssues && result.sharedDefinitionKeys
        ? result as SkillScanResponse
        : null
      serverDriven.current = projected !== null
      setScannedSkills(definitions.map(normalizeInstalledSkill))
      setScanProjection(projected)
      setScanMetadata(Array.isArray(result) ? null : result.scan ?? null)
      if (projected && projected.page.page !== page) setPage(projected.page.page)
      setScanStatus('complete')
    } catch {
      if (requestId === scanRequest.current) setScanStatus('failed')
    }
  }, [attentionFilter, debouncedQuery, page, providerFilter, query, runtimeFilter, sourceFilter, statusFilter])

  useEffect(() => { void scan() }, [scan])
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 200)
    return () => window.clearTimeout(timeout)
  }, [query])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (query) params.set('query', query)
    else params.delete('query')
    if (runtimeFilter !== 'all') params.set('runtime', runtimeFilter)
    else params.delete('runtime')
    if (sourceFilter !== 'all') params.set('source', sourceFilter)
    else params.delete('source')
    if (providerFilter !== 'all') params.set('provider', providerFilter)
    else params.delete('provider')
    if (statusFilter !== 'enabled') params.set('status', statusFilter)
    else params.delete('status')
    if (attentionFilter !== 'all') params.set('attention', attentionFilter)
    else params.delete('attention')
    if (page > 1) params.set('page', String(page))
    else params.delete('page')
    const pathname = registryPathnames.has(window.location.pathname) ? window.location.pathname : '/assets'
    const next = `${pathname}${params.size ? `?${params}` : ''}`
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState({}, '', next)
  }, [attentionFilter, page, providerFilter, query, runtimeFilter, sourceFilter, statusFilter])
  useEffect(() => {
    const restoreLocation = () => {
      const restored = readRegistryLocation()
      setQuery(restored.query)
      setRuntimeFilter(restored.runtime)
      setSourceFilter(restored.source)
      setProviderFilter(restored.provider)
      setStatusFilter(restored.status)
      setAttentionFilter(restored.attention)
      setPage(restored.page)
    }
    window.addEventListener('popstate', restoreLocation)
    return () => window.removeEventListener('popstate', restoreLocation)
  }, [])


  const rows = useMemo(() => [...(scannedSkills ?? [])], [scannedSkills])
  const allEnabledDefinitions = useMemo(() => rows.filter((row) => row.enabled), [rows])
  const allEnabledSkills = useMemo(() => allEnabledDefinitions.filter((row) => row.kind === 'skill'), [allEnabledDefinitions])
  const clientRuntimeStats = useMemo(() => runtimeOrder.map((runtime) => {
    const definitions = allEnabledDefinitions.filter((row) => row.runtime === runtime)
    return {
      runtime,
      count: definitions.length,
      unique: new Set(definitions.filter((row) => row.kind === 'skill').map((row) => normalizedSkillId(row.skillId))).size,
      sources: countBy(definitions, sourceOrder, (row) => row.source),
    }
  }), [allEnabledDefinitions])
  const runtimeStats = scanProjection?.aggregates.runtimes ?? clientRuntimeStats
  const legacySharedSkillIds = useMemo(() => {
    const runtimeBySkill = new Map<string, Set<Runtime>>()
    allEnabledSkills.forEach((row) => {
      const skillId = normalizedSkillId(row.skillId)
      const runtimes = runtimeBySkill.get(skillId) ?? new Set<Runtime>()
      runtimes.add(row.runtime)
      runtimeBySkill.set(skillId, runtimes)
    })
    return new Set([...runtimeBySkill].filter(([, runtimes]) => runtimes.size > 1).map(([skillId]) => skillId))
  }, [allEnabledSkills])
  const sharedDefinitionKeys = useMemo(() => new Set(scanProjection?.sharedDefinitionKeys ?? []), [scanProjection])
  const isShared = useCallback((row: InstalledSkill) => scanProjection
    ? sharedDefinitionKeys.has(definitionKey(row))
    : legacySharedSkillIds.has(normalizedSkillId(row.skillId)), [legacySharedSkillIds, scanProjection, sharedDefinitionKeys])
  const sharedSkillCount = scanProjection?.aggregates.sharedSkillCount ?? legacySharedSkillIds.size
  const allEnabledDefinitionCount = scanProjection?.aggregates.enabledDefinitionCount ?? allEnabledDefinitions.length
  const issueByDefinition = useMemo(() => scanProjection
    ? new Map(Object.entries(scanProjection.definitionIssues)
      .map(([key, issues]) => [key, new Set<InventoryIssue>(issues)]))
    : buildInventoryIssues(rows), [rows, scanProjection])
  const issuesFor = useCallback((row: InstalledSkill) => issuesForDefinition(issueByDefinition, row), [issueByDefinition])
  const clientAttentionCounts = useMemo(
    () => countInventoryIssues(rows, issueByDefinition, runtimeFilter),
    [issueByDefinition, rows, runtimeFilter],
  )
  const attentionCounts = scanProjection?.aggregates.attention ?? clientAttentionCounts
  const scopeRows = useMemo(() => rows.filter((row) => runtimeFilter === 'all' || row.runtime === runtimeFilter), [rows, runtimeFilter])
  const enabledSkills = useMemo(() => scopeRows.filter((row) => row.kind === 'skill' && row.enabled), [scopeRows])
  const enabledDefinitions = useMemo(() => scopeRows.filter((row) => row.enabled), [scopeRows])
  const categoryDefinitions = useMemo(() => scopeRows.filter((row) =>
    (statusFilter === 'all' || (statusFilter === 'enabled' ? row.enabled : !row.enabled))), [scopeRows, statusFilter])
  const uniqueSkills = useMemo(() => new Set(enabledSkills.map((row) => normalizedSkillId(row.skillId))).size, [enabledSkills])
  const pluginSkills = useMemo(() => enabledSkills.filter((row) => row.source === 'plugin').length, [enabledSkills])
  const disabledSkills = useMemo(() => scopeRows.filter((row) => row.kind === 'skill' && !row.enabled).length, [scopeRows])
  const clientSourceCounts = useMemo(() => countBy(categoryDefinitions, sourceOrder, (row) => row.source), [categoryDefinitions])
  const sourceCounts = scanProjection?.aggregates.sources ?? clientSourceCounts
  const providerRows = useMemo(() => categoryDefinitions.filter((row) => sourceFilter === 'all' || row.source === sourceFilter), [categoryDefinitions, sourceFilter])
  const clientProviders = useMemo(() => [...new Set(providerRows.map((row) => row.provider))].sort(), [providerRows])
  const clientProviderCounts = useMemo(() => clientProviders
    .map((provider) => ({ provider, count: providerRows.filter((row) => row.provider === provider).length }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count || left.provider.localeCompare(right.provider)), [clientProviders, providerRows])
  const providerCounts = scanProjection?.aggregates.providers ?? clientProviderCounts
  const providers = useMemo(() => providerCounts.map((item) => item.provider), [providerCounts])

  const filteredRows = useMemo(() => {
    if (scanProjection) return rows
    const needle = query.trim().toLowerCase()
    return rows.filter((row) =>
      (runtimeFilter === 'all' || row.runtime === runtimeFilter) &&
      (sourceFilter === 'all' || row.source === sourceFilter) &&
      (providerFilter === 'all' || row.provider === providerFilter) &&
      (statusFilter === 'all' || (statusFilter === 'enabled' ? row.enabled : !row.enabled)) &&
      (attentionFilter === 'all' || (attentionFilter === 'attention' ? issuesFor(row).size > 0 : issuesFor(row).has(attentionFilter))) &&
      (!needle || `${row.skillId} ${row.provider} ${displayProvider(row.provider)} ${row.sourcePath}`.toLowerCase().includes(needle)))
      .sort((left, right) => runtimeOrder.indexOf(left.runtime) - runtimeOrder.indexOf(right.runtime) ||
        Number(right.enabled) - Number(left.enabled) || left.skillId.localeCompare(right.skillId) || left.sourcePath.localeCompare(right.sourcePath))
  }, [attentionFilter, displayProvider, issuesFor, providerFilter, query, rows, runtimeFilter, scanProjection, sourceFilter, statusFilter])

  const totalItems = scanProjection?.page.totalItems ?? filteredRows.length
  const totalDefinitions = scanProjection?.aggregates.totalDefinitions ?? rows.length
  const totalPages = scanProjection?.page.totalPages ?? Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const currentPage = scanProjection?.page.page ?? Math.min(page, totalPages)
  const pagedRows = useMemo(() => scanProjection
    ? filteredRows
    : filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [currentPage, filteredRows, scanProjection])
  const visibleRuntimeCounts = useMemo(() => new Map(scanProjection
    ? scanProjection.aggregates.visibleRuntimes.map((item) => [item.runtime, item.count])
    : runtimeOrder.map((runtime) => [runtime, filteredRows.filter((row) => row.runtime === runtime).length])), [filteredRows, scanProjection])
  const scopeLabel = runtimeFilter === 'all' ? t('registry.combined') : runtimeLabel[runtimeFilter]

  useEffect(() => {
    if (!scanProjection && scanStatus === 'complete' && page > totalPages) setPage(totalPages)
  }, [page, scanProjection, scanStatus, totalPages])

  const selectRuntime = (runtime: RuntimeFilter) => {
    setRuntimeFilter(runtime)
    setSourceFilter('all')
    setProviderFilter('all')
    setPage(1)
  }

  const metrics = [
    { label: t('registry.availableSkills'), value: scanProjection?.aggregates.metrics.uniqueEnabledSkills ?? uniqueSkills, note: t('registry.uniqueEnabled') },
    { label: t('registry.enabledDefinitions'), value: scanProjection?.aggregates.metrics.enabledDefinitions ?? enabledDefinitions.length, note: t('registry.filesAvailable') },
    { label: t('registry.pluginSkills'), value: scanProjection?.aggregates.metrics.pluginEnabledSkills ?? pluginSkills, note: t('registry.enabledPluginDefinitions') },
    { label: t('registry.disabledSkills'), value: scanProjection?.aggregates.metrics.disabledSkills ?? disabledSkills, note: t('registry.installedDisabled') },
  ]
  const attentionItems: Array<{ value: AttentionFilter; label: string; count: number; note: string }> = [
    { value: 'attention', label: t('registry.needsAttention'), count: attentionCounts.attention, note: t('registry.attentionNote') },
    { value: 'conflict', label: t('registry.versionConflicts'), count: attentionCounts.conflict, note: t('registry.conflictNote') },
    { value: 'duplicate', label: t('registry.duplicateDefinitions'), count: attentionCounts.duplicate, note: t('registry.duplicateNote') },
    { value: 'disabled', label: t('common.disabled'), count: attentionCounts.disabled, note: t('registry.disabledNote') },
    { value: 'missing', label: t('registry.missingMetadata'), count: attentionCounts.missing, note: t('registry.missingNote') },
  ]

  if (selectedConflict) return <ConflictDetailPage skill={selectedConflict} onBack={() => setSelectedConflict(null)} onChanged={() => void scan(true)} />

  return (
    <div className="single-page registry-page">
      <div className="page-intro">
        <div><h2>{t('registry.inventoryTitle')}</h2><p>{t('registry.inventoryDescription')}</p></div>
        <button className="button secondary" type="button" disabled={scanStatus === 'scanning'} onClick={() => void scan(true)}>
          <RefreshCw size={15} className={scanStatus === 'scanning' ? 'spin' : ''} />
          {scanStatus === 'scanning' ? t('registry.scanning') : scanStatus === 'failed' ? t('registry.retry') : t('registry.scanAgain')}
        </button>
      </div>

      <ArtifactRegistry refreshToken={scanMetadata?.id} />

      {scanMetadata ? (
        <section className="panel registry-scan-summary" aria-label={t('registry.scanSummary')}>
          <header>
            <div><span>{t('registry.scanSummary')}</span><strong className="mono">{scanMetadata.id}</strong></div>
            <b>{t('registry.scanDuration', { duration: formatNumber(scanMetadata.durationMs) })}</b>
          </header>
          <div><span>{t('registry.projectRoot')}</span><code>{scanMetadata.projectRoot}</code></div>
          <footer>
            {scanMetadata.observability.some((item) => item.state === 'partial') ? <span title={scanMetadata.observability.find((item) => item.state === 'partial')?.reason}>{t('registry.partiallyObservable')}</span> : null}
            {scanMetadata.errors.length ? <span>{t('registry.scanErrors', { count: formatNumber(scanMetadata.errors.length) })}</span> : null}
          </footer>
        </section>
      ) : null}

      <section className="registry-runtime-workspaces" aria-label={t('registry.workspaces')}>
        <header>
          <div><span>{t('registry.primaryView')}</span><h3>{t('registry.workspaces')}</h3></div>
          <p>{t('registry.workspaceDescription')}</p>
        </header>
        <div className="runtime-workspace-grid">
          <button className={`runtime-workspace-card runtime-all ${runtimeFilter === 'all' ? 'is-selected' : ''}`} type="button" aria-pressed={runtimeFilter === 'all'} aria-label={t('registry.showCombined', { count: formatNumber(allEnabledDefinitionCount) })} onClick={() => selectRuntime('all')}>
            <span className="runtime-workspace-icon"><RuntimeIcon runtime="all" /></span>
            <span className="runtime-workspace-copy"><strong>{t('registry.combined')}</strong><small>{t('common.allRuntimes')}</small></span>
            <b>{formatNumber(allEnabledDefinitionCount)}</b>
            <span className="runtime-workspace-meta">{t('registry.sharedNames', { count: formatNumber(sharedSkillCount), unit: t(sharedSkillCount === 1 ? 'registry.name' : 'registry.names') })}</span>
          </button>
          {runtimeStats.map((item) => (
            <button className={`runtime-workspace-card runtime-${item.runtime} ${runtimeFilter === item.runtime ? 'is-selected' : ''}`} type="button" key={item.runtime} disabled={item.count === 0} aria-pressed={runtimeFilter === item.runtime} aria-label={t('registry.showRuntime', { runtime: runtimeLabel[item.runtime], count: formatNumber(item.count) })} onClick={() => selectRuntime(item.runtime)}>
              <span className="runtime-workspace-icon"><RuntimeIcon runtime={item.runtime} /></span>
              <span className="runtime-workspace-copy"><strong>{runtimeLabel[item.runtime]}</strong><small>{t('registry.uniqueSkills', { count: formatNumber(item.unique) })}</small></span>
              <b>{formatNumber(item.count)}</b>
              <span className="runtime-workspace-meta">{item.sources.filter((source) => source.count > 0).map((source) => `${t(sourceLabel[source.value])} ${formatNumber(source.count)}`).join(' · ') || t('common.noDefinitionsFound')}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="registry-summary" aria-label={t('registry.totals')}>
        {metrics.map((metric) => <div className="registry-metric" data-metric={metric.label} key={metric.label}><span>{metric.label}</span><strong>{formatNumber(metric.value)}</strong><p>{metric.note} · {scopeLabel}</p></div>)}
      </section>

      <section className="registry-health" aria-labelledby="registry-health-title">
        <header><div><span>{t('registry.health')}</span><h3 id="registry-health-title">{t('registry.needsAttention')}</h3></div><button type="button" className={attentionFilter === 'all' ? 'is-selected' : ''} onClick={() => { setAttentionFilter('all'); setPage(1) }}>{t('registry.showAllDefinitions')}</button></header>
        <div>{attentionItems.map((item) => <button type="button" className={attentionFilter === item.value ? 'is-selected' : ''} aria-pressed={attentionFilter === item.value} key={item.value} onClick={() => { setAttentionFilter((current) => current === item.value ? 'all' : item.value); setStatusFilter('all'); setPage(1) }}><span><strong>{item.label}</strong><b>{formatNumber(item.count)}</b></span><small>{item.note}</small></button>)}</div>
      </section>

      {scanStatus === 'failed' ? <div className="registry-warning" role="alert">{t(scannedSkills ? 'registry.scanFailedKeep' : 'registry.scanFailedFallback')}</div> : null}
      {scanProjection?.sourceStatus === 'partial' ? <div className="registry-warning" role="alert">{t('cc.partial')}</div> : null}

      <div className="registry-categories">
        <CategoryPanel title={t('registry.bySource')} items={sourceCounts.map((item) => ({
          ...item,
          label: t(sourceLabel[item.value]),
          selected: sourceFilter === item.value,
          onSelect: () => {
            setSourceFilter((current) => current === item.value ? 'all' : item.value)
            setProviderFilter('all')
            setPage(1)
          },
        }))} />
      </div>

      <section className="panel provider-panel">
        <div><h3>{t('registry.byProvider')}</h3><span>{t('registry.statusDefinitions', { scope: scopeLabel, status: t(statusFilter === 'all' ? 'common.all' : statusFilter === 'enabled' ? 'common.enabled' : 'common.disabled') })}</span></div>
        <div className="provider-pills">
          {providerCounts.map((item) => <button className={providerFilter === item.provider ? 'is-selected' : ''} type="button" key={item.provider} onClick={() => { setProviderFilter((current) => current === item.provider ? 'all' : item.provider); setPage(1) }} aria-pressed={providerFilter === item.provider}><span>{displayProvider(item.provider)}</span><strong>{formatNumber(item.count)}</strong></button>)}
        </div>
      </section>

      <section className="panel registry-table-wrap">
        <div className="registry-table-heading">
          <div><span>{t('registry.definitionInventory')}</span><h3>{t('registry.scopeInventory', { scope: scopeLabel })}</h3></div>
          <strong>{t('registry.inventoryShown', { scope: scopeLabel, count: formatNumber(totalItems) })}</strong>
        </div>
        <header className="registry-toolbar">
          <label className="search-control"><Search size={14} /><input aria-label={t('registry.search')} type="search" placeholder={t('registry.search')} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} /></label>
          <label><span>{t('common.source')}</span><select aria-label={t('registry.sourceLabel')} value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value as SourceFilter); setProviderFilter('all'); setPage(1) }}><option value="all">{t('common.allSources')}</option>{sourceOrder.map((source) => <option value={source} key={source}>{t(sourceLabel[source])}</option>)}</select></label>
          <label><span>{t('common.provider')}</span><select aria-label={t('registry.providerLabel')} value={providerFilter} onChange={(event) => { setProviderFilter(event.target.value); setPage(1) }}><option value="all">{t('common.allProviders')}</option>{providers.map((provider) => <option value={provider} key={provider}>{displayProvider(provider)}</option>)}</select></label>
          <label><span>{t('common.status')}</span><select aria-label={t('registry.statusLabel')} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as StatusFilter); setProviderFilter('all'); setPage(1) }}><option value="enabled">{t('common.enabled')}</option><option value="disabled">{t('common.disabled')}</option><option value="all">{t('common.allStatuses')}</option></select></label>
          <span className="registry-result-count">{t('registry.resultCount', { shown: formatNumber(totalItems), scanned: formatNumber(totalDefinitions) })}</span>
        </header>
        <div className="registry-table-scroll">
          <table className="registry-table">
            <caption className="sr-only">{t('registry.scopeInventory', { scope: scopeLabel })}</caption>
            <thead><tr><th>{t('common.skill')}</th><th>{t('common.type')}</th><th>{t('common.version')}</th><th>{t('common.runtime')}</th><th>{t('common.category')}</th><th>{t('registry.configurationSource')}</th><th>{t('common.provider')}</th><th>{t('common.location')}</th><th>{t('common.status')}</th><th>{t('registry.governance')}</th></tr></thead>
            <tbody>
              {pagedRows.map((skill, index) => {
                const nomination = nominationStatus[nominationKey(skill)]
                const definitionStatus = skill.status ?? (skill.enabled ? 'active' : 'disabled')
                const configurationSource = skill.configurationSource ?? (skill.source === 'plugin' ? 'plugin' : skill.source === 'project' ? 'project' : 'user')
                return <Fragment key={definitionKey(skill)}>
                  {runtimeFilter === 'all' && pagedRows[index - 1]?.runtime !== skill.runtime ? <tr className={`registry-runtime-group runtime-${skill.runtime}`}><th scope="rowgroup" colSpan={10}><span className="registry-runtime-badge"><RuntimeIcon runtime={skill.runtime} />{runtimeLabel[skill.runtime]}</span><strong>{t('registry.runtimeGroup', { runtime: runtimeLabel[skill.runtime], count: formatNumber(visibleRuntimeCounts.get(skill.runtime) ?? 0) })}</strong></th></tr> : null}
                  <tr className={definitionStatus === 'active' ? '' : `is-${definitionStatus}`}>
                    <td><span className="registry-skill-name"><strong>{skill.skillId}</strong>{runtimeFilter === 'all' && isShared(skill) ? <span className="shared-skill">{t('registry.shared')}</span> : null}{[...issuesFor(skill)].map((issue) => <span className={`registry-issue ${issue}`} key={issue}>{t(issueLabel[issue])}</span>)}</span></td>
                    <td>{t(kindLabel[skill.kind])}</td>
                    <td><span className="version">{skill.skillVersion === 'unversioned' ? t('common.unversioned') : skill.skillVersion}</span></td>
                    <td><span className={`registry-runtime-badge runtime-${skill.runtime}`}><RuntimeIcon runtime={skill.runtime} />{runtimeLabel[skill.runtime]}</span></td>
                    <td>{t(sourceLabel[skill.source])}</td>
                    <td>{t(configurationSourceLabel[configurationSource])}</td>
                    <td>{displayProvider(skill.provider)}</td>
                    <td className="mono source-path" title={skill.sourcePath}>{skill.sourcePath === 'Unknown location' ? t('common.unknownLocation') : skill.sourcePath}</td>
                    <td><span className={`registry-status ${definitionStatus}`} title={skill.shadowedBy || (!skill.enabled && skill.disabledReason ? t(disabledReasonLabel[skill.disabledReason]) : undefined)}>{definitionStatus === 'active' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{t(definitionStatusLabel[definitionStatus])}{!skill.enabled && skill.disabledReason ? <small>{t(disabledReasonLabel[skill.disabledReason])}</small> : null}</span></td>
                    <td><div className="registry-actions"><button className="button secondary registry-nominate" type="button" disabled={definitionStatus !== 'active' || skill.kind !== 'skill' || skill.sourcePath === 'Unknown location' || nomination === 'busy' || nomination === 'done'} onClick={() => void nominate(skill)}><GitPullRequest size={13} />{t(nomination === 'done' ? 'registry.nominated' : nomination === 'busy' ? 'registry.nominating' : nomination === 'failed' ? 'registry.retryNomination' : 'registry.nominate')}</button>{issuesFor(skill).size ? <button className="button secondary registry-conflict-details" type="button" onClick={() => setSelectedConflict(skill)}>{t('registry.conflictDetails')}</button> : null}</div></td>
                  </tr>
                </Fragment>
              })}
              {!totalItems ? <tr><td className="registry-empty" colSpan={10}>{scanStatus === 'scanning' ? t('registry.scanningLocations') : t('registry.noMatches')}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && <nav className="runs-pagination-bar registry-pagination" aria-label={t('common.pageOf', { page: formatNumber(currentPage), count: formatNumber(totalPages) })}><div className="pagination-controls"><button type="button" aria-label={t('common.previousPage')} disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span role="status">{t('common.pageOf', { page: formatNumber(currentPage), count: formatNumber(totalPages) })}</span><button type="button" aria-label={t('common.nextPage')} disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={15} /></button></div></nav>}
      </section>
    </div>
  )
}
