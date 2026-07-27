import {
  appendEvent as appendStoredEvent,
  appendEvents as appendStoredEvents,
  clearEvents as clearStoredEvents,
  eventVersion as readEventVersion,
  readEvents as readStoredEvents,
  readEventsWithStatus as readStoredEventsWithStatus,
} from './event-store.mjs'
import { normalizeEvent, normalizeEvents } from '../shared/event-schema.mjs'
import { sendApiError, sendJson, setJsonApiHeaders } from './api-response.mjs'
import { syncCodexDesktopEvents } from './codex-desktop-ingest.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from './evaluations/request-guard.mjs'
import { createPageEnvelope } from './page-envelope.mjs'
import { enrichRuntimeConnections, readRuntimeConnections } from './runtime-connections.mjs'
import { parseRegistryScanQuery, projectRegistryScan } from './registry-scan-projection.mjs'
import { scanSkillInventory } from './skill-scanner.mjs'

const ROUTES = new Set(['/api/connections', '/api/scan', '/api/events', '/api/import'])
const MAX_EVENT_IMPORT_REQUEST_BYTES = 32 * 1024 * 1024
const scanSnapshots = new WeakMap()

function requireMethod(request, response, allowed) {
  if (allowed.includes(request.method)) return
  response.setHeader('Allow', allowed.join(', '))
  throw new EvaluationError('Method not allowed.', 405)
}

async function boundedJson(request, message, options) {
  try {
    return await readEvaluationJsonBody(request, options)
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    throw new EvaluationError(message, 400)
  }
}

function validatedEvents(value, many = false) {
  try {
    return many ? normalizeEvents(value) : normalizeEvent(value)
  } catch (error) {
    throw new EvaluationError(error instanceof Error ? error.message : 'Event payload is invalid.', 400)
  }
}

function latestRuntimeEventAt(events) {
  let latest = null
  for (const event of events) {
    if (event.event === 'skill.discovered') continue
    if (!latest || Date.parse(event.timestamp) > Date.parse(latest)) latest = event.timestamp
  }
  return latest
}

async function readScanSnapshot(scanInventory, refresh, now) {
  const previous = scanSnapshots.get(scanInventory)
  if (!refresh && previous?.current) return previous.current
  if (previous?.pending) return refresh || !previous.current ? previous.pending : previous.current

  const pending = Promise.resolve().then(scanInventory).then((snapshot) => {
    if (!Array.isArray(snapshot) && !Array.isArray(snapshot?.definitions)) {
      throw new EvaluationError('Skill scan returned an invalid result.', 500)
    }
    const completedAt = Array.isArray(snapshot) ? null : snapshot.scan?.completedAt
    const parsedCompletedAt = typeof completedAt === 'string' ? new Date(completedAt) : null
    return {
      snapshot,
      generatedAt: parsedCompletedAt && !Number.isNaN(parsedCompletedAt.valueOf()) ? parsedCompletedAt : now(),
    }
  })
  scanSnapshots.set(scanInventory, { current: previous?.current, pending })
  try {
    const current = await pending
    scanSnapshots.set(scanInventory, { current })
    return current
  } catch (error) {
    if (previous?.current) scanSnapshots.set(scanInventory, { current: previous.current })
    else scanSnapshots.delete(scanInventory)
    throw error
  }
}

