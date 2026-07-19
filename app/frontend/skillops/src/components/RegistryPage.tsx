import { Bot, CheckCircle2, Code2, Layers3, MousePointer2, RefreshCw, Search, XCircle } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { runtimeLabel } from '../lib/analytics'
import type { InstalledSkill, Runtime, SkillEvent } from '../types'

type AttentionFilter = 'all' | 'attention' | 'conflict' | 'duplicate' | 'disabled' | 'missing'

const sourceLabel: Record<InstalledSkill['source'], string> = {
  global: 'Global',
  project: 'Project',
  plugin: 'Plugin',
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
  const maximum = Math.max(1, ...items.map((item) => item.count))
  return (
    <section className="panel registry-category" aria-label={`${title} categories`}>
      <h3>{title}</h3>
      <div className="registry-category-list">
        {items.map((item) => (
          <button className={item.selected ? 'is-selected' : ''} type="button" key={item.value} onClick={item.onSelect} aria-pressed={item.selected}>
            <span><strong>{item.label}</strong><b>{item.count.toLocaleString()}</b></span>
            <i><span style={{ width: `${(item.count / maximum) * 100}%` }} /></i>
          </button>
        ))}
      </div>
    </section>
  )
}

export function RegistryPage({ events }: { events: SkillEvent[] }) {
  const [scannedSkills, setScannedSkills] = useState<InstalledSkill[] | null>(null)
  const [scanStatus, setScanStatus] = useState<'scanning' | 'complete' | 'failed'>('scanning')
  const [query, setQuery] = useState('')
  const [runtimeFilter, setRuntimeFilter] = useState<Runtime | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<InstalledSkill['source'] | 'all'>('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'enabled' | 'disabled' | 'all'>('enabled')
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>('all')

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

  const discovered = useMemo(() => [...new Map(events
    .filter((event) => event.event === 'skill.discovered' && Boolean(event.skillId))
    .map((event) => [`${event.runtime}:${event.skillId}:${event.sourcePath}`, fromEvent(event)])).values()], [events])

  const rows = useMemo(() => [...(scannedSkills ?? discovered)], [discovered, scannedSkills])
  const allEnabledDefinitions = useMemo(() => rows.filter((row) => row.enabled), [rows])
  const allEnabledSkills = useMemo(() => allEnabledDefinitions.filter((row) => row.kind === 'skill'), [allEnabledDefinitions])
  const runtimeStats = useMemo(() => runtimeOrder.map((runtime) => {
    const definitions = allEnabledDefinitions.filter((row) => row.runtime === runtime)
    return {
      runtime,
      count: definitions.length,
      unique: new Set(definitions.filter((row) => row.kind === 'skill').map((row) => row.skillId.toLowerCase())).size,
      sources: countBy(definitions, sourceOrder, (row) => row.source),
    }
  }), [allEnabledDefinitions])
  const sharedSkillIds = useMemo(() => {
    const runtimeBySkill = new Map<string, Set<Runtime>>()
    allEnabledSkills.forEach((row) => {
      const skillId = row.skillId.toLowerCase()
      const runtimes = runtimeBySkill.get(skillId) ?? new Set<Runtime>()
      runtimes.add(row.runtime)
      runtimeBySkill.set(skillId, runtimes)
    })
    return new Set([...runtimeBySkill].filter(([, runtimes]) => runtimes.size > 1).map(([skillId]) => skillId))
  }, [allEnabledSkills])
  const issueByDefinition = useMemo(() => {
    const issues = new Map<string, Set<Exclude<AttentionFilter, 'all' | 'attention'>>>()
    const definitionKey = (row: InstalledSkill) => `${row.runtime}:${row.skillId}:${row.sourcePath}`
    const add = (row: InstalledSkill, issue: Exclude<AttentionFilter, 'all' | 'attention'>) => {
      const key = definitionKey(row)
      const current = issues.get(key) ?? new Set()
      current.add(issue)
      issues.set(key, current)
    }
    const byRuntimeSkill = new Map<string, InstalledSkill[]>()
    rows.forEach((row) => {
      const key = `${row.runtime}:${row.skillId.toLowerCase()}`
      byRuntimeSkill.set(key, [...(byRuntimeSkill.get(key) ?? []), row])
      if (!row.enabled) add(row, 'disabled')
      if (row.sourcePath === 'Unknown location' || row.skillId === 'unknown-skill') add(row, 'missing')
    })
    byRuntimeSkill.forEach((definitions) => {
      if (definitions.length > 1) definitions.forEach((row) => add(row, 'duplicate'))
      if (new Set(definitions.map((row) => row.skillVersion)).size > 1) definitions.forEach((row) => add(row, 'conflict'))
    })
    return issues
  }, [rows])
  const issuesFor = (row: InstalledSkill) => issueByDefinition.get(`${row.runtime}:${row.skillId}:${row.sourcePath}`) ?? new Set()
  const attentionCounts = useMemo(() => {
    const definitions = rows.filter((row) => issueByDefinition.has(`${row.runtime}:${row.skillId}:${row.sourcePath}`))
    return {
      attention: definitions.length,
      conflict: definitions.filter((row) => issuesFor(row).has('conflict')).length,
      duplicate: definitions.filter((row) => issuesFor(row).has('duplicate')).length,
      disabled: definitions.filter((row) => issuesFor(row).has('disabled')).length,
      missing: definitions.filter((row) => issuesFor(row).has('missing')).length,
    }
  }, [issueByDefinition, rows])
  const scopeRows = useMemo(() => rows.filter((row) => runtimeFilter === 'all' || row.runtime === runtimeFilter), [rows, runtimeFilter])
  const enabledSkills = useMemo(() => scopeRows.filter((row) => row.kind === 'skill' && row.enabled), [scopeRows])
  const enabledDefinitions = useMemo(() => scopeRows.filter((row) => row.enabled), [scopeRows])
  const categoryDefinitions = useMemo(() => scopeRows.filter((row) =>
    (statusFilter === 'all' || (statusFilter === 'enabled' ? row.enabled : !row.enabled))), [scopeRows, statusFilter])
  const uniqueSkills = useMemo(() => new Set(enabledSkills.map((row) => row.skillId.toLowerCase())).size, [enabledSkills])
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
      (!needle || `${row.skillId} ${row.provider} ${row.sourcePath}`.toLowerCase().includes(needle)))
      .sort((left, right) => runtimeOrder.indexOf(left.runtime) - runtimeOrder.indexOf(right.runtime) ||
        Number(right.enabled) - Number(left.enabled) || left.skillId.localeCompare(right.skillId) || left.sourcePath.localeCompare(right.sourcePath))
  }, [attentionFilter, issueByDefinition, providerFilter, query, rows, runtimeFilter, sourceFilter, statusFilter])

  const visibleRuntimeCounts = useMemo(() => new Map(runtimeOrder.map((runtime) => [runtime, filteredRows.filter((row) => row.runtime === runtime).length])), [filteredRows])
  const scopeLabel = runtimeFilter === 'all' ? 'Combined' : runtimeLabel[runtimeFilter]

  const selectRuntime = (runtime: Runtime | 'all') => {
    setRuntimeFilter(runtime)
    setSourceFilter('all')
    setProviderFilter('all')
  }

  const metrics = [
    { label: 'Available Skills', value: uniqueSkills, note: 'unique enabled Skill names' },
    { label: 'Enabled definitions', value: enabledDefinitions.length, note: 'Skill and command files available' },
    { label: 'Plugin Skills', value: pluginSkills, note: 'enabled plugin definitions' },
    { label: 'Disabled Skills', value: disabledSkills, note: 'installed but explicitly disabled' },
  ]
  const attentionItems: Array<{ value: AttentionFilter; label: string; count: number; note: string }> = [
    { value: 'attention', label: 'Needs attention', count: attentionCounts.attention, note: 'definitions with at least one issue' },
    { value: 'conflict', label: 'Version conflicts', count: attentionCounts.conflict, note: 'same runtime and name, different versions' },
    { value: 'duplicate', label: 'Duplicate definitions', count: attentionCounts.duplicate, note: 'same runtime and Skill name' },
    { value: 'disabled', label: 'Disabled', count: attentionCounts.disabled, note: 'installed but not usable' },
    { value: 'missing', label: 'Missing metadata', count: attentionCounts.missing, note: 'unknown name or location' },
  ]

  return (
    <div className="single-page registry-page">
      <div className="page-intro">
        <div><h2>Installed Skill inventory</h2><p>Live filesystem scan across Codex, Claude Code, Cursor, project folders and plugin installations.</p></div>
        <button className="button secondary" type="button" disabled={scanStatus === 'scanning'} onClick={scan}>
          <RefreshCw size={15} className={scanStatus === 'scanning' ? 'spin' : ''} />
          {scanStatus === 'scanning' ? 'Scanning…' : scanStatus === 'failed' ? 'Retry scan' : 'Scan again'}
        </button>
      </div>

      <section className="registry-runtime-workspaces" aria-label="Runtime workspaces">
        <header>
          <div><span>Primary view</span><h3>Runtime workspaces</h3></div>
          <p>Choose a runtime first. Every total, source and provider below will stay inside that workspace.</p>
        </header>
        <div className="runtime-workspace-grid">
          <button className={`runtime-workspace-card runtime-all ${runtimeFilter === 'all' ? 'is-selected' : ''}`} type="button" aria-pressed={runtimeFilter === 'all'} aria-label={`Show combined inventory: ${allEnabledDefinitions.length} enabled definitions`} onClick={() => selectRuntime('all')}>
            <span className="runtime-workspace-icon"><RuntimeIcon runtime="all" /></span>
            <span className="runtime-workspace-copy"><strong>Combined</strong><small>All runtimes</small></span>
            <b>{allEnabledDefinitions.length.toLocaleString()}</b>
            <span className="runtime-workspace-meta">{sharedSkillIds.size.toLocaleString()} shared Skill {sharedSkillIds.size === 1 ? 'name' : 'names'}</span>
          </button>
          {runtimeStats.map((item) => (
            <button className={`runtime-workspace-card runtime-${item.runtime} ${runtimeFilter === item.runtime ? 'is-selected' : ''}`} type="button" key={item.runtime} disabled={item.count === 0} aria-pressed={runtimeFilter === item.runtime} aria-label={`Show ${runtimeLabel[item.runtime]} Skills: ${item.count} enabled definitions`} onClick={() => selectRuntime(item.runtime)}>
              <span className="runtime-workspace-icon"><RuntimeIcon runtime={item.runtime} /></span>
              <span className="runtime-workspace-copy"><strong>{runtimeLabel[item.runtime]}</strong><small>{item.unique.toLocaleString()} unique Skills</small></span>
              <b>{item.count.toLocaleString()}</b>
              <span className="runtime-workspace-meta">{item.sources.filter((source) => source.count > 0).map((source) => `${sourceLabel[source.value]} ${source.count}`).join(' · ') || 'No definitions found'}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="registry-summary" aria-label="Installed Skill totals">
        {metrics.map((metric) => <div className="registry-metric" data-metric={metric.label} key={metric.label}><span>{metric.label}</span><strong>{metric.value.toLocaleString()}</strong><p>{metric.note} · {scopeLabel}</p></div>)}
      </section>

      <section className="registry-health" aria-labelledby="registry-health-title">
        <header><div><span>Inventory health</span><h3 id="registry-health-title">Needs attention</h3></div><button type="button" className={attentionFilter === 'all' ? 'is-selected' : ''} onClick={() => setAttentionFilter('all')}>Show all definitions</button></header>
        <div>{attentionItems.map((item) => <button type="button" className={attentionFilter === item.value ? 'is-selected' : ''} aria-pressed={attentionFilter === item.value} key={item.value} onClick={() => { setAttentionFilter((current) => current === item.value ? 'all' : item.value); setStatusFilter('all') }}><span><strong>{item.label}</strong><b>{item.count}</b></span><small>{item.note}</small></button>)}</div>
      </section>

      {scanStatus === 'failed' ? <div className="registry-warning" role="alert">Live scan failed. {scannedSkills ? 'Keeping the last successful scan.' : 'Showing previously discovered event data where available.'}</div> : null}

      <div className="registry-categories">
        <CategoryPanel title="By installation source" items={sourceCounts.map((item) => ({
          ...item,
          label: sourceLabel[item.value],
          selected: sourceFilter === item.value,
          onSelect: () => {
            setSourceFilter((current) => current === item.value ? 'all' : item.value)
            setProviderFilter('all')
          },
        }))} />
      </div>

      <section className="panel provider-panel">
        <div><h3>By provider</h3><span>{scopeLabel} · {statusFilter === 'all' ? 'All' : statusFilter === 'enabled' ? 'Enabled' : 'Disabled'} definitions</span></div>
        <div className="provider-pills">
          {providerCounts.map((item) => <button className={providerFilter === item.provider ? 'is-selected' : ''} type="button" key={item.provider} onClick={() => setProviderFilter((current) => current === item.provider ? 'all' : item.provider)} aria-pressed={providerFilter === item.provider}><span>{item.provider}</span><strong>{item.count}</strong></button>)}
        </div>
      </section>

      <section className="panel registry-table-wrap">
        <div className="registry-table-heading">
          <div><span>Definition inventory</span><h3>{scopeLabel} inventory</h3></div>
          <strong>{scopeLabel} inventory · {filteredRows.length.toLocaleString()} shown</strong>
        </div>
        <header className="registry-toolbar">
          <label className="search-control"><Search size={14} /><input aria-label="Search installed Skills" type="search" placeholder="Search installed Skills" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span>Source</span><select aria-label="Registry source" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value as InstalledSkill['source'] | 'all'); setProviderFilter('all') }}><option value="all">All sources</option>{sourceOrder.map((source) => <option value={source} key={source}>{sourceLabel[source]}</option>)}</select></label>
          <label><span>Provider</span><select aria-label="Registry provider" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">All providers</option>{providers.map((provider) => <option value={provider} key={provider}>{provider}</option>)}</select></label>
          <label><span>Status</span><select aria-label="Registry status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as 'enabled' | 'disabled' | 'all'); setProviderFilter('all') }}><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="all">All statuses</option></select></label>
          <span className="registry-result-count">{filteredRows.length.toLocaleString()} shown · {rows.length.toLocaleString()} scanned</span>
        </header>
        <div className="registry-table-scroll">
          <table className="registry-table">
            <thead><tr><th>Skill</th><th>Type</th><th>Version</th><th>Runtime</th><th>Category</th><th>Provider</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              {filteredRows.map((skill, index) => <Fragment key={`${skill.runtime}:${skill.skillId}:${skill.sourcePath}`}>
                {runtimeFilter === 'all' && filteredRows[index - 1]?.runtime !== skill.runtime ? <tr className={`registry-runtime-group runtime-${skill.runtime}`}><th scope="rowgroup" colSpan={8}><span className="registry-runtime-badge"><RuntimeIcon runtime={skill.runtime} />{runtimeLabel[skill.runtime]}</span><strong>{runtimeLabel[skill.runtime]} · {visibleRuntimeCounts.get(skill.runtime)?.toLocaleString()} definitions</strong></th></tr> : null}
                <tr className={skill.enabled ? '' : 'is-disabled'}><td><span className="registry-skill-name"><strong>{skill.skillId}</strong>{runtimeFilter === 'all' && sharedSkillIds.has(skill.skillId.toLowerCase()) ? <span className="shared-skill">Shared</span> : null}{[...issuesFor(skill)].map((issue) => <span className={`registry-issue ${issue}`} key={issue}>{issue}</span>)}</span></td><td>{skill.kind === 'command' ? 'Command' : 'Skill'}</td><td><span className="version">{skill.skillVersion}</span></td><td><span className={`registry-runtime-badge runtime-${skill.runtime}`}><RuntimeIcon runtime={skill.runtime} />{runtimeLabel[skill.runtime]}</span></td><td>{sourceLabel[skill.source]}</td><td>{skill.provider}</td><td className="mono source-path" title={skill.sourcePath}>{skill.sourcePath}</td><td><span className={`registry-status ${skill.enabled ? '' : 'disabled'}`}>{skill.enabled ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{skill.enabled ? 'Enabled' : 'Disabled'}</span></td></tr>
              </Fragment>)}
              {!filteredRows.length ? <tr><td className="registry-empty" colSpan={8}>{scanStatus === 'scanning' ? 'Scanning local Skill locations…' : 'No installed definitions match these filters.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
