import { Bot, Box, ChevronDown, ChevronRight, Code2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { skillDefinitionById, skillRegistry } from '../data/seed'
import { useI18n } from '../i18n/I18nProvider'
import { demoDescriptionKeys } from '../i18n/demo'
import { bySkill, runtimeLabel } from '../lib/analytics'
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
  const { formatNumber, t } = useI18n()
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
        <div><h2>{t('skills.performance')}</h2><span>{t('skills.activeCount', { count: formatNumber(metrics.length) })}</span></div>
        {searchable && <label className="search-control"><Search size={15} /><input aria-label={t('skills.search')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('skills.search')} /></label>}
      </header>
      <div className="table-scroll">
        <table className="skill-table">
          <thead><tr><th aria-label={t('skills.expand')} /><th>Skill <span className="sort">↑</span></th><th>{t('common.version')}</th><th>{t('skills.primaryRuntime')}</th><th>{t('nav.runs')} <span className="sort">↓</span></th><th>{t('skills.success')}</th><th>{t('common.cost')}</th><th>{t('charts.trend')}</th></tr></thead>
          <tbody>
            {visible.map((metric) => {
              const seedDefinition = demo ? skillDefinitionById.get(metric.skillId) : undefined
              const discovered = discoveredByKey.get(metric.key) ?? []
              const demoDescriptionKey = seedDefinition ? demoDescriptionKeys[seedDefinition.id] : undefined
              const definition = seedDefinition ? {
                description: demoDescriptionKey
                  ? t(demoDescriptionKey)
                  : t('demo.skill.teamCapability', { capability: seedDefinition.id.replaceAll('-', ' ') }),
                tags: seedDefinition.tags,
                paths: [seedDefinition.path],
              } : {
                description: discovered.find((event) => event.description)?.description ?? t('skills.noDescription'),
                tags: [...new Set(discovered.flatMap((event) => event.tags ?? [event.provider, event.source]).filter(Boolean) as string[])],
                paths: [...new Set(discovered.map((event) => event.sourcePath).filter(Boolean) as string[])],
              }
              if (!definition.tags.length) definition.tags = [metric.runtime]
              if (!definition.paths.length) definition.paths = [t('skills.observedSource')]
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
            {!visible.length && <tr><td className="registry-empty" colSpan={8}>{t('skills.noRuns')}</td></tr>}
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
  const { formatDuration, formatNumber, formatUsd, t } = useI18n()
  return (
    <>
      <tr className={expanded ? 'is-expanded' : ''} onClick={onToggle} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
        <td><button type="button" aria-label={expanded ? t('skills.collapse') : t('skills.expand')} onClick={(event) => { event.stopPropagation(); onToggle() }}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></td>
        <td><strong>{metric.skillId}</strong></td>
        <td><span className="version">{metric.version}</span></td>
        <td><span className="runtime-cell"><Icon size={15} />{runtimeLabel[metric.runtime]}</span></td>
        <td>{formatNumber(metric.runs)}</td>
        <td><span className={metric.successRate === null ? 'unknown-text' : metric.successRate >= 90 ? 'success-text' : 'warning-text'}>{metric.lifecycleOnly ? t('skills.lifecycleOnly') : metric.successRate === null ? t('common.unknown') : `${formatNumber(metric.successRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}</span></td>
        <td>{metric.costReportedRuns ? formatUsd(metric.cost) : t('common.notReported')}</td>
        <td><Sparkline values={metric.trend} /></td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={8}>
            <div className="skill-detail">
              <div><span>{t('skills.description')}</span><p>{definition.description}</p></div>
              <div><span>{t('skills.tags')}</span><p className="mono">{definition.tags.length ? definition.tags.join(', ') : t('common.noTags')}</p></div>
              <div><span>{t('skills.sources')}</span><div className="definition-paths">{definition.paths.map((path) => <p className="mono source-path" key={path}>{path}</p>)}</div></div>
              <div><span>{t('skills.avgDuration')}</span><p>{formatDuration(metric.avgDuration)}</p></div>
              <div><span>{t('skills.knownOutcomes')}</span><p className={metric.knownOutcomes ? 'success-text' : 'unknown-text'}>{formatNumber(metric.knownOutcomes)}</p></div>
              {onViewRun && <div className="skill-detail-action"><span>{t('skills.latestActivity')}</span><button className="button secondary" type="button" onClick={() => onViewRun(metric.latestRunId)}>{t('skills.viewLatest')}</button></div>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
