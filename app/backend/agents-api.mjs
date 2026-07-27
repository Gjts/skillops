import { createHash } from 'node:crypto'
import { evidenceState, ratioMetric } from '../shared/truth-semantics.mjs'
import { setJsonApiHeaders, sendApiError, sendJson } from './api-response.mjs'
import { readEventsWithStatus as readStoredEvents } from './event-store.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest } from './evaluations/request-guard.mjs'
import { scanSkillInventory } from './skill-scanner.mjs'

const TERMINAL_EVENTS = new Set(['skill.completed', 'skill.failed'])
const LIFECYCLE_EVENTS = new Set(['skill.started', 'skill.completed', 'skill.failed', 'subagent.started', 'subagent.completed'])
const RUNTIMES = new Set(['codex', 'claude-code', 'cursor'])
const TABS = new Set(['observed', 'definitions'])
const WINDOWS = new Map([['7d', 7], ['14d', 14], ['30d', 30]])
const PAGE_SIZES = new Set([20, 50, 100])
const TELEMETRY_GAP_MS = 15 * 60_000

function badRequest(message) {
  return new EvaluationError(message, 400)
}

function timestamp(event) {
  const value = Date.parse(event.timestamp)
  return Number.isFinite(value) ? value : 0
}

function agentName(event) {
  if (event.event === 'subagent.started' || event.event === 'subagent.completed') return event.subagentType || event.subagentId
  if (event.kind === 'agent' && event.event !== 'skill.discovered') return event.skillId
  return undefined
}

function publicDefinition(event) {
  return {
    skillId: event.skillId,
    ...(event.skillVersion ? { skillVersion: event.skillVersion } : {}),
    runtime: event.runtime,
    ...(event.source ? { source: event.source } : {}),
    ...(event.sourcePath ? { sourcePath: event.sourcePath } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.contentHash ? { contentHash: event.contentHash } : {}),
    enabled: event.enabled !== false,
    ...(event.status ? { status: event.status } : {}),
  }
}

function publicLifecycle(event) {
  return {
    id: event.id,
    event: event.event,
    runtime: event.runtime,
    timestamp: event.timestamp,
    ...(event.skillId ? { skillId: event.skillId } : {}),
    ...(event.outcome === 'success' || event.outcome === 'failed' ? { outcome: event.outcome } : {}),
  }
}

function configurationState(definition) {
  if (!definition || definition.status === 'missing') return 'missing'
  if (definition.enabled === false || definition.status === 'disabled' || definition.status === 'inactive') return 'disabled'
  if (definition.status === 'shadowed') return 'shadowed'
  if (definition.status === 'conflicted') return 'conflicted'
  return 'active'
}

function projection(identity, name, runtime, definition, lifecycle, resolvedConfigurationState, now, recentWindowMs, activityWindowMs) {
  const ordered = [...lifecycle].sort((left, right) => timestamp(right) - timestamp(left) || String(left.id).localeCompare(String(right.id)))
  const starts = ordered.filter((event) => event.event === 'skill.started' || event.event === 'subagent.started')
  const stateTerminals = ordered.filter((event) => event.event === 'skill.completed' || event.event === 'skill.failed' || event.event === 'subagent.completed')
  const latestStart = starts[0]
  const latestTerminal = stateTerminals[0]
  const openStart = latestStart && (!latestTerminal || timestamp(latestStart) > timestamp(latestTerminal)) ? latestStart : undefined
  const activity = ordered.filter((event) => {
    const age = now - timestamp(event)
    return age >= 0 && age <= activityWindowMs
  })
  const skillTerminals = activity.filter((event) => event.kind === 'agent' && TERMINAL_EVENTS.has(event.event))
  const activityTerminals = activity.filter((event) => event.event === 'skill.completed' || event.event === 'skill.failed' || event.event === 'subagent.completed')
  const outcomeEvents = skillTerminals.length ? skillTerminals : activityTerminals
  const knownOutcomes = outcomeEvents.filter((event) => event.outcome === 'success' || event.outcome === 'failed').length

  return {
    key: createHash('sha256').update(identity).digest('hex').slice(0, 32),
    name,
    runtime,
    ...(definition ? { definition: publicDefinition(definition) } : {}),
    configurationState: resolvedConfigurationState,
    evidenceState: evidenceState({
      lastObservedAt: latestTerminal?.timestamp,
      openStartAt: openStart?.timestamp,
      now,
      recentWindowMs,
      telemetryGapMs: TELEMETRY_GAP_MS,
    }),
    ...(latestTerminal ? { lastVerifiedAt: latestTerminal.timestamp } : {}),
    terminalRuns: skillTerminals.slice(0, 5).map(publicLifecycle),
    knownOutcomes,
    outcomeCoverage: ratioMetric(knownOutcomes, outcomeEvents.length),
    ...(outcomeEvents[0]?.outcome === 'success' || outcomeEvents[0]?.outcome === 'failed' ? { latestOutcome: outcomeEvents[0].outcome } : {}),
    timeline: activity.slice(0, 12).map(publicLifecycle),
  }
}

