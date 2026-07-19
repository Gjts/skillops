import {
  Bot,
  Box,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Code2,
  Download,
  Lightbulb,
  PlugZap,
  ShieldCheck,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityRail } from './components/ActivityRail'
import { ConnectModal } from './components/ConnectModal'
import { RuntimeDistribution, RunsChart } from './components/Charts'
import { KpiStrip } from './components/KpiStrip'
import { RegistryPage } from './components/RegistryPage'
import { RunDetail } from './components/RunDetail'
import { Sidebar } from './components/Sidebar'
import { SkillTable } from './components/SkillTable'
import { createSeedEvents } from './data/seed'
import { filterEvents, runtimeLabel, summarize, terminalRuns } from './lib/analytics'
import { parseEventFile } from './lib/import-events'
import type { PageId, Runtime, RuntimeConnection, SkillEvent } from './types'

const EVENT_REFRESH_MS = 3_000
const CONNECTION_REFRESH_MS = 5_000
const pathForPage: Record<PageId, string> = {
  overview: '/',
  skills: '/skills',
  runs: '/runs',
  evaluations: '/evaluations',
  registry: '/registry',
  settings: '/settings',
}
const pageForPath = new Map<string, PageId>([
  ['/', 'overview'],
  ['/overview', 'overview'],
  ...Object.entries(pathForPage).map(([page, path]) => [path, page as PageId] as const),
])

function currentPage() {
  return pageForPath.get(window.location.pathname.replace(/\/$/, '') || '/') ?? 'overview'
}

const checkingConnections: RuntimeConnection[] = [
  { runtime: 'codex', status: 'checking' },
  { runtime: 'claude-code', status: 'checking' },
  { runtime: 'cursor', status: 'preview' },
]

const pageTitle: Record<PageId, string> = {
  overview: 'Overview',
  skills: 'Skills',
  runs: 'Runs',
  evaluations: 'Evaluations',
  registry: 'Registry',
  settings: 'Settings',
}

