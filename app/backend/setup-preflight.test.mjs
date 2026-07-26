// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { handleSetupPreflightApi, readSetupPreflight } from './setup-preflight.mjs'

const checkedAt = '2026-07-25T12:00:00.000Z'

function request(overrides = {}) {
  return {
    method: 'GET',
    url: '/api/setup/preflight',
    headers: { host: '127.0.0.1:4173' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body = value },
  }
}

function services(overrides = {}) {
  return {
    nodeVersion: '22.22.0',
    checkGit: vi.fn().mockResolvedValue(true),
    probeDataDirectory: vi.fn().mockResolvedValue(true),
    dataDirectory: 'C:\\private\\skillops-data',
    readConnections: vi.fn().mockResolvedValue([
      { runtime: 'codex', detected: true, configurationStatus: 'installed', sourcePath: 'PRIVATE_PATH_SENTINEL' },
      { runtime: 'claude-code', detected: true, configurationStatus: 'broken', error: 'RAW_ERROR_SENTINEL' },
      { runtime: 'cursor', detected: false, configurationStatus: 'preview' },
      { runtime: 'PRIVATE_PATH_SENTINEL', detected: true, configurationStatus: 'installed' },
    ]),
    now: () => checkedAt,
    ...overrides,
  }
}

describe('setup preflight', () => {
  it('returns only sanitized read-only readiness facts', async () => {
    const dependencies = services()
    const result = await readSetupPreflight(dependencies)

    expect(result).toEqual({
      checkedAt,
      node: { version: '22.22.0', minimumVersion: '22.22.0', supported: true },
      git: { available: true },
      localApi: { available: true },
      dataDirectory: { available: true, writable: true },
      runtimes: {
        available: true,
        items: [
          { runtime: 'codex', configurationDetected: true, configurationStatus: 'installed', adapterReferenceHealth: 'healthy' },
          { runtime: 'claude-code', configurationDetected: true, configurationStatus: 'broken', adapterReferenceHealth: 'unhealthy' },
          { runtime: 'cursor', configurationDetected: false, configurationStatus: 'preview', adapterReferenceHealth: 'unsupported' },
        ],
      },
    })
    expect(dependencies.probeDataDirectory).toHaveBeenCalledWith(dependencies.dataDirectory)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PATH_SENTINEL')
    expect(JSON.stringify(result)).not.toContain('RAW_ERROR_SENTINEL')
    expect(JSON.stringify(result)).not.toContain(dependencies.dataDirectory)
  })

  it('does not create a missing data directory and hides probe failures', async () => {
    const missing = path.join(os.tmpdir(), `skillops-preflight-${randomUUID()}`)
    const result = await readSetupPreflight({
      nodeVersion: '22.21.9',
      checkGit: async () => { throw new Error('RAW_GIT_ERROR') },
      dataDirectory: missing,
      readConnections: async () => { throw new Error('RAW_RUNTIME_ERROR') },
      now: () => checkedAt,
    })

    expect(existsSync(missing)).toBe(false)
    expect(result.node.supported).toBe(false)
    expect(result.git.available).toBe(false)
    expect(result.dataDirectory.available).toBe(true)
    expect(result.dataDirectory.writable).toBe(true)
    expect(result.runtimes).toEqual({ available: false, items: [] })
    expect(JSON.stringify(result)).not.toMatch(/RAW_(GIT|RUNTIME)_ERROR/)

    const unavailable = await readSetupPreflight({
      ...services(),
      probeDataDirectory: async () => { throw new Error('RAW_DATA_ERROR') },
    })
    expect(unavailable.dataDirectory).toEqual({ available: false, writable: false })
    expect(JSON.stringify(unavailable)).not.toContain('RAW_DATA_ERROR')

    const invalidPath = await readSetupPreflight({
      ...services(),
      probeDataDirectory: undefined,
      dataDirectory: '\0invalid',
    })
    expect(invalidPath.dataDirectory).toEqual({ available: false, writable: false })
  })

  it('does not report a writable file as a writable data directory', async () => {
    const result = await readSetupPreflight({
      nodeVersion: '22.22.0',
      checkGit: async () => true,
      dataDirectory: path.join(process.cwd(), 'package.json'),
      readConnections: async () => [],
      now: () => checkedAt,
    })

    expect(result.dataDirectory).toEqual({ available: true, writable: false })
  })

  it('handles only loopback GET requests for the exact route', async () => {
    const ignored = response()
    expect(await handleSetupPreflightApi(request(), ignored, '/api/other')).toBe(false)

    const valid = response()
    await handleSetupPreflightApi(request(), valid, '/api/setup/preflight', services())
    expect(valid.statusCode).toBe(200)
    expect(valid.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(valid.body).localApi.available).toBe(true)

    const method = response()
    await handleSetupPreflightApi(request({ method: 'POST' }), method, '/api/setup/preflight', services())
    expect(method.statusCode).toBe(405)
    expect(method.headers.allow).toBe('GET')

    const remote = response()
    await handleSetupPreflightApi(request({
      headers: { host: 'evil.example:4173', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '10.0.0.1' },
    }), remote, '/api/setup/preflight', services())
    expect(remote.statusCode).toBe(403)
    expect(JSON.parse(remote.body).error.code).toBe('FORBIDDEN')
  })
})
