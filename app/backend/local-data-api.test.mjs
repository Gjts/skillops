// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { normalizeEvent } from '../shared/event-schema.mjs'
import { handleLocalDataApi } from './local-data-api.mjs'

const now = new Date('2026-07-25T12:00:00.000Z')
const events = [
  { id: 'discovery', event: 'skill.discovered', skillId: 'review', runtime: 'codex', timestamp: '2026-07-25T11:59:00.000Z' },
  { id: 'terminal', event: 'skill.completed', skillId: 'review', runtime: 'codex', timestamp: '2026-07-25T11:58:00.000Z' },
]
const largeImportEvents = Array.from({ length: 3_600 }, (_, index) => ({
  id: `bulk-${index}`,
  event: 'skill.completed',
  skillId: `skill-${index}`,
  runtime: 'codex',
  timestamp: '2026-07-25T11:58:00.000Z',
  outcome: 'success',
}))

function request(url, method = 'GET', body) {
  const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
  return {
    method,
    url,
    headers: {
      host: '127.0.0.1:4173',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes },
  }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

function services(overrides = {}) {
  return {
    appendEvent: vi.fn(async (event) => event),
    appendEvents: vi.fn(async (incoming) => incoming),
    clearEvents: vi.fn(async () => ({ cleared: 2 })),
    eventVersion: vi.fn(async () => '"events-2"'),
    readEvents: vi.fn(async () => events),
    readEventsWithStatus: vi.fn(async () => ({ events, sourceStatus: 'ok' })),
    readConnections: vi.fn(async () => []),
    enrichConnections: vi.fn(() => []),
    scanInventory: vi.fn(async () => ({ items: [] })),
    syncEvents: vi.fn(async () => undefined),
    now: () => now,
    ...overrides,
  }
}

async function call(url, method = 'GET', body, overrides = {}) {
  const target = response()
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  const handled = await handleLocalDataApi(request(url, method, body), target, pathname, services(overrides))
  return { handled, response: target, json: target.body && target.headers['content-type']?.startsWith('application/json') ? JSON.parse(target.body) : null }
}

describe('local data API', () => {
  it('keeps summary and download behavior identical for every server host', async () => {
    const summary = await call('/api/events?summary=1')
    expect(summary.json).toEqual({
      generatedAt: now.toISOString(),
      count: 2,
      lastRuntimeEventAt: '2026-07-25T11:58:00.000Z',
      sourceStatus: 'ok',
    })
    expect(summary.response.headers.etag).toBe('"events-2"')
    expect(summary.response.headers['cache-control']).toBe('no-store')

    const download = await call('/api/events?download=1')
    expect(download.response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
    expect(download.response.headers['content-disposition']).toContain('skillops-events-2026-07-25.jsonl')
    expect(download.response.headers['x-skillops-source-status']).toBe('ok')
    expect(download.response.body.split('\n').filter(Boolean)).toHaveLength(2)

    const conflicting = await call('/api/events?summary=1&download=1')
    expect(conflicting.response.statusCode).toBe(400)
    expect(conflicting.json.error.message).toContain('cannot be combined')
  })

  it('reports a recoverable partial event source in summary and download metadata', async () => {
    const readEventsWithStatus = vi.fn(async () => ({ events: events.slice(0, 1), sourceStatus: 'partial' }))
    const summary = await call('/api/events?summary=1', 'GET', undefined, { readEventsWithStatus })
    const download = await call('/api/events?download=1', 'GET', undefined, { readEventsWithStatus })

    expect(summary.json).toMatchObject({ count: 1, sourceStatus: 'partial' })
    expect(download.response.headers['x-skillops-source-status']).toBe('partial')
    expect(download.response.body.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('returns the compatibility event feed as a bounded stable page', async () => {
    const listed = await call('/api/events?page=1&pageSize=20')
    expect(listed.json).toEqual({
      generatedAt: now.toISOString(),
      sourceStatus: 'ok',
      items: events,
      page: 1,
      pageSize: 20,
      totalItems: 2,
      totalPages: 1,
      hasPrevious: false,
      hasNext: false,
    })
    expect((await call('/api/events?pageSize=25')).response.statusCode).toBe(400)
  })

  it('validates event queries before honoring a matching ETag', async () => {
    const conditionalServices = services()
    for (const url of ['/api/events?pageSize=25', '/api/events?summary=1&download=1']) {
      const incoming = request(url)
      incoming.headers['if-none-match'] = '"events-2"'
      const target = response()

      await handleLocalDataApi(incoming, target, '/api/events', conditionalServices)

      expect(target.statusCode).toBe(400)
    }
    expect(conditionalServices.syncEvents).not.toHaveBeenCalled()
    expect(conditionalServices.eventVersion).not.toHaveBeenCalled()
  })

  it('supports the shared connection, scan, event, and import mutations', async () => {
    const connectionServices = services({
      enrichConnections: vi.fn(() => [{ runtime: 'codex' }, { runtime: 'claude-code' }]),
    })
    const connectionResponse = response()
    await handleLocalDataApi(request('/api/connections'), connectionResponse, '/api/connections', connectionServices)
    expect(connectionServices.enrichConnections).toHaveBeenCalledWith([], events)
    expect(JSON.parse(connectionResponse.body)).toEqual({
      generatedAt: now.toISOString(),
      items: [{ runtime: 'claude-code' }, { runtime: 'codex' }],
      page: 1,
      pageSize: 50,
      totalItems: 2,
      totalPages: 1,
      hasPrevious: false,
      hasNext: false,
    })

    expect((await call('/api/scan', 'POST', undefined, { scanInventory: vi.fn(async () => ({ definitions: [] })) })).response.statusCode).toBe(200)
    expect((await call('/api/events', 'POST', events[1])).response.statusCode).toBe(201)
    expect((await call('/api/events', 'DELETE')).json).toEqual({ cleared: 2 })
    expect((await call('/api/import', 'POST', events)).json.importedCount).toBe(2)
  })

  it('accepts a valid event import larger than the shared 512 KB request limit', async () => {
    const payloadBytes = Buffer.byteLength(JSON.stringify(largeImportEvents))
    expect(payloadBytes).toBeGreaterThan(512_000)
    expect(payloadBytes).toBeLessThan(32 * 1024 * 1024)

    const importServices = services()
    const target = response()
    await handleLocalDataApi(request('/api/import', 'POST', largeImportEvents), target, '/api/import', importServices)

    expect(target.statusCode).toBe(201)
    expect(JSON.parse(target.body).importedCount).toBe(3_600)
    expect(importServices.appendEvents).toHaveBeenCalledOnce()
  })

  it('rejects a declared event import larger than 32 MiB before reading or appending', async () => {
    const importServices = services()
    const incoming = {
      ...request('/api/import', 'POST', []),
      headers: {
        host: '127.0.0.1:4173',
        'content-type': 'application/json',
        'content-length': String(32 * 1024 * 1024 + 1),
      },
      async *[Symbol.asyncIterator]() { throw new Error('oversized declared body should not be read') },
    }
    const target = response()

    await handleLocalDataApi(incoming, target, '/api/import', importServices)

    expect(target.statusCode).toBe(413)
    expect(JSON.parse(target.body).error.message).toBe('Event import request body exceeds the 32 MiB limit.')
    expect(importServices.appendEvents).not.toHaveBeenCalled()
  })

  it('rejects a streamed event import larger than 32 MiB before appending', async () => {
    const importServices = services()
    const chunk = Buffer.alloc(1024 * 1024, 0x20)
    const incoming = {
      ...request('/api/import', 'POST', []),
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 33; index += 1) yield chunk
      },
    }
    const target = response()

    await handleLocalDataApi(incoming, target, '/api/import', importServices)

    expect(target.statusCode).toBe(413)
    expect(JSON.parse(target.body).error.message).toBe('Event import request body exceeds the 32 MiB limit.')
    expect(importServices.appendEvents).not.toHaveBeenCalled()
  })

  it('validates a large import batch completely before appending any event', async () => {
    const importServices = services()
    const invalidBatch = [...largeImportEvents, {
      id: 'invalid-bulk-event',
      event: 'skill.completed',
      skillId: 'invalid-bulk-event',
      runtime: 'codex',
      durationMs: 'abc',
    }]
    const target = response()

    await handleLocalDataApi(request('/api/import', 'POST', invalidBatch), target, '/api/import', importServices)

    expect(target.statusCode).toBe(400)
    expect(JSON.parse(target.body).error.message).toContain('durationMs must be a finite number')
    expect(importServices.appendEvents).not.toHaveBeenCalled()
  })

  it('returns a bounded, stable, server-filtered Registry page for large scans', async () => {
    const definitions = Array.from({ length: 5_000 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(4, '0')}`,
      skillVersion: '1.0.0',
      runtime: index % 2 ? 'claude-code' : 'codex',
      source: index % 3 ? 'global' : 'project',
      sourcePath: `/skills/${String(4_999 - index).padStart(4, '0')}/SKILL.md`,
      provider: index % 3 ? 'Codex' : 'Project',
      kind: 'skill',
      enabled: true,
    }))
    const scan = {
      definitions,
      scan: {
        id: 'scan_large',
        projectRoot: '/workspace',
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        durationMs: 12,
        coverage: [],
        errors: [],
        observability: [],
      },
    }

    const first = await call('/api/scan?runtime=codex&source=global&provider=Codex&query=skill&pageSize=100&page=1', 'POST', undefined, {
      scanInventory: vi.fn(async () => scan),
    })
    const second = await call('/api/scan?runtime=codex&source=global&provider=Codex&query=skill&pageSize=100&page=2', 'POST', undefined, {
      scanInventory: vi.fn(async () => scan),
    })

    expect(first.response.statusCode).toBe(200)
    expect(first.json.generatedAt).toBe(now.toISOString())
    expect(first.json.scan.id).toBe('scan_large')
    expect(first.json.definitions).toHaveLength(100)
    expect(second.json.definitions).toHaveLength(100)
    expect(first.json.page).toMatchObject({ page: 1, pageSize: 100, totalItems: 1_666, totalPages: 17, hasPrevious: false, hasNext: true })
    expect(second.json.page).toMatchObject({ page: 2, pageSize: 100, totalItems: 1_666, totalPages: 17, hasPrevious: true, hasNext: true })
    expect(new Set([...first.json.definitions, ...second.json.definitions].map((item) => item.sourcePath)).size).toBe(200)
    expect(first.json.aggregates.totalDefinitions).toBe(5_000)
    expect(first.json.aggregates.providers).toEqual([{ provider: 'Codex', count: 1_666 }])
  })

  it('rejects invalid Registry pagination instead of returning an unbounded scan', async () => {
    const result = await call('/api/scan?pageSize=101', 'POST')

    expect(result.response.statusCode).toBe(400)
    expect(result.json.error.message).toBe('pageSize must be an integer from 1 to 100.')
  })

  it('bounds Registry facets and diagnostics and allowlists projected definition fields', async () => {
    const sentinel = 'REGISTRY_PRIVATE_SENTINEL'
    const definitions = Array.from({ length: 101 }, (_, index) => ({
      skillId: `skill-${String(index).padStart(3, '0')}`,
      skillVersion: '1.0.0',
      runtime: 'codex',
      source: 'global',
      sourcePath: `/skills/${index}/SKILL.md`,
      provider: `Provider ${String(index).padStart(3, '0')}`,
      kind: 'skill',
      enabled: true,
      rawPrompt: sentinel,
      originConfigs: Array.from({ length: 101 }, (_, item) => `/config/${item}`),
      tags: Array.from({ length: 101 }, (_, item) => `tag-${item}`),
    }))
    const diagnostics = Array.from({ length: 101 }, (_, index) => index)
    const result = await call('/api/scan?pageSize=1', 'POST', undefined, {
      scanInventory: vi.fn(async () => ({
        definitions,
        scan: {
          id: 'scan_bounded',
          projectRoot: '/workspace',
          startedAt: now.toISOString(),
          completedAt: now.toISOString(),
          durationMs: 1,
          coverage: diagnostics.map((index) => ({ runtime: 'codex', directory: `/scan/${index}`, source: 'global', configurationSource: 'user', state: 'scanned', rawStack: sentinel })),
          errors: diagnostics.map((index) => ({ runtime: 'codex', path: `/scan/${index}`, code: 'EACCES', message: sentinel, rawStack: sentinel })),
          observability: diagnostics.map(() => ({ runtime: 'codex', state: 'partial', reason: 'Filesystem-only visibility.' })),
          rawTranscript: sentinel,
        },
      })),
    })

    expect(result.response.statusCode).toBe(200)
    expect(result.json).toMatchObject({ sourceStatus: 'partial', definitions: [{ skillId: 'skill-000' }] })
    expect(result.json.aggregates.providers).toHaveLength(100)
    expect(result.json.scan.coverage).toHaveLength(100)
    expect(result.json.scan.errors).toHaveLength(100)
    expect(result.json.scan.observability).toHaveLength(100)
    expect(result.json.definitions[0].originConfigs).toHaveLength(100)
    expect(result.json.definitions[0].tags).toHaveLength(100)
    expect(result.response.body).not.toContain(sentinel)
  })

  it('keeps generatedAt tied to the cached scan instead of the projection request', async () => {
    let clock = new Date('2026-07-25T12:00:00.000Z')
    const scanInventory = vi.fn(async () => ({ definitions: [] }))
    const overrides = { scanInventory, now: () => clock }

    const first = await call('/api/scan', 'POST', undefined, overrides)
    clock = new Date('2026-07-25T13:00:00.000Z')
    const cached = await call('/api/scan?page=2', 'POST', undefined, overrides)

    expect(first.json.generatedAt).toBe('2026-07-25T12:00:00.000Z')
    expect(cached.json.generatedAt).toBe(first.json.generatedAt)
    expect(scanInventory).toHaveBeenCalledOnce()
  })

  it('reuses the last successful scan while refresh is pending or fails', async () => {
    let rejectRefresh
    const snapshot = {
      definitions: [{
        skillId: 'stable-skill',
        skillVersion: '1.0.0',
        runtime: 'codex',
        source: 'global',
        sourcePath: '/skills/stable/SKILL.md',
        provider: 'Codex',
        kind: 'skill',
        enabled: true,
      }],
      scan: { id: 'scan_stable' },
    }
    const scanInventory = vi.fn()
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject }))

    expect((await call('/api/scan', 'POST', undefined, { scanInventory })).json.scan.id).toBe('scan_stable')
    const refresh = call('/api/scan?refresh=1', 'POST', undefined, { scanInventory })
    await vi.waitFor(() => expect(scanInventory).toHaveBeenCalledTimes(2))

    const cached = await call('/api/scan?query=stable', 'POST', undefined, { scanInventory })
    expect(cached.response.statusCode).toBe(200)
    expect(cached.json.definitions[0].skillId).toBe('stable-skill')
    expect(scanInventory).toHaveBeenCalledTimes(2)

    rejectRefresh(new Error('scan unavailable'))
    expect((await refresh).response.statusCode).toBe(500)
    const afterFailure = await call('/api/scan?query=stable', 'POST', undefined, { scanInventory })
    expect(afterFailure.json.scan.id).toBe('scan_stable')
    expect(scanInventory).toHaveBeenCalledTimes(2)
  })

  it('computes conflicts from the full snapshot before slicing a page', async () => {
    const definitions = [
      { skillId: 'Review', skillVersion: '1.0.0', runtime: 'codex', source: 'global', sourcePath: '/a/SKILL.md', provider: 'Codex', kind: 'skill', enabled: true },
      { skillId: 'review', skillVersion: '2.0.0', runtime: 'codex', source: 'project', sourcePath: '/b/review.md', provider: 'Project', kind: 'command', enabled: true },
      { skillId: 'review', skillVersion: '3.0.0', runtime: 'codex', source: 'plugin', sourcePath: '/c/SKILL.md', provider: 'Plugin', kind: 'skill', enabled: false },
    ]
    const result = await call('/api/scan?attention=conflict&pageSize=1', 'POST', undefined, {
      scanInventory: vi.fn(async () => ({ definitions })),
    })

    expect(result.json.page).toMatchObject({ pageSize: 1, totalItems: 2, totalPages: 2 })
    expect(result.json.definitions).toHaveLength(1)
    expect(Object.values(result.json.definitionIssues)).toEqual([['conflict']])
    expect(result.json.aggregates.attention).toMatchObject({ attention: 3, conflict: 2, disabled: 1 })
  })

  it('enforces exact routes, loopback access, methods, and bounded JSON', async () => {
    const ignored = await call('/api/other')
    expect(ignored.handled).toBe(false)

    const method = await call('/api/connections', 'POST', {})
    expect(method.response.statusCode).toBe(405)
    expect(method.response.headers.allow).toBe('GET')

    const target = response()
    await handleLocalDataApi({
      ...request('/api/events'),
      headers: { host: 'evil.example:4173', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '10.0.0.1' },
    }, target, '/api/events', services())
    expect(target.statusCode).toBe(403)
    expect(target.body).not.toContain('10.0.0.1')

    const eventServices = services()
    const large = response()
    await handleLocalDataApi({
      ...request('/api/events', 'POST', {}),
      headers: { host: '127.0.0.1:4173', 'content-type': 'application/json', 'content-length': '600000' },
    }, large, '/api/events', eventServices)
    expect(large.statusCode).toBe(413)
    expect(JSON.parse(large.body).error.message).toBe('Evaluation request body exceeds the 512 KB limit.')
    expect(eventServices.appendEvent).not.toHaveBeenCalled()
  })

  it('returns a client error when event schema validation rejects a mutation', async () => {
    const result = await call('/api/events', 'POST', {
      event: 'skill.completed',
      skillId: 'invalid-number',
      runtime: 'codex',
      durationMs: 'abc',
    }, {
      appendEvent: async (event) => normalizeEvent(event),
    })

    expect(result.response.statusCode).toBe(400)
    expect(result.json.error.message).toContain('durationMs must be a finite number')
  })
})
