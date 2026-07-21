import { Bot, CheckCircle2, Code2, GitPullRequest, Layers3, MousePointer2, RefreshCw, Search, XCircle } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import { runtimeLabel } from '../lib/analytics'
import { buildInventoryIssues, countInventoryIssues, definitionKey, issuesForDefinition, normalizedSkillId } from '../lib/skill-inventory'
import type { InstalledSkill, Runtime, SkillEvent } from '../types'

type AttentionFilter = 'all' | 'attention' | 'conflict' | 'duplicate' | 'disabled' | 'missing'

const sourceLabel: Record<InstalledSkill['source'], MessageKey> = {
  global: 'registry.global',
  project: 'registry.project',
  plugin: 'registry.plugin',
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

const runtimeOrder: Runtime[] = ['codex', 'claude-code', 'cursor']
const sourceOrder: InstalledSkill['source'][] = ['global', 'project', 'plugin']

function RuntimeIcon({ runtime }: { runtime: Runtime | 'all' }) {
  if (runtime === 'codex') return <Code2 size={18} />
  if (runtime === 'claude-code') return <Bot size={18} />
  if (runtime === 'cursor') return <MousePointer2 size={18} />
  return <Layers3 size={18} />
}

function fromEvent(event: SkillEvent): InstalledSkill {
  const source = event.source ?? 'global'
  return {
    skillId: event.skillId!,
    skillVersion: event.skillVersion ?? 'unversioned',
    runtime: event.runtime,
    source,
    sourcePath: event.sourcePath ?? 'Unknown location',
    provider: event.provider ?? (source === 'project' ? 'Project' : runtimeLabel[event.runtime]),
    kind: event.kind ?? 'skill',
    enabled: event.enabled ?? true,
    description: event.description,
    tags: event.tags,
  }
}

function normalizeInstalledSkill(skill: Partial<InstalledSkill>): InstalledSkill {
  const runtime = skill.runtime ?? 'codex'
  const source = skill.source ?? 'global'
  return {
    skillId: skill.skillId ?? 'unknown-skill',
    skillVersion: skill.skillVersion ?? 'unversioned',
    runtime,
    source,
    sourcePath: skill.sourcePath ?? 'Unknown location',
    provider: skill.provider ?? (source === 'project' ? 'Project' : runtimeLabel[runtime]),
    kind: skill.kind ?? 'skill',
    enabled: skill.enabled ?? true,
    disabledReason: skill.disabledReason,
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

export function RegistryPage({ events }: { events: SkillEvent[] }) {
  const { formatNumber, t } = useI18n()
  const displayProvider = useCallback((provider: string) => provider === 'Project' ? t('registry.project') : provider, [t])
  const [scannedSkills, setScannedSkills] = useState<InstalledSkill[] | null>(null)
  const [scanStatus, setScanStatus] = useState<'scanning' | 'complete' | 'failed'>('scanning')
  const [query, setQuery] = useState('')
  const [runtimeFilter, setRuntimeFilter] = useState<Runtime | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<InstalledSkill['source'] | 'all'>('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'enabled' | 'disabled' | 'all'>('enabled')
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>('all')
  const [nominationStatus, setNominationStatus] = useState<Record<string, 'busy' | 'done' | 'failed'>>({})

  const nominate = async (skill: InstalledSkill) => {
    const sourceRef = `local-scan:${skill.runtime}:${skill.sourcePath}`
    setNominationStatus((current) => ({ ...current, [sourceRef]: 'busy' }))
    try {
      const response = await fetch('/api/capabilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceRef, owner: 'local-owner' }),
      })
      if (!response.ok) throw new Error('Nomination failed')
      setNominationStatus((current) => ({ ...current, [sourceRef]: 'done' }))
    } catch {
      setNominationStatus((current) => ({ ...current, [sourceRef]: 'failed' }))
    }
  }

  const scan = useCallback(async () => {
    setScanStatus('scanning')
    try {
      const response = await fetch('/api/scan', { method: 'POST' })
      if (!response.ok) throw new Error('Scan failed')
      const result = await response.json() as Array<Partial<InstalledSkill>>
      if (!Array.isArray(result)) throw new Error('Scan returned an invalid response')
      setScannedSkills(result.map(normalizeInstalledSkill))
      setScanStatus('complete')
    } catch {
      setScanStatus('failed')
    }
  }, [])

  useEffect(() => { void scan() }, [scan])

  const discovered = useMemo(() => {
    const definitions = events
      .filter((event) => event.event === 'skill.discovered' && Boolean(event.skillId))
      .map(fromEvent)
    return [...new Map(definitions.map((definition) => [definitionKey(definition), definition])).values()]
  }, [events])

  const rows = useMemo(() => [...(scannedSkills ?? discovered)], [discovered, scannedSkills])
  const allEnabledDefinitions = useMemo(() => rows.filter((row) => row.enabled), [rows])
  const allEnabledSkills = useMemo(() => allEnabledDefinitions.filter((row) => row.kind === 'skill'), [allEnabledDefinitions])
  const runtimeStats = useMemo(() => runtimeOrder.map((runtime) => {
    const definitions = allEnabledDefinitions.filter((row) => row.runtime === runtime)
    return {
      runtime,
      count: definitions.length,
      unique: new Set(definitions.filter((row) => row.kind === 'skill').map((row) => normalizedSkillId(row.skillId))).size,
      sources: countBy(definitions, sourceOrder, (row) => row.source),
    }
  }), [allEnabledDefinitions])
  const sharedSkillIds = useMemo(() => {
    const runtimeBySkill = new Map<string, Set<Runtime>>()
    allEnabledSkills.forEach((row) => {
      const skillId = normalizedSkillId(row.skillId)
      const runtimes = runtimeBySkill.get(skillId) ?? new Set<Runtime>()
      runtimes.add(row.runtime)
      runtimeBySkill.set(skillId, runtimes)
    })
    return new Set([...runtimeBySkill].filter(([, runtimes]) => runtimes.size > 1).map(([skillId]) => skillId))
  }, [allEnabledSkills])
  const issueByDefinition = useMemo(() => buildInventoryIssues(rows), [rows])
  const issuesFor = useCallback((row: InstalledSkill) => issuesForDefinition(issueByDefinition, row), [issueByDefinition])
  const attentionCounts = useMemo(
    () => countInventoryIssues(rows, issueByDefinition, runtimeFilter),
    [issueByDefinition, rows, runtimeFilter],
  )
  const scopeRows = useMemo(() => rows.filter((row) => runtimeFilter === 'all' || row.runtime === runtimeFilter), [rows, runtimeFilter])
  const enabledSkills = useMemo(() => scopeRows.filter((row) => row.kind === 'skill' && row.enabled), [scopeRows])
  const enabledDefinitions = useMemo(() => scopeRows.filter((row) => row.enabled), [scopeRows])
  const categoryDefinitions = useMemo(() => scopeRows.filter((row) =>
    (statusFilter === 'all' || (statusFilter === 'enabled' ? row.enabled : !row.enabled))), [scopeRows, statusFilter])
  const uniqueSkills = useMemo(() => new Set(enabledSkills.map((row) => normalizedSkillId(row.skillId))).size, [enabledSkills])
  const pluginSkills = useMemo(() => enabledSkills.filter((row) => row.source === 'plugin').length, [enabledSkills])
  const disabledSkills = useMemo(() => scopeRows.filter((row) => row.kind === 'skill' && !row.enabled).length, [scopeRows])
  const sourceCounts = useMemo(() => countBy(categoryDefinitions, sourceOrder, (row) => row.source), [categoryDefinitions])
  const providerRows = useMemo(() => categoryDefinitions.filter((row) => sourceFilter === 'all' || row.source === sourceFilter), [categoryDefinitions, sourceFilter])
  const providers = useMemo(() => [...new Set(providerRows.map((row) => row.provider))].sort(), [providerRows])
  const providerCounts = useMemo(() => providers
    .map((provider) => ({ provider, count: providerRows.filter((row) => row.provider === provider).length }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count || left.provider.localeCompare(right.provider)), [providerRows, providers])

  const filteredRows = useMemo(() => {
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
  }, [attentionFilter, displayProvider, issuesFor, providerFilter, query, rows, runtimeFilter, sourceFilter, statusFilter])

  const visibleRuntimeCounts = useMemo(() => new Map(runtimeOrder.map((runtime) => [runtime, filteredRows.filter((row) => row.runtime === runtime).length])), [filteredRows])
  const scopeLabel = runtimeFilter === 'all' ? t('registry.combined') : runtimeLabel[runtimeFilter]

  const selectRuntime = (runtime: Runtime | 'all') => {
    setRuntimeFilter(runtime)
    setSourceFilter('all')
    setProviderFilter('all')
  }

  const metrics = [
    { label: t('registry.availableSkills'), value: uniqueSkills, note: t('registry.uniqueEnabled') },
    { label: t('registry.enabledDefinitions'), value: enabledDefinitions.length, note: t('registry.filesAvailable') },
    { label: t('registry.pluginSkills'), value: pluginSkills, note: t('registry.enabledPluginDefinitions') },
    { label: t('registry.disabledSkills'), value: disabledSkills, note: t('registry.installedDisabled') },
  ]
  const attentionItems: Array<{ value: AttentionFilter; label: string; count: number; note: string }> = [
    { value: 'attention', label: t('registry.needsAttention'), count: attentionCounts.attention, note: t('registry.attentionNote') },
    { value: 'conflict', label: t('registry.versionConflicts'), count: attentionCounts.conflict, note: t('registry.conflictNote') },
    { value: 'duplicate', label: t('registry.duplicateDefinitions'), count: attentionCounts.duplicate, note: t('registry.duplicateNote') },
    { value: 'disabled', label: t('common.disabled'), count: attentionCounts.disabled, note: t('registry.disabledNote') },
    { value: 'missing', label: t('registry.missingMetadata'), count: attentionCounts.missing, note: t('registry.missingNote') },
  ]

  return (
    <div className="single-page registry-page">
      <div className="page-intro">
        <div><h2>{t('registry.inventoryTitle')}</h2><p>{t('registry.inventoryDescription')}</p></div>
        <button className="button secondary" type="button" disabled={scanStatus === 'scanning'} onClick={scan}>
          <RefreshCw size={15} className={scanStatus === 'scanning' ? 'spin' : ''} />
          {scanStatus === 'scanning' ? t('registry.scanning') : scanStatus === 'failed' ? t('registry.retry') : t('registry.scanAgain')}
        </button>
      </div>

      <section className="registry-runtime-workspaces" aria-label={t('registry.workspaces')}>
        <header>
          <div><span>{t('registry.primaryView')}</span><h3>{t('registry.workspaces')}</h3></div>
          <p>{t('registry.workspaceDescription')}</p>
        </header>
        <div className="runtime-workspace-grid">
          <button className={`runtime-workspace-card runtime-all ${runtimeFilter === 'all' ? 'is-selected' : ''}`} type="button" aria-pressed={runtimeFilter === 'all'} aria-label={t('registry.showCombined', { count: formatNumber(allEnabledDefinitions.length) })} onClick={() => selectRuntime('all')}>
            <span className="runtime-workspace-icon"><RuntimeIcon runtime="all" /></span>
            <span className="runtime-workspace-copy"><strong>{t('registry.combined')}</strong><small>{t('common.allRuntimes')}</small></span>
            <b>{formatNumber(allEnabledDefinitions.length)}</b>
            <span className="runtime-workspace-meta">{t('registry.sharedNames', { count: formatNumber(sharedSkillIds.size), unit: t(sharedSkillIds.size === 1 ? 'registry.name' : 'registry.names') })}</span>
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
        <header><div><span>{t('registry.health')}</span><h3 id="registry-health-title">{t('registry.needsAttention')}</h3></div><button type="button" className={attentionFilter === 'all' ? 'is-selected' : ''} onClick={() => setAttentionFilter('all')}>{t('registry.showAllDefinitions')}</button></header>
        <div>{attentionItems.map((item) => <button type="button" className={attentionFilter === item.value ? 'is-selected' : ''} aria-pressed={attentionFilter === item.value} key={item.value} onClick={() => { setAttentionFilter((current) => current === item.value ? 'all' : item.value); setStatusFilter('all') }}><span><strong>{item.label}</strong><b>{formatNumber(item.count)}</b></span><small>{item.note}</small></button>)}</div>
      </section>

      {scanStatus === 'failed' ? <div className="registry-warning" role="alert">{t(scannedSkills ? 'registry.scanFailedKeep' : 'registry.scanFailedFallback')}</div> : null}

      <div className="registry-categories">
        <CategoryPanel title={t('registry.bySource')} items={sourceCounts.map((item) => ({
          ...item,
          label: t(sourceLabel[item.value]),
          selected: sourceFilter === item.value,
          onSelect: () => {
            setSourceFilter((current) => current === item.value ? 'all' : item.value)
            setProviderFilter('all')
          },
        }))} />
      </div>

      <section className="panel provider-panel">
        <div><h3>{t('registry.byProvider')}</h3><span>{t('registry.statusDefinitions', { scope: scopeLabel, status: t(statusFilter === 'all' ? 'common.all' : statusFilter === 'enabled' ? 'common.enabled' : 'common.disabled') })}</span></div>
        <div className="provider-pills">
          {providerCounts.map((item) => <button className={providerFilter === item.provider ? 'is-selected' : ''} type="button" key={item.provider} onClick={() => setProviderFilter((current) => current === item.provider ? 'all' : item.provider)} aria-pressed={providerFilter === item.provider}><span>{displayProvider(item.provider)}</span><strong>{formatNumber(item.count)}</strong></button>)}
        </div>
      </section>

      <section className="panel registry-table-wrap">
        <div className="registry-table-heading">
          <div><span>{t('registry.definitionInventory')}</span><h3>{t('registry.scopeInventory', { scope: scopeLabel })}</h3></div>
          <strong>{t('registry.inventoryShown', { scope: scopeLabel, count: formatNumber(filteredRows.length) })}</strong>
        </div>
        <header className="registry-toolbar">
          <label className="search-control"><Search size={14} /><input aria-label={t('registry.search')} type="search" placeholder={t('registry.search')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span>{t('common.source')}</span><select aria-label={t('registry.sourceLabel')} value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value as InstalledSkill['source'] | 'all'); setProviderFilter('all') }}><option value="all">{t('common.allSources')}</option>{sourceOrder.map((source) => <option value={source} key={source}>{t(sourceLabel[source])}</option>)}</select></label>
          <label><span>{t('common.provider')}</span><select aria-label={t('registry.providerLabel')} value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">{t('common.allProviders')}</option>{providers.map((provider) => <option value={provider} key={provider}>{displayProvider(provider)}</option>)}</select></label>
          <label><span>{t('common.status')}</span><select aria-label={t('registry.statusLabel')} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as 'enabled' | 'disabled' | 'all'); setProviderFilter('all') }}><option value="enabled">{t('common.enabled')}</option><option value="disabled">{t('common.disabled')}</option><option value="all">{t('common.allStatuses')}</option></select></label>
          <span className="registry-result-count">{t('registry.resultCount', { shown: formatNumber(filteredRows.length), scanned: formatNumber(rows.length) })}</span>
        </header>
        <div className="registry-table-scroll">
          <table className="registry-table">
            <thead><tr><th>Skill</th><th>{t('common.type')}</th><th>{t('common.version')}</th><th>{t('common.runtime')}</th><th>{t('common.category')}</th><th>{t('common.provider')}</th><th>{t('common.location')}</th><th>{t('common.status')}</th><th>{t('registry.governance')}</th></tr></thead>
            <tbody>
              {filteredRows.map((skill, index) => {
                const nomination = nominationStatus[`local-scan:${skill.runtime}:${skill.sourcePath}`]
                return <Fragment key={definitionKey(skill)}>
                  {runtimeFilter === 'all' && filteredRows[index - 1]?.runtime !== skill.runtime ? <tr className={`registry-runtime-group runtime-${skill.runtime}`}><th scope="rowgroup" colSpan={9}><span className="registry-runtime-badge"><RuntimeIcon runtime={skill.runtime} />{runtimeLabel[skill.runtime]}</span><strong>{t('registry.runtimeGroup', { runtime: runtimeLabel[skill.runtime], count: formatNumber(visibleRuntimeCounts.get(skill.runtime) ?? 0) })}</strong></th></tr> : null}
                  <tr className={skill.enabled ? '' : 'is-disabled'}><td><span className="registry-skill-name"><strong>{skill.skillId}</strong>{runtimeFilter === 'all' && sharedSkillIds.has(normalizedSkillId(skill.skillId)) ? <span className="shared-skill">{t('registry.shared')}</span> : null}{[...issuesFor(skill)].map((issue) => <span className={`registry-issue ${issue}`} key={issue}>{t(issueLabel[issue])}</span>)}</span></td><td>{t(skill.kind === 'command' ? 'common.command' : 'common.skill')}</td><td><span className="version">{skill.skillVersion === 'unversioned' ? t('common.unversioned') : skill.skillVersion}</span></td><td><span className={`registry-runtime-badge runtime-${skill.runtime}`}><RuntimeIcon runtime={skill.runtime} />{runtimeLabel[skill.runtime]}</span></td><td>{t(sourceLabel[skill.source])}</td><td>{displayProvider(skill.provider)}</td><td className="mono source-path" title={skill.sourcePath}>{skill.sourcePath === 'Unknown location' ? t('common.unknownLocation') : skill.sourcePath}</td><td><span className={`registry-status ${skill.enabled ? '' : 'disabled'}`} title={!skill.enabled && skill.disabledReason ? t(disabledReasonLabel[skill.disabledReason]) : undefined}>{skill.enabled ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{t(skill.enabled ? 'common.enabled' : 'common.disabled')}{!skill.enabled && skill.disabledReason ? <small>{t(disabledReasonLabel[skill.disabledReason])}</small> : null}</span></td><td><button className="button secondary registry-nominate" type="button" disabled={!skill.enabled || skill.kind !== 'skill' || skill.sourcePath === 'Unknown location' || nomination === 'busy' || nomination === 'done'} onClick={() => void nominate(skill)}><GitPullRequest size={13} />{t(nomination === 'done' ? 'registry.nominated' : nomination === 'busy' ? 'registry.nominating' : nomination === 'failed' ? 'registry.retryNomination' : 'registry.nominate')}</button></td></tr>
                </Fragment>
              })}
              {!filteredRows.length ? <tr><td className="registry-empty" colSpan={9}>{scanStatus === 'scanning' ? t('registry.scanningLocations') : t('registry.noMatches')}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