export default function App() {
  const [page, setPage] = useState<PageId>(currentPage)
  const [events, setEvents] = useState<SkillEvent[]>([])
  const [runtime, setRuntime] = useState<Runtime | 'all'>('all')
  const [days, setDays] = useState(7)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectRuntime, setConnectRuntime] = useState<Runtime>('codex')
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null)
  const [connections, setConnections] = useState<RuntimeConnection[]>(checkingConnections)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<'loading' | 'demo' | 'local'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const eventEtag = useRef<string | null>(null)

  const loadConnections = useCallback(async () => {
    try {
      const response = await fetch('/api/connections')
      if (!response.ok) throw new Error(`Runtime connection API returned ${response.status}.`)
      const items = await response.json() as RuntimeConnection[]
      if (!Array.isArray(items)) throw new Error('Runtime connection API returned an invalid response.')
      setConnections(items)
      return items
    } catch {
      const unavailable = checkingConnections.map((item) => item.runtime === 'cursor' ? item : { ...item, status: 'unavailable' as const })
      setConnections(unavailable)
      return unavailable
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async (initial: boolean) => {
      try {
        const response = await fetch('/api/events', eventEtag.current ? { headers: { 'If-None-Match': eventEtag.current } } : undefined)
        if (response.status === 304) return
        if (!response.ok) throw new Error(`Local event API returned ${response.status}.`)
        const localEvents = await response.json() as SkillEvent[]
        if (cancelled) return
        if (!Array.isArray(localEvents)) throw new Error('Local event API returned an invalid response.')
        setEvents(localEvents)
        eventEtag.current = response.headers?.get?.('etag') ?? null
        setMode('local')
        setLoadError(null)
      } catch (error) {
        if (cancelled) return
        if (initial) {
          setEvents(createSeedEvents())
          setMode('demo')
          setLoadError(error instanceof Error ? error.message : 'The local event API is unavailable.')
        }
      }
    }
    void load(true)
    const interval = window.setInterval(() => { void load(false) }, EVENT_REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    void loadConnections()
    const interval = window.setInterval(() => { void loadConnections() }, CONNECTION_REFRESH_MS)
    return () => { window.clearInterval(interval) }
  }, [loadConnections])

  useEffect(() => {
    const restorePage = () => setPage(currentPage())
    window.addEventListener('popstate', restorePage)
    return () => window.removeEventListener('popstate', restorePage)
  }, [])

  const navigate = (target: PageId) => {
    if (window.location.pathname !== pathForPage[target]) window.history.pushState({}, '', pathForPage[target])
    setPage(target)
  }

  const openConnect = (target: Runtime = 'codex') => {
    setConnectRuntime(target)
    setConnectOpen(true)
  }
  const openRun = (runId: string) => {
    setRequestedRunId(runId)
    navigate('runs')
  }

  const filtered = useMemo(() => filterEvents(events, runtime, days), [events, runtime, days])
  const summary = useMemo(() => summarize(filtered), [filtered])
  const visibleRuns = useMemo(() => terminalRuns(filtered), [filtered])

  const importEvents = async (incoming: SkillEvent[]) => {
    const response = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incoming),
    })
    const result = await response.json() as { importedCount?: number; error?: string }
    if (!response.ok) throw new Error(result.error || `Import API returned ${response.status}.`)
    const refreshed = await fetch('/api/events')
    if (!refreshed.ok) throw new Error(`Events were imported, but refresh returned ${refreshed.status}.`)
    const localEvents = await refreshed.json() as SkillEvent[]
    if (!Array.isArray(localEvents)) throw new Error('Local event API returned an invalid response.')
    setEvents(localEvents)
    eventEtag.current = refreshed.headers?.get?.('etag') ?? null
    setMode('local')
    setLoadError(null)
    return result.importedCount ?? 0
  }

  const clearLocalEvents = async () => {
    const response = await fetch('/api/events', { method: 'DELETE' })
    const result = await response.json() as { removed?: number; backupFile?: string; error?: string }
    if (!response.ok) throw new Error(result.error || `Clear API returned ${response.status}.`)
    setEvents([])
    eventEtag.current = null
    setMode('local')
    return { removed: result.removed ?? 0, backupFile: result.backupFile }
  }

  const showEventFilters = page === 'overview' || page === 'skills' || page === 'runs'
  const modeLabel = page === 'registry' ? 'Live inventory'
    : page === 'evaluations' ? 'Sample evaluation'
      : mode === 'loading' ? 'Loading local events…' : mode === 'demo' ? 'Demo dataset' : 'Local events'

  return (
    <div className="app-shell">
      <Sidebar page={page} open={menuOpen} onNavigate={navigate} onToggle={() => setMenuOpen((open) => !open)} onClose={() => setMenuOpen(false)} />
      <main className="app-main">
        <header className="topbar">
          <div className="title-wrap"><h1>{pageTitle[page]}</h1><span className={`data-mode ${mode}`}>{modeLabel}</span></div>
          <div className="topbar-actions">
            {showEventFilters && <label className="select-control date-select"><CalendarDays size={16} /><select aria-label="Date range" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></select><ChevronDown size={14} /></label>}
            {showEventFilters && <label className="select-control runtime-select"><Code2 size={16} /><select aria-label="Runtime" value={runtime} onChange={(event) => setRuntime(event.target.value as Runtime | 'all')}><option value="all">All runtimes</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="cursor">Cursor</option></select><ChevronDown size={14} /></label>}
            <button className="button primary connect-button" type="button" onClick={() => openConnect(runtime === 'all' ? 'codex' : runtime)}><PlugZap size={16} />Connect runtime</button>
          </div>
        </header>

        {loadError && page !== 'registry' && <div className="data-warning" role="alert">Local events could not be loaded: {loadError} Showing the clearly labeled demo dataset.</div>}

        {page === 'overview' && (
          <div className="dashboard-layout">
            <div className="dashboard-content">
              <KpiStrip {...summary} mode={mode === 'demo' ? 'demo' : 'local'} />
              {visibleRuns.length ? <><div className="charts-grid"><RunsChart events={filtered} days={days} /><RuntimeDistribution events={filtered} /></div><SkillTable events={filtered} definitionEvents={events} limit={4} days={days} demo={mode === 'demo'} onViewRun={openRun} />{mode === 'demo' && <Insight onCompare={() => navigate('evaluations')} />}</> : <EmptyActivity runtime={runtime} days={days} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onShowAll={runtime === 'all' ? undefined : () => setRuntime('all')} />}
            </div>
            <ActivityRail events={filtered} onViewAll={() => navigate('runs')} onSelectRun={(run) => openRun(run.id)} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} refreshLabel="Refreshes every 3s" />
          </div>
        )}
        {page === 'skills' && <div className="single-page">{visibleRuns.length ? <SkillTable events={filtered} definitionEvents={events} searchable days={days} demo={mode === 'demo'} onViewRun={openRun} /> : <EmptyActivity runtime={runtime} days={days} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onShowAll={runtime === 'all' ? undefined : () => setRuntime('all')} />}</div>}
        {page === 'runs' && <RunsPage events={filtered} allEvents={events} requestedRunId={requestedRunId} onRequestedRunHandled={() => setRequestedRunId(null)} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onImport={importEvents} />}
        {page === 'evaluations' && <EvaluationsPage />}
        {page === 'registry' && <RegistryPage events={events} />}
        {page === 'settings' && <SettingsPage connections={connections} events={events} localData={mode === 'local'} onConnect={openConnect} onRefresh={loadConnections} onClear={clearLocalEvents} />}
      </main>
      {connectOpen && <ConnectModal initialRuntime={connectRuntime} connections={connections} onRefresh={loadConnections} onClose={() => setConnectOpen(false)} />}
    </div>
  )
}

