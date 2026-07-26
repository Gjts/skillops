import { aiProviderDefinition } from '../shared/ai-provider-catalog.mjs'
import { isQualifyingLifecycle, runtimeMetrics } from '../shared/truth-semantics.mjs'
import { setJsonApiHeaders, sendApiError, sendJson } from './api-response.mjs'
import { readAiSettings as readStoredSettings } from './ai-settings-store.mjs'
import { syncCodexDesktopEvents } from './codex-desktop-ingest.mjs'
import { eventVersion, readEventsWithStatus as readStoredEvents } from './event-store.mjs'
import { createEvaluationStore } from './evaluations/evaluation-store.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest } from './evaluations/request-guard.mjs'
import { initializeGovernanceServices } from './governance/governance-api.mjs'
import { enrichRuntimeConnections, readRuntimeConnections as inspectRuntimeConnections } from './runtime-connections.mjs'
import { readSetupPreflight } from './setup-preflight.mjs'
import { scanSkillInventory } from './skill-scanner.mjs'

const RUNTIMES = new Set(['all', 'codex', 'claude-code', 'cursor'])
const DAY_WINDOWS = new Map([['1d', 1], ['7d', 7], ['14d', 14], ['30d', 30]])
const RECENT_LIMIT = 8
const CACHE_TTL_MS = 2_500
const projectionCache = new Map()
const ACTION_PRIORITY = Object.freeze({
  blocker: 0,
  trust: 1,
  safety: 2,
  improvement: 3,
  maintenance: 4,
})
const ACTION_IMPACT = Object.freeze({
  blocker: 'Blocks trustworthy daily operation until resolved.',
  trust: 'Reduces confidence in the available evidence.',
  safety: 'May expose a known quality or release risk.',
  improvement: 'Limits an optional evidence-building workflow.',
  maintenance: 'Can reduce freshness or completeness over time.',
})

