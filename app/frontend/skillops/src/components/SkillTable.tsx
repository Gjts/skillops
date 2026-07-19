import { Bot, Box, ChevronDown, ChevronRight, Code2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { skillDefinitionById, skillRegistry } from '../data/seed'
import { bySkill, formatDuration, runtimeLabel } from '../lib/analytics'
import type { Runtime, SkillEvent } from '../types'
import { Sparkline } from './Charts'

const runtimeIcon: Record<Runtime, typeof Code2> = { codex: Code2, 'claude-code': Bot, cursor: Box }

interface SkillTableProps {
  events: SkillEvent[]
  definitionEvents?: SkillEvent[]
  limit?: number
  searchable?: boolean
  days?: number
  demo?: boolean
  onViewRun?: (runId: string) => void
}

export function SkillTable({ events, definitionEvents = events, limit, searchable = false, days = 7, demo = false, onViewRun }: SkillTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const metrics = useMemo(() => bySkill(events, days), [events, days])
  const discoveredByKey = useMemo(() => {
    const definitions = new Map<string, SkillEvent[]>()
    definitionEvents.forEach((event) => {
      if (event.event !== 'skill.discovered' || !event.skillId) return
      const key = `${event.runtime}:${event.skillId}`
      definitions.set(key, [...(definitions.get(key) ?? []), event])
    })
    return definitions
  }, [definitionEvents])
  const matching = metrics.filter((metric) => metric.skillId.toLowerCase().includes(query.toLowerCase()))
  const visible = limit === undefined ? matching : matching.slice(0, limit)

  return (
    <section className="panel skill-table-panel">
      <header className="panel-header table-header">
        <div><h2>Skill performance</h2><span>{metrics.length} active Skills observed in this period</span></div>
        {searchable && <label className="search-control"><Search size={15} /><input aria-label="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" /></label>}
      </header>
      <div className="table-scroll">
        <table className="skill-table">
          <thead><tr><th aria-label="Expand" /><th>Skill <span className="sort">↑</span></th><th>Version</th><th>Primary runtime</th><th>Runs <span className="sort">↓</span></th><th>Success</th><th>Cost</th><th>Trend</th></tr></thead>
          <tbody>
            {visible.map((metric) => {
              const seedDefinition = demo ? skillDefinitionById.get(metric.skillId) : undefined
              const discovered = discoveredByKey.get(metric.key) ?? []
              const definition = seedDefinition ? {
                description: seedDefinition.description,
                tags: seedDefinition.tags,
                paths: [seedDefinition.path],
              } : {
                description: discovered.find((event) => event.description)?.description ?? 'No description metadata was recorded for this local Skill.',
                tags: [...new Set(discovered.flatMap((event) => event.tags ?? [event.provider, event.source]).filter(Boolean) as string[])],
                paths: [...new Set(discovered.map((event) => event.sourcePath).filter(Boolean) as string[])],
              }
              if (!definition.tags.length) definition.tags = [metric.runtime]
              if (!definition.paths.length) definition.paths = ['Observed from local runtime events']
              const Icon = runtimeIcon[metric.runtime]
              const isExpanded = expanded === metric.key
              return (
                <SkillRows
                  key={metric.key}
                  metric={metric}
                  definition={definition}
                  Icon={Icon}
                  expanded={isExpanded}
                  onToggle={() => setExpanded(isExpanded ? null : metric.key)}
                  onViewRun={onViewRun}
                />
              )
            })}
            {!visible.length && <tr><td className="registry-empty" colSpan={8}>No Skill runs were observed in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SkillRows({ metric, definition, Icon, expanded, onToggle, onViewRun }: {
  metric: ReturnType<typeof bySkill>[number]
  definition: Pick<(typeof skillRegistry)[number], 'description' | 'tags'> & { paths: string[] }
  Icon: typeof Code2
  expanded: boolean
  onToggle: () => void
  onViewRun?: (runId: string) => void
}) {
  return (
    <>
      <tr className={expanded ? 'is-expanded' : ''} onClick={onToggle} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
        <td><button type="button" aria-label={expanded ? 'Collapse Skill details' : 'Expand Skill details'} onClick={(event) => { event.stopPropagation(); onToggle() }}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></td>
        <td><strong>{metric.skillId}</strong></td>
        <td><span className="version">{metric.version}</span></td>
        <td><span className="runtime-cell"><Icon size={15} />{runtimeLabel[metric.runtime]}</span></td>
        <td>{metric.runs.toLocaleString()}</td>
        <td><span className={metric.successRate === null ? 'unknown-text' : metric.successRate >= 90 ? 'success-text' : 'warning-text'}>{metric.lifecycleOnly ? 'Lifecycle only' : metric.successRate === null ? 'Unknown' : `${metric.successRate.toFixed(1)}%`}</span></td>
        <td>${metric.cost.toFixed(2)}</td>
        <td><Sparkline values={metric.trend} /></td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={8}>
            <div className="skill-detail">
              <div><span>Description</span><p>{definition.description}</p></div>
              <div><span>Tags</span><p className="mono">{definition.tags.length ? definition.tags.join(', ') : 'No tags recorded'}</p></div>
              <div><span>Definition sources</span><div className="definition-paths">{definition.paths.map((path) => <p className="mono source-path" key={path}>{path}</p>)}</div></div>
              <div><span>Avg duration</span><p>{formatDuration(metric.avgDuration)}</p></div>
              <div><span>Known outcomes</span><p className={metric.knownOutcomes ? 'success-text' : 'unknown-text'}>{metric.knownOutcomes.toLocaleString()}</p></div>
              {onViewRun && <div className="skill-detail-action"><span>Latest activity</span><button className="button secondary" type="button" onClick={() => onViewRun(metric.latestRunId)}>View latest run</button></div>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
