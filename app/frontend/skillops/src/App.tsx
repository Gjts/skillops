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
// @ts-expect-error Plain JavaScript schema shared with the local event API.
import { normalizeEvent } from '../../../shared/event-schema.mjs'
import { ActivityRail } from './components/ActivityRail'
import { ConnectModal } from './components/ConnectModal'
import { RuntimeDistribution, RunsChart } from './components/Charts'
import { EvaluationWorkspace } from './components/EvaluationWorkspace'
import { GovernancePage } from './components/GovernancePage'
import { KpiStrip } from './components/KpiStrip'
import { RegistryPage } from './components/RegistryPage'
import { correlatedRunEvents, RunDetail } from './components/RunDetail'
import { Sidebar } from './components/Sidebar'
import { TeamPage } from './components/TeamPage'
import { SkillTable } from './components/SkillTable'
import { createSeedEvents } from './data/seed'
import { useI18n } from './i18n/I18nProvider'
import type { MessageKey } from './i18n/messages'
import { filterEvents, runtimeLabel, summarize, terminalRuns } from './lib/analytics'
import { EventFileError, parseEventFile, type EventFileErrorCode } from './lib/import-events'
import type { Outcome, PageId, Runtime, RuntimeConnection, SkillEvent } from './types'

const EVENT_REFRESH_MS = 3_000
const CONNECTION_REFRESH_MS = 5_000
const pathForPage: Record<PageId, string> = {
  overview: '/',
  skills: '/skills',
  runs: '/runs',
  evaluations: '/evaluations',
  registry: '/registry',
  governance: '/governance',
  team: '/team',
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
  governance: 'nav.governance',
  team: 'nav.team',
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

type RunPageSize = 20 | 50 | 100
type RunSort = 'timestamp_desc' | 'timestamp_asc'
type RunCostFilter = '' | 'reported' | 'unreported'

interface RuntimeActivityCounts {
  sessions: number
  prompts: number
  toolCalls: number
  subagents: number
}

type RunActivity = Record<Extract<Runtime, 'codex' | 'claude-code'>, RuntimeActivityCounts>

interface RunPageResponse {
  items: SkillEvent[]
  page: number
  pageSize: RunPageSize
  totalItems: number
  totalPages: number
  hasPrevious: boolean
  hasNext: boolean
  activity?: RunActivity
}

interface RunDetailResponse {
  run: SkillEvent
  events: SkillEvent[]
  totalEvents: number
  truncated: boolean
}

interface RunLocationState {
  page: number
  pageSize: RunPageSize
  query: string
  project: string
  outcome: Outcome | ''
  sort: RunSort
  cost: RunCostFilter
  runtime: Runtime | 'all'
  days: number
}

const runPageSizes = new Set<RunPageSize>([20, 50, 100])
const runSorts = new Set<RunSort>(['timestamp_desc', 'timestamp_asc'])
const runOutcomes = new Set<Outcome>(['success', 'failed', 'unknown'])
const runCostFilters = new Set<Exclude<RunCostFilter, ''>>(['reported', 'unreported'])

function readRunLocation(): RunLocationState {
  const params = new URLSearchParams(window.location.search)
  const parsedPage = Number(params.get('page'))
  const parsedPageSize = Number(params.get('pageSize'))
  const parsedDays = Number(params.get('days'))
  const runtime = params.get('runtime')
  const outcome = params.get('outcome')
  const sort = params.get('sort')
  const cost = params.get('cost')
  return {
    page: Number.isInteger(parsedPage) && parsedPage >= 1 ? Math.min(parsedPage, 1_000_000) : 1,
    pageSize: runPageSizes.has(parsedPageSize as RunPageSize) ? parsedPageSize as RunPageSize : 20,
    query: params.get('query') ?? '',
    project: params.get('project') ?? '',
    outcome: runOutcomes.has(outcome as Outcome) ? outcome as Outcome : '',
    sort: runSorts.has(sort as RunSort) ? sort as RunSort : 'timestamp_desc',
    cost: runCostFilters.has(cost as Exclude<RunCostFilter, ''>) ? cost as RunCostFilter : '',
    runtime: runtime === 'codex' || runtime === 'claude-code' || runtime === 'cursor' ? runtime : 'all',
    days: parsedDays === 14 || parsedDays === 30 ? parsedDays : 7,
  }
}

function runLocationParams(state: RunLocationState) {
  const params = new URLSearchParams()
  params.set('page', String(state.page))
  params.set('pageSize', String(state.pageSize))
  params.set('days', String(state.days))
  params.set('sort', state.sort)
  if (state.query) params.set('query', state.query)
  if (state.project) params.set('project', state.project)
  if (state.outcome) params.set('outcome', state.outcome)
  if (state.runtime !== 'all') params.set('runtime', state.runtime)
  if (state.cost) params.set('cost', state.cost)
  return params
}

function writeRunLocation(state: RunLocationState, method: 'pushState' | 'replaceState' = 'replaceState') {
  window.history[method]({}, '', `/runs?${runLocationParams(state)}`)
}

function runsApiPath(state: RunLocationState) {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    query: state.query,
    runtime: state.runtime === 'all' ? '' : state.runtime,
    project: state.project,
    outcome: state.outcome,
    dateFrom: new Date(Date.now() - state.days * 86_400_000).toISOString(),
    dateTo: new Date().toISOString(),
    sort: state.sort,
    cost: state.cost,
  })
  return `/api/runs?${params}`
}