export function projectAgents(events, { inventory = [], now = Date.now(), recentWindowMs = TELEMETRY_GAP_MS, activityWindowMs = Number.POSITIVE_INFINITY } = {}) {
  const definitionsByIdentity = new Map()
  const lifecycleByAgent = new Map()

  for (const definition of inventory) {
    if (definition.kind !== 'agent' || !definition.skillId || !RUNTIMES.has(definition.runtime)) continue
    const identity = `${definition.runtime}\u0000${definition.skillId}\u0000${definition.sourcePath || definition.source || ''}`
    definitionsByIdentity.set(identity, definition)
  }

  for (const event of events) {
    if (!LIFECYCLE_EVENTS.has(event.event) || !RUNTIMES.has(event.runtime)) continue
    const name = agentName(event)
    if (!name) continue
    const key = `${event.runtime}\u0000${name}`
    const current = lifecycleByAgent.get(key)
    if (current) current.push(event)
    else lifecycleByAgent.set(key, [event])
  }

  const definitionsByAgent = new Map()
  for (const definition of definitionsByIdentity.values()) {
    const key = `${definition.runtime}\u0000${definition.skillId}`
    const current = definitionsByAgent.get(key)
    if (current) current.push(definition)
    else definitionsByAgent.set(key, [definition])
  }

  const definitions = [...definitionsByIdentity.entries()].map(([identity, definition]) => {
    const key = `${definition.runtime}\u0000${definition.skillId}`
    const matches = definitionsByAgent.get(key) || []
    const state = matches.length > 1 ? 'conflicted' : configurationState(definition)
    return projection(`definition:${identity}`, definition.skillId, definition.runtime, definition, lifecycleByAgent.get(key) || [], state, now, recentWindowMs, activityWindowMs)
  })

  const observed = [...lifecycleByAgent.entries()].map(([identity, lifecycle]) => {
    const [runtime, name] = identity.split('\u0000')
    const matches = definitionsByAgent.get(identity) || []
    const definition = matches.length === 1 ? matches[0] : undefined
    const state = !matches.length ? 'missing' : matches.length > 1 ? 'conflicted' : configurationState(definition)
    return projection(`observed:${identity}`, name, runtime, definition, lifecycle, state, now, recentWindowMs, activityWindowMs)
  }).filter((item) => item.timeline.length)

  const byRecent = (left, right) => (Date.parse(right.lastVerifiedAt || '') || 0) - (Date.parse(left.lastVerifiedAt || '') || 0) || left.name.localeCompare(right.name) || left.runtime.localeCompare(right.runtime)
  return {
    definitions: definitions.sort((left, right) => left.name.localeCompare(right.name) || left.runtime.localeCompare(right.runtime) || left.key.localeCompare(right.key)),
    observed: observed.sort(byRecent),
  }
}

