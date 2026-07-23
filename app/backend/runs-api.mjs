import { syncCodexDesktopEvents } from './codex-desktop-ingest.mjs'
import { readEvents as readStoredEvents } from './event-store.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest } from './evaluations/request-guard.mjs'

const PAGE_SIZES = new Set([20, 50, 100])
const RUNTIMES = new Set(['codex', 'claude-code', 'cursor'])
const OUTCOMES = new Set(['success', 'failed', 'unknown'])
const SORTS = new Set(['timestamp_desc', 'timestamp_asc'])
const COST_FILTERS = new Set(['reported', 'unreported'])
const TERMINAL_EVENTS = new Set(['skill.completed', 'skill.failed'])
const RUN_TIMELINE_LIMIT = 200

function badRequest(message) {
  return new EvaluationError(message, 400)
}

function positiveInteger(params, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const value = params.get(name)
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) throw badRequest(`${name} must be a positive integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw badRequest(`${name} must be between 1 and ${maximum}.`)
  return parsed
}

function limitedText(params, name) {
  const value = params.get(name) ?? ''
  if (value.length > 200) throw badRequest(`${name} must contain at most 200 characters.`)
  return value.trim()
}

function selectedValue(params, name, allowed, fallback = '') {
  const value = params.get(name) ?? fallback
  if (value && !allowed.has(value)) throw badRequest(`${name} is not supported.`)
  return value || fallback
}

function selectedDate(params, name) {
  const value = params.get(name)
  if (!value) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw badRequest(`${name} must be a valid date.`)
  return timestamp
}

function eventOutcome(event) {
  if (OUTCOMES.has(event.outcome)) return event.outcome
  return event.event === 'skill.failed' ? 'failed' : 'unknown'
}

function eventHasCost(event) {
  return typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)
}

function summarizeActivity(events, runtime, dateFrom, dateTo) {
  const activity = {
    codex: { sessions: 0, prompts: 0, toolCalls: 0, subagents: 0 },
    'claude-code': { sessions: 0, prompts: 0, toolCalls: 0, subagents: 0 },
  }
  for (const event of events) {
    const counts = activity[event.runtime]
    if (!counts || (runtime && event.runtime !== runtime)) continue
    const timestamp = Date.parse(event.timestamp)
    if (!Number.isFinite(timestamp)
      || (dateFrom !== undefined && timestamp < dateFrom)
      || (dateTo !== undefined && timestamp > dateTo)) continue
    if (event.event === 'session.started') counts.sessions += 1
    else if (event.event === 'prompt.submitted') counts.prompts += 1
    else if (event.event === 'tool.completed') counts.toolCalls += 1
    else if (event.event === 'subagent.started') counts.subagents += 1
  }
  return activity
}

function compareRuns(left, right, sort) {
  const direction = sort === 'timestamp_asc' ? 1 : -1
  const timestampDifference = Date.parse(left.timestamp) - Date.parse(right.timestamp)
  if (timestampDifference) return timestampDifference * direction
  const leftId = String(left.id)
  const rightId = String(right.id)
  return (leftId < rightId ? -1 : leftId > rightId ? 1 : 0) * direction
}

function runTimeline(events, run) {
  const correlated = events
    .filter((event) => {
      if (event.id === run.id) return true
      if (event.runtime !== run.runtime) return false
      if (!run.turnId) return Boolean(run.sessionId && event.sessionId === run.sessionId)
      if (run.sessionId) return event.sessionId === run.sessionId && (event.turnId === run.turnId || !event.turnId)
      return event.turnId === run.turnId && !event.sessionId
    })
    .sort((left, right) => compareRuns(left, right, 'timestamp_asc'))
  if (correlated.length <= RUN_TIMELINE_LIMIT) {
    return { events: correlated, totalEvents: correlated.length, truncated: false }
  }
  const runIndex = correlated.findIndex((event) => event.id === run.id)
  const start = Math.min(
    Math.max(0, runIndex - Math.floor(RUN_TIMELINE_LIMIT / 2)),
    correlated.length - RUN_TIMELINE_LIMIT,
  )
  return {
    events: correlated.slice(start, start + RUN_TIMELINE_LIMIT),
    totalEvents: correlated.length,
    truncated: true,
  }
}

export function queryRuns(events, params) {
  const page = positiveInteger(params, 'page', 1, 1_000_000)
  const pageSize = positiveInteger(params, 'pageSize', 20, 100)
  if (!PAGE_SIZES.has(pageSize)) throw badRequest('pageSize must be 20, 50, or 100.')
  const query = limitedText(params, 'query').toLocaleLowerCase()
  const project = limitedText(params, 'project').toLocaleLowerCase()
  const runtime = selectedValue(params, 'runtime', RUNTIMES)
  const outcome = selectedValue(params, 'outcome', OUTCOMES)
  const sort = selectedValue(params, 'sort', SORTS, 'timestamp_desc')
  const cost = selectedValue(params, 'cost', COST_FILTERS)
  const dateFrom = selectedDate(params, 'dateFrom')
  const dateTo = selectedDate(params, 'dateTo')
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) throw badRequest('dateFrom must not be later than dateTo.')

  const matches = events.filter((event) => {
    if (!TERMINAL_EVENTS.has(event.event) || !event.skillId) return false
    const timestamp = Date.parse(event.timestamp)
    if (!Number.isFinite(timestamp)) return false
    if (runtime && event.runtime !== runtime) return false
    if (outcome && eventOutcome(event) !== outcome) return false
    if (dateFrom !== undefined && timestamp < dateFrom) return false
    if (dateTo !== undefined && timestamp > dateTo) return false
    if (project && !String(event.project ?? '').toLocaleLowerCase().includes(project)) return false
    if (query && ![event.skillId, event.id, event.project].some((value) => String(value ?? '').toLocaleLowerCase().includes(query))) return false
    if (cost === 'reported' && !eventHasCost(event)) return false
    if (cost === 'unreported' && eventHasCost(event)) return false
    return true
  }).sort((left, right) => compareRuns(left, right, sort))

  const totalItems = matches.length
  const totalPages = Math.ceil(totalItems / pageSize)
  const offset = (page - 1) * pageSize
  return {
    items: matches.slice(offset, offset + pageSize),
    page,
    pageSize,
    totalItems,
    totalPages,
    hasPrevious: totalItems > 0 && page > 1,
    hasNext: page < totalPages,
    activity: summarizeActivity(events, runtime, dateFrom, dateTo),
  }
}

export async function handleRunsApi(request, response, pathname, {
  readEvents = readStoredEvents,
  syncEvents = syncCodexDesktopEvents,
} = {}) {
  if (pathname !== '/api/runs' && !pathname.startsWith('/api/runs/')) return false
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  try {
    assertLocalApiRequest(request)
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.setHeader('Allow', 'GET')
      response.end(JSON.stringify({ error: 'Method not allowed.' }))
      return true
    }
    const url = new URL(request.url || pathname, 'http://127.0.0.1')
    const detailPath = pathname.startsWith('/api/runs/') ? pathname.slice('/api/runs/'.length) : ''
    if (!detailPath) queryRuns([], url.searchParams)
    let runId = ''
    if (detailPath) {
      try {
        runId = decodeURIComponent(detailPath.startsWith('~') ? detailPath.slice(1) : detailPath)
      } catch {
        throw badRequest('Run id is invalid.')
      }
      if (!runId) throw badRequest('Run id is required.')
    }
    await syncEvents()
    const events = await readEvents()
    response.statusCode = 200
    if (runId) {
      const run = events.find((event) => event.id === runId && TERMINAL_EVENTS.has(event.event) && event.skillId)
      if (!run) throw new EvaluationError('Run not found.', 404)
      response.end(JSON.stringify({ run, ...runTimeline(events, run) }))
    } else {
      response.end(JSON.stringify(queryRuns(events, url.searchParams)))
    }
  } catch (error) {
    response.statusCode = Number.isInteger(error?.status) ? error.status : 500
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Run query failed.' }))
  }
  return true
}