export async function handleLocalDataApi(request, response, pathname, {
  appendEvent = appendStoredEvent,
  appendEvents = appendStoredEvents,
  clearEvents = clearStoredEvents,
  eventVersion = readEventVersion,
  readEvents = readStoredEvents,
  readEventsWithStatus = readStoredEventsWithStatus,
  readConnections = readRuntimeConnections,
  enrichConnections = enrichRuntimeConnections,
  scanInventory = scanSkillInventory,
  syncEvents = syncCodexDesktopEvents,
  now = () => new Date(),
} = {}) {
  if (!ROUTES.has(pathname)) return false
  setJsonApiHeaders(response)
  try {
    assertLocalApiRequest(request, {
      requireJson: request.method === 'POST' && (pathname === '/api/events' || pathname === '/api/import'),
    })

    if (pathname === '/api/connections') {
      requireMethod(request, response, ['GET'])
      await syncEvents()
      const [connections, events] = await Promise.all([readConnections(), readEvents()])
      const search = new URL(request.url || pathname, 'http://127.0.0.1').searchParams
      sendJson(response, 200, {
        generatedAt: now().toISOString(),
        ...createPageEnvelope(enrichConnections(connections, events), {
          page: search.get('page') ?? undefined,
          pageSize: search.get('pageSize') ?? undefined,
          compare: (left, right) => String(left.runtime).localeCompare(String(right.runtime), 'en-US'),
        }),
      })
    } else if (pathname === '/api/scan') {
      requireMethod(request, response, ['POST'])
      const filters = parseRegistryScanQuery(request.url || pathname)
      const { snapshot, generatedAt } = await readScanSnapshot(scanInventory, filters.refresh, now)
      sendJson(response, 200, projectRegistryScan(snapshot, filters, generatedAt))
    } else if (pathname === '/api/import') {
      requireMethod(request, response, ['POST'])
      const created = await appendEvents(validatedEvents(await boundedJson(request, 'Import payload is invalid.', {
        maxBytes: MAX_EVENT_IMPORT_REQUEST_BYTES,
        limitMessage: 'Event import request body exceeds the 32 MiB limit.',
      }), true))
      sendJson(response, 201, { created, importedCount: created.length })
    } else if (request.method === 'GET') {
      const mode = new URL(request.url || pathname, 'http://127.0.0.1').searchParams
      if (mode.get('summary') === '1' && mode.get('download') === '1') {
        throw new EvaluationError('Event summary and download modes cannot be combined.', 400)
      }
      if (mode.get('summary') !== '1' && mode.get('download') !== '1') {
        createPageEnvelope([], {
          page: mode.get('page') ?? undefined,
          pageSize: mode.get('pageSize') ?? undefined,
          compare: () => 0,
        })
      }
      await syncEvents()
      const etag = await eventVersion()
      response.setHeader('ETag', etag)
      if (request.headers['if-none-match'] === etag) {
        response.statusCode = 304
        response.end()
        return true
      }
      const snapshot = await readEventsWithStatus()
      const { events } = snapshot
      if (mode.get('summary') === '1') {
        sendJson(response, 200, {
          generatedAt: now().toISOString(),
          count: events.length,
          lastRuntimeEventAt: latestRuntimeEventAt(events),
          sourceStatus: snapshot.sourceStatus,
        })
      } else if (mode.get('download') === '1') {
        response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        response.setHeader('Content-Disposition', `attachment; filename="skillops-events-${now().toISOString().slice(0, 10)}.jsonl"`)
        response.setHeader('X-SkillOps-Source-Status', snapshot.sourceStatus)
        response.statusCode = 200
        response.end(events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
      } else {
        sendJson(response, 200, {
          generatedAt: now().toISOString(),
          sourceStatus: snapshot.sourceStatus,
          ...createPageEnvelope(events, {
            page: mode.get('page') ?? undefined,
            pageSize: mode.get('pageSize') ?? undefined,
            compare: (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
              || String(right.id ?? '').localeCompare(String(left.id ?? ''), 'en-US'),
          }),
        })
      }
    } else if (request.method === 'POST') {
      sendJson(response, 201, await appendEvent(validatedEvents(await boundedJson(request, 'Event payload is invalid.'))))
    } else if (request.method === 'DELETE') {
      sendJson(response, 200, await clearEvents())
    } else {
      requireMethod(request, response, ['GET', 'POST', 'DELETE'])
    }
  } catch (error) {
    sendApiError(response, error, 'Local data API request failed.')
  }
  return true
}