function positiveInteger(params, name, fallback, maximum) {
  const value = params.get(name)
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) throw badRequest(`${name} must be a positive integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw badRequest(`${name} is invalid.`)
  return parsed
}

function listResponse(projected, params, generatedAt) {
  const tab = params.get('tab') || 'observed'
  const runtime = params.get('runtime') || ''
  const window = params.get('window') || '7d'
  const query = (params.get('query') || '').trim().toLocaleLowerCase('en-US')
  const page = positiveInteger(params, 'page', 1, 1_000_000)
  const pageSize = positiveInteger(params, 'pageSize', 50, 100)
  if (!TABS.has(tab)) throw badRequest('tab is invalid.')
  if (runtime && !RUNTIMES.has(runtime)) throw badRequest('runtime is invalid.')
  if (!WINDOWS.has(window)) throw badRequest('window must be 7d, 14d, or 30d.')
  if (!PAGE_SIZES.has(pageSize)) throw badRequest('pageSize must be 20, 50, or 100.')
  if (query.length > 120) throw badRequest('query must contain at most 120 characters.')

  const all = projected[tab]
  const filtered = all.filter((item) => (!runtime || item.runtime === runtime)
    && (!query || `${item.name} ${item.definition?.sourcePath || ''}`.toLocaleLowerCase('en-US').includes(query)))
  const totalItems = filtered.length
  const totalPages = Math.ceil(totalItems / pageSize)
  const offset = (page - 1) * pageSize
  return {
    generatedAt,
    items: filtered.slice(offset, offset + pageSize),
    page,
    pageSize,
    totalItems,
    totalPages,
    available: all.length,
    hasPrevious: totalItems > 0 && page > 1,
    hasNext: page < totalPages,
  }
}

export async function handleAgentsApi(request, response, pathname, { readEvents = readStoredEvents, scanInventory = scanSkillInventory, now = () => new Date() } = {}) {
  if (pathname !== '/api/agents' && !pathname.startsWith('/api/agents/')) return false
  setJsonApiHeaders(response)
  try {
    assertLocalApiRequest(request)
    if (request.method !== 'GET') throw new EvaluationError('Method not allowed.', 405)
    const url = new URL(request.url || pathname, 'http://127.0.0.1')
    const window = url.searchParams.get('window') || '7d'
    const days = WINDOWS.get(window)
    if (!days) throw badRequest('window must be 7d, 14d, or 30d.')
    const generatedAt = now().toISOString()
    const [eventSnapshot, inventorySnapshot] = await Promise.all([readEvents(), scanInventory()])
    const events = Array.isArray(eventSnapshot) ? eventSnapshot : eventSnapshot.events
    const sourceStatus = Array.isArray(eventSnapshot) ? 'ok' : eventSnapshot.sourceStatus
    const inventory = Array.isArray(inventorySnapshot) ? inventorySnapshot : inventorySnapshot?.definitions
    if (!Array.isArray(inventory)) throw new EvaluationError('Agent inventory returned an invalid result.', 500)
    const projected = projectAgents(events, { inventory, now: Date.parse(generatedAt), activityWindowMs: days * 86_400_000 })
    const encodedId = pathname === '/api/agents' ? '' : pathname.slice('/api/agents/'.length)
    if (!encodedId) sendJson(response, 200, { ...listResponse(projected, url.searchParams, generatedAt), sourceStatus })
    else {
      let id
      try { id = decodeURIComponent(encodedId) } catch { throw badRequest('Agent id is invalid.') }
      if (!/^[a-f0-9]{32}$/.test(id)) throw badRequest('Agent id is invalid.')
      const item = [...projected.observed, ...projected.definitions].find((candidate) => candidate.key === id)
      if (!item) throw new EvaluationError('Agent was not found.', 404)
      sendJson(response, 200, { generatedAt, item, sourceStatus })
    }
  } catch (error) {
    if (error?.status === 405) response.setHeader('Allow', 'GET')
    sendApiError(response, error, 'Agent projection failed.')
  }
  return true
}
