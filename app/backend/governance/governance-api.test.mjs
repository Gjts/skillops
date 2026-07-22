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
    previewCanary: vi.fn().mockResolvedValue({ previewToken: 'canary-1', conflict: false }),
    canary: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'canary' } }),
    previewInstallation: vi.fn().mockResolvedValue({ previewToken: 'install-1' }),
    install: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'stable' } }),
    previewPromotion: vi.fn().mockResolvedValue({ previewToken: 'preview-1', conflict: false }),
    promote: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'stable' } }),
    previewDeprecation: vi.fn().mockResolvedValue({ previewToken: 'deprecate-1' }),
    deprecate: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'deprecated' } }),
    previewRollback: vi.fn().mockResolvedValue({ previewToken: 'rollback-1' }),
    rollback: vi.fn().mockResolvedValue({ capability: { ...capability, stage: 'rolled-back' } }),
    lockState: vi.fn().mockResolvedValue({ schemaVersion: 1, targets: {} }),
    listAudit: vi.fn().mockResolvedValue([{ id: 'audit-1', action: 'candidate.nominated' }]),
  }
}

async function call(method, pathname, body, governance = service(), headers, remoteAddress) {
  const res = response()
  const handled = await handleGovernanceApi(request(method, pathname, body, headers, remoteAddress), res, pathname, {
    governanceServices: { governance },
    resolveGovernancePrincipal: async () => ({ id: 'Operator', assurance: 'test' }),
  })
  return { handled, response: res, json: res.body ? JSON.parse(res.body) : null, governance }
}