function isSkillEvent(value: unknown): value is SkillEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<SkillEvent>
  if (typeof event.id !== 'string' || !event.id.trim() || typeof event.timestamp !== 'string') return false
  try {
    normalizeEvent(value)
    return true
  } catch {
    return false
  }
}

function isRunEvent(value: unknown): value is SkillEvent {
  if (!isSkillEvent(value)) return false
  return value.event === 'skill.completed' || value.event === 'skill.failed'
}

function isRuntimeActivity(value: unknown): value is RunActivity {
  if (!value || typeof value !== 'object') return false
  const activity = value as Partial<RunActivity>
  return ['codex', 'claude-code'].every((runtime) => {
    const counts = activity[runtime as keyof RunActivity]
    return counts !== undefined && ['sessions', 'prompts', 'toolCalls', 'subagents'].every((field) => Number.isInteger(counts[field as keyof RuntimeActivityCounts]) && counts[field as keyof RuntimeActivityCounts] >= 0)
  })
}

function isRunPageResponse(value: unknown): value is RunPageResponse {
  if (!value || typeof value !== 'object') return false
  const page = value as Partial<RunPageResponse>
  return Array.isArray(page.items)
    && page.items.every(isRunEvent)
    && Number.isInteger(page.page) && Number(page.page) >= 1
    && runPageSizes.has(page.pageSize as RunPageSize)
    && Number.isInteger(page.totalItems) && Number(page.totalItems) >= 0
    && Number.isInteger(page.totalPages) && Number(page.totalPages) >= 0
    && typeof page.hasPrevious === 'boolean'
    && typeof page.hasNext === 'boolean'
    && (page.activity === undefined || isRuntimeActivity(page.activity))
}

function isRunDetailResponse(value: unknown): value is RunDetailResponse {
  if (!value || typeof value !== 'object') return false
  const detail = value as Partial<RunDetailResponse>
  return isRunEvent(detail.run)
    && Array.isArray(detail.events)
    && detail.events.every(isSkillEvent)
    && Number.isInteger(detail.totalEvents)
    && Number(detail.totalEvents) >= detail.events.length
    && typeof detail.truncated === 'boolean'
    && detail.truncated === (Number(detail.totalEvents) > detail.events.length)
}

function matchesRunFilters(event: SkillEvent, state: RunLocationState) {
  const query = state.query.trim().toLocaleLowerCase()
  const project = state.project.trim().toLocaleLowerCase()
  if (query && ![event.skillId, event.id, event.project].some((value) => String(value ?? '').toLocaleLowerCase().includes(query))) return false
  if (project && !String(event.project ?? '').toLocaleLowerCase().includes(project)) return false
  if (state.outcome && (event.event === 'skill.failed' ? 'failed' : event.outcome ?? 'unknown') !== state.outcome) return false
  const reportedCost = typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)
  if (state.cost === 'reported' && !reportedCost) return false
  if (state.cost === 'unreported' && reportedCost) return false
  return true
}

