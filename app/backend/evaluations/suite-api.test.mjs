// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { EvaluationError } from './errors.mjs'
import { handleManagedEvaluationApi } from './suite-api.mjs'

const suite = {
  schemaVersion: 1, id: 'suite-1', name: 'Suite one', version: '1.0.0', owner: 'qa', sensitivity: 'synthetic',
  artifactKind: 'skill', repeats: 1, suiteHash: 'c'.repeat(64), datasetHash: null, datasetId: null,
  cases: [{ id: 'case-1', input: 'private test input', weight: 1, assertions: [{ label: 'required', type: 'contains', value: 'private value', blocking: true }] }],
}
const artifact = (id, hash) => ({
  artifact: { kind: 'skill', artifactId: id, version: '1.0.0', source: 'github', sourceRef: `github:https://github.com/acme/${id}/blob/${hash.repeat(40)}/SKILL.md#SKILL.md`, contentHash: hash.repeat(64), gitCommit: hash.repeat(40) },
  contents: `private ${id} content`,
})
const summary = {
  id: 'run-1', status: 'queued', suiteId: 'suite-1', provider: { id: 'openai', model: 'gpt-test' }, evidenceHash: null,
}

function request(method, url, body, headers = {}) {
  const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
  return {
    method,
    url,
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes },
  }
}

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

function services(overrides = {}) {
  return {
    suites: {
      list: vi.fn().mockResolvedValue([{ id: suite.id, name: suite.name, suiteHash: suite.suiteHash }]),
      get: vi.fn().mockResolvedValue(suite),
    },
    artifacts: { resolve: vi.fn(async (ref) => ref.includes('baseline') ? artifact('baseline', 'a') : artifact('candidate', 'b')) },
    manager: {
      enqueue: vi.fn().mockResolvedValue({ summary, reused: false }),
      cancel: vi.fn().mockResolvedValue({ summary: { ...summary, status: 'cancelled' }, cancelled: true }),
    },
    store: {
      listRuns: vi.fn().mockResolvedValue({ items: [summary], nextCursor: null }),
      getRun: vi.fn().mockResolvedValue(summary),
      getCases: vi.fn().mockResolvedValue([
        { id: 'case-1:1', caseId: 'case-1', baseline: { pass: true, score: 100 }, candidate: { pass: true, score: 100 } },
        { id: 'case-2:1', caseId: 'case-2', baseline: { pass: true, score: 100 }, candidate: { pass: false, score: 0 } },
      ]),
    },
    ...overrides,
  }
}

async function call(method, url, body, service = services(), headers, options = {}) {
  const res = response()
  const pathname = new URL(url, 'http://127.0.0.1').pathname
  const handled = await handleManagedEvaluationApi(request(method, url, body, headers), res, pathname, { managedEvaluationServices: service, ...options })
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null, service }
}

