// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildCommandCenter, handleCommandCenterApi, readCachedCommandCenter, readCommandCenter } from './command-center.mjs'

const now = '2026-07-25T12:00:00.000Z'
const connections = [
  { runtime: 'codex', status: 'installed', configurationStatus: 'installed', connectionStage: 'verified', verifiedEvidenceAt: now },
  { runtime: 'claude-code', status: 'not-installed', configurationStatus: 'not-installed', connectionStage: 'not-installed' },
  { runtime: 'cursor', status: 'preview', configurationStatus: 'preview', connectionStage: 'preview-only' },
]

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(body = '') { this.body = body },
  }
}

function fakeRequest(url, overrides = {}) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:4173' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

describe('Command Center aggregate', () => {
  it('uses shared truth semantics and never treats discovery, unknown outcomes, or missing cost as zero', () => {
    const result = buildCommandCenter({
      now,
      runtime: 'all',
      days: 7,
      connections,
      providerConfigured: false,
      events: [
        { id: 'discovery', event: 'skill.discovered', runtime: 'codex', skillId: 'only-definition', timestamp: now },
        { id: 'success', event: 'skill.completed', runtime: 'codex', skillId: 'review', timestamp: now, outcome: 'success', costUsd: 0.25 },
        { id: 'unknown', event: 'skill.completed', runtime: 'codex', skillId: 'review', timestamp: now, outcome: 'unknown' },
        { id: 'failure', event: 'skill.failed', runtime: 'claude-code', skillId: 'test', timestamp: now, outcome: 'failed' },
      ],
    })

    expect(result.metrics).toEqual(expect.objectContaining({
      runs: 3,
      knownOutcomes: 2,
      successRate: 50,
      unknownOutcomes: 1,
      costUsd: 0.25,
      costReportedRuns: 1,
      activeSkills: 2,
    }))
    expect(result.recentActivity.map((item) => item.id)).not.toContain('discovery')
    expect(result.metrics.costCoverage).toBeCloseTo(100 / 3)
    expect(result.nextActions).toHaveLength(3)
    expect(result.nextActions.map((item) => item.id)).toEqual(['review-failures', 'review-unknown-outcomes', 'review-cost-coverage'])
    expect(result.issues.some((item) => item.id === 'configure-provider')).toBe(true)
    expect(result.metricDefinitions.successRate).toContain('known success')
  })

  it('returns bounded sanitized activity and deterministic executable actions', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      id: `event-${index}`,
      event: index % 2 ? 'tool.completed' : 'skill.completed',
      runtime: 'codex',
      skillId: 'safe-id',
      timestamp: new Date(Date.parse(now) - index * 1_000).toISOString(),
      outcome: 'success',
      prompt: 'must not leave the aggregate',
      error: 'raw error must not leave the aggregate',
      toolInput: { secret: true },
    }))
    const result = buildCommandCenter({ now, runtime: 'codex', days: 7, connections, providerConfigured: true, events })

    expect(result.recentActivity).toHaveLength(8)
    expect(JSON.stringify(result)).not.toContain('must not leave')
    expect(result.nextActions.every((item) => item.href.startsWith('/'))).toBe(true)
  })

  it('keeps available sources usable when another source fails', async () => {
    const result = await readCommandCenter({
      now,
      runtime: 'all',
      days: 7,
      syncEvents: vi.fn().mockRejectedValue(new Error('raw sync secret')),
      readEvents: vi.fn().mockResolvedValue([{ id: 'run', event: 'skill.completed', runtime: 'codex', skillId: 'review', timestamp: now, outcome: 'success' }]),
      readConnections: vi.fn().mockRejectedValue(new Error('raw config secret')),
      readSettings: vi.fn().mockResolvedValue({ activeProvider: 'ollama', providers: { ollama: { model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' } } }),
    })

    expect(result.sources).toEqual({ events: 'partial', connections: 'unavailable', provider: 'ok' })
    expect(result.metrics.runs).toBe(1)

    expect(result.readiness.level).toBe('attention')
    expect(result.issues.some((item) => item.id === 'source-unavailable')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('raw config secret')
    expect(JSON.stringify(result)).not.toContain('raw sync secret')
  })

  it('coalesces warm projections and invalidates on revision or TTL changes', async () => {
    let revision = 'fixture-v1'
    let clock = 1_000
    const reader = vi.fn(async () => ({ generatedAt: String(reader.mock.calls.length) }))
    const options = {
      runtime: 'cursor',
      days: 14,
      readRevision: async () => revision,
      reader,
      clock: () => clock,
    }

    const [first, concurrent] = await Promise.all([readCachedCommandCenter(options), readCachedCommandCenter(options)])
    expect(first).toBe(concurrent)
    expect(reader).toHaveBeenCalledTimes(1)

    revision = 'fixture-v2'
    await readCachedCommandCenter(options)
    expect(reader).toHaveBeenCalledTimes(2)

    clock += 2_501
    await readCachedCommandCenter(options)
    expect(reader).toHaveBeenCalledTimes(3)
  })

  it('guards and validates the loopback aggregate API', async () => {
    const valid = fakeResponse()
    await handleCommandCenterApi(fakeRequest('/api/command-center?runtime=codex&window=7d'), valid, '/api/command-center', {
      syncEvents: vi.fn(),
      readEvents: vi.fn().mockResolvedValue([]),
      readConnections: vi.fn().mockResolvedValue(connections),
      readSettings: vi.fn().mockResolvedValue({ activeProvider: 'openai', providers: { openai: { model: 'gpt', baseUrl: 'https://api.openai.com/v1', apiKey: 'secret-not-returned' } } }),
      now,
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.headers['cache-control']).toBe('no-store')
    expect(valid.body).not.toContain('secret-not-returned')

    const invalid = fakeResponse()
    await handleCommandCenterApi(fakeRequest('/api/command-center?runtime=invalid'), invalid, '/api/command-center')
    expect(invalid.statusCode).toBe(400)
    const invalidWindow = fakeResponse()
    await handleCommandCenterApi(fakeRequest('/api/command-center?window=8d'), invalidWindow, '/api/command-center')
    expect(invalidWindow.statusCode).toBe(400)

    const blocked = fakeResponse()
    await handleCommandCenterApi(fakeRequest('/api/command-center', {
      headers: { host: 'evil.example:4173', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '10.0.0.1' },
    }), blocked, '/api/command-center')
    expect(blocked.statusCode).toBe(403)
  })
})
