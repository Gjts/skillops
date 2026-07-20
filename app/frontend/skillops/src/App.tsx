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
import { EvaluationWorkspace } from './components/EvaluationWorkspace'
import { KpiStrip } from './components/KpiStrip'
import { RegistryPage } from './components/RegistryPage'
import { RunDetail } from './components/RunDetail'
import { Sidebar } from './components/Sidebar'
import { SkillTable } from './components/SkillTable'
import { createSeedEvents } from './data/seed'
import { useI18n } from './i18n/I18nProvider'
import type { MessageKey } from './i18n/messages'
import { filterEvents, runtimeLabel, summarize, terminalRuns } from './lib/analytics'
import { EventFileError, parseEventFile, type EventFileErrorCode } from './lib/import-events'
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

const pageTitle: Record<PageId, MessageKey> = {
  overview: 'nav.overview',
  skills: 'nav.skills',
  runs: 'nav.runs',
  evaluations: 'nav.evaluations',
  registry: 'nav.registry',
  settings: 'nav.settings',
}

const importErrorKey: Record<EventFileErrorCode, MessageKey> = {
  'empty-file': 'runs.emptyFile',
  'invalid-json': 'runs.invalidJson',
  'invalid-jsonl': 'runs.invalidJsonl',
  'invalid-events': 'runs.invalidEvents',
}

type ImportFeedback =
  | { kind: 'success'; count: number }
  | { kind: 'error'; code: EventFileErrorCode; line?: number }
  | { kind: 'error'; code: 'request-failed'; line?: number }

type DataFeedback =
  | { kind: 'exported'; count: number }
  | { kind: 'cleared'; count: number; backupFile?: string }
  | { kind: 'clear-failed'; error?: string }