const metricDefinitions = Object.freeze({
  terminalRuns: 'skill.completed + skill.failed lifecycle events in the selected runtime and date range',
  knownOutcomes: 'terminal runs whose outcome is explicitly success or failed',
  successRate: 'known success / (known success + known failed); unknown outcomes are excluded',
  runtimeOutcomeCoverage: 'known outcomes / all terminal Skill runs',
  observedAssets: 'distinct Skill identifiers with qualifying non-Discovery lifecycle evidence',
  reportedCostUsd: 'sum of finite reported costUsd values; unavailable when no run reports cost',
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

async function readStoredEvaluations() {
  const store = createEvaluationStore()
  const [runs, health] = await Promise.all([
    store.listRuns({ limit: 100 }),
    store.health(),
  ])
  return { items: runs.items, health }
}

async function readStoredGovernance() {
  const { governance } = await initializeGovernanceServices()
  return governance.list()
}

function windowStart(days, now) {
  const end = new Date(now)
  if (days === 1) end.setHours(0, 0, 0, 0)
  else end.setTime(end.getTime() - days * 86_400_000)
  return end.getTime()
}

function scopedEvents(events, runtime, days, now) {
  const end = Date.parse(now)
  const start = windowStart(days, now)
  return events.filter((event) => {
    const timestamp = Date.parse(event.timestamp)
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end
      && (runtime === 'all' || event.runtime === runtime)
  })
}

function sanitizedActivity(event) {
  return {
    id: event.id,
    occurredAt: event.timestamp,
    category: 'runtime',
    action: event.event,
    subject: { kind: 'skill', id: event.skillId, label: event.skillId },
    event: event.event,
    runtime: event.runtime,
    timestamp: event.timestamp,
    severity: event.event === 'skill.failed' ? 'error' : event.outcome === 'unknown' ? 'warning' : 'info',
    evidenceRef: `run:${event.id}`,
    href: `/activity?tab=runs&run=${encodeURIComponent(event.id)}`,
    ...(event.skillId ? { skillId: event.skillId } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
    ...(Number.isFinite(event.costUsd) ? { costUsd: event.costUsd } : {}),
  }
}

function createIssue(id, priority, severity, href, data = {}) {
  return { id, priority, severity, href, data }
}

const actionDefinitions = Object.freeze({
  'source-unavailable': {
    priority: 'blocker',
    title: 'Restore unavailable data sources',
    reason: 'One or more local fact sources could not be read.',
    actionLabel: 'Review data health',
    evidenceRefs: (issue) => issue.data.sources.map((source) => `source:${source}`),
  },
  'repair-runtime': {
    priority: 'blocker',
    title: 'Repair the Runtime adapter',
    reason: 'An installed Runtime adapter has degraded evidence.',
    actionLabel: 'Review connections',
    evidenceRefs: () => ['runtime:degraded'],
  },
  'repair-data-directory': {
    priority: 'blocker',
    title: 'Restore local data access',
    reason: 'The configured local data directory is not writable.',
    actionLabel: 'Review data settings',
    evidenceRefs: () => ['data-directory:not-writable'],
  },
  'verify-runtime': {
    priority: 'trust',
    title: 'Verify the Runtime connection',
    reason: 'The adapter is installed but still needs qualifying lifecycle evidence.',
    actionLabel: 'Verify connection',
    evidenceRefs: () => ['runtime:awaiting-verification'],
  },
  'connect-runtime': {
    priority: 'trust',
    title: 'Connect a supported Runtime',
    reason: 'No supported Runtime adapter is currently installed.',
    actionLabel: 'Connect Runtime',
    evidenceRefs: () => ['runtime:not-connected'],
  },
  'review-unknown-outcomes': {
    priority: 'trust',
    title: 'Review runs with unknown outcomes',
    reason: 'Some terminal runs do not have a known success or failure outcome.',
    actionLabel: 'Review unknown outcomes',
    evidenceRefs: () => ['run-outcome:unknown'],
  },
  'refresh-stale-evidence': {
    priority: 'trust',
    title: 'Refresh stale release evidence',
    reason: 'Governed capabilities are backed by evidence that is no longer fresh.',
    actionLabel: 'Review releases',
    evidenceRefs: () => ['governance:evidence-stale'],
  },
  'review-failures': {
    priority: 'safety',
    title: 'Review failed runs',
    reason: 'The selected window contains known failed Skill runs.',
    actionLabel: 'Review failures',
    evidenceRefs: () => ['run-outcome:failed'],
  },
  'resolve-inventory-conflicts': {
    priority: 'safety',
    title: 'Resolve definition conflicts',
    reason: 'The local inventory contains conflicting or shadowed definitions.',
    actionLabel: 'Review assets',
    evidenceRefs: (issue) => [
      ...(issue.data.conflicts ? ['inventory:conflicted'] : []),
      ...(issue.data.shadowed ? ['inventory:shadowed'] : []),
    ],
  },
  'review-blocked-candidates': {
    priority: 'safety',
    title: 'Review blocked candidates',
    reason: 'One or more governed candidates are blocked.',
    actionLabel: 'Review releases',
    evidenceRefs: () => ['governance:blocked'],
  },
  'configure-provider': {
    priority: 'improvement',
    title: 'Configure an AI provider',
    reason: 'Existing local evidence remains available, but new AI-backed benchmarks need a provider.',
    actionLabel: 'Configure provider',
    evidenceRefs: () => ['provider:not-configured'],
  },
  'review-cost-coverage': {
    priority: 'maintenance',
    title: 'Review cost coverage',
    reason: 'Some terminal runs do not report cost.',
    actionLabel: 'Review cost coverage',
    evidenceRefs: () => ['metric:costCoverage'],
  },
  'repair-inventory-scan': {
    priority: 'maintenance',
    title: 'Review the inventory scan',
    reason: 'The latest asset scan reported incomplete coverage.',
    actionLabel: 'Review assets',
    evidenceRefs: () => ['inventory:scan-partial'],
  },
  'storage-warning': {
    priority: 'maintenance',
    title: 'Review local evaluation storage',
    reason: 'The evaluation store has reached its configured warning threshold.',
    actionLabel: 'Review data settings',
    evidenceRefs: () => ['storage:evaluations-warning'],
  },
})

function projectNextAction(issue) {
  const definition = actionDefinitions[issue.id]
  return {
    id: issue.id,
    priority: definition.priority,
    title: definition.title,
    reason: definition.reason,
    impact: ACTION_IMPACT[definition.priority],
    evidenceRefs: definition.evidenceRefs(issue),
    href: issue.href,
    actionLabel: definition.actionLabel,
    severity: issue.severity,
    data: issue.data,
  }
}

function readinessItem(id, state, label, checkedAt, reasonCode, href, evidenceAt) {
  return {
    id,
    state,
    label,
    ...(reasonCode ? { reasonCode } : {}),
    ...(href ? { href } : {}),
    ...(evidenceAt ? { evidenceAt } : {}),
    checkedAt,
  }
}

function inventorySignals(inventory) {
  const definitions = Array.isArray(inventory?.definitions) ? inventory.definitions : []
  const shadowed = definitions.filter((item) => item?.status === 'shadowed' || item?.shadowedBy).length
  const enabledGroups = new Map()
  for (const definition of definitions) {
    if (!definition?.enabled || !definition.runtime || typeof definition.skillId !== 'string' || !definition.skillId.trim()) continue
    const kind = ['skill', 'command'].includes(definition.kind) ? 'invocable' : definition.kind
    const key = `${definition.runtime}:${kind}:${definition.skillId.trim().toLowerCase()}`
    const group = enabledGroups.get(key) || []
    group.push(definition)
    enabledGroups.set(key, group)
  }
  let conflicts = 0
  for (const definitions of enabledGroups.values()) {
    if (definitions.length < 2) continue
    const completeHashes = definitions.every((item) => /^[a-f0-9]{64}$/i.test(item.contentHash || ''))
    const fingerprints = new Set(definitions.map((item) => completeHashes
      ? item.contentHash.toLowerCase()
      : `version:${String(item.skillVersion || '').trim()}`))
    if (fingerprints.size > 1) conflicts += 1
  }
  return { conflicts, shadowed }
}

export function buildCommandCenter({
  events = [],
  connections = [],
  providerConfigured = false,
  preflight = null,
  inventory = null,
  evaluations = null,
  capabilities = null,
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
  const lastVerifiedActivityAt = verified
    .map((connection) => connection.verifiedEvidenceAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  const degraded = currentConnections.filter((connection) => connection.connectionStage === 'degraded')
  const issues = []
  const sourceReady = (name) => sources[name] === 'ok'
  const runtimeSourceReady = sourceReady('connections') && sourceReady('events')
  const dataSourceReady = sourceReady('data') && preflight?.dataDirectory?.available === true
  const inventoryEvidence = inventorySignals(inventory)
  const scanWarnings = Boolean(inventory?.scan?.errors?.length
    || inventory?.scan?.coverage?.some((item) => !['scanned', 'not-configured'].includes(item.state))
    || inventory?.scan?.observability?.some((item) => item.state === 'partial'))
  const staleCapabilities = Array.isArray(capabilities)
    ? capabilities.filter((capability) => capability?.evidenceStale).length
    : 0
  const blockedCapabilities = Array.isArray(capabilities)
    ? capabilities.filter((capability) => capability?.stage === 'blocked').length
    : 0

  if (Object.values(sources).some((status) => status !== 'ok')) {
    issues.push(createIssue('source-unavailable', 110, 'high', '/settings?section=data', {
      sources: Object.entries(sources).filter(([, status]) => status !== 'ok').map(([source]) => source),
    }))
  }
  if (runtimeSourceReady && degraded.length) {
    issues.push(createIssue('repair-runtime', 105, 'high', '/settings?section=connections', { count: degraded.length }))
  } else if (runtimeSourceReady && !verified.length) {
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
  if (dataSourceReady && preflight.dataDirectory.writable === false) {
    issues.push(createIssue('repair-data-directory', 104, 'high', '/settings?section=data'))
  }
  if (sourceReady('inventory') && (inventoryEvidence.conflicts || inventoryEvidence.shadowed)) {
    issues.push(createIssue('resolve-inventory-conflicts', 89, 'high', '/assets?attention=conflict', inventoryEvidence))
  }
  if (sourceReady('governance') && staleCapabilities) {
    issues.push(createIssue('refresh-stale-evidence', 86, 'medium', '/releases', { count: staleCapabilities }))
  }
  if (sourceReady('governance') && blockedCapabilities) {
    issues.push(createIssue('review-blocked-candidates', 88, 'high', '/releases', { count: blockedCapabilities }))
  }
  if (sourceReady('inventory') && scanWarnings) {
    issues.push(createIssue('repair-inventory-scan', 60, 'medium', '/assets', {
      errors: inventory.scan.errors?.length || 0,
      incompleteCoverage: inventory.scan.coverage?.filter((item) => !['scanned', 'not-configured'].includes(item.state)).length || 0,
    }))
  }
  if (sourceReady('evaluations') && evaluations?.health?.warning) {
    issues.push(createIssue('storage-warning', 50, 'low', '/settings?section=data', {
      sizeBytes: evaluations.health.sizeBytes,
      warningBytes: evaluations.health.warningBytes,
    }))
  }
  if (sourceReady('provider') && !providerConfigured) {
    issues.push(createIssue('configure-provider', 40, 'low', '/benchmarks?tab=suites&configure=provider'))
  }
  issues.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
  const nextActions = issues
    .map((issue) => ({ issue, action: projectNextAction(issue) }))
    .sort((left, right) => ACTION_PRIORITY[left.action.priority] - ACTION_PRIORITY[right.action.priority]
      || right.issue.priority - left.issue.priority
      || left.issue.id.localeCompare(right.issue.id))
    .slice(0, 3)
    .map(({ action }) => action)

  const inventoryWarnings = scanWarnings || inventoryEvidence.conflicts || inventoryEvidence.shadowed
  const governanceWarnings = staleCapabilities || blockedCapabilities
  const readinessItems = [
    readinessItem(
      'runtime',
      !runtimeSourceReady ? 'unknown' : degraded.length ? 'blocked' : verified.length ? 'ready' : 'attention',
      'Runtime connections',
      now,
      !runtimeSourceReady ? 'source-unavailable' : degraded.length ? 'runtime-degraded' : verified.length ? null : installed.length ? 'awaiting-verification' : 'runtime-not-installed',
      '/settings?section=connections',
      lastVerifiedActivityAt,
    ),
    readinessItem(
      'git',
      !sourceReady('git') || !preflight?.git ? 'unknown' : preflight.git.available ? 'ready' : 'blocked',
      'Git',
      now,
      !sourceReady('git') || !preflight?.git ? 'source-unavailable' : preflight.git.available ? null : 'git-unavailable',
      '/settings?section=data',
    ),
    readinessItem(
      'data',
      !dataSourceReady ? 'unknown' : !preflight.dataDirectory.writable ? 'blocked' : evaluations?.health?.warning ? 'attention' : 'ready',
      'Local data',
      now,
      !dataSourceReady ? 'source-unavailable' : !preflight.dataDirectory.writable ? 'data-directory-read-only' : evaluations?.health?.warning ? 'storage-warning' : null,
      '/settings?section=data',
    ),
    readinessItem(
      'inventory',
      !sourceReady('inventory') || !inventory?.scan ? 'unknown' : inventoryWarnings ? 'attention' : 'ready',
      'Inventory scan',
      now,
      !sourceReady('inventory') || !inventory?.scan
        ? 'source-unavailable'
        : inventoryEvidence.conflicts || inventoryEvidence.shadowed
          ? 'definition-conflict'
          : scanWarnings ? 'scan-partial' : null,
      '/assets',
      inventory?.scan?.completedAt,
    ),
    readinessItem(
      'provider',
      !sourceReady('provider') ? 'unknown' : providerConfigured ? 'ready' : 'attention',
      'AI provider',
      now,
      !sourceReady('provider') ? 'source-unavailable' : providerConfigured ? null : 'provider-not-configured',
      '/settings?section=provider',
    ),
    readinessItem(
      'evaluations',
      !sourceReady('evaluations') || !evaluations ? 'unknown' : evaluations.health?.warning ? 'attention' : 'ready',
      'Managed evaluations',
      now,
      !sourceReady('evaluations') || !evaluations ? 'source-unavailable' : evaluations.health?.warning ? 'storage-warning' : null,
      '/benchmarks?tab=history',
    ),
    readinessItem(
      'governance',
      !sourceReady('governance') || !Array.isArray(capabilities) ? 'unknown' : governanceWarnings ? 'attention' : 'ready',
      'Governance',
      now,
      !sourceReady('governance') || !Array.isArray(capabilities) ? 'source-unavailable' : governanceWarnings ? 'governance-attention' : null,
      '/releases',
    ),
  ]
  const allReadinessFactsReady = readinessItems.every((item) => item.state === 'ready')
  const hasUnavailableSource = Object.values(sources).some((status) => status !== 'ok')
  const readinessLevel = allReadinessFactsReady
    ? 'ready'
    : hasUnavailableSource
      ? 'attention'
      : !installed.length && !verified.length ? 'setup' : 'attention'
  const activity = scoped
    .filter((event) => Boolean(event.skillId) && (event.event === 'skill.completed' || event.event === 'skill.failed'))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, RECENT_LIMIT)
    .map(sanitizedActivity)

  return {
    generatedAt: now,
    window: {
      from: new Date(windowStart(days, now)).toISOString(),
      to: now,
    },
    scope: { runtime, days },
    demo: false,
    sources,
    readiness: {
      level: readinessLevel,
      verifiedRuntimes: verified.map((connection) => connection.runtime),
      installedRuntimes: installed.map((connection) => connection.runtime),
      providerConfigured,
      items: readinessItems,
    },
    metrics: {
      terminalRuns: metrics.terminalRuns,
      knownOutcomes: metrics.knownOutcomes,
      successRate: metrics.successRate,
      runtimeOutcomeCoverage: metrics.runtimeOutcomeCoverage,
      reportedCostUsd: metrics.reportedCostUsd,
      costCoverage: metrics.costCoverage,
      observedAssets: metrics.observedAssets,
    },
    metricDefinitions,
    issues,
    nextActions,
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
  readPreflight = readSetupPreflight,
  readInventory = scanSkillInventory,
  readEvaluations = readStoredEvaluations,
  readGovernance = readStoredGovernance,
} = {}) {
  let eventStatus = 'ok'
  try {
    await syncEvents()
  } catch {
    eventStatus = 'partial'
  }
  const [
    eventSource,
    connectionSource,
    settingsSource,
    preflightSource,
    inventorySource,
    evaluationSource,
    governanceSource,
  ] = await Promise.all([
    settle(readEvents, []),
    settle(readConnections, []),
    settle(readSettings, null),
    settle(readPreflight, null),
    settle(readInventory, null),
    settle(readEvaluations, null),
    settle(readGovernance, null),
  ])
  if (eventSource.status === 'unavailable') eventStatus = 'unavailable'
  const eventSnapshot = Array.isArray(eventSource.value)
    ? { events: eventSource.value, sourceStatus: 'ok' }
    : eventSource.value
  const events = Array.isArray(eventSnapshot?.events) ? eventSnapshot.events : []
  if (eventStatus === 'ok' && eventSnapshot?.sourceStatus === 'partial') eventStatus = 'partial'
  const connections = connectionSource.status === 'ok'
    ? enrichRuntimeConnections(connectionSource.value, events, now)
    : []
  const sources = {
    events: eventStatus,
    connections: connectionSource.status,
    provider: settingsSource.status,
    git: preflightSource.status,
    data: preflightSource.status,
    inventory: inventorySource.status,
    evaluations: evaluationSource.status,
    governance: governanceSource.status,
  }
  return buildCommandCenter({
    events,
    connections,
    providerConfigured: settingsSource.status === 'ok' && configuredProvider(settingsSource.value),
    preflight: preflightSource.value,
    inventory: inventorySource.value,
    evaluations: evaluationSource.value,
    capabilities: governanceSource.value,
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
  let revision
  try {
    revision = await readRevision()
  } catch {
    return reader({ runtime, days })
  }
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
    if (!days) throw new EvaluationError('window must be 1d, 7d, 14d, or 30d.', 400)
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
