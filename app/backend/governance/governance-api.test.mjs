// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { EvaluationError } from '../evaluations/errors.mjs'
import { handleGovernanceApi } from './governance-api.mjs'

function request(method, url, body, headers = {}, remoteAddress = '127.0.0.1') {
  const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
  return {
    method, url,
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes },
  }
}

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(value = '') { this.body += value } }
}

function service() {
  const capability = { id: 'cap-1', stage: 'candidate', artifact: { artifactId: 'review' } }
  return {
    list: vi.fn().mockResolvedValue([capability]),
    get: vi.fn().mockResolvedValue(capability),
    nominate: vi.fn().mockResolvedValue({ capability, reused: false }),
    bindEvidence: vi.fn().mockResolvedValue({ ...capability, stage: 'ready' }),
    approve: vi.fn().mockResolvedValue({ ...capability, stage: 'approved' }),
    canary: vi.fn().mockResolvedValue({ ...capability, stage: 'canary' }),
    previewPromotion: vi.fn().mockResolvedValue({ previewToken: 'preview-1', conflict: false }),
    promote: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'stable' } }),
    previewRollback: vi.fn().mockResolvedValue({ previewToken: 'rollback-1' }),
    rollback: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'rolled-back' } }),
    lockState: vi.fn().mockResolvedValue({ schemaVersion: 1, targets: {} }),
  }
}

async function call(method, pathname, body, governance = service(), headers, remoteAddress) {
  const res = response()
  const handled = await handleGovernanceApi(request(method, pathname, body, headers, remoteAddress), res, pathname, { governanceServices: { governance } })
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null, governance }
}

describe('governance API', () => {
  it('implements the capability collection, detail, evidence, approval, and canary routes', async () => {
    expect((await call('GET', '/api/capabilities')).json.items).toHaveLength(1)
    expect((await call('GET', '/api/capabilities/cap-1')).json.id).toBe('cap-1')
    const governance = service()
    const nomination = await call('POST', '/api/capabilities', { artifact: {}, owner: 'Owner', targetSkeleton: 'target' }, governance)
    expect(nomination.response.statusCode).toBe(201)
    expect(governance.nominate).toHaveBeenCalledWith({ artifact: {}, owner: 'Owner', targetSkeleton: 'target' })
    await call('POST', '/api/capabilities/cap-1/evaluate', { runId: 'run-1' }, governance)
    expect(governance.bindEvidence).toHaveBeenCalledWith('cap-1', { runId: 'run-1' })
    await call('POST', '/api/capabilities/cap-1/approve', { reviewer: 'Reviewer' }, governance)
    expect(governance.approve).toHaveBeenCalledWith('cap-1', { reviewer: 'Reviewer' })
    await call('POST', '/api/capabilities/cap-1/canary', {}, governance)
    expect(governance.canary).toHaveBeenCalledWith('cap-1')
  })

  it('resolves inventory references on the server before nomination', async () => {
    const governance = service()
    const artifacts = {
      resolve: vi.fn().mockResolvedValue({
        artifact: {
          artifactId: 'review',
          version: '1.0.0',
          kind: 'skill',
          source: 'local-scan',
          sourceRef: 'local-scan:codex:C:/skills/review/SKILL.md',
          contentHash: 'a'.repeat(64),
        },
      }),
    }
    const res = response()
    await handleGovernanceApi(
      request('POST', '/api/capabilities', { sourceRef: 'local-scan:codex:C:/skills/review/SKILL.md', owner: 'Local owner' }),
      res,
      '/api/capabilities',
      { governanceServices: { governance, artifacts } },
    )
    expect(res.statusCode).toBe(201)
    expect(artifacts.resolve).toHaveBeenCalledWith('local-scan:codex:C:/skills/review/SKILL.md')
    expect(governance.nominate).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ contentHash: 'a'.repeat(64) }),
      targetSkeleton: 'local-scan:codex:C:/skills/review/SKILL.md',
    }))
  })

  it('requires preview then explicit apply for Stable and Rollback operations', async () => {
    const governance = service()
    expect((await call('POST', '/api/capabilities/cap-1/promote', { action: 'preview' }, governance)).json.previewToken).toBe('preview-1')
    await call('POST', '/api/capabilities/cap-1/promote', { action: 'apply', previewToken: 'preview-1', confirm: true }, governance)
    expect(governance.promote).toHaveBeenCalledWith('cap-1', { action: 'apply', previewToken: 'preview-1', confirm: true })
    expect((await call('POST', '/api/capabilities/cap-1/rollback', { action: 'preview' }, governance)).json.previewToken).toBe('rollback-1')
    await call('POST', '/api/capabilities/cap-1/rollback', { action: 'apply', previewToken: 'rollback-1', confirm: true }, governance)
    expect(governance.rollback).toHaveBeenCalledWith('cap-1', { action: 'apply', previewToken: 'rollback-1', confirm: true })
  })

  it('returns the metadata-only skeleton lock and rejects forged metrics or unknown actions', async () => {
    expect((await call('GET', '/api/project-skeleton-lock')).json).toEqual({ schemaVersion: 1, targets: {} })
    const forged = await call('POST', '/api/capabilities/cap-1/evaluate', { runId: 'run-1', candidateScore: 100 })
    expect(forged.response.statusCode).toBe(422)
    expect(forged.json.error.code).toBe('VALIDATION_FAILED')
    const action = await call('POST', '/api/capabilities/cap-1/promote', { action: 'latest' })
    expect(action.response.statusCode).toBe(422)
  })

  it('uses shared loopback, media type, body limit, and safe error handling', async () => {
    expect((await call('POST', '/api/capabilities', {}, service(), {}, '10.0.0.8')).response.statusCode).toBe(403)
    expect((await call('POST', '/api/capabilities', {}, service(), { 'content-type': 'text/plain' })).response.statusCode).toBe(415)
    expect((await call('POST', '/api/capabilities', {}, service(), { 'content-length': '600000' })).response.statusCode).toBe(413)
    const governance = service()
    governance.get.mockRejectedValue(new Error('secret internal detail'))
    const failed = await call('GET', '/api/capabilities/cap-1', undefined, governance)
    expect(failed.response.statusCode).toBe(500)
    expect(failed.response.body).not.toContain('secret internal detail')
    governance.get.mockRejectedValue(new EvaluationError('Capability was not found.', 404))
    const missing = await call('GET', '/api/capabilities/cap-1', undefined, governance)
    expect(missing.json.error).toEqual({ code: 'NOT_FOUND', message: 'Capability was not found.' })
  })
})