export default function App() {
  const { t } = useI18n()
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
      if (!response.ok) throw new Error(t('errors.connectionStatus', { status: response.status }))
      const items = await response.json() as RuntimeConnection[]
      if (!Array.isArray(items)) throw new Error(t('errors.connectionInvalid'))
      setConnections(items)
      return items
    } catch {
      const unavailable = checkingConnections.map((item) => item.runtime === 'cursor' ? item : { ...item, status: 'unavailable' as const })
      setConnections(unavailable)
      return unavailable
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    const load = async (initial: boolean) => {
      try {
        const response = await fetch('/api/events', eventEtag.current ? { headers: { 'If-None-Match': eventEtag.current } } : undefined)
        if (response.status === 304) return
        if (!response.ok) throw new Error(t('errors.eventStatus', { status: response.status }))
        const localEvents = await response.json() as SkillEvent[]
        if (cancelled) return
        if (!Array.isArray(localEvents)) throw new Error(t('errors.eventInvalid'))
        setEvents(localEvents)
        eventEtag.current = response.headers?.get?.('etag') ?? null
        setMode('local')
        setLoadError(null)
      } catch (error) {
        if (cancelled) return
        if (initial) {
          setEvents(createSeedEvents())
          setMode('demo')
          setLoadError(error instanceof Error ? error.message : t('errors.localUnavailable'))
        }
      }
    }
    void load(true)
    const interval = window.setInterval(() => { void load(false) }, EVENT_REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [t])

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
    if (!response.ok) throw new Error(result.error || t('errors.importStatus', { status: response.status }))
    const refreshed = await fetch('/api/events')
    if (!refreshed.ok) throw new Error(t('errors.importRefresh', { status: refreshed.status }))
    const localEvents = await refreshed.json() as SkillEvent[]
    if (!Array.isArray(localEvents)) throw new Error(t('errors.eventInvalid'))
    setEvents(localEvents)
    eventEtag.current = refreshed.headers?.get?.('etag') ?? null
    setMode('local')
    setLoadError(null)
    return result.importedCount ?? 0
  }

  const clearLocalEvents = async () => {
    const response = await fetch('/api/events', { method: 'DELETE' })
    const result = await response.json() as { removed?: number; backupFile?: string; error?: string }
    if (!response.ok) throw new Error(result.error || t('errors.clearStatus', { status: response.status }))
    setEvents([])
    eventEtag.current = null
    setMode('local')
    return { removed: result.removed ?? 0, backupFile: result.backupFile }
  }

  const showEventFilters = page === 'overview' || page === 'skills' || page === 'runs'
  const modeLabel = page === 'registry' ? t('mode.liveInventory')
    : page === 'evaluations' ? t('mode.liveEvaluation')
      : mode === 'loading' ? t('mode.loadingEvents') : mode === 'demo' ? t('mode.demoDataset') : t('mode.localEvents')

  return (
    <div className="app-shell">
      <Sidebar page={page} open={menuOpen} onNavigate={navigate} onToggle={() => setMenuOpen((open) => !open)} onClose={() => setMenuOpen(false)} />
      <main className="app-main">
        <header className="topbar">
          <div className="title-wrap"><h1>{t(pageTitle[page])}</h1><span className={`data-mode ${mode}`}>{modeLabel}</span></div>
          <div className="topbar-actions">
            {showEventFilters && <label className="select-control date-select"><CalendarDays size={16} /><select aria-label={t('common.dateRange')} value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>{t('common.lastDays', { count: 7 })}</option><option value={14}>{t('common.lastDays', { count: 14 })}</option><option value={30}>{t('common.lastDays', { count: 30 })}</option></select><ChevronDown size={14} /></label>}
            {showEventFilters && <label className="select-control runtime-select"><Code2 size={16} /><select aria-label={t('common.runtime')} value={runtime} onChange={(event) => setRuntime(event.target.value as Runtime | 'all')}><option value="all">{t('common.allRuntimes')}</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="cursor">Cursor</option></select><ChevronDown size={14} /></label>}
            <button className="button primary connect-button" type="button" onClick={() => openConnect(runtime === 'all' ? 'codex' : runtime)}><PlugZap size={16} />{t('common.connectRuntime')}</button>
          </div>
        </header>

        {loadError && page !== 'registry' && <div className="data-warning" role="alert">{t('mode.loadWarning', { error: loadError })}</div>}

        {page === 'overview' && (
          <div className="dashboard-layout">
            <div className="dashboard-content">
              <KpiStrip {...summary} mode={mode === 'demo' ? 'demo' : 'local'} />
              {visibleRuns.length ? <><div className="charts-grid"><RunsChart events={filtered} days={days} /><RuntimeDistribution events={filtered} /></div><SkillTable events={filtered} definitionEvents={events} limit={4} days={days} demo={mode === 'demo'} onViewRun={openRun} />{mode === 'demo' && <Insight onCompare={() => navigate('evaluations')} />}</> : <EmptyActivity runtime={runtime} days={days} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onShowAll={runtime === 'all' ? undefined : () => setRuntime('all')} />}
            </div>
            <ActivityRail events={filtered} onViewAll={() => navigate('runs')} onSelectRun={(run) => openRun(run.id)} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} refreshLabel={t('activity.refresh')} />
          </div>
        )}
        {page === 'skills' && <div className="single-page">{visibleRuns.length ? <SkillTable events={filtered} definitionEvents={events} searchable days={days} demo={mode === 'demo'} onViewRun={openRun} /> : <EmptyActivity runtime={runtime} days={days} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onShowAll={runtime === 'all' ? undefined : () => setRuntime('all')} />}</div>}
        {page === 'runs' && <RunsPage events={filtered} allEvents={events} requestedRunId={requestedRunId} onRequestedRunHandled={() => setRequestedRunId(null)} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onImport={importEvents} />}
        {page === 'evaluations' && <EvaluationWorkspace />}
        {page === 'registry' && <RegistryPage events={events} />}
        {page === 'settings' && <SettingsPage connections={connections} events={events} localData={mode === 'local'} onConnect={openConnect} onRefresh={loadConnections} onClear={clearLocalEvents} />}
      </main>
      {connectOpen && <ConnectModal initialRuntime={connectRuntime} connections={connections} onRefresh={loadConnections} onClose={() => setConnectOpen(false)} />}
    </div>
  )
}