function EmptyActivity({ runtime, days, onConnect, onShowAll }: { runtime: Runtime | 'all'; days: number; onConnect: () => void; onShowAll?: () => void }) {
  const label = runtime === 'all' ? 'any runtime' : runtimeLabel[runtime]
  return <section className="panel empty-state" aria-labelledby="empty-activity-title"><span className="empty-state-icon"><PlugZap size={22} /></span><div><h2 id="empty-activity-title">No Skill runs from {label}</h2><p>No terminal Skill events were recorded in the last {days} days. Verify the adapter, use a Skill once, then refresh.</p></div><div><button className="button primary" type="button" onClick={onConnect}>Connect {runtime === 'all' ? 'Codex' : runtimeLabel[runtime]}</button>{onShowAll && <button className="button secondary" type="button" onClick={onShowAll}>Show all runtimes</button>}</div></section>
}

function Insight({ onCompare }: { onCompare: () => void }) {
  return (
    <section className="insight-bar">
      <span className="insight-icon"><Lightbulb size={22} /></span>
      <div className="insight-label"><strong>Insight</strong><span>Version recommendation</span></div>
      <p><strong>frontend-builder v2.1.0</strong> has a lower success rate than v2.2.0 in evaluation runs. Consider upgrading to improve reliability.</p>
      <button className="button secondary" type="button" onClick={onCompare}>View skill</button>
      <button className="button primary" type="button" onClick={onCompare}>Compare versions</button>
    </section>
  )
}

