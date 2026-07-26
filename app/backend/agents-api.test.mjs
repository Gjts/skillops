import { describe, expect, it, vi } from 'vitest'
import { handleAgentsApi, projectAgents } from './agents-api.mjs'

const now = new Date('2026-07-25T12:00:00.000Z')

function event(id, fields = {}) {
  return {
    id,
    event: 'skill.discovered',
    runtime: 'codex',
    timestamp: '2026-07-25T11:00:00.000Z',
    source: 'project',
    kind: 'agent',
    skillId: 'reviewer',
    enabled: true,
    ...fields,
  }
}

function request(url, overrides = {}) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:4173' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

function response() {
  return {
    headers: {},
    statusCode: 0,
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

async function call(url, events, overrides = {}) {
  const target = response()
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  await handleAgentsApi(request(url, overrides.request), target, pathname, {
    readEvents: vi.fn().mockResolvedValue(events),
    now: () => now,
  })
  return { response: target, json: target.body ? JSON.parse(target.body) : null }
}

const lifecycleEvents = [
  event('codex-definition', { sourcePath: 'project/.codex/agents/reviewer.md', skillVersion: '1.0.0' }),
  event('claude-definition', { runtime: 'claude-code', sourcePath: 'project/.claude/agents/reviewer.md', skillVersion: '2.0.0' }),
  event('planner-definition', { skillId: 'planner', sourcePath: 'project/.codex/agents/planner.md' }),
  event('codex-start', { event: 'skill.started', timestamp: '2026-07-25T11:58:00.000Z', sourcePath: undefined, prompt: 'PROMPT_SENTINEL', rawError: 'RAW_ERROR_SENTINEL' }),
  event('codex-terminal', { event: 'skill.completed', timestamp: '2026-07-25T11:59:00.000Z', sourcePath: undefined, outcome: 'success' }),
  event('claude-start', { event: 'subagent.started', runtime: 'claude-code', timestamp: '2026-07-25T11:30:00.000Z', skillId: undefined, kind: undefined, subagentType: 'reviewer' }),
]

describe('Agent projection API', () => {
  it('separates definitions from observed evidence without merging runtimes', () => {
    const projected = projectAgents(lifecycleEvents, { now: now.getTime(), days: 7 })
    expect(projected.definitions.map((item) => `${item.runtime}:${item.name}`)).toEqual([
      'codex:planner',
      'claude-code:reviewer',
      'codex:reviewer',
    ])
    expect(projected.observed.map((item) => `${item.runtime}:${item.name}`)).toEqual([
      'codex:reviewer',
      'claude-code:reviewer',
    ])
    expect(projected.definitions.find((item) => item.name === 'planner')?.evidenceState).toBe('unverified')
    const gap = projected.observed.find((item) => item.runtime === 'claude-code')
    expect(gap).toMatchObject({ evidenceState: 'telemetry-gap', knownOutcomes: 0, outcomeCoverage: { numerator: 0, denominator: 0, value: null } })
    expect(projected.observed.find((item) => item.runtime === 'codex')).toMatchObject({
      evidenceState: 'observed-recently',
      latestOutcome: 'success',
      outcomeCoverage: { numerator: 1, denominator: 1, value: 100 },
    })
  })

  it('uses the fixed 15 minute evidence window independently of the list date range', () => {
    const projected = projectAgents([
      event('definition'),
      event('old-terminal', {
        event: 'skill.completed',
        timestamp: '2026-07-25T11:30:00.000Z',
        sourcePath: undefined,
        outcome: 'success',
      }),
    ], { now: now.getTime(), days: 30 })

    expect(projected.observed[0]).toMatchObject({
      evidenceState: 'idle',
      latestOutcome: 'success',
    })
  })

  it('applies the requested activity window without changing the fixed evidence recency rule', async () => {
    const events = [
      event('recent-definition', { skillId: 'recent', sourcePath: 'project/.codex/agents/recent.md' }),
      event('recent-terminal', { skillId: 'recent', event: 'skill.completed', timestamp: '2026-07-24T12:00:00.000Z', sourcePath: undefined, outcome: 'success' }),
      event('old-definition', { skillId: 'old', sourcePath: 'project/.codex/agents/old.md' }),
      event('old-terminal', { skillId: 'old', event: 'skill.completed', timestamp: '2026-07-10T12:00:00.000Z', sourcePath: undefined, outcome: 'success' }),
    ]

    const sevenDays = await call('/api/agents?tab=observed&window=7d', events)
    expect(sevenDays.json.items.map((item) => item.name)).toEqual(['recent'])
    expect(sevenDays.json.items[0]).toMatchObject({
      evidenceState: 'idle',
      outcomeCoverage: { numerator: 1, denominator: 1, value: 100 },
    })

    const thirtyDays = await call('/api/agents?tab=observed&window=30d', events)
    expect(thirtyDays.json.items.map((item) => item.name).sort()).toEqual(['old', 'recent'])
    expect(thirtyDays.json.items.find((item) => item.name === 'old')).toMatchObject({ evidenceState: 'idle' })
  })

  it('returns recovered Agent projections with an explicit partial source status', async () => {
    const result = await call('/api/agents?tab=observed&window=7d', {
      events: lifecycleEvents,
      sourceStatus: 'partial',
    })

    expect(result.json).toEqual(expect.objectContaining({
      sourceStatus: 'partial',
      items: expect.arrayContaining([expect.objectContaining({ name: 'reviewer' })]),
    }))
  })

  it('keeps definition condition separate from observed lifecycle evidence', () => {
    const projected = projectAgents([
      event('definition-a', { sourcePath: 'project/.codex/agents/reviewer-a.md' }),
      event('definition-b', { sourcePath: 'project/.codex/agents/reviewer-b.md' }),
      event('terminal', {
        event: 'skill.completed',
        timestamp: '2026-07-25T11:59:00.000Z',
        sourcePath: undefined,
        outcome: 'success',
      }),
    ], { now: now.getTime() })

    expect(projected.observed[0]).toMatchObject({
      configurationState: 'conflicted',
      evidenceState: 'observed-recently',
    })
    expect(projected.definitions).toHaveLength(2)
    expect(projected.definitions.every((item) => item.configurationState === 'conflicted')).toBe(true)
    expect(projected.definitions.every((item) => item.evidenceState === 'observed-recently')).toBe(true)
  })

  it('paginates and filters bounded metadata-only list responses', async () => {
    const definitions = Array.from({ length: 25 }, (_, index) => event(`definition-${index}`, {
      skillId: `agent-${String(index).padStart(2, '0')}`,
      sourcePath: `project/.codex/agents/agent-${index}.md`,
      prompt: 'PROMPT_SENTINEL',
      rawError: 'RAW_ERROR_SENTINEL',
    }))
    const first = await call('/api/agents?tab=definitions&page=1&pageSize=20&window=7d', definitions)
    expect(first.response.statusCode).toBe(200)
    expect(first.response.headers['cache-control']).toBe('no-store')
    expect(first.json).toMatchObject({ page: 1, pageSize: 20, totalItems: 25, totalPages: 2, available: 25, hasPrevious: false, hasNext: true })
    expect(first.json.items).toHaveLength(20)
    expect(first.response.body).not.toContain('PROMPT_SENTINEL')
    expect(first.response.body).not.toContain('RAW_ERROR_SENTINEL')

    const filtered = await call('/api/agents?tab=definitions&runtime=codex&query=agent-24&pageSize=50', definitions)
    expect(filtered.json.items).toHaveLength(1)
    expect(filtered.json.items[0].name).toBe('agent-24')
  })

  it('opens an exact bounded detail and rejects invalid or non-loopback requests', async () => {
    const list = await call('/api/agents?tab=observed', lifecycleEvents)
    const reviewer = list.json.items.find((item) => item.runtime === 'codex')
    const detail = await call(`/api/agents/${reviewer.key}?window=7d`, lifecycleEvents)
    expect(detail.response.statusCode).toBe(200)
    expect(detail.json.item).toMatchObject({ key: reviewer.key, name: 'reviewer', runtime: 'codex' })
    expect(detail.json.item.timeline).toHaveLength(2)

    const invalid = await call('/api/agents/not-an-id', lifecycleEvents)
    expect(invalid.response.statusCode).toBe(400)
    expect(invalid.json.error.code).toBe('INVALID_REQUEST')

    const blocked = await call('/api/agents', lifecycleEvents, {
      request: { headers: { host: 'evil.example:4173', 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '10.0.0.1' } },
    })
    expect(blocked.response.statusCode).toBe(403)
    expect(blocked.json.error.code).toBe('FORBIDDEN')

    const method = await call('/api/agents', lifecycleEvents, { request: { method: 'POST' } })
    expect(method.response.statusCode).toBe(405)
    expect(method.response.headers.allow).toBe('GET')
  })
})