describe('managed evaluation API', () => {
  it('lists suites and returns a detail contract without test inputs or assertion values', async () => {
    const list = await call('GET', '/api/evaluation-suites')
    expect(list.handled).toBe(true)
    expect(list.json.items[0].id).toBe('suite-1')
    const detail = await call('GET', '/api/evaluation-suites/suite-1')
    expect(detail.json.cases[0]).toEqual({ id: 'case-1', weight: 1, assertions: [{ label: 'required', type: 'contains', blocking: true }] })
    expect(detail.response.body).not.toContain('private test input')
    expect(detail.response.body).not.toContain('private value')
  })

  it('creates an asynchronous run after validating provider and resolving both artifacts', async () => {
    const service = services()
    const result = await call('POST', '/api/evaluation-runs', {
      suiteId: 'suite-1', baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate',
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'sentinel-key' },
      requestedBy: 'qa', clientRequestId: 'request-1', timeoutMs: 45_000,
    }, service, undefined, { teamPrincipal: { id: 'user:developer' } })
    expect(result.response.statusCode).toBe(202)
    expect(result.json).toEqual({ run: summary, reused: false })
    expect(result.response.body).not.toContain('sentinel-key')
    expect(service.manager.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'suite',
      suite, baseline: expect.objectContaining({ artifact: expect.objectContaining({ artifactId: 'baseline' }) }),
      candidate: expect.objectContaining({ artifact: expect.objectContaining({ artifactId: 'candidate' }) }),
      provider: expect.objectContaining({ provider: 'openai', model: 'gpt-test' }),
      requestedBy: 'user:developer',
      timeoutMs: 45_000,
    }))
  })

  it('uses stable validation errors for missing providers, unknown config, media type, and size', async () => {
    const base = { suiteId: 'suite-1', baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate', requestedBy: 'qa' }
    const missing = await call('POST', '/api/evaluation-runs', base)
    expect(missing.response.statusCode).toBe(422)
    expect(missing.json.error.code).toBe('VALIDATION_FAILED')
    const implementation = await call('POST', '/api/evaluation-runs', { ...base, provider: { provider: 'openai', apiKey: 'key', implementation: 'exec:node' } })
    expect(implementation.response.statusCode).toBe(422)
    expect(implementation.json.error.message).toContain('unsupported field')
    const media = await call('POST', '/api/evaluation-runs', { ...base, provider: {} }, services(), { 'content-type': 'text/plain' })
    expect(media.response.statusCode).toBe(415)
    const oversized = await call('POST', '/api/evaluation-runs', { ...base, provider: {} }, services(), { 'content-length': '600000' })
    expect(oversized.response.statusCode).toBe(413)
  })

  it('supports run filters, safe case pagination, detail, and explicit cancellation', async () => {
    const service = services()
    const list = await call('GET', '/api/evaluation-runs?status=completed&suiteId=suite-1&capabilityId=cap-1&limit=10&cursor=old', undefined, service)
    expect(service.store.listRuns).toHaveBeenCalledWith({ status: 'completed', suiteId: 'suite-1', capabilityId: 'cap-1', limit: '10', cursor: 'old' })
    expect(list.json.items).toEqual([summary])
    expect((await call('GET', '/api/evaluation-runs/run-1', undefined, service)).json).toEqual(summary)
    const cases = await call('GET', '/api/evaluation-runs/run-1/cases?limit=1', undefined, service)
    expect(cases.json).toEqual({ items: [expect.objectContaining({ id: 'case-1:1' })], nextCursor: 'case-1:1' })
    const cancelled = await call('POST', '/api/evaluation-runs/run-1/cancel', {}, service)
    expect(cancelled.json.cancelled).toBe(true)
  })
  it('exports sanitized JSON and inert HTML reports', async () => {
    const service = services()
    const reportSummary = {
      id: 'run-1', mode: 'suite', status: 'completed', suiteId: 'suite-1', suiteVersion: '1.0.0',
      suiteHash: 'c'.repeat(64), datasetHash: null, baseline: artifact('baseline', 'a').artifact,
      candidate: artifact('candidate', 'b').artifact, engine: { name: 'promptfoo', version: '0.121.19' },
      provider: { id: 'openai', model: '<script>alert(1)</script>' }, metrics: null, policyHash: null, gates: [],
      evidenceHash: 'd'.repeat(64), gateResult: 'passed', requestedBy: 'qa',
      requestedAt: '2026-07-22T00:00:00.000Z', startedAt: '2026-07-22T00:00:01.000Z',
      completedAt: '2026-07-22T00:00:02.000Z', errorCode: null,
    }
    service.store.getRun.mockResolvedValue(reportSummary)
    const json = await call('GET', '/api/evaluation-runs/run-1/report?format=json', undefined, service)
    expect(json.json).toEqual({ schemaVersion: 1, summary: expect.objectContaining({ id: 'run-1' }), cases: expect.any(Array) })
    expect(json.response.body).not.toContain('private test input')

    const res = response()
    await handleManagedEvaluationApi(request('GET', '/api/evaluation-runs/run-1/report?format=html'), res, '/api/evaluation-runs/run-1/report', { managedEvaluationServices: service })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.body).toContain('SkillOps Evaluation Report')
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(res.body).not.toContain('<script>alert(1)</script>')
  })


  it('returns a conflict for duplicates and hides unexpected exception details', async () => {
    const duplicate = services({ manager: { enqueue: vi.fn().mockRejectedValue(new EvaluationError('An active evaluation already exists.', 409)), cancel: vi.fn() } })
    const body = {
      suiteId: 'suite-1', baselineRef: 'local-scan:baseline', candidateRef: 'github:candidate',
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'key' }, requestedBy: 'qa',
    }
    const conflict = await call('POST', '/api/evaluation-runs', body, duplicate)
    expect(conflict.response.statusCode).toBe(409)
    expect(conflict.json.error.code).toBe('CONFLICT')
    const broken = services({ suites: { list: vi.fn().mockRejectedValue(new Error('sensitive stack detail')), get: vi.fn() } })
    const failure = await call('GET', '/api/evaluation-suites', undefined, broken)
    expect(failure.response.statusCode).toBe(500)
    expect(failure.response.body).not.toContain('sensitive stack detail')
  })

  it('rejects non-loopback requests and returns false for unrelated routes', async () => {
    const res = response()
    const forged = request('GET', '/api/evaluation-runs')
    forged.socket.remoteAddress = '10.0.0.7'
    expect(await handleManagedEvaluationApi(forged, res, '/api/evaluation-runs', { managedEvaluationServices: services() })).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(await handleManagedEvaluationApi(request('GET', '/api/events'), response(), '/api/events', { managedEvaluationServices: services() })).toBe(false)
  })
})