function RunsPage({ events, allEvents, requestedRunId, onRequestedRunHandled, onConnect, onImport }: { events: SkillEvent[]; allEvents: SkillEvent[]; requestedRunId: string | null; onRequestedRunHandled: () => void; onConnect: () => void; onImport: (events: SkillEvent[]) => Promise<number> }) {
  const input = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [runPage, setRunPage] = useState(0)
  const [selectedRun, setSelectedRun] = useState<SkillEvent | null>(null)
  const pageSize = 20
  const matchingRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return terminalRuns(events)
      .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
      .filter((event) => !normalizedQuery || [event.skillId, event.id, event.project].some((value) => value?.toLowerCase().includes(normalizedQuery)))
  }, [events, query])
  const pageCount = Math.max(1, Math.ceil(matchingRuns.length / pageSize))
  const safePage = Math.min(runPage, pageCount - 1)
  const pageEvents = matchingRuns.slice(safePage * pageSize, (safePage + 1) * pageSize)
  const firstRun = matchingRuns.length ? safePage * pageSize + 1 : 0
  const lastRun = Math.min((safePage + 1) * pageSize, matchingRuns.length)
  const resultLabel = `${firstRun}–${lastRun} of ${matchingRuns.length} ${matchingRuns.length === 1 ? 'run' : 'runs'}`
  useEffect(() => {
    if (!requestedRunId) return
    const run = terminalRuns(allEvents).find((event) => event.id === requestedRunId)
    if (run) setSelectedRun(run)
    onRequestedRunHandled()
  }, [allEvents, onRequestedRunHandled, requestedRunId])
  const handleFile = async (file?: File) => {
    if (!file) return
    setImporting(true)
    setImportStatus(null)
    try {
      const importedCount = await onImport(parseEventFile(await file.text()))
      setImportError(null)
      setImportStatus(`Imported ${importedCount} new ${importedCount === 1 ? 'event' : 'events'} into the local event store.`)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not import this event file.')
    } finally {
      setImporting(false)
    }
  }
  return (
    <div className="single-page">
      <div className="page-intro"><div><h2>Execution timeline</h2><p>Inspect terminal Skill events across every connected runtime.</p></div><button className="button secondary" type="button" disabled={importing} onClick={() => input.current?.click()}><Upload size={15} />{importing ? 'Importing…' : 'Import JSON or JSONL'}</button><input ref={input} type="file" accept=".jsonl,.json,application/json" hidden onChange={(event) => { void handleFile(event.target.files?.[0]); event.target.value = '' }} /></div>
      {importError && <div className="data-warning" role="alert">Import failed: {importError}</div>}
      {importStatus && <div className="import-status" role="status">{importStatus}</div>}
      <div className="runtime-lifecycles">
        <RuntimeLifecycle events={events} runtime="codex" />
        <RuntimeLifecycle events={events} runtime="claude-code" />
      </div>
      <div className="runs-toolbar">
        <label className="search-control"><Search size={15} /><input type="search" aria-label="Search runs" placeholder="Search skill, run ID, or project" value={query} onChange={(event) => { setQuery(event.target.value); setRunPage(0) }} /></label>
        <span>{resultLabel}</span>
        <div className="pagination-controls">
          <button type="button" aria-label="Previous page" disabled={safePage === 0} onClick={() => setRunPage((page) => Math.max(0, page - 1))}><ChevronLeft size={15} /></button>
          <span>Page {safePage + 1} of {pageCount}</span>
          <button type="button" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setRunPage((page) => Math.min(pageCount - 1, page + 1))}><ChevronRight size={15} /></button>
        </div>
      </div>
      <ActivityRail events={pageEvents} expanded onSelectRun={setSelectedRun} onConnect={onConnect} />
      {selectedRun && <RunDetail run={selectedRun} events={allEvents} onClose={() => setSelectedRun(null)} />}
    </div>
  )
}

