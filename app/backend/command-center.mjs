import { aiProviderDefinition } from '../shared/ai-provider-catalog.mjs'
import { isQualifyingLifecycle, runtimeMetrics } from '../shared/truth-semantics.mjs'
import { setJsonApiHeaders, sendApiError, sendJson } from './api-response.mjs'
import { readAiSettings as readStoredSettings } from './ai-settings-store.mjs'
import { syncCodexDesktopEvents } from './codex-desktop-ingest.mjs'
import { eventVersion, readEvents as readStoredEvents } from './event-store.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest } from './evaluations/request-guard.mjs'
import { enrichRuntimeConnections, readRuntimeConnections as inspectRuntimeConnections } from './runtime-connections.mjs'

const RUNTIMES = new Set(['all', 'codex', 'claude-code', 'cursor'])
const DAY_WINDOWS = new Map([['7d', 7], ['14d', 14], ['30d', 30]])
const RECENT_LIMIT = 8
const CACHE_TTL_MS = 2_500
const projectionCache = new Map()

const metricDefinitions = Object.freeze({
  runs: 'skill.completed + skill.failed lifecycle events in the selected runtime and date range',
  successRate: 'known success / (known success + known failed); unknown outcomes are excluded',
  activeSkills: 'distinct Skill identifiers with qualifying non-Discovery lifecycle evidence',
  costUsd: 'sum of finite reported costUsd values; unavailable when no run reports cost',
  costCoverage: 'runs with finite reported costUsd / all terminal Skill runs',
})

function configuredProvider(settings) {
  const definition = aiProviderDefinition(settings?.activeProvider)
  const config = settings?.providers?.[settings?.activeProvider]
  return Boolean(definition && config?.model?.trim() && config?.baseUrl?.trim()
    && (!definition.requiresKey || config?.apiKey?.trim()))
}

function sourceResult(status, value) {
  return { status, value }
}

async function settle(reader, fallback) {
  try {
    return sourceResult('ok', await reader())
  } catch {
    return sourceResult('unavailable', fallback)
  }
}

function scopedEvents(events, runtime, days, now) {
  const end = Date.parse(now)
  const start = end - days * 86_400_000
  return events.filter((event) => {
    const timestamp = Date.parse(event.timestamp)
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end
      && (runtime === 'all' || event.runtime === runtime)
  })
}

function sanitizedActivity(event) {
  return {
    id: event.id,
    event: event.event,
    runtime: event.runtime,
    timestamp: event.timestamp,
    ...(event.skillId ? { skillId: event.skillId } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
    ...(Number.isFinite(event.costUsd) ? { costUsd: event.costUsd } : {}),
  }
}

function createIssue(id, priority, severity, href, data = {}) {
  return { id, priority, severity, href, data }
}

export function buildCommandCenter({
  events = [],
  connections = [],
  providerConfigured = false,
  runtime = 'all',
  days = 7,
  now = new Date().toISOString(),
  sources = { events: 'ok', connections: 'ok', provider: 'ok' },
} = {}) {
  const scoped = scopedEvents(events, runtime, days, now)
  const metrics = runtimeMetrics(scoped)
  const unknownOutcomes = metrics.terminalRuns - metrics.knownOutcomes
  const failures = scoped.filter((event) => event.event === 'skill.failed').length
  const currentConnections = connections.filter((connection) => connection.runtime !== 'cursor')
  const installed = currentConnections.filter((connection) => connection.configurationStatus === 'installed' || connection.status === 'installed')
  const verified = currentConnections.filter((connection) => connection.connectionStage === 'verified')
  const degraded = currentConnections.filter((connection) => connection.connectionStage === 'degraded')
  const issues = []

  if (Object.values(sources).some((status) => status !== 'ok')) {
    issues.push(createIssue('source-unavailable', 110, 'high', '/settings?section=data', {
      sources: Object.entries(sources).filter(([, status]) => status !== 'ok').map(([source]) => source),
    }))
  }
  if (degraded.length) issues.push(createIssue('repair-runtime', 105, 'high', '/settings?section=connections', { count: degraded.length }))
  else if (!verified.length) {
    issues.push(installed.length
      ? createIssue('verify-runtime', 100, 'high', '/settings?section=connections', { count: installed.length })
      : createIssue('connect-runtime', 100, 'high', '/settings?section=connections'))
  }
  if (failures) issues.push(createIssue('review-failures', 90, 'high', '/activity?tab=runs&outcome=failed', { count: failures }))
  if (unknownOutcomes) issues.push(createIssue('review-unknown-outcomes', 80, 'medium', '/activity?tab=runs&outcome=unknown', { count: unknownOutcomes }))
  if (metrics.terminalRuns && metrics.costCoverage.numerator < metrics.costCoverage.denominator) {
    issues.push(createIssue('review-cost-coverage', 70, 'low', '/activity?tab=runs&cost=unreported', {
      reported: metrics.costCoverage.numerator,
      total: metrics.costCoverage.denominator,
    }))
  }
  if (!providerConfigured) issues.push(createIssue('configure-provider', 40, 'low', '/benchmarks?tab=suites&configure=provider'))
  issues.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))

  const allSourcesHealthy = Object.values(sources).every((status) => status === 'ok')
  const readinessLevel = !allSourcesHealthy ? 'attention' : verified.length ? 'ready' : installed.length ? 'attention' : 'setup'
  const activity = scoped
    .filter((event) => event.event !== 'skill.discovered')
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, RECENT_LIMIT)
    .map(sanitizedActivity)

  return {
    generatedAt: now,
    scope: { runtime, days },
    sources,
    readiness: {
      level: readinessLevel,
      verifiedRuntimes: verified.map((connection) => connection.runtime),
      installedRuntimes: installed.map((connection) => connection.runtime),
      providerConfigured,
    },
    metrics: {
      runs: metrics.terminalRuns,
      knownOutcomes: metrics.knownOutcomes,
      unknownOutcomes,
      successRate: metrics.successRate.value,
      activeSkills: metrics.observedAssets,
      costUsd: metrics.reportedCostUsd,
      costReportedRuns: metrics.costCoverage.numerator,
      costCoverage: metrics.costCoverage.value,
    },
    metricDefinitions,
    issues,
    nextActions: issues.slice(0, 3),
    recentActivity: activity,
  }
}

