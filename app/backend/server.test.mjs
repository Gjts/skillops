// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

async function availablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.')
  return address.port
}

function responseFrom(port, requestPath) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: requestPath }, (incoming) => {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk) => { body += chunk })
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let diagnostics = ''
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out. ${diagnostics}`)), 15_000)
    const finish = (callback) => {
      clearTimeout(timeout)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
      callback()
    }
    const onStdout = (chunk) => {
      diagnostics += chunk
      if (diagnostics.includes('SkillOps is running at')) finish(resolve)
    }
    const onStderr = (chunk) => { diagnostics += chunk }
    const onExit = (code) => finish(() => reject(new Error(`Server exited before startup with ${code}. ${diagnostics}`)))
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', onExit)
  })
}

describe('production server binding', () => {
  it('rejects non-loopback hosts before opening the unauthenticated API', () => {
    const result = spawnSync(process.execPath, ['app/backend/server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SKILLOPS_HOST: '0.0.0.0' },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('must remain a loopback hostname')
  })

  it('returns a structured client error for malformed URL encoding and keeps serving requests', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'skillops-server-url-'))
    const port = await availablePort()
    const child = spawn(process.execPath, ['app/backend/server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), SKILLOPS_DATA_DIR: dataDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    try {
      await waitForStartup(child)
      for (const requestPath of ['/%', '/api/runs/%']) {
        const malformed = await responseFrom(port, requestPath)
        expect(malformed.status).toBe(400)
        expect(malformed.headers['content-type']).toBe('application/json; charset=utf-8')
        expect(JSON.parse(malformed.body)).toEqual({
          error: { code: 'INVALID_REQUEST', message: 'Request URL encoding is invalid.' },
        })
      }

      const healthy = await responseFrom(port, '/api/events?summary=1')
      expect(healthy.status).toBe(200)
      expect(child.exitCode).toBeNull()
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await once(child, 'exit')
      }
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }, 30_000)
})