function EvaluationsPage() {
  const comparisons = [
    { label: 'Success rate', current: '89.6%', candidate: '95.6%', delta: '+6.0pp' },
    { label: 'Median duration', current: '3m 42s', candidate: '3m 09s', delta: '-14.9%' },
    { label: 'Cost per success', current: '$0.17', candidate: '$0.15', delta: '-11.8%' },
  ]
  return (
    <div className="single-page evaluation-page">
      <div className="page-intro"><div><div className="sample-heading"><h2>Evaluation preview</h2><span className="data-mode">Sample only</span></div><p>A read-only example of the comparison workflow. No evaluation runner or promotion pipeline is connected.</p></div></div>
      <div className="registry-warning" role="note">Preview data is illustrative and never changes an installed Skill or runtime configuration.</div>
      <section className="panel comparison-panel">
        <header className="comparison-header"><span>Metric</span><strong>v2.1.0 · current</strong><strong>v2.2.0 · candidate</strong><span>Change</span></header>
        {comparisons.map((item) => <div className="comparison-row" key={item.label}><span>{item.label}</span><strong>{item.current}</strong><strong className="success-text">{item.candidate}</strong><span className="delta-positive">{item.delta}</span></div>)}
      </section>
      <section className="evaluation-verdict preview"><span><ShieldCheck size={24} /></span><div><strong>Decision controls are intentionally unavailable</strong><p>Connect a future evaluation runner before enabling comparisons, rollout decisions, or promotion actions.</p></div></section>
    </div>
  )
}

function RuntimeLifecycle({ events, runtime }: { events: SkillEvent[]; runtime: Extract<Runtime, 'codex' | 'claude-code'> }) {
  const items = [
    { label: 'Sessions', value: events.filter((event) => event.event === 'session.started' && event.runtime === runtime).length },
    { label: 'Prompts', value: events.filter((event) => event.event === 'prompt.submitted' && event.runtime === runtime).length },
    { label: 'Tool calls', value: events.filter((event) => event.event === 'tool.completed' && event.runtime === runtime).length },
    { label: 'Subagents', value: events.filter((event) => event.event === 'subagent.started' && event.runtime === runtime).length },
  ]
  return <section className="lifecycle-section" aria-label={`${runtimeLabel[runtime]} lifecycle activity`}><h3>{runtimeLabel[runtime]}</h3><div className="codex-lifecycle">{items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value.toLocaleString()}</strong></div>)}</div></section>
}