function localRunPage(events: SkillEvent[], state: RunLocationState): RunPageResponse {
  const direction = state.sort === 'timestamp_asc' ? 1 : -1
  const matches = terminalRuns(events).filter((event) => matchesRunFilters(event, state)).sort((left, right) => {
    const timestampDifference = Date.parse(left.timestamp) - Date.parse(right.timestamp)
    if (timestampDifference) return timestampDifference * direction
    return left.id.localeCompare(right.id) * direction
  })
  const totalItems = matches.length
  const totalPages = Math.ceil(totalItems / state.pageSize)
  const offset = (state.page - 1) * state.pageSize
  return {
    items: matches.slice(offset, offset + state.pageSize),
    page: state.page,
    pageSize: state.pageSize,
    totalItems,
    totalPages,
    hasPrevious: totalItems > 0 && state.page > 1,
    hasNext: state.page < totalPages,
  }
}

function runFilterScope(state: RunLocationState) {
  return JSON.stringify([state.runtime, state.days, state.query.trim().toLocaleLowerCase(), state.project.trim().toLocaleLowerCase(), state.outcome, state.cost])
}

function neighboringPages(current: number, total: number) {
  if (total <= 0) return []
  const length = Math.min(5, total)
  const start = Math.min(Math.max(1, current - 2), total - length + 1)
  return Array.from({ length }, (_, index) => start + index)
}

interface RunsPageProps {
  events: SkillEvent[]
  mode: 'loading' | 'demo' | 'local'
  runtime: Runtime | 'all'
  days: number
  onRunsAvailable: () => void
  onRunsRetry: () => void
  onRunsUnavailable: (error: string) => void
  requestedRunId: string | null
  onRequestedRunHandled: () => void
  onRuntimeChange: (runtime: Runtime | 'all') => void
  onDaysChange: (days: number) => void
  onConnect: () => void
  onImport: (events: SkillEvent[]) => Promise<number>
}

