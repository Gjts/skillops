// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { handleTeamControlPlaneApi } from './team-control-plane-api.mjs'

function request(method, body, headers = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    async *[Symbol.asyncIterator]() { yield* bytes },
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value = '') { this.body = value },
  }
}

const principal = { id: 'user:owner', displayName: 'Owner', assurance: 'test' }
const options = (teamControlPlane) => ({ teamControlPlane, resolveGovernancePrincipal: async () => principal })

describe('Team control-plane API', () => {
  it('creates and reads the local Team through bounded JSON routes', async () => {
    const teamControlPlane = {
      initialize: vi.fn(async (body, actor) => ({ team: body, actor: actor.id })),
      snapshot: vi.fn(async () => ({ team: { id: 'acme' } })),
    }
    const created = response()
    expect(await handleTeamControlPlaneApi(request('POST', { id: 'acme', name: 'Acme' }), created, '/api/team', options(teamControlPlane))).toBe(true)
    expect(created.statusCode).toBe(201)
    expect(JSON.parse(created.body)).toEqual({ team: { id: 'acme', name: 'Acme' }, actor: 'user:owner' })

    const read = response()
    await handleTeamControlPlaneApi(request('GET'), read, '/api/team', options(teamControlPlane))
    expect(read.statusCode).toBe(200)
    expect(JSON.parse(read.body)).toEqual({ team: { id: 'acme' } })
    expect(read.headers['Cache-Control']).toBe('no-store')
  })

  it('rejects unknown Team mutation fields before calling the module', async () => {
    const teamControlPlane = { initialize: vi.fn() }
    const output = response()
    await handleTeamControlPlaneApi(request('POST', { id: 'acme', name: 'Acme', networkHost: '0.0.0.0' }), output, '/api/team', options(teamControlPlane))
    expect(output.statusCode).toBe(422)
    expect(JSON.parse(output.body).error.message).toContain('networkHost')
    expect(teamControlPlane.initialize).not.toHaveBeenCalled()
  })

  it('rejects unknown Project and nested Template fields before calling the module', async () => {
    const teamControlPlane = { saveEntity: vi.fn() }
    const unknownProject = response()
    await handleTeamControlPlaneApi(request('PUT', { name: 'Project A', secretPath: 'C:/secret' }), unknownProject, '/api/team/entities/project/project-a', options(teamControlPlane))
    expect(unknownProject.statusCode).toBe(422)
    expect(JSON.parse(unknownProject.body).error.message).toContain('secretPath')

    const unknownTemplate = response()
    await handleTeamControlPlaneApi(request('PUT', { name: 'Project A', template: { id: 'team-default', version: '1.0.0', status: 'current', fileBodies: ['secret'] } }), unknownTemplate, '/api/team/entities/project/project-a', options(teamControlPlane))
    expect(unknownTemplate.statusCode).toBe(422)
    expect(JSON.parse(unknownTemplate.body).error.message).toContain('fileBodies')
    expect(teamControlPlane.saveEntity).not.toHaveBeenCalled()
  })

  it('requires a loopback JSON request and a scoped bearer token for collector uploads', async () => {
    const teamControlPlane = { collect: vi.fn(async () => ({ accepted: true })) }
    const forbidden = response()
    await handleTeamControlPlaneApi(request('POST', { events: [] }, { host: 'skillops.example.com', origin: 'https://evil.example.com', authorization: 'Bearer device-token' }), forbidden, '/api/team/collector', options(teamControlPlane))
    expect(forbidden.statusCode).toBe(403)
    expect(teamControlPlane.collect).not.toHaveBeenCalled()

    const missing = response()
    await handleTeamControlPlaneApi(request('POST', { events: [] }), missing, '/api/team/collector', options(teamControlPlane))
    expect(missing.statusCode).toBe(403)

    const accepted = response()
    await handleTeamControlPlaneApi(request('POST', { events: [] }, { authorization: 'Bearer device-token' }), accepted, '/api/team/collector', options(teamControlPlane))
    expect(accepted.statusCode).toBe(202)
    expect(teamControlPlane.collect).toHaveBeenCalledWith('device-token', { events: [] })
  })

  it('routes entity, exception, audit, backup, restore, export, and retention operations without exposing another interface', async () => {
    const teamControlPlane = {
      saveEntity: vi.fn(async () => ({ revision: 2 })),
      removeEntity: vi.fn(async () => ({ revision: 3 })),
      requestException: vi.fn(async () => ({ id: 'exception-1' })),
      reviewException: vi.fn(async () => ({ status: 'approved' })),
      audit: vi.fn(async () => []),
      exportTeam: vi.fn(async () => ({ schemaVersion: 1 })),
      backup: vi.fn(async () => ({ created: true })),
      restoreBackup: vi.fn(async () => ({ restored: true })),
      applyRetention: vi.fn(async () => ({ retentionDays: 30 })),
    }
    const cases = [
      ['PUT', '/api/team/entities/project/project-a', { name: 'Project A', template: { id: 'team-default', version: '1.0.0', status: 'current' } }, 200],
      ['DELETE', '/api/team/entities/project/project-a', undefined, 200],
      ['POST', '/api/team/exceptions', { projectId: 'project-a', policyId: 'secure', reason: 'needed' }, 201],
      ['POST', '/api/team/exceptions/exception-1/review', { decision: 'approved' }, 200],
      ['GET', '/api/team/audit', undefined, 200],
      ['GET', '/api/team/export', undefined, 200],
      ['POST', '/api/team/backup', {}, 201],
      ['POST', '/api/team/restore', { file: 'team-backup-safe.json' }, 200],
      ['PUT', '/api/team/retention', { days: 30 }, 200],
    ]
    for (const [method, pathname, body, status] of cases) {
      const output = response()
      expect(await handleTeamControlPlaneApi(request(method, body), output, pathname, options(teamControlPlane))).toBe(true)
      expect(output.statusCode).toBe(status)
    }
    expect(teamControlPlane.saveEntity).toHaveBeenCalledWith('project', { name: 'Project A', template: { id: 'team-default', version: '1.0.0', status: 'current' }, id: 'project-a' }, principal)
    expect(teamControlPlane.removeEntity).toHaveBeenCalledWith('project', 'project-a', principal)
    expect(teamControlPlane.reviewException).toHaveBeenCalledWith('exception-1', 'approved', principal)
    expect(teamControlPlane.applyRetention).toHaveBeenCalledWith(30, principal)
    expect(teamControlPlane.restoreBackup).toHaveBeenCalledWith('team-backup-safe.json', principal)

    expect(await handleTeamControlPlaneApi(request('GET'), response(), '/api/team-unknown', options(teamControlPlane))).toBe(false)
  })
})