export async function readCommandCenter({
  runtime = 'all',
  days = 7,
  now = new Date().toISOString(),
  syncEvents = syncCodexDesktopEvents,
  readEvents = readStoredEvents,
  readConnections = inspectRuntimeConnections,
  readSettings = readStoredSettings,
} = {}) {
  let eventStatus = 'ok'
  try {
    await syncEvents()
  } catch {
    eventStatus = 'partial'
  }
  const [eventSource, connectionSource, settingsSource] = await Promise.all([
    settle(readEvents, []),
    settle(readConnections, []),
    settle(readSettings, null),
  ])
  if (eventSource.status === 'unavailable') eventStatus = 'unavailable'
  const connections = connectionSource.status === 'ok'
    ? enrichRuntimeConnections(connectionSource.value, eventSource.value, now)
    : []
  const sources = {
    events: eventStatus,
    connections: connectionSource.status,
    provider: settingsSource.status,
  }
  return buildCommandCenter({
    events: eventSource.value,
    connections,
    providerConfigured: settingsSource.status === 'ok' && configuredProvider(settingsSource.value),
    runtime,
    days,
    now,
    sources,
  })
}

export async function readCachedCommandCenter({
  runtime = 'all',
  days = 7,
  readRevision = eventVersion,
  reader = readCommandCenter,
  clock = Date.now,
} = {}) {
  const revision = await readRevision()
  const key = `${runtime}:${days}`
  const now = clock()
  const cached = projectionCache.get(key)
  if (cached?.revision === revision && cached.expiresAt > now) return cached.value
  const value = Promise.resolve(reader({ runtime, days }))
  const entry = { revision, expiresAt: now + CACHE_TTL_MS, value }
  projectionCache.set(key, entry)
  try {
    return await value
  } catch (error) {
    if (projectionCache.get(key) === entry) projectionCache.delete(key)
    throw error
  }
}

export async function handleCommandCenterApi(request, response, pathname, services = {}) {
  if (pathname !== '/api/command-center') return false
  setJsonApiHeaders(response)
  try {
    assertLocalApiRequest(request)
    if (request.method !== 'GET') throw new EvaluationError('Method not allowed.', 405)
    const params = new URL(request.url || pathname, 'http://127.0.0.1').searchParams
    const runtime = params.get('runtime') || 'all'
    const days = DAY_WINDOWS.get(params.get('window') || '7d')
    if (!RUNTIMES.has(runtime)) throw new EvaluationError('runtime is invalid.', 400)
    if (!days) throw new EvaluationError('window must be 7d, 14d, or 30d.', 400)
    const snapshot = Object.keys(services).length
      ? await readCommandCenter({ ...services, runtime, days })
      : await readCachedCommandCenter({ runtime, days })
    sendJson(response, 200, snapshot)
  } catch (error) {
    if (error?.status === 405) response.setHeader('Allow', 'GET')
    sendApiError(response, error, 'Command Center aggregate failed.')
  }
  return true
}
