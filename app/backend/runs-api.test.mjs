// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { handleRunsApi } from './runs-api.mjs'

function request(method, url) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

function event(index, overrides = {}) {
  return {
    id: `run-${String(index).padStart(3, '0')}`,
    event: 'skill.completed',
    skillId: `skill-${index}`,
    runtime: 'codex',
    timestamp: new Date(Date.UTC(2026, 6, 23, 12, 0, 0) - index * 1_000).toISOString(),
    project: 'alpha',
    outcome: 'success',
    ...overrides,
  }
}

async function call(url, events, method = 'GET') {
  const res = response()
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  const readEvents = vi.fn().mockResolvedValue(events)
  const syncEvents = vi.fn().mockResolvedValue(undefined)
  const handled = await handleRunsApi(request(method, url), res, pathname, { readEvents, syncEvents })
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null, readEvents, syncEvents }
}

describe('GET /api/runs', () => {
  it('returns exact 0, 1, 20, 21, and 45-run page boundaries', async () => {
    const cases = [
      { count: 0, page: 1, expected: 0, totalPages: 0, previous: false, next: false },
      { count: 1, page: 1, expected: 1, totalPages: 1, previous: false, next: false },
      { count: 20, page: 1, expected: 20, totalPages: 1, previous: false, next: false },
      { count: 21, page: 1, expected: 20, totalPages: 2, previous: false, next: true },
      { count: 21, page: 2, expected: 1, totalPages: 2, previous: true, next: false },
      { count: 45, page: 1, expected: 20, totalPages: 3, previous: false, next: true },
      { count: 45, page: 2, expected: 20, totalPages: 3, previous: true, next: true },
      { count: 45, page: 3, expected: 5, totalPages: 3, previous: true, next: false },
    ]

    for (const item of cases) {
      const result = await call(`/api/runs?page=${item.page}&pageSize=20`, Array.from({ length: item.count }, (_, index) => event(index + 1)))
      expect(result.handled).toBe(true)
      expect(result.response.statusCode).toBe(200)
      expect(result.json).toMatchObject({
        page: item.page,
        pageSize: 20,
        totalItems: item.count,
        totalPages: item.totalPages,
        hasPrevious: item.previous,
        hasNext: item.next,
      })
      expect(result.json.items).toHaveLength(item.expected)
      expect(result.json.items.length).toBeLessThanOrEqual(20)
    }
  })

  it('filters terminal Skill runs and applies stable timestamp/id ordering', async () => {
    const timestamp = '2026-07-23T12:00:00.000Z'
    const events = [
      event(1, { id: 'a', timestamp, skillId: 'needle-one', costUsd: 0 }),
      event(2, { id: 'c', timestamp, skillId: 'needle-two', costUsd: 0.01 }),
      event(3, { id: 'b', timestamp, skillId: 'needle-three', costUsd: 0.02 }),
      event(4, { id: 'failed', event: 'skill.failed', outcome: 'failed', project: 'beta' }),
      event(5, { id: 'started', event: 'skill.started' }),
      event(6, { id: 'discovery', event: 'skill.discovered' }),
      event(7, { id: 'claude', runtime: 'claude-code' }),
    ]

    const ordered = await call('/api/runs?page=1&pageSize=20', events)
    expect(ordered.json.items.map((item) => item.id)).toEqual(['c', 'b', 'a', 'failed', 'claude'])

    const filtered = await call('/api/runs?page=1&pageSize=20&query=needle&runtime=codex&project=alpha&outcome=success&dateFrom=2026-07-23T00%3A00%3A00.000Z&dateTo=2026-07-24T00%3A00%3A00.000Z&sort=timestamp_asc&cost=reported', events)
    expect(filtered.json.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(filtered.json.totalItems).toBe(3)
  })

  it('returns scoped lifecycle counts without returning lifecycle rows', async () => {
    const events = [
      event(1),
      event(2, { id: 'codex-session', event: 'session.started' }),
      event(3, { id: 'codex-prompt', event: 'prompt.submitted' }),
      event(4, { id: 'codex-tool', event: 'tool.completed' }),
      event(5, { id: 'claude-agent', event: 'subagent.started', runtime: 'claude-code' }),
      event(6, { id: 'old-session', event: 'session.started', timestamp: '2026-06-01T00:00:00.000Z' }),
    ]

    const result = await call('/api/runs?page=1&pageSize=20&dateFrom=2026-07-23T00%3A00%3A00.000Z&runtime=codex', events)
    expect(result.json.activity).toEqual({
      codex: { sessions: 1, prompts: 1, toolCalls: 1, subagents: 0 },
      'claude-code': { sessions: 0, prompts: 0, toolCalls: 0, subagents: 0 },
    })
    expect(result.json.items).toHaveLength(1)
  })

  it('loads one bounded run timeline on demand for every valid event id', async () => {
    const events = [
      event(1, { id: 'timeline-end', sessionId: 'session-1', timestamp: '2026-07-23T12:00:03.000Z' }),
      event(2, { id: 'timeline-start', event: 'session.started', sessionId: 'session-1', timestamp: '2026-07-23T12:00:01.000Z' }),
      event(3, { id: 'other-session', event: 'tool.completed', sessionId: 'session-2' }),
    ]

    const result = await call('/api/runs/timeline-end', events)
    expect(result.response.statusCode).toBe(200)
    expect(result.json.run.id).toBe('timeline-end')
    expect(result.json.events.map((item) => item.id)).toEqual(['timeline-start', 'timeline-end'])
    expect(result.json.totalEvents).toBe(2)
    expect(result.json.truncated).toBe(false)

    const mixedRun = event(4, { id: 'mixed-run', sessionId: 'mixed-session', turnId: 'turn-1', timestamp: '2026-07-23T12:00:03.000Z' })
    const mixed = await call('/api/runs/mixed-run', [
      event(5, { id: 'mixed-session-start', event: 'session.started', sessionId: 'mixed-session', turnId: undefined, timestamp: '2026-07-23T12:00:00.000Z' }),
      event(6, { id: 'mixed-turn', event: 'tool.completed', sessionId: 'mixed-session', turnId: 'turn-1', timestamp: '2026-07-23T12:00:01.000Z' }),
      event(7, { id: 'mixed-other-turn', event: 'tool.completed', sessionId: 'mixed-session', turnId: 'turn-2', timestamp: '2026-07-23T12:00:01.500Z' }),
      event(8, { id: 'mixed-other-session', event: 'tool.completed', sessionId: 'other-session', turnId: 'turn-1', timestamp: '2026-07-23T12:00:02.000Z' }),
      event(9, { id: 'mixed-other-runtime', event: 'tool.completed', runtime: 'claude-code', sessionId: 'mixed-session', turnId: 'turn-1', timestamp: '2026-07-23T12:00:02.500Z' }),
      mixedRun,
    ])
    expect(mixed.json.events.map((item) => item.id)).toEqual(['mixed-session-start', 'mixed-turn', 'mixed-run'])

    const turnOnlyRun = event(10, { id: 'turn-only-run', sessionId: undefined, turnId: 'turn-only', timestamp: '2026-07-23T12:00:03.000Z' })
    const turnOnly = await call('/api/runs/turn-only-run', [
      event(11, { id: 'turn-only-event', event: 'tool.completed', sessionId: undefined, turnId: 'turn-only', timestamp: '2026-07-23T12:00:01.000Z' }),
      event(12, { id: 'turn-with-session', event: 'tool.completed', sessionId: 'session-1', turnId: 'turn-only', timestamp: '2026-07-23T12:00:01.500Z' }),
      event(13, { id: 'turn-other-runtime', event: 'tool.completed', runtime: 'claude-code', sessionId: undefined, turnId: 'turn-only', timestamp: '2026-07-23T12:00:02.000Z' }),
      turnOnlyRun,
    ])
    expect(turnOnly.json.events.map((item) => item.id)).toEqual(['turn-only-event', 'turn-only-run'])

    const longId = 'x'.repeat(201)
    const longIdResult = await call(`/api/runs/${encodeURIComponent(longId)}`, [event(4, { id: longId })])
    expect(longIdResult.response.statusCode).toBe(200)
    expect(longIdResult.json.run.id).toBe(longId)

    for (const dotId of ['.', '..']) {
      const dotResult = await call(`/api/runs/~${dotId}`, [event(5, { id: dotId })])
      expect(dotResult.response.statusCode).toBe(200)
      expect(dotResult.json.run.id).toBe(dotId)
    }

    const denseRun = event(5, {
      id: 'dense-run',
      sessionId: 'dense-session',
      turnId: 'turn-1',
      timestamp: '2026-07-23T12:01:40.000Z',
    })
    const denseTimeline = Array.from({ length: 205 }, (_, index) => event(100 + index, {
      id: `dense-${String(index).padStart(3, '0')}`,
      event: 'tool.completed',
      sessionId: 'dense-session',
      turnId: 'turn-1',
      timestamp: new Date(Date.UTC(2026, 6, 23, 12, 0, index)).toISOString(),
    }))
    const bounded = await call('/api/runs/dense-run', [
      ...denseTimeline,
      event(400, { id: 'other-turn', event: 'tool.completed', sessionId: 'dense-session', turnId: 'turn-2' }),
      event(401, {
        id: 'other-session',
        event: 'tool.completed',
        sessionId: 'other-session',
        turnId: 'turn-1',
        timestamp: '2026-07-23T12:03:29.500Z',
      }),
      denseRun,
    ])
    expect(bounded.json.events).toHaveLength(200)
    expect(bounded.json.events.some((item) => item.id === 'dense-run')).toBe(true)
    expect(bounded.json.events.some((item) => item.id === 'dense-204')).toBe(false)
    expect(bounded.json.events.some((item) => item.id === 'other-turn')).toBe(false)
    expect(bounded.json.events.some((item) => item.id === 'other-session')).toBe(false)
    expect(bounded.json.totalEvents).toBe(206)
    expect(bounded.json.truncated).toBe(true)

    const missing = await call('/api/runs/missing', events)
    expect(missing.response.statusCode).toBe(404)
    expect(missing.json.error).toBe('Run not found.')
  })

  it('rejects invalid or unbounded query parameters', async () => {
    const invalidQueries = [
      'page=0',
      'page=1.5',
      'page=1000001',
      'pageSize=25',
      'runtime=unknown',
      'outcome=pending',
      'dateFrom=not-a-date',
      'dateTo=not-a-date',
      'sort=random',
      'cost=estimated',
      `query=${'q'.repeat(201)}`,
      `project=${'p'.repeat(201)}`,
    ]

    for (const query of invalidQueries) {
      const result = await call(`/api/runs?${query}`, [])
      expect(result.response.statusCode, query).toBe(400)
      expect(result.json.error, query).toBeTruthy()
      expect(result.syncEvents, query).not.toHaveBeenCalled()
      expect(result.readEvents, query).not.toHaveBeenCalled()
    }
  })

  it('rejects non-GET methods without reading the JSONL event store', async () => {
    const result = await call('/api/runs', [], 'POST')
    expect(result.handled).toBe(true)
    expect(result.response.statusCode).toBe(405)
    expect(result.readEvents).not.toHaveBeenCalled()
  })

  it('leaves unrelated routes for the next handler', async () => {
    const result = await call('/api/events', [])
    expect(result.handled).toBe(false)
    expect(result.response.body).toBe('')
  })
})
