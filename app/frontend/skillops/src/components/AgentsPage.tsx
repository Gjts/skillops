import { Bot, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'
import type { Outcome, Runtime, SkillEvent } from '../types'

type AgentTab = 'observed' | 'definitions'
type AgentEvidenceState = 'unverified' | 'observed-recently' | 'idle' | 'telemetry-gap'
type AgentConfigurationState = 'active' | 'disabled' | 'shadowed' | 'missing' | 'conflicted'

export interface AgentProjection {
  key: string
  name: string
  runtime: Runtime
  definition?: Partial<SkillEvent>
  configurationState: AgentConfigurationState
  evidenceState: AgentEvidenceState
  lastVerifiedAt?: string
  terminalRuns: SkillEvent[]
  knownOutcomes: number
  outcomeCoverage: { numerator: number; denominator: number; value: number | null }
  latestOutcome?: Outcome
  timeline: SkillEvent[]
}

interface AgentPageResponse {
  generatedAt: string
  items: AgentProjection[]
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  available: number
  hasPrevious: boolean
  hasNext: boolean
  sourceStatus?: 'ok' | 'partial'
}

function readLocation(): { tab: AgentTab; runtime: Runtime | 'all'; days: number; query: string; page: number } {
  const params = new URLSearchParams(window.location.search)
  const runtime = params.get('runtime')
  const days = Number(params.get('days'))
  const page = Number(params.get('page'))
  return {
    tab: params.get('tab') === 'definitions' ? 'definitions' as const : 'observed' as const,
    runtime: runtime === 'codex' || runtime === 'claude-code' || runtime === 'cursor' ? runtime : 'all',
    days: days === 14 || days === 30 ? days : 7,
    query: (params.get('query') || '').slice(0, 120),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  }
}

const stateKeys: Record<AgentEvidenceState, MessageKey> = {
  unverified: 'agents.unverified',
  'observed-recently': 'agents.observedRecently',
  idle: 'agents.idle',
  'telemetry-gap': 'agents.telemetryGap',
}

const configurationKeys: Record<AgentConfigurationState, MessageKey> = {
  active: 'agents.configuration.active',
  disabled: 'agents.configuration.disabled',
  shadowed: 'agents.configuration.shadowed',
  missing: 'agents.configuration.missing',
  conflicted: 'agents.configuration.conflicted',
}

export function AgentsPage({ onOpen }: { onOpen: (href: string) => void }) {
  const { formatDateTime, formatNumber, t } = useI18n()
  const initial = readLocation()
  const [tab, setTab] = useState<AgentTab>(initial.tab)
  const [runtime, setRuntime] = useState<Runtime | 'all'>(initial.runtime)
  const [days, setDays] = useState(initial.days)
  const [query, setQuery] = useState(initial.query)
  const [page, setPage] = useState(initial.page)
  const [result, setResult] = useState<AgentPageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<AgentProjection | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const rows = result?.items ?? []

  useEffect(() => {
    const params = new URLSearchParams()
    if (tab !== 'observed') params.set('tab', tab)
    if (runtime !== 'all') params.set('runtime', runtime)
    if (days !== 7) params.set('days', String(days))
    if (query) params.set('query', query)
    if (page !== 1) params.set('page', String(page))
    window.history.replaceState({}, '', `/agents${params.size ? `?${params}` : ''}`)
  }, [days, page, query, runtime, tab])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void (async () => {
      try {
        const params = new URLSearchParams({ tab, window: `${days}d`, page: String(page), pageSize: '50' })
        if (runtime !== 'all') params.set('runtime', runtime)
        if (query) params.set('query', query)
        const response = await fetch(`/api/agents?${params}`, { signal: controller.signal })
        const body = await response.json() as AgentPageResponse & { error?: { message?: string } }
        if (!response.ok) throw new Error(body.error?.message || t('agents.loadFailed'))
        if (!Array.isArray(body.items) || !Number.isSafeInteger(body.totalItems) || !Number.isSafeInteger(body.totalPages)) throw new Error(t('agents.loadFailed'))
        if (body.totalPages > 0 && page > body.totalPages) {
          setPage(body.totalPages)
          return
        }
        setResult(body)
        setError(null)
      } catch (problem) {
        if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : t('agents.loadFailed'))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [attempt, days, page, query, runtime, t, tab])

  useEffect(() => {
    const restore = () => {
      const location = readLocation()
      setTab(location.tab)
      setRuntime(location.runtime)
      setDays(location.days)
      setQuery(location.query)
      setPage(location.page)
      setSelected(null)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])

  useEffect(() => {
    if (!selected) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('keydown', escape)
      previousFocus.current?.focus()
    }
  }, [selected?.key])

  const inspect = (item: AgentProjection) => {
    setSelected(item)
    void fetch(`/api/agents/${encodeURIComponent(item.key)}?window=${days}d`)
      .then(async (response) => response.ok ? (await response.json() as { item: AgentProjection }).item : null)
      .then((detail) => { if (detail) setSelected((current) => current?.key === item.key ? detail : current) })
      .catch(() => undefined)
  }

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
    if (!controls.length) return
    const first = controls[0]
    const last = controls.at(-1)!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const emptyMessage = result?.available ? t('agents.noMatches') : tab === 'observed' ? t('agents.noObserved') : t('agents.noDefinitions')
  const coverage = (item: AgentProjection) => `${item.outcomeCoverage.value === null ? '—' : `${formatNumber(item.outcomeCoverage.value, { maximumFractionDigits: 1 })}%`} (${formatNumber(item.outcomeCoverage.numerator)}/${formatNumber(item.outcomeCoverage.denominator)})`
  const outcome = (value?: Outcome) => value === 'success' ? t('activity.success') : value === 'failed' ? t('activity.failed') : t('agents.unknownOutcome')
  const tabs: AgentTab[] = ['observed', 'definitions']

  return (
    <div className="single-page agents-page">
      <div className="page-intro"><div><h2>{t('nav.agents')}</h2><p>{t('agents.description')}</p></div></div>
      <section className="panel agents-inventory">
        <div className="agents-tabs" role="tablist" aria-label={t('nav.agents')}>
          {tabs.map((item, index) => <button
            id={`agents-tab-${item}`}
            key={item}
            role="tab"
            tabIndex={tab === item ? 0 : -1}
            aria-controls="agents-tabpanel"
            aria-selected={tab === item}
            className={tab === item ? 'is-active' : ''}
            type="button"
            onClick={() => { setTab(item); setPage(1); setSelected(null) }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              setTab(tabs[next]); setPage(1); setSelected(null)
              ;(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus()
            }}
          >{t(item === 'observed' ? 'agents.observedTab' : 'agents.definitionsTab')}</button>)}
        </div>
        <div id="agents-tabpanel" role="tabpanel" aria-labelledby={`agents-tab-${tab}`}>
        {result?.sourceStatus === 'partial' && <div className="data-warning" role="alert">{t('cc.partial')}</div>}
        <div className="registry-toolbar agents-toolbar">
          <label className="search-control"><Search size={15} /><input aria-label={t('agents.search')} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setSelected(null) }} placeholder={t('agents.search')} /></label>
          <label><span>{t('common.runtime')}</span><select aria-label={t('common.runtime')} value={runtime} onChange={(event) => { setRuntime(event.target.value as Runtime | 'all'); setPage(1); setSelected(null) }}><option value="all">{t('common.allRuntimes')}</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="cursor">Cursor</option></select></label>
          <label><span>{t('common.dateRange')}</span><select aria-label={t('common.dateRange')} value={days} onChange={(event) => { setDays(Number(event.target.value)); setPage(1); setSelected(null) }}><option value="7">{t('common.lastDays', { count: 7 })}</option><option value="14">{t('common.lastDays', { count: 14 })}</option><option value="30">{t('common.lastDays', { count: 30 })}</option></select></label>
          <span className="registry-result-count">{formatNumber(result?.totalItems ?? 0)}</span>
        </div>
        {error && <div className="data-warning" role="alert"><span>{error}</span><button className="button secondary" type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} />{t('cc.retry')}</button></div>}
        {loading && !result && <div className="activity-empty" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="spin" size={18} /><strong>{t('agents.loading')}</strong></div>}
        {result && (rows.length ? (
          <div className="registry-table-scroll">
            <table className="registry-table agents-table">
              <caption className="sr-only">{t('nav.agents')}</caption>
              <thead><tr><th>{t('registry.name')}</th><th>{t('common.runtime')}</th><th>{t('agents.source')}</th><th>{t('common.version')}</th><th>{t('agents.configurationState')}</th><th>{t('agents.state')}</th><th>{t('agents.lastVerified')}</th><th>{t('agents.terminalRuns')}</th><th>{t('agents.outcomeCoverage')}</th><th>{t('agents.latestOutcome')}</th></tr></thead>
              <tbody>{rows.map((item) => (
                <tr key={item.key}>
                  <td><button className="text-button" type="button" aria-label={t('agents.inspect', { name: item.name })} onClick={() => inspect(item)}><Bot size={14} />{item.name}</button></td>
                  <td>{item.runtime === 'claude-code' ? 'Claude Code' : item.runtime === 'codex' ? 'Codex' : 'Cursor'}</td>
                  <td><span className="source-path mono">{item.definition?.sourcePath || item.configurationState}</span></td>
                  <td>{item.definition?.skillVersion || t('common.unversioned')}</td>
                  <td><span className={`agent-state ${item.configurationState}`}>{t(configurationKeys[item.configurationState])}</span></td>
                  <td><span className={`agent-state ${item.evidenceState}`}>{t(stateKeys[item.evidenceState])}</span></td>
                  <td>{item.lastVerifiedAt ? formatDateTime(item.lastVerifiedAt) : t('agents.noLastActivity')}</td>
                  <td>{formatNumber(item.terminalRuns.length)}</td>
                  <td>{coverage(item)}</td>
                  <td><span className={`outcome ${item.latestOutcome || 'unknown'}`}>{outcome(item.latestOutcome)}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <div className="activity-empty" role="status"><strong>{emptyMessage}</strong></div>)}
        {result && result.totalPages > 1 && <div className="runs-pagination-bar">
          <span role="status" aria-live="polite">{t('common.pageOf', { page: formatNumber(result.page), count: formatNumber(result.totalPages) })}</span>
          <div className="pagination-controls">
            <button type="button" aria-label={t('common.previousPage')} disabled={!result.hasPrevious || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} /></button>
            <button type="button" aria-label={t('common.nextPage')} disabled={!result.hasNext || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={15} /></button>
          </div>
        </div>}
        </div>
      </section>
      {selected && (
        <div className="run-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null) }}>
          <aside ref={dialogRef} className="agent-detail" role="dialog" aria-modal="true" aria-labelledby="agent-detail-title" onKeyDown={trapFocus}>
            <header>
              <div><small>{t('agents.details')}</small><h2 id="agent-detail-title">{selected.name}</h2></div>
              <button ref={closeRef} type="button" aria-label={t('common.close')} onClick={() => setSelected(null)}><X size={17} /></button>
            </header>
            <dl>
              <div><dt>{t('common.runtime')}</dt><dd>{selected.runtime}</dd></div>
              <div><dt>{t('agents.source')}</dt><dd className="mono">{selected.definition?.sourcePath || selected.configurationState}</dd></div>
              <div><dt>{t('agents.configurationState')}</dt><dd>{t(configurationKeys[selected.configurationState])}</dd></div>
              <div><dt>{t('agents.state')}</dt><dd>{t(stateKeys[selected.evidenceState])}</dd></div>
              <div><dt>{t('agents.lastVerified')}</dt><dd>{selected.lastVerifiedAt ? formatDateTime(selected.lastVerifiedAt) : t('agents.noLastActivity')}</dd></div>
              <div><dt>{t('agents.terminalRuns')}</dt><dd>{formatNumber(selected.terminalRuns.length)}</dd></div>
              <div><dt>{t('agents.outcomeCoverage')}</dt><dd>{coverage(selected)}</dd></div>
            </dl>
            <section>
              <h3>{t('agents.timeline')}</h3>
              {selected.timeline.length ? <ol className="agent-timeline">
                {selected.timeline.map((event) => (
                  <li key={event.id}>
                    <strong>{event.event}</strong>
                    <time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>
                    <small>{event.outcome ? outcome(event.outcome) : event.skillId || selected.name}</small>
                    {(event.event === 'skill.completed' || event.event === 'skill.failed') && <button className="text-button" type="button" onClick={() => onOpen(`/activity?tab=runs&run=${encodeURIComponent(event.id)}`)}>{t('agents.openRun')}</button>}
                  </li>
                ))}
              </ol> : <p>{t('agents.noTerminalRuns')}</p>}
            </section>
            <footer>
              {selected.terminalRuns[0] && <button className="button primary" type="button" onClick={() => onOpen(`/activity?tab=runs&run=${encodeURIComponent(selected.terminalRuns[0].id)}`)}>{t('agents.openRun')}</button>}
              <button className="button secondary" type="button" onClick={() => onOpen(`/assets?tab=skills&query=${encodeURIComponent(selected.name)}`)}>{t('agents.openAsset')}</button>
              <button className="button secondary" type="button" onClick={() => onOpen(`/benchmarks?tab=quick&artifactKind=agent&artifactId=${encodeURIComponent(selected.name)}`)}>{t('agents.openBenchmark')}</button>
            </footer>
          </aside>
        </div>
      )}
    </div>
  )
}
