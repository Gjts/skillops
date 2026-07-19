import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const port = 4188
const smokeData = await mkdtemp(path.join(tmpdir(), 'skillops-smoke-'))
const server = spawn(process.execPath, ['app/backend/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), SKILLOPS_DATA_DIR: smokeData },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk })

try {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(100)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      const html = await response.text()
      if (!response.ok || !html.includes('<title>SkillOps</title>')) throw new Error('Frontend response is invalid.')
      ready = true
      break
    } catch {
      // The child process may still be binding the local port.
    }
  }
  if (!ready) throw new Error('Production server did not become ready.')
  if (!serverOutput.includes(`http://127.0.0.1:${port}`)) throw new Error('Production server did not bind to the loopback host by default.')

  const eventsResponse = await fetch(`http://127.0.0.1:${port}/api/events?source=smoke`)
  const events = await eventsResponse.json()
  if (!eventsResponse.ok || !Array.isArray(events)) throw new Error('Event API did not return an array.')
  const eventEtag = eventsResponse.headers.get('etag')
  const unchangedEvents = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'If-None-Match': eventEtag } })
  if (!eventEtag || unchangedEvents.status !== 304) throw new Error('Unchanged event polling did not use a lightweight 304 response.')

  const scanResponse = await fetch(`http://127.0.0.1:${port}/api/scan?source=smoke`, { method: 'POST' })
  const installed = await scanResponse.json()
  if (!scanResponse.ok || !Array.isArray(installed)) throw new Error('Installed Skill scan API did not return an array.')

  const connectionsResponse = await fetch(`http://127.0.0.1:${port}/api/connections`)
  const connections = await connectionsResponse.json()
  if (!connectionsResponse.ok || !Array.isArray(connections) || !connections.some((item) => item.runtime === 'codex')) {
    throw new Error('Runtime connection API did not return current adapter status.')
  }

  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'smoke-test', skillVersion: '0.1.0', runtime: 'codex', prompt: 'must-not-be-stored' }),
  })
  const created = await createdResponse.json()
  if (createdResponse.status !== 201 || created.skillId !== 'smoke-test') throw new Error('Valid event was not accepted.')
  if (created.outcome !== 'unknown') throw new Error('Lifecycle-only completion was incorrectly marked successful.')
  if (JSON.stringify(created).includes('must-not-be-stored')) throw new Error('Unknown event fields were not removed.')
  if ((await readFile(path.join(smokeData, 'events.jsonl'), 'utf8')).includes('must-not-be-stored')) throw new Error('Sensitive unknown fields reached the event store.')

  const invalidNumberResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'invalid-number', runtime: 'codex', durationMs: 'abc' }),
  })
  if (invalidNumberResponse.status !== 400) throw new Error('Invalid numeric event data was not rejected.')

  const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'unknown.event' }),
  })
  if (invalidResponse.status !== 400) throw new Error('Invalid event was not rejected.')

  const invalidTimestampResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'bad-time', runtime: 'codex', timestamp: 'not-a-date' }),
  })
  if (invalidTimestampResponse.status !== 400) throw new Error('Invalid event timestamp was not rejected.')

  const importedEvent = { id: 'smoke-import', event: 'skill.completed', skillId: 'imported-smoke', runtime: 'claude-code', outcome: 'success' }
  const importResponse = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([importedEvent]),
  })
  const importResult = await importResponse.json()
  if (importResponse.status !== 201 || importResult.importedCount !== 1) throw new Error('Event import was not persisted.')
  const duplicateImport = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([importedEvent]),
  })
  if ((await duplicateImport.json()).importedCount !== 0) throw new Error('Duplicate imported event IDs were appended again.')

  const routeResponse = await fetch(`http://127.0.0.1:${port}/registry`)
  if (!routeResponse.ok || !(await routeResponse.text()).includes('<title>SkillOps</title>')) throw new Error('SPA route fallback failed.')
  const missingAsset = await fetch(`http://127.0.0.1:${port}/missing.js`)
  if (missingAsset.status !== 404) throw new Error('Missing asset did not return 404.')
  const nestedApiRoute = await fetch(`http://127.0.0.1:${port}/api/events/extra`)
  if (!(nestedApiRoute.headers.get('content-type') || '').includes('text/html')) throw new Error('Nested event path was incorrectly handled as the event API.')
  console.log('Smoke test passed: loopback frontend, SPA routing, privacy validation, and local API are healthy.')
} finally {
  const exit = server.exitCode === null ? once(server, 'exit') : Promise.resolve()
  server.kill('SIGTERM')
  await exit
  await rm(smokeData, { recursive: true, force: true })
}