function SettingsPage({ connections, events, localData, onConnect, onRefresh, onClear }: { connections: RuntimeConnection[]; events: SkillEvent[]; localData: boolean; onConnect: (runtime: Runtime) => void; onRefresh: () => Promise<RuntimeConnection[]>; onClear: () => Promise<{ removed: number; backupFile?: string }> }) {
  const [confirmClear, setConfirmClear] = useState(false)
  const [dataStatus, setDataStatus] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const statusFor = (runtime: Runtime) => {
    const status = connections.find((connection) => connection.runtime === runtime)?.status ?? 'unavailable'
    return {
      checking: 'Checking…',
      installed: 'Installed',
      'not-installed': 'Not installed',
      preview: 'Preview',
      broken: 'Broken',
      error: 'Config error',
      unavailable: 'Unavailable',
    }[status]
  }
  const runtimes: Array<{ runtime: Runtime; name: string; detail: string; status: string; icon: typeof Code2 }> = [
    { runtime: 'codex', name: 'Codex', detail: 'Native lifecycle hooks and Skill detection', status: statusFor('codex'), icon: Code2 },
    { runtime: 'claude-code', name: 'Claude Code', detail: 'Native hooks with exact slash-command and Skill-tool detection', status: statusFor('claude-code'), icon: Bot },
    { runtime: 'cursor', name: 'Cursor', detail: 'Agent hooks preview adapter', status: statusFor('cursor'), icon: Box },
  ]
  const activityFor = (runtime: Runtime) => {
    const connection = connections.find((item) => item.runtime === runtime)
    if (!connection?.eventCount) return 'No runtime activity recorded'
    const lastSeen = connection.lastEventAt ? new Date(connection.lastEventAt).toLocaleString() : 'time unavailable'
    return `${connection.eventCount.toLocaleString()} runtime events · Last activity ${lastSeen}`
  }
  const runtimeEvents = events.filter((event) => event.event !== 'skill.discovered')
  const lastEvent = [...runtimeEvents].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0]
  const exportEvents = () => {
    const contents = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/x-ndjson' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `skillops-events-${new Date().toISOString().slice(0, 10)}.jsonl`
    anchor.click()
    URL.revokeObjectURL(url)
    setDataStatus(`Exported ${events.length.toLocaleString()} local events.`)
  }
  const clear = async () => {
    setClearing(true)
    try {
      const result = await onClear()
      setDataStatus(`Cleared ${result.removed.toLocaleString()} events. A local backup was created${result.backupFile ? ` at ${result.backupFile}` : ''}.`)
      setConfirmClear(false)
    } catch (error) {
      setDataStatus(error instanceof Error ? `Clear failed: ${error.message}` : 'Clear failed.')
    } finally { setClearing(false) }
  }
  return (
    <div className="single-page settings-page">
      <div className="page-intro"><div><h2>Runtime connections</h2><p>Keep source code local while collecting normalized execution metadata.</p></div><button className="button secondary" type="button" onClick={() => void onRefresh()}>Refresh status</button></div>
      <section className="panel connection-list">{runtimes.map((runtime) => { const Icon = runtime.icon; return <div className="connection-row" key={runtime.name}><span className="runtime-icon"><Icon size={18} /></span><div><strong>{runtime.name}</strong><span>{runtime.detail}</span><small>{activityFor(runtime.runtime)}</small></div><span className={`connection-status ${runtime.status === 'Broken' ? 'broken' : ''}`}>{runtime.status}</span><button className="button secondary" type="button" aria-label={`Configure ${runtime.name}`} onClick={() => onConnect(runtime.runtime)}>Configure</button></div> })}</section>
      <section className="panel data-controls" aria-labelledby="local-data-title">
        <header><div><h2 id="local-data-title">Local event data</h2><p>Inspect, export, or clear the normalized metadata stored on this machine.</p></div><strong>{events.length.toLocaleString()} events</strong></header>
        <dl><div><dt>Storage</dt><dd className="mono">data/events.jsonl</dd></div><div><dt>Last runtime event</dt><dd>{lastEvent ? new Date(lastEvent.timestamp).toLocaleString() : 'No runtime activity recorded'}</dd></div><div><dt>Content boundary</dt><dd>No raw prompts, transcripts, tool output, or source code</dd></div></dl>
        <footer><button className="button secondary" type="button" disabled={!localData} onClick={exportEvents}><Download size={15} />Export JSONL</button><button className="button danger" type="button" disabled={!localData || clearing} onClick={() => setConfirmClear(true)}><Trash2 size={15} />Clear event data</button></footer>
        {!localData && <p className="data-control-note">Start the local API before exporting or clearing data. Demo events are never written.</p>}
        {dataStatus && <p className="data-control-note" role="status">{dataStatus}</p>}
      </section>
      {confirmClear && <div className="confirm-clear" role="alertdialog" aria-modal="true" aria-labelledby="confirm-clear-title"><div><h2 id="confirm-clear-title">Clear {events.length.toLocaleString()} local events?</h2><p>The current JSONL file will be copied to a timestamped local backup before it is cleared.</p></div><div><button className="button secondary" type="button" onClick={() => setConfirmClear(false)}>Cancel</button><button className="button danger" type="button" disabled={clearing} onClick={() => void clear()}>{clearing ? 'Clearing…' : 'Clear and create backup'}</button></div></div>}
      <section className="privacy-note"><ShieldCheck size={20} /><div><strong>Local-first by design</strong><p>Raw prompts, transcripts, and source code are not uploaded. The MVP stores normalized events in <span className="mono">data/events.jsonl</span>.</p></div></section>
    </div>
  )
}