describe('governance API', () => {
  it('implements the capability collection, detail, evidence, approval, and canary routes', async () => {
    expect((await call('GET', '/api/capabilities')).json.items).toHaveLength(1)
    expect((await call('GET', '/api/capabilities/cap-1')).json.id).toBe('cap-1')
    const governance = service()
    const nomination = await call('POST', '/api/capabilities', {
      artifact: {},
      targetSkeleton: 'target',
      projectId: 'project-a',
      policyId: 'strict-v1',
    }, governance)
    expect(nomination.response.statusCode).toBe(201)
    expect(governance.nominate).toHaveBeenCalledWith({
      artifact: {},
      projectId: 'project-a',
      policyId: 'strict-v1',
      owner: 'Operator',
      ownerIdentityAssurance: 'test',
      targetSkeleton: 'target',
    })
    await call('POST', '/api/capabilities/cap-1/evaluate', { runId: 'run-1' }, governance)
    expect(governance.bindEvidence).toHaveBeenCalledWith('cap-1', { runId: 'run-1', actor: 'Operator' })
    await call('POST', '/api/capabilities/cap-1/approve', { decision: 'approved' }, governance)
    expect(governance.approve).toHaveBeenCalledWith('cap-1', {
      decision: 'approved',
      reviewer: 'Operator',
      reviewerIdentityAssurance: 'test',
    })
    await call('POST', '/api/capabilities/cap-1/canary', { action: 'preview', targetSkeleton: 'canary:review', projectRoot: 'C:\\canary-project' }, governance)
    expect(governance.previewCanary).toHaveBeenCalledWith('cap-1', { targetSkeleton: 'canary:review', projectRoot: 'C:\\canary-project' })
    await call('POST', '/api/capabilities/cap-1/canary', { action: 'apply', previewToken: 'canary-1', targetSkeleton: 'canary:review', projectRoot: 'C:\\canary-project', confirm: true }, governance)
    expect(governance.canary).toHaveBeenCalledWith('cap-1', {
      action: 'apply',
      previewToken: 'canary-1',
      targetSkeleton: 'canary:review',
      projectRoot: 'C:\\canary-project',
      confirm: true,
      actor: 'Operator',
    })
  })

  it('maps configured bearer tokens to reviewer identities and rejects unknown credentials', async () => {
    const token = 'reviewer-token-'.padEnd(32, 'x')
    const governance = service()
    const options = {
      governanceServices: { governance },
      environment: { SKILLOPS_GOVERNANCE_PRINCIPALS: JSON.stringify([{ id: 'reviewer-two', token }]) },
    }
    const approved = response()
    await handleGovernanceApi(
      request('POST', '/api/capabilities/cap-1/approve', { decision: 'approved' }, { authorization: `Bearer ${token}` }),
      approved,
      '/api/capabilities/cap-1/approve',
      options,
    )
    expect(approved.statusCode).toBe(200)
    expect(approved.body).not.toContain(token)
    expect(governance.approve).toHaveBeenCalledWith('cap-1', {
      decision: 'approved',
      reviewer: 'reviewer-two',
      reviewerIdentityAssurance: 'configured-bearer-token',
    })

    const rejected = response()
    await handleGovernanceApi(
      request('POST', '/api/capabilities/cap-1/approve', { decision: 'approved' }, { authorization: `Bearer ${'unknown'.padEnd(32, 'x')}` }),
      rejected,
      '/api/capabilities/cap-1/approve',
      options,
    )
    expect(rejected.statusCode).toBe(403)
    expect(rejected.body).not.toContain('unknown')
    expect(governance.approve).toHaveBeenCalledTimes(1)
    const audit = response()
    await handleGovernanceApi(
      request('GET', '/api/governance-audit', undefined, { authorization: `Bearer ${token}` }),
      audit,
      '/api/governance-audit',
      options,
    )
    expect(audit.statusCode).toBe(200)
    expect(JSON.parse(audit.body).items).toHaveLength(1)
  })


  it('enforces Team roles before governance reads, approvals, and releases', async () => {
    const governance = service()
    const teamControlPlane = { authorize: vi.fn().mockResolvedValue({ role: 'Owner' }) }
    const options = {
      governanceServices: { governance, teamControlPlane },
      resolveGovernancePrincipal: async () => ({ id: 'team-member', assurance: 'test' }),
    }
    const listed = response()
    await handleGovernanceApi(request('GET', '/api/capabilities'), listed, '/api/capabilities', options)
    const approved = response()
    await handleGovernanceApi(request('POST', '/api/capabilities/cap-1/approve', { decision: 'approved' }), approved, '/api/capabilities/cap-1/approve', options)
    const promoted = response()
    await handleGovernanceApi(request('POST', '/api/capabilities/cap-1/promote', { action: 'preview' }), promoted, '/api/capabilities/cap-1/promote', options)

    expect(teamControlPlane.authorize.mock.calls.map(([, role]) => role)).toEqual(['Viewer', 'Reviewer', 'Maintainer'])

    teamControlPlane.authorize.mockRejectedValueOnce(new EvaluationError('Team role Reviewer is required.', 403))
    const denied = response()
    await handleGovernanceApi(request('POST', '/api/capabilities/cap-1/approve', { decision: 'approved' }), denied, '/api/capabilities/cap-1/approve', options)
    expect(denied.statusCode).toBe(403)
    expect(governance.approve).toHaveBeenCalledTimes(1)
  })

  it('requires Maintainer authority to replace evidence while a target is Canary', async () => {
    const governance = service()
    governance.get.mockResolvedValue({ id: 'cap-1', stage: 'canary' })
    const teamControlPlane = { authorize: vi.fn().mockResolvedValue({ role: 'Maintainer' }) }
    const res = response()
    await handleGovernanceApi(
      request('POST', '/api/capabilities/cap-1/evaluate', { runId: 'run-2' }),
      res,
      '/api/capabilities/cap-1/evaluate',
      {
        governanceServices: { governance, teamControlPlane },
        resolveGovernancePrincipal: async () => ({ id: 'maintainer', assurance: 'test' }),
      },
    )

    expect(res.statusCode).toBe(200)
    expect(teamControlPlane.authorize).toHaveBeenCalledWith(expect.objectContaining({ id: 'maintainer' }), 'Maintainer')
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
      request('POST', '/api/capabilities', { sourceRef: 'local-scan:codex:C:/skills/review/SKILL.md' }),
      res,
      '/api/capabilities',
      {
        governanceServices: { governance, artifacts },
        resolveGovernancePrincipal: async () => ({ id: 'Operator', assurance: 'test' }),
      },
    )
    expect(res.statusCode).toBe(201)
    expect(artifacts.resolve).toHaveBeenCalledWith('local-scan:codex:C:/skills/review/SKILL.md')
    expect(governance.nominate).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ contentHash: 'a'.repeat(64) }),
      targetSkeleton: 'local-scan:codex:C:/skills/review/SKILL.md',
    }))
  })

  it('requires an explicit release target for non-inventory candidates', async () => {
    const governance = service()
    const artifacts = { resolve: vi.fn().mockResolvedValue({ artifact: { artifactId: 'review' } }) }
    const res = response()
    await handleGovernanceApi(
      request('POST', '/api/capabilities', { sourceRef: 'github:https://github.com/acme/review#SKILL.md' }),
      res,
      '/api/capabilities',
      { governanceServices: { governance, artifacts }, resolveGovernancePrincipal: async () => ({ id: 'Operator', assurance: 'test' }) },
    )
    expect(res.statusCode).toBe(422)
    expect(governance.nominate).not.toHaveBeenCalled()
  })

  it('requires preview then explicit apply for Canary, install, Stable promotion, deprecation, and rollback', async () => {
    const governance = service()
    expect((await call('POST', '/api/capabilities/cap-1/install', { action: 'preview' }, governance)).json.previewToken).toBe('install-1')
    await call('POST', '/api/capabilities/cap-1/install', { action: 'apply', previewToken: 'install-1', confirm: true }, governance)
    expect(governance.install).toHaveBeenCalledWith('cap-1', { action: 'apply', previewToken: 'install-1', confirm: true, actor: 'Operator' })
    expect((await call('POST', '/api/capabilities/cap-1/promote', { action: 'preview' }, governance)).json.previewToken).toBe('preview-1')
    await call('POST', '/api/capabilities/cap-1/promote', { action: 'apply', previewToken: 'preview-1', confirm: true }, governance)
    expect(governance.promote).toHaveBeenCalledWith('cap-1', { action: 'apply', previewToken: 'preview-1', confirm: true, actor: 'Operator' })
    expect((await call('POST', '/api/capabilities/cap-1/deprecate', { action: 'preview' }, governance)).json.previewToken).toBe('deprecate-1')
    await call('POST', '/api/capabilities/cap-1/deprecate', { action: 'apply', previewToken: 'deprecate-1', confirm: true }, governance)
    expect(governance.deprecate).toHaveBeenCalledWith('cap-1', { action: 'apply', previewToken: 'deprecate-1', confirm: true, actor: 'Operator' })
    expect((await call('POST', '/api/capabilities/cap-1/rollback', { action: 'preview' }, governance)).json.previewToken).toBe('rollback-1')
    await call('POST', '/api/capabilities/cap-1/rollback', { action: 'apply', previewToken: 'rollback-1', confirm: true }, governance)
    expect(governance.rollback).toHaveBeenCalledWith('cap-1', { action: 'apply', previewToken: 'rollback-1', confirm: true, actor: 'Operator' })
  })

  it('returns the metadata-only skeleton lock and rejects forged metrics or unknown actions', async () => {
    expect((await call('GET', '/api/project-skeleton-lock')).json).toEqual({ schemaVersion: 1, targets: {} })
    expect((await call('GET', '/api/governance-audit')).json.items).toEqual([{ id: 'audit-1', action: 'candidate.nominated' }])
    const forged = await call('POST', '/api/capabilities/cap-1/evaluate', { runId: 'run-1', candidateScore: 100 })
    expect(forged.response.statusCode).toBe(422)
    expect(forged.json.error.code).toBe('VALIDATION_FAILED')
    const action = await call('POST', '/api/capabilities/cap-1/promote', { action: 'latest' })
    expect(action.response.statusCode).toBe(422)
  })

  it('requires authentication for audit and lock metadata', async () => {
    for (const pathname of ['/api/governance-audit', '/api/project-skeleton-lock']) {
      const governance = service()
      const res = response()
      await handleGovernanceApi(request('GET', pathname), res, pathname, {
        governanceServices: { governance },
        environment: {},
      })
      expect(res.statusCode).toBe(403)
      expect(governance.listAudit).not.toHaveBeenCalled()
      expect(governance.lockState).not.toHaveBeenCalled()
    }
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