function EmptyActivity({ runtime, days, onConnect, onShowAll }: { runtime: Runtime | 'all'; days: number; onConnect: () => void; onShowAll?: () => void }) {
  const { t } = useI18n()
  const label = runtime === 'all' ? t('empty.anyRuntime') : runtimeLabel[runtime]
  const target = runtime === 'all' ? 'Codex' : runtimeLabel[runtime]
  return <section className="panel empty-state" aria-labelledby="empty-activity-title"><span className="empty-state-icon"><PlugZap size={22} /></span><div><h2 id="empty-activity-title">{t('empty.title', { runtime: label })}</h2><p>{t('empty.description', { days })}</p></div><div><button className="button primary" type="button" onClick={onConnect}>{t('empty.connectTarget', { runtime: target })}</button>{onShowAll && <button className="button secondary" type="button" onClick={onShowAll}>{t('empty.showAll')}</button>}</div></section>
}

function Insight({ onCompare }: { onCompare: () => void }) {
  const { t } = useI18n()
  return (
    <section className="insight-bar">
      <span className="insight-icon"><Lightbulb size={22} /></span>
      <div className="insight-label"><strong>{t('insight.title')}</strong><span>{t('insight.recommendation')}</span></div>
      <p>{t('insight.description')}</p>
      <button className="button secondary" type="button" onClick={onCompare}>{t('insight.viewSkill')}</button>
      <button className="button primary" type="button" onClick={onCompare}>{t('insight.compare')}</button>
    </section>
  )
}

function RunsPage({ events, allEvents, requestedRunId, onRequestedRunHandled, onConnect, onImport }: { events: SkillEvent[]; allEvents: SkillEvent[]; requestedRunId: string | null; onRequestedRunHandled: () => void; onConnect: () => void; onImport: (events: SkillEvent[]) => Promise<number> }) {
  const { formatNumber, t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null)
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
  const resultLabel = t('runs.resultCount', {
    first: formatNumber(firstRun),
    last: formatNumber(lastRun),
    count: formatNumber(matchingRuns.length),
    unit: t(matchingRuns.length === 1 ? 'common.run' : 'common.runs'),
  })
  useEffect(() => {
    if (!requestedRunId) return
    const run = terminalRuns(allEvents).find((event) => event.id === requestedRunId)
    if (run) setSelectedRun(run)
    onRequestedRunHandled()
  }, [allEvents, onRequestedRunHandled, requestedRunId])
  const handleFile = async (file?: File) => {
    if (!file) return
    setImporting(true)
    setImportFeedback(null)
    try {
      const importedCount = await onImport(parseEventFile(await file.text()))
      setImportFeedback({ kind: 'success', count: importedCount })
    } catch (error) {
      setImportFeedback(error instanceof EventFileError
        ? { kind: 'error', code: error.code, line: error.line }
        : { kind: 'error', code: 'request-failed' })
    } finally {
      setImporting(false)
    }
  }
  const importError = importFeedback?.kind === 'error'
    ? t(importFeedback.code === 'request-failed' ? 'runs.couldNotImport' : importErrorKey[importFeedback.code], { line: importFeedback.line ?? '' })
    : null
  const importStatus = importFeedback?.kind === 'success'
    ? t(importFeedback.count === 1 ? 'runs.importedOne' : 'runs.importedMany', { count: formatNumber(importFeedback.count) })
    : null
  return (
    <div className="single-page">
      <div className="page-intro"><div><h2>{t('runs.timeline')}</h2><p>{t('runs.description')}</p></div><button className="button secondary" type="button" disabled={importing} onClick={() => input.current?.click()}><Upload size={15} />{importing ? t('runs.importing') : t('runs.importFile')}</button><input ref={input} type="file" accept=".jsonl,.json,application/json" hidden onChange={(event) => { void handleFile(event.target.files?.[0]); event.target.value = '' }} /></div>
      {importError && <div className="data-warning" role="alert">{t('runs.importFailed', { error: importError })}</div>}
      {importStatus && <div className="import-status" role="status">{importStatus}</div>}
      <div className="runtime-lifecycles">
        <RuntimeLifecycle events={events} runtime="codex" />
        <RuntimeLifecycle events={events} runtime="claude-code" />
      </div>
      <div className="runs-toolbar">
        <label className="search-control"><Search size={15} /><input type="search" aria-label={t('runs.search')} placeholder={t('runs.searchPlaceholder')} value={query} onChange={(event) => { setQuery(event.target.value); setRunPage(0) }} /></label>
        <span>{resultLabel}</span>
        <div className="pagination-controls">
          <button type="button" aria-label={t('common.previousPage')} disabled={safePage === 0} onClick={() => setRunPage((page) => Math.max(0, page - 1))}><ChevronLeft size={15} /></button>
          <span>{t('common.pageOf', { page: formatNumber(safePage + 1), count: formatNumber(pageCount) })}</span>
          <button type="button" aria-label={t('common.nextPage')} disabled={safePage >= pageCount - 1} onClick={() => setRunPage((page) => Math.min(pageCount - 1, page + 1))}><ChevronRight size={15} /></button>
        </div>
      </div>
      <ActivityRail events={pageEvents} expanded onSelectRun={setSelectedRun} onConnect={onConnect} />
      {selectedRun && <RunDetail run={selectedRun} events={allEvents} onClose={() => setSelectedRun(null)} />}
    </div>
  )
}