export default function App() {
  const { t } = useI18n()
  const [page, setPage] = useState<PageId>(currentPage)
  const [events, setEvents] = useState<SkillEvent[]>([])
  const [runtime, setRuntime] = useState<Runtime | 'all'>(() => currentPage() === 'runs' ? readRunLocation().runtime : 'all')
  const [days, setDays] = useState(() => currentPage() === 'runs' ? readRunLocation().days : 7)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectRuntime, setConnectRuntime] = useState<Runtime>('codex')
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null)
  const [connections, setConnections] = useState<RuntimeConnection[]>(checkingConnections)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<'loading' | 'demo' | 'local'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [runsMode, setRunsMode] = useState<'loading' | 'demo' | 'local'>('loading')
  const [runsLoadError, setRunsLoadError] = useState<string | null>(null)
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
    if (page === 'runs') return
    let cancelled = false
    const controller = new AbortController()
    const load = async (initial: boolean) => {
      try {
        const response = await fetch('/api/events', {
          signal: controller.signal,
          ...(eventEtag.current ? { headers: { 'If-None-Match': eventEtag.current } } : {}),
        })
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
    return () => { cancelled = true; controller.abort(); window.clearInterval(interval) }
  }, [page, t])

  useEffect(() => {
    void loadConnections()
    const interval = window.setInterval(() => { void loadConnections() }, CONNECTION_REFRESH_MS)
    return () => { window.clearInterval(interval) }
  }, [loadConnections])

  useEffect(() => {
    const restorePage = () => {
      const nextPage = currentPage()
      if (nextPage === 'runs') {
        const restored = readRunLocation()
        setRuntime(restored.runtime)
        setDays(restored.days)
      }
      setPage(nextPage)
    }
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
  const openCostRuns = () => {
    window.history.pushState({}, '', '/runs?cost=reported')
    setPage('runs')
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
    return result.importedCount ?? 0
  }

  const markRunsAvailable = useCallback(() => {
    setRunsMode('local')
    setRunsLoadError(null)
  }, [])

  const retryRuns = useCallback(() => {
    setRunsMode('loading')
    setRunsLoadError(null)
  }, [])

  const useRunsDemo = useCallback((error: string) => {
    setEvents(createSeedEvents())
    setMode('demo')
    setLoadError(error)
    setRunsMode('demo')
    setRunsLoadError(error)
  }, [])

  const clearLocalEvents = async () => {
    const response = await fetch('/api/events', { method: 'DELETE' })
    const result = await response.json() as { removed?: number; backupFile?: string; error?: string }
    if (!response.ok) throw new Error(result.error || t('errors.clearStatus', { status: response.status }))
    setEvents([])
    eventEtag.current = null
    setMode('local')
    return { removed: result.removed ?? 0, backupFile: result.backupFile }
  }

  const activeMode = page === 'runs' ? runsMode : mode
  const activeLoadError = page === 'runs' ? runsLoadError : loadError
  const showEventFilters = page === 'overview' || page === 'skills' || page === 'runs'
  const modeLabel = page === 'registry' ? t('mode.liveInventory')
    : page === 'evaluations' ? t('mode.liveEvaluation')
      : page === 'governance' ? t('mode.liveGovernance')
        : page === 'team' ? t('mode.liveTeam')
          : activeMode === 'loading' ? t('mode.loadingEvents') : activeMode === 'demo' ? t('mode.demoDataset') : t('mode.localEvents')

  return (
    <div className="app-shell">
      <Sidebar page={page} open={menuOpen} onNavigate={navigate} onToggle={() => setMenuOpen((open) => !open)} onClose={() => setMenuOpen(false)} />
      <main className="app-main">
        <header className="topbar">
          <div className="title-wrap"><h1>{t(pageTitle[page])}</h1><span className={`data-mode ${activeMode}`}>{modeLabel}</span></div>
          <div className="topbar-actions">
            {showEventFilters && <label className="select-control date-select"><CalendarDays size={16} /><select aria-label={t('common.dateRange')} value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>{t('common.lastDays', { count: 7 })}</option><option value={14}>{t('common.lastDays', { count: 14 })}</option><option value={30}>{t('common.lastDays', { count: 30 })}</option></select><ChevronDown size={14} /></label>}
            {showEventFilters && <label className="select-control runtime-select"><Code2 size={16} /><select aria-label={t('common.runtime')} value={runtime} onChange={(event) => setRuntime(event.target.value as Runtime | 'all')}><option value="all">{t('common.allRuntimes')}</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="cursor">Cursor</option></select><ChevronDown size={14} /></label>}
            <button className="button primary connect-button" type="button" onClick={() => openConnect(runtime === 'all' ? 'codex' : runtime)}><PlugZap size={16} />{t('common.connectRuntime')}</button>
          </div>
        </header>

        {activeLoadError && page !== 'registry' && <div className="data-warning" role="alert">{t('mode.loadWarning', { error: activeLoadError })}</div>}

        {page === 'overview' && (
          <div className="dashboard-layout">
            <div className="dashboard-content">
              <KpiStrip {...summary} mode={mode === 'demo' ? 'demo' : 'local'} onViewCostRuns={openCostRuns} />
              {visibleRuns.length ? <><div className="charts-grid"><RunsChart events={filtered} days={days} /><RuntimeDistribution events={filtered} /></div><SkillTable events={filtered} definitionEvents={events} limit={4} days={days} demo={mode === 'demo'} onViewRun={openRun} />{mode === 'demo' && <Insight onCompare={() => navigate('evaluations')} />}</> : <EmptyActivity runtime={runtime} days={days} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onShowAll={runtime === 'all' ? undefined : () => setRuntime('all')} />}
            </div>
            <ActivityRail events={filtered} onViewAll={() => navigate('runs')} onSelectRun={(run) => openRun(run.id)} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} refreshLabel={t('activity.refresh')} />
          </div>
        )}
        {page === 'skills' && <div className="single-page">{visibleRuns.length ? <SkillTable events={filtered} definitionEvents={events} searchable days={days} demo={mode === 'demo'} onViewRun={openRun} /> : <EmptyActivity runtime={runtime} days={days} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onShowAll={runtime === 'all' ? undefined : () => setRuntime('all')} />}</div>}
        {page === 'runs' && <RunsPage events={filtered} mode={runsMode} runtime={runtime} days={days} requestedRunId={requestedRunId} onRequestedRunHandled={() => setRequestedRunId(null)} onRunsAvailable={markRunsAvailable} onRunsRetry={retryRuns} onRunsUnavailable={useRunsDemo} onRuntimeChange={setRuntime} onDaysChange={setDays} onConnect={() => openConnect(runtime === 'all' ? 'codex' : runtime)} onImport={importEvents} />}
        {page === 'evaluations' && <EvaluationWorkspace />}
        {page === 'registry' && <RegistryPage events={events} />}
        {page === 'governance' && <GovernancePage />}
        {page === 'team' && <TeamPage />}
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

function RunsPage({ events, mode, runtime, days, requestedRunId, onRequestedRunHandled, onRunsAvailable, onRunsRetry, onRunsUnavailable, onRuntimeChange, onDaysChange, onConnect, onImport }: RunsPageProps) {
  const { formatNumber, t } = useI18n()
  const initial = useMemo(readRunLocation, [])
  const input = useRef<HTMLInputElement>(null)
  const listTop = useRef<HTMLDivElement>(null)
  const requestSequence = useRef(0)
  const previousLoadedPage = useRef(initial.page)
  const successfulLocation = useRef<RunLocationState | null>(null)
  const rollbackLocation = useRef<string | null>(null)
  const pendingPagePush = useRef<string | null>(null)
  const previousScope = useRef(`${runtime}:${days}`)
  const knownRunTotal = useRef<number | null>(null)
  const knownRunScope = useRef('')
  const knownNewestRun = useRef<Pick<SkillEvent, 'id' | 'timestamp'> | null>(null)
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null)
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState(initial.query)
  const [project, setProject] = useState(initial.project)
  const [outcome, setOutcome] = useState<Outcome | ''>(initial.outcome)
  const [sort, setSort] = useState<RunSort>(initial.sort)
  const [cost, setCost] = useState<RunCostFilter>(initial.cost)
  const [runPage, setRunPage] = useState(initial.page)
  const [pageSize, setPageSize] = useState<RunPageSize>(initial.pageSize)
  const [result, setResult] = useState<RunPageResponse>({
    items: [],
    page: initial.page,
    pageSize: initial.pageSize,
    totalItems: 0,
    totalPages: 0,
    hasPrevious: false,
    hasNext: false,
  })
  const [loading, setLoading] = useState(true)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [newRunCount, setNewRunCount] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null)
  const locationState: RunLocationState = { page: runPage, pageSize, query, project, outcome, sort, cost, runtime, days }

  useEffect(() => {
    const scope = `${runtime}:${days}`
    if (previousScope.current === scope) return
    previousScope.current = scope
    setRunPage(1)
  }, [days, runtime])

  useEffect(() => {
    const key = runLocationParams(locationState).toString()
    if (pendingPagePush.current === key) return
    pendingPagePush.current = null
    writeRunLocation(locationState)
  }, [cost, days, outcome, pageSize, project, query, runPage, runtime, sort])

  useEffect(() => {
    const restore = () => {
      if (currentPage() !== 'runs') return
      const restored = readRunLocation()
      previousScope.current = `${restored.runtime}:${restored.days}`
      setRunPage(restored.page)
      setPageSize(restored.pageSize)
      setQuery(restored.query)
      setProject(restored.project)
      setOutcome(restored.outcome)
      setSort(restored.sort)
      setCost(restored.cost)
      onRuntimeChange(restored.runtime)
      onDaysChange(restored.days)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [onDaysChange, onRuntimeChange])

  useEffect(() => {
    if (rollbackLocation.current !== null) {
      if (rollbackLocation.current === runLocationParams(locationState).toString()) rollbackLocation.current = null
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    setLoading(true)
    setRunsError(null)
    void (async () => {
      let apiResponded = mode === 'demo'
      try {
        let body: unknown
        if (mode === 'demo') {
          body = localRunPage(events, locationState)
        } else {
          const response = await fetch(runsApiPath(locationState), { signal: controller.signal })
          apiResponded = true
          body = await response.json() as unknown
          if (!response.ok) {
            const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : t('runs.loadFailed')
            throw new Error(message)
          }
        }
        if (!isRunPageResponse(body)) throw new Error(t('runs.invalidResponse'))
        if (controller.signal.aborted || sequence !== requestSequence.current) return
        if (mode !== 'demo') onRunsAvailable()
        const locationKey = runLocationParams(locationState).toString()
        const lastPage = Math.max(1, body.totalPages)
        if (runPage > lastPage) {
          if (pendingPagePush.current === locationKey) {
            pendingPagePush.current = runLocationParams({ ...locationState, page: lastPage }).toString()
          }
          setRunPage(lastPage)
          return
        }
        if (pendingPagePush.current === locationKey) {
          pendingPagePush.current = null
          if (runLocationParams(readRunLocation()).toString() !== locationKey) writeRunLocation(locationState, 'pushState')
        }
        setResult(body)
        successfulLocation.current = locationState
        if (previousLoadedPage.current !== body.page) listTop.current?.scrollIntoView?.({ block: 'start' })
        previousLoadedPage.current = body.page
      } catch (error) {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          const message = error instanceof Error ? error.message : t('runs.loadFailed')
          const locationKey = runLocationParams(locationState).toString()
          if (pendingPagePush.current === locationKey) pendingPagePush.current = null
          if (mode === 'loading' && apiResponded) onRunsAvailable()
          if (mode === 'loading' && !apiResponded) {
            onRunsUnavailable(message)
          } else {
            setRunsError(message)
            const previous = successfulLocation.current
            if (previous && runLocationParams(previous).toString() !== runLocationParams(locationState).toString()) {
              rollbackLocation.current = runLocationParams(previous).toString()
              previousScope.current = `${previous.runtime}:${previous.days}`
              writeRunLocation(previous)
              setRunPage(previous.page)
              setPageSize(previous.pageSize)
              setQuery(previous.query)
              setProject(previous.project)
              setOutcome(previous.outcome)
              setSort(previous.sort)
              setCost(previous.cost)
              onRuntimeChange(previous.runtime)
              onDaysChange(previous.days)
            }
          }
        }
      } finally {
        if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [cost, days, events, outcome, pageSize, project, query, refreshVersion, runPage, runtime, sort, t])

  useEffect(() => {
    knownRunScope.current = runFilterScope(locationState)
    knownRunTotal.current = null
    knownNewestRun.current = null
    setNewRunCount(0)
  }, [cost, days, outcome, project, query, runtime, sort])

  useEffect(() => {
    if (mode === 'loading') return
    const controller = new AbortController()
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const response = await fetch(runsApiPath({ ...locationState, page: 1, pageSize: 20, sort: 'timestamp_desc' }), { signal: controller.signal })
        const body = await response.json() as unknown
        if (!response.ok || !isRunPageResponse(body) || controller.signal.aborted) return
        if (mode === 'demo') {
          onRunsRetry()
          setRefreshVersion((version) => version + 1)
          return
        }
        if (successfulLocation.current === null) {
          setRefreshVersion((version) => version + 1)
          return
        }
        const lastPage = Math.max(1, Math.ceil(body.totalItems / pageSize))
        setRunPage((current) => Math.min(current, lastPage))
        const scope = runFilterScope(locationState)
        const latest = body.items[0] ?? null
        if (knownRunTotal.current === null || knownRunScope.current !== scope) {
          knownRunScope.current = scope
          knownRunTotal.current = body.totalItems
          knownNewestRun.current = latest
          return
        }
        const baseline = knownNewestRun.current
        // ponytail: the bounded newest page detects up to 20 arrivals per poll; add an API cursor if exact burst counts become necessary.
        const added = baseline
          ? body.items.filter((event) => {
            const timestampDifference = Date.parse(event.timestamp) - Date.parse(baseline.timestamp)
            return timestampDifference > 0 || (timestampDifference === 0 && event.id > baseline.id)
          }).length
          : Math.max(0, body.totalItems - knownRunTotal.current)
        knownRunTotal.current = body.totalItems
        knownNewestRun.current = latest
        if (added) setNewRunCount((count) => count + added)
      } catch {
        // Polling is advisory and must not replace the loaded page with an error.
      } finally {
        checking = false
      }
    }
    const interval = window.setInterval(() => { void check() }, EVENT_REFRESH_MS)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [cost, days, mode, outcome, pageSize, project, query, runtime, sort])

  useEffect(() => {
    if (!requestedRunId) return
    const fallback = result.items.find((event) => event.id === requestedRunId) ?? terminalRuns(events).find((event) => event.id === requestedRunId)
    setSelectedRunId(requestedRunId)
    if (fallback) {
      const detailEvents = mode === 'demo' ? correlatedRunEvents(fallback, events) : [fallback]
      setRunDetail({ run: fallback, events: detailEvents, totalEvents: detailEvents.length, truncated: false })
    }
    onRequestedRunHandled()
  }, [events, mode, onRequestedRunHandled, requestedRunId, result.items])

  useEffect(() => {
    if (!selectedRunId || mode === 'demo') return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`/api/runs/~${encodeURIComponent(selectedRunId)}`, { signal: controller.signal })
        const body = await response.json() as unknown
        if (!response.ok) {
          const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : t('runs.loadFailed')
          throw new Error(message)
        }
        if (!isRunDetailResponse(body)) throw new Error(t('runs.invalidResponse'))
        if (!controller.signal.aborted) setRunDetail(body)
      } catch (error) {
        if (!controller.signal.aborted) setRunsError(error instanceof Error ? error.message : t('runs.loadFailed'))
      }
    })()
    return () => controller.abort()
  }, [mode, selectedRunId, t])

  const goToPage = (page: number) => {
    const target = Math.min(Math.max(1, page), Math.max(1, result.totalPages))
    if (target === runPage) return
    pendingPagePush.current = runLocationParams({ ...locationState, page: target }).toString()
    setRunPage(target)
  }
  const resetPage = () => setRunPage(1)
  const refreshRuns = () => {
    setNewRunCount(0)
    knownRunTotal.current = null
    knownNewestRun.current = null
    setRefreshVersion((version) => version + 1)
  }
  const handleFile = async (file?: File) => {
    if (!file) return
    setImporting(true)
    setImportFeedback(null)
    try {
      const incoming = parseEventFile(await file.text())
      const importedCount = await onImport(incoming)
      knownRunTotal.current = null
      knownNewestRun.current = null
      setNewRunCount(0)
      setRefreshVersion((version) => version + 1)
      setImportFeedback({ kind: 'success', count: importedCount })
    } catch (error) {
      setImportFeedback(error instanceof EventFileError
        ? { kind: 'error', code: error.code, line: error.line }
        : { kind: 'error', code: 'request-failed' })
    } finally {
      setImporting(false)
    }
  }
  const firstRun = result.totalItems ? (result.page - 1) * result.pageSize + 1 : 0
  const lastRun = Math.min(result.page * result.pageSize, result.totalItems)
  const resultLabel = t('runs.resultCount', {
    first: formatNumber(firstRun),
    last: formatNumber(lastRun),
    count: formatNumber(result.totalItems),
    unit: t(result.totalItems === 1 ? 'common.run' : 'common.runs'),
  })
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
      {newRunCount > 0 && <div className="new-runs-notice" role="status"><span>{t(newRunCount === 1 ? 'runs.newRun' : 'runs.newRuns', { count: formatNumber(newRunCount) })}</span><button className="button secondary" type="button" onClick={refreshRuns}>{t('runs.refresh')}</button></div>}
      <div className="runtime-lifecycles">
        <RuntimeLifecycle counts={result.activity?.codex} events={events} runtime="codex" />
        <RuntimeLifecycle counts={result.activity?.['claude-code']} events={events} runtime="claude-code" />
      </div>
      <div className="runs-toolbar">
        <label className="search-control"><Search size={15} /><input type="search" maxLength={200} aria-label={t('runs.search')} placeholder={t('runs.searchPlaceholder')} value={query} onChange={(event) => { setQuery(event.target.value); resetPage() }} /></label>
        <label className="runs-filter-control"><span>{t('common.project')}</span><input maxLength={200} aria-label={t('runs.projectFilter')} placeholder={t('runs.projectPlaceholder')} value={project} onChange={(event) => { setProject(event.target.value); resetPage() }} /></label>
        <label className="runs-filter-control"><span>{t('runs.outcome')}</span><select aria-label={t('runs.outcome')} value={outcome} onChange={(event) => { setOutcome(event.target.value as Outcome | ''); resetPage() }}><option value="">{t('runs.allOutcomes')}</option><option value="success">{t('activity.success')}</option><option value="failed">{t('activity.failed')}</option><option value="unknown">{t('activity.observed')}</option></select></label>
        <label className="runs-filter-control"><span>{t('runs.sort')}</span><select aria-label={t('runs.sort')} value={sort} onChange={(event) => { setSort(event.target.value as RunSort); resetPage() }}><option value="timestamp_desc">{t('runs.newestFirst')}</option><option value="timestamp_asc">{t('runs.oldestFirst')}</option></select></label>
        <label className="runs-filter-control"><span>{t('common.cost')}</span><select aria-label={t('runs.costFilter')} value={cost} onChange={(event) => { setCost(event.target.value as RunCostFilter); resetPage() }}><option value="">{t('runs.allCosts')}</option><option value="reported">{t('runs.reportedCosts')}</option><option value="unreported">{t('runs.unreportedCosts')}</option></select></label>
      </div>
      <div className="runs-pagination-bar">
        <span role="status" aria-live="polite" aria-atomic="true">{resultLabel}</span>
        <label className="runs-filter-control page-size-control"><span>{t('runs.pageSize')}</span><select aria-label={t('runs.pageSize')} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) as RunPageSize); resetPage() }}>{[20, 50, 100].map((size) => <option key={size} value={size}>{formatNumber(size)}</option>)}</select></label>
        <div className="pagination-controls">
          <button type="button" aria-label={t('common.firstPage')} disabled={runPage <= 1} onClick={() => goToPage(1)}>«</button>
          <button type="button" aria-label={t('common.previousPage')} disabled={runPage <= 1} onClick={() => goToPage(runPage - 1)}><ChevronLeft size={15} /></button>
          {neighboringPages(runPage, result.totalPages).map((page) => <button className="page-number" type="button" aria-current={page === runPage ? 'page' : undefined} aria-label={t(page === runPage ? 'runs.currentPage' : 'runs.pageNumber', { page: formatNumber(page) })} key={page} onClick={() => goToPage(page)}>{formatNumber(page)}</button>)}
          <span>{t('common.pageOf', { page: formatNumber(result.totalPages ? runPage : 0), count: formatNumber(result.totalPages) })}</span>
          <button type="button" aria-label={t('common.nextPage')} disabled={result.totalPages === 0 || runPage >= result.totalPages} onClick={() => goToPage(runPage + 1)}><ChevronRight size={15} /></button>
          <button type="button" aria-label={t('common.lastPage')} disabled={result.totalPages === 0 || runPage >= result.totalPages} onClick={() => goToPage(result.totalPages)}>»</button>
        </div>
      </div>
      {runsError && <div className="data-warning" role="alert">{t('runs.loadError', { error: runsError })}</div>}
      <div className={`runs-list-shell${loading ? ' is-loading' : ''}`} ref={listTop} aria-busy={loading}>
        {loading && <span className="runs-loading" aria-live="polite">{t('runs.loading')}</span>}
        <ActivityRail events={result.items} expanded onSelectRun={(run) => {
          const detailEvents = mode === 'demo' ? correlatedRunEvents(run, events) : [run]
          setSelectedRunId(run.id)
          setRunDetail({ run, events: detailEvents, totalEvents: detailEvents.length, truncated: false })
        }} onConnect={onConnect} />
      </div>
      {runDetail && <RunDetail run={runDetail.run} events={runDetail.events} totalEvents={runDetail.totalEvents} truncated={runDetail.truncated} onClose={() => { setSelectedRunId(null); setRunDetail(null) }} />}
    </div>
  )
}


function RuntimeLifecycle({ counts, events, runtime }: { counts?: RuntimeActivityCounts; events: SkillEvent[]; runtime: Extract<Runtime, 'codex' | 'claude-code'> }) {
  const { formatNumber, t } = useI18n()
  const activity = counts ?? events.reduce<RuntimeActivityCounts>((total, event) => {
    if (event.runtime !== runtime) return total
    if (event.event === 'session.started') total.sessions += 1
    else if (event.event === 'prompt.submitted') total.prompts += 1
    else if (event.event === 'tool.completed') total.toolCalls += 1
    else if (event.event === 'subagent.started') total.subagents += 1
    return total
  }, { sessions: 0, prompts: 0, toolCalls: 0, subagents: 0 })
  const items = [
    { label: t('runs.sessions'), value: activity.sessions },
    { label: t('runs.prompts'), value: activity.prompts },
    { label: t('runs.toolCalls'), value: activity.toolCalls },
    { label: t('runs.subagents'), value: activity.subagents },
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
