// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildCommandCenter, handleCommandCenterApi, readCachedCommandCenter, readCommandCenter } from './command-center.mjs'

const now = '2026-07-25T12:00:00.000Z'
const connections = [
  { runtime: 'codex', status: 'installed', configurationStatus: 'installed', connectionStage: 'verified', verifiedEvidenceAt: now },
  { runtime: 'claude-code', status: 'not-installed', configurationStatus: 'not-installed', connectionStage: 'not-detected' },
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
  it('adds the exact time window, real-data provenance, and seven source-backed readiness facts', () => {
    const result = buildCommandCenter({
      now,
      runtime: 'all',
      days: 7,
      connections,
      providerConfigured: true,
      preflight: {
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: true, writable: true },
      },
      inventory: {
        definitions: [],
        scan: { completedAt: now, coverage: [], errors: [] },
      },
      evaluations: {
        items: [],
        health: { sizeBytes: 0, warning: false },
      },
      capabilities: [],
      sources: {
        events: 'ok',
        connections: 'ok',
        provider: 'ok',
        git: 'ok',
        data: 'ok',
        inventory: 'ok',
        evaluations: 'ok',
        governance: 'ok',
      },
    })

    expect(result).toMatchObject({
      generatedAt: now,
      window: { from: '2026-07-18T12:00:00.000Z', to: now },
      scope: { runtime: 'all', days: 7 },
      demo: false,
      readiness: {
        level: 'ready',
        verifiedRuntimes: ['codex'],
        installedRuntimes: ['codex'],
        providerConfigured: true,
      },
    })
    expect(result.readiness.items).toEqual([
      expect.objectContaining({ id: 'runtime', state: 'ready', checkedAt: now, evidenceAt: now }),
      expect.objectContaining({ id: 'git', state: 'ready', checkedAt: now }),
      expect.objectContaining({ id: 'data', state: 'ready', checkedAt: now }),
      expect.objectContaining({ id: 'inventory', state: 'ready', checkedAt: now, evidenceAt: now }),
      expect.objectContaining({ id: 'provider', state: 'ready', checkedAt: now }),
      expect.objectContaining({ id: 'evaluations', state: 'ready', checkedAt: now }),
      expect.objectContaining({ id: 'governance', state: 'ready', checkedAt: now }),
    ])
  })

  it('treats Today as the server-local calendar day instead of a rolling 24 hours', () => {
    const localStart = new Date(now)
    localStart.setHours(0, 0, 0, 0)
    const result = buildCommandCenter({
      now,
      runtime: 'all',
      days: 1,
      events: [
        { id: 'before-today', event: 'skill.completed', runtime: 'codex', skillId: 'old', timestamp: new Date(localStart.getTime() - 1).toISOString(), outcome: 'success' },
        { id: 'today', event: 'skill.completed', runtime: 'codex', skillId: 'current', timestamp: localStart.toISOString(), outcome: 'success' },
      ],
    })

    expect(result.window.from).toBe(localStart.toISOString())
    expect(result.metrics.terminalRuns).toBe(1)
    expect(result.recentActivity.map((item) => item.id)).toEqual(['today'])
  })

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

    expect(result.metrics).toEqual({
      terminalRuns: 3,
      knownOutcomes: 2,
      successRate: {
        numerator: 1,
        denominator: 2,
        value: 50,
        label: 'Known outcomes',
      },
      runtimeOutcomeCoverage: {
        numerator: 2,
        denominator: 3,
        value: 2 / 3 * 100,
        label: 'Runtime outcome coverage',
      },
      reportedCostUsd: 0.25,
      costCoverage: {
        numerator: 1,
        denominator: 3,
        value: 1 / 3 * 100,
        label: 'Cost coverage',
      },
      observedAssets: 2,
    })
    expect(result.recentActivity.map((item) => item.id)).not.toContain('discovery')
    expect(result.nextActions).toHaveLength(3)
    expect(result.nextActions.map((item) => item.id)).toEqual(['review-unknown-outcomes', 'review-failures', 'configure-provider'])
    expect(result.nextActions).toEqual([
      expect.objectContaining({
        id: 'review-unknown-outcomes',
        priority: 'trust',
        title: expect.any(String),
        reason: expect.any(String),
        impact: expect.any(String),
        evidenceRefs: ['run-outcome:unknown'],
        href: '/activity?tab=runs&outcome=unknown',
        actionLabel: expect.any(String),
      }),
      expect.objectContaining({ id: 'review-failures', priority: 'safety' }),
      expect.objectContaining({ id: 'configure-provider', priority: 'improvement' }),
    ])
    expect(typeof result.issues.find((item) => item.id === 'review-unknown-outcomes').priority).toBe('number')
    expect(result.nextActions[0]).not.toBe(result.issues.find((item) => item.id === 'review-unknown-outcomes'))
    expect(result.issues.some((item) => item.id === 'configure-provider')).toBe(true)
    expect(result.metricDefinitions.successRate).toContain('known success')
  })

  it('returns only bounded sanitized terminal Skill runs as recent activity', () => {
    const terminalRuns = Array.from({ length: 12 }, (_, index) => ({
      id: `run-${index}`,
      event: index % 2 ? 'skill.failed' : 'skill.completed',
      runtime: 'codex',
      skillId: 'safe-id',
      timestamp: new Date(Date.parse(now) - (index + 3) * 1_000).toISOString(),
      outcome: index % 2 ? 'failed' : 'success',
      prompt: 'must not leave the aggregate',
      error: 'raw error must not leave the aggregate',
      toolInput: { secret: true },
    }))
    const result = buildCommandCenter({
      now,
      runtime: 'codex',
      days: 7,
      connections,
      providerConfigured: true,
      events: [
        { id: 'tool', event: 'tool.completed', runtime: 'codex', skillId: 'safe-id', timestamp: now },
        { id: 'started', event: 'skill.started', runtime: 'codex', skillId: 'safe-id', timestamp: new Date(Date.parse(now) - 1_000).toISOString() },
        { id: 'subagent', event: 'subagent.completed', runtime: 'codex', skillId: 'safe-id', timestamp: new Date(Date.parse(now) - 2_000).toISOString() },
        ...terminalRuns,
      ],
    })

    expect(result.recentActivity).toHaveLength(8)
    expect(result.recentActivity.map((item) => item.id)).toEqual(terminalRuns.slice(0, 8).map((event) => event.id))
    expect(result.recentActivity[0]).toMatchObject({
      occurredAt: terminalRuns[0].timestamp,
      category: 'runtime',
      action: 'skill.completed',
      subject: { kind: 'skill', id: 'safe-id', label: 'safe-id' },
      severity: 'info',
      evidenceRef: 'run:run-0',
      href: '/activity?tab=runs&run=run-0',
    })
    expect(JSON.stringify(result)).not.toContain('must not leave')
    expect(result.nextActions.every((item) => item.href.startsWith('/'))).toBe(true)
  })

  it('surfaces only evidenced inventory, governance, and storage warnings', () => {
    const result = buildCommandCenter({
      now,
      connections,
      providerConfigured: true,
      preflight: {
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: true, writable: true },
      },
      inventory: {
        definitions: [
          { runtime: 'codex', kind: 'skill', skillId: 'review', skillVersion: '1.0.0', enabled: true, status: 'active', contentHash: 'a'.repeat(64) },
          { runtime: 'codex', kind: 'skill', skillId: 'review', skillVersion: '2.0.0', enabled: true, status: 'active', contentHash: 'b'.repeat(64) },
          { runtime: 'claude-code', kind: 'command', skillId: 'legacy', skillVersion: '1.0.0', enabled: false, status: 'shadowed', shadowedBy: 'C:\\secret-path\\SKILL.md' },
        ],
        scan: { completedAt: now, coverage: [], errors: [], observability: [] },
      },
      evaluations: {
        items: [],
        health: { sizeBytes: 60 * 1024 * 1024, warningBytes: 50 * 1024 * 1024, warning: true },
      },
      capabilities: [
        { id: 'stale-capability', stage: 'ready', evidenceStale: true },
        { id: 'blocked-capability', stage: 'blocked', evidenceStale: false },
      ],
      sources: {
        events: 'ok',
        connections: 'ok',
        provider: 'ok',
        git: 'ok',
        data: 'ok',
        inventory: 'ok',
        evaluations: 'ok',
        governance: 'ok',
      },
    })

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'resolve-inventory-conflicts', data: { conflicts: 1, shadowed: 1 } }),
      expect.objectContaining({ id: 'refresh-stale-evidence', data: { count: 1 } }),
      expect.objectContaining({ id: 'review-blocked-candidates', data: { count: 1 } }),
      expect.objectContaining({ id: 'storage-warning', data: { sizeBytes: 60 * 1024 * 1024, warningBytes: 50 * 1024 * 1024 } }),
    ]))
    expect(result.nextActions.map((item) => item.id)).toEqual([
      'refresh-stale-evidence',
      'resolve-inventory-conflicts',
      'review-blocked-candidates',
    ])
    expect(result.nextActions).toEqual([
      expect.objectContaining({ priority: 'trust', evidenceRefs: ['governance:evidence-stale'] }),
      expect.objectContaining({ priority: 'safety', evidenceRefs: ['inventory:conflicted', 'inventory:shadowed'] }),
      expect.objectContaining({ priority: 'safety', evidenceRefs: ['governance:blocked'] }),
    ])
    expect(result.readiness.items.find((item) => item.id === 'inventory')).toMatchObject({ state: 'attention' })
    expect(result.readiness.items.find((item) => item.id === 'evaluations')).toMatchObject({ state: 'attention' })
    expect(result.readiness.items.find((item) => item.id === 'governance')).toMatchObject({ state: 'attention' })
    expect(JSON.stringify(result)).not.toContain('secret-path')
  })

  it('keeps available sources usable when another source fails', async () => {
    const result = await readCommandCenter({
      now,
      runtime: 'all',
      days: 7,
      syncEvents: vi.fn(),
      readEvents: vi.fn().mockResolvedValue([{ id: 'run', event: 'skill.completed', runtime: 'codex', skillId: 'review', timestamp: now, outcome: 'success' }]),
      readConnections: vi.fn().mockResolvedValue(connections),
      readSettings: vi.fn().mockResolvedValue({ activeProvider: 'ollama', providers: { ollama: { model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' } } }),
      readPreflight: vi.fn().mockResolvedValue({
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: true, writable: true },
      }),
      readInventory: vi.fn().mockRejectedValue(new Error('raw inventory secret')),
      readEvaluations: vi.fn().mockResolvedValue({ items: [], health: { sizeBytes: 0, warning: false } }),
      readGovernance: vi.fn().mockResolvedValue([]),
    })

    expect(result.sources).toEqual({
      events: 'ok',
      connections: 'ok',
      provider: 'ok',
      git: 'ok',
      data: 'ok',
      inventory: 'unavailable',
      evaluations: 'ok',
      governance: 'ok',
    })
    expect(result.metrics.terminalRuns).toBe(1)
    expect(result.readiness.level).toBe('attention')
    expect(result.readiness.items.find((item) => item.id === 'inventory')).toMatchObject({ state: 'unknown' })
    expect(result.readiness.items.filter((item) => item.id !== 'inventory').every((item) => item.state === 'ready')).toBe(true)
    expect(result.issues.some((item) => item.id === 'source-unavailable')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('raw inventory secret')
  })

  it('keeps recovered event facts while marking a partial JSONL tail', async () => {
    const result = await readCommandCenter({
      now,
      runtime: 'all',
      days: 7,
      syncEvents: vi.fn(),
      readEvents: vi.fn().mockResolvedValue({
        sourceStatus: 'partial',
        events: [{ id: 'run', event: 'skill.completed', runtime: 'codex', skillId: 'review', timestamp: now, outcome: 'success' }],
      }),
      readConnections: vi.fn().mockResolvedValue(connections),
      readSettings: vi.fn().mockResolvedValue({}),
      readPreflight: vi.fn().mockResolvedValue({ checkedAt: now, git: { available: true }, dataDirectory: { available: true, writable: true } }),
      readInventory: vi.fn().mockResolvedValue({ definitions: [], scan: { completedAt: now, coverage: [], errors: [], observability: [] } }),
      readEvaluations: vi.fn().mockResolvedValue({ items: [], health: { sizeBytes: 0, warning: false } }),
      readGovernance: vi.fn().mockResolvedValue([]),
    })

    expect(result.sources.events).toBe('partial')
    expect(result.metrics.terminalRuns).toBe(1)
    expect(result.issues.some((item) => item.id === 'source-unavailable')).toBe(true)
  })

  it('does not infer a missing configuration from an unavailable source', async () => {
    const result = await readCommandCenter({
      now,
      syncEvents: vi.fn(),
      readEvents: vi.fn().mockResolvedValue([]),
      readConnections: vi.fn().mockResolvedValue(connections),
      readSettings: vi.fn().mockRejectedValue(new Error('raw provider secret')),
      readPreflight: vi.fn().mockResolvedValue({
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: true, writable: true },
      }),
      readInventory: vi.fn().mockResolvedValue({
        definitions: [],
        scan: { completedAt: now, coverage: [], errors: [], observability: [] },
      }),
      readEvaluations: vi.fn().mockResolvedValue({ items: [], health: { sizeBytes: 0, warning: false } }),
      readGovernance: vi.fn().mockResolvedValue([]),
    })

    expect(result.readiness.items.find((item) => item.id === 'provider')).toMatchObject({ state: 'unknown' })
    expect(result.issues.some((item) => item.id === 'configure-provider')).toBe(false)
    expect(result.nextActions.some((item) => item.id === 'configure-provider')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('raw provider secret')
  })

  it('does not infer runtime verification state when lifecycle events are unavailable', async () => {
    const result = await readCommandCenter({
      now,
      syncEvents: vi.fn(),
      readEvents: vi.fn().mockRejectedValue(new Error('raw event secret')),
      readConnections: vi.fn().mockResolvedValue(connections),
      readSettings: vi.fn().mockResolvedValue({}),
      readPreflight: vi.fn().mockResolvedValue({
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: true, writable: true },
      }),
      readInventory: vi.fn().mockResolvedValue({ definitions: [], scan: { completedAt: now, coverage: [], errors: [], observability: [] } }),
      readEvaluations: vi.fn().mockResolvedValue({ items: [], health: { sizeBytes: 0, warning: false } }),
      readGovernance: vi.fn().mockResolvedValue([]),
    })

    expect(result.readiness.items.find((item) => item.id === 'runtime')).toMatchObject({
      state: 'unknown',
      reasonCode: 'source-unavailable',
    })
    expect(result.issues.some((item) => ['verify-runtime', 'connect-runtime'].includes(item.id))).toBe(false)
    expect(JSON.stringify(result)).not.toContain('raw event secret')
  })

  it('does not diagnose an unavailable data-directory probe as read-only', () => {
    const result = buildCommandCenter({
      now,
      connections,
      providerConfigured: true,
      preflight: {
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: false, writable: false },
      },
      sources: {
        events: 'ok',
        connections: 'ok',
        provider: 'ok',
        git: 'ok',
        data: 'ok',
        inventory: 'ok',
        evaluations: 'ok',
        governance: 'ok',
      },
    })

    expect(result.readiness.items.find((item) => item.id === 'data')).toMatchObject({
      state: 'unknown',
      reasonCode: 'source-unavailable',
    })
    expect(result.issues.some((item) => item.id === 'repair-data-directory')).toBe(false)
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

  it('bypasses the cache and continues with the aggregate reader when the event revision is unavailable', async () => {
    const expected = {
      generatedAt: now,
      sources: { events: 'unavailable', connections: 'ok', provider: 'ok' },
    }

    await expect(readCachedCommandCenter({
      runtime: 'all',
      days: 7,
      readRevision: async () => { throw new Error('event stat unavailable') },
      reader: async () => expected,
    })).resolves.toBe(expected)
  })

  it('guards and validates the loopback aggregate API', async () => {
    const valid = fakeResponse()
    await handleCommandCenterApi(fakeRequest('/api/command-center?runtime=codex&window=1d'), valid, '/api/command-center', {
      syncEvents: vi.fn(),
      readEvents: vi.fn().mockResolvedValue([]),
      readConnections: vi.fn().mockResolvedValue(connections),
      readSettings: vi.fn().mockResolvedValue({ activeProvider: 'openai', providers: { openai: { model: 'gpt', baseUrl: 'https://api.openai.com/v1', apiKey: 'secret-not-returned' } } }),
      readPreflight: vi.fn().mockResolvedValue({
        checkedAt: now,
        git: { available: true },
        dataDirectory: { available: true, writable: true },
      }),
      readInventory: vi.fn().mockResolvedValue({
        definitions: [],
        scan: { completedAt: now, coverage: [], errors: [], observability: [] },
      }),
      readEvaluations: vi.fn().mockResolvedValue({ items: [], health: { sizeBytes: 0, warning: false } }),
      readGovernance: vi.fn().mockResolvedValue([]),
      now,
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.headers['cache-control']).toBe('no-store')
    expect(valid.body).not.toContain('secret-not-returned')
    expect(JSON.parse(valid.body).scope.days).toBe(1)

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