function RuntimeLifecycle({ events, runtime }: { events: SkillEvent[]; runtime: Extract<Runtime, 'codex' | 'claude-code'> }) {
  const { formatNumber, t } = useI18n()
  const items = [
    { label: t('runs.sessions'), value: events.filter((event) => event.event === 'session.started' && event.runtime === runtime).length },
    { label: t('runs.prompts'), value: events.filter((event) => event.event === 'prompt.submitted' && event.runtime === runtime).length },
    { label: t('runs.toolCalls'), value: events.filter((event) => event.event === 'tool.completed' && event.runtime === runtime).length },
    { label: t('runs.subagents'), value: events.filter((event) => event.event === 'subagent.started' && event.runtime === runtime).length },
  ]
  return <section className="lifecycle-section" aria-label={t('runs.lifecycleActivity', { runtime: runtimeLabel[runtime] })}><h3>{runtimeLabel[runtime]}</h3><div className="codex-lifecycle">{items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div>)}</div></section>
}

function SettingsPage({ connections, events, localData, onConnect, onRefresh, onClear }: { connections: RuntimeConnection[]; events: SkillEvent[]; localData: boolean; onConnect: (runtime: Runtime) => void; onRefresh: () => Promise<RuntimeConnection[]>; onClear: () => Promise<{ removed: number; backupFile?: string }> }) {
  const { formatDateTime, formatNumber, t } = useI18n()
  const [confirmClear, setConfirmClear] = useState(false)
  const [dataFeedback, setDataFeedback] = useState<DataFeedback | null>(null)
  const [clearing, setClearing] = useState(false)
  const statusFor = (runtime: Runtime) => {
    const status = connections.find((connection) => connection.runtime === runtime)?.status ?? 'unavailable'
    return {
      checking: t('common.checking'),
      installed: t('common.installed'),
      'not-installed': t('common.notInstalled'),
      preview: t('common.preview'),
      broken: t('common.broken'),
      error: t('common.configError'),
      unavailable: t('common.unavailable'),
    }[status]
  }
  const runtimes: Array<{ runtime: Runtime; name: string; detail: string; status: string; broken: boolean; icon: typeof Code2 }> = [
    { runtime: 'codex', name: 'Codex', detail: t('settings.codexDetail'), status: statusFor('codex'), broken: connections.find((item) => item.runtime === 'codex')?.status === 'broken', icon: Code2 },
    { runtime: 'claude-code', name: 'Claude Code', detail: t('settings.claudeDetail'), status: statusFor('claude-code'), broken: connections.find((item) => item.runtime === 'claude-code')?.status === 'broken', icon: Bot },
    { runtime: 'cursor', name: 'Cursor', detail: t('settings.cursorDetail'), status: statusFor('cursor'), broken: connections.find((item) => item.runtime === 'cursor')?.status === 'broken', icon: Box },
  ]
  const activityFor = (runtime: Runtime) => {
    const connection = connections.find((item) => item.runtime === runtime)
    if (!connection?.eventCount) return t('connect.noActivity')
    const lastSeen = connection.lastEventAt ? formatDateTime(connection.lastEventAt) : t('settings.timeUnavailable')
    return t('settings.activityCount', { count: formatNumber(connection.eventCount), time: lastSeen })
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
    setDataFeedback({ kind: 'exported', count: events.length })
  }
  const clear = async () => {
    setClearing(true)
    try {
      const result = await onClear()
      setDataFeedback({ kind: 'cleared', count: result.removed, backupFile: result.backupFile })
      setConfirmClear(false)
    } catch (error) {
      setDataFeedback({ kind: 'clear-failed', error: error instanceof Error ? error.message : undefined })
    } finally { setClearing(false) }
  }
  const dataStatus = dataFeedback?.kind === 'exported'
    ? t('settings.exported', { count: formatNumber(dataFeedback.count) })
    : dataFeedback?.kind === 'cleared'
      ? t('settings.cleared', {
        count: formatNumber(dataFeedback.count),
        path: dataFeedback.backupFile ? t('settings.backupPath', { path: dataFeedback.backupFile }) : '',
      })
      : dataFeedback?.kind === 'clear-failed'
        ? t('settings.clearFailed', { error: dataFeedback.error ?? t('common.unknown') })
        : null
  return (
    <div className="single-page settings-page">
      <div className="page-intro"><div><h2>{t('settings.runtimeConnections')}</h2><p>{t('settings.description')}</p></div><button className="button secondary" type="button" onClick={() => void onRefresh()}>{t('settings.refresh')}</button></div>
      <section className="panel connection-list">{runtimes.map((runtime) => { const Icon = runtime.icon; return <div className="connection-row" key={runtime.name}><span className="runtime-icon"><Icon size={18} /></span><div><strong>{runtime.name}</strong><span>{runtime.detail}</span><small>{activityFor(runtime.runtime)}</small></div><span className={`connection-status ${runtime.broken ? 'broken' : ''}`}>{runtime.status}</span><button className="button secondary" type="button" aria-label={t('settings.configureRuntime', { runtime: runtime.name })} onClick={() => onConnect(runtime.runtime)}>{t('common.configure')}</button></div> })}</section>
      <section className="panel data-controls" aria-labelledby="local-data-title">
        <header><div><h2 id="local-data-title">{t('settings.localData')}</h2><p>{t('settings.localDataDescription')}</p></div><strong>{t('settings.eventCount', { count: formatNumber(events.length) })}</strong></header>
        <dl><div><dt>{t('settings.storage')}</dt><dd className="mono">data/events.jsonl</dd></div><div><dt>{t('settings.lastRuntimeEvent')}</dt><dd>{lastEvent ? formatDateTime(lastEvent.timestamp) : t('connect.noActivity')}</dd></div><div><dt>{t('settings.contentBoundary')}</dt><dd>{t('settings.noRawContent')}</dd></div></dl>
        <footer><button className="button secondary" type="button" disabled={!localData} onClick={exportEvents}><Download size={15} />{t('settings.export')}</button><button className="button danger" type="button" disabled={!localData || clearing} onClick={() => setConfirmClear(true)}><Trash2 size={15} />{t('settings.clear')}</button></footer>
        {!localData && <p className="data-control-note">{t('settings.apiRequired')}</p>}
        {dataStatus && <p className="data-control-note" role="status">{dataStatus}</p>}
      </section>
      {confirmClear && <div className="confirm-clear" role="alertdialog" aria-modal="true" aria-labelledby="confirm-clear-title"><div><h2 id="confirm-clear-title">{t('settings.confirmTitle', { count: formatNumber(events.length) })}</h2><p>{t('settings.confirmDescription')}</p></div><div><button className="button secondary" type="button" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</button><button className="button danger" type="button" disabled={clearing} onClick={() => void clear()}>{clearing ? t('settings.clearing') : t('settings.clearBackup')}</button></div></div>}
      <section className="privacy-note"><ShieldCheck size={20} /><div><strong>{t('settings.localFirst')}</strong><p>{t('settings.privacy')}</p></div></section>
    </div>
  )
}
