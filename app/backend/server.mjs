import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { appendEvent, appendEvents, clearEvents, eventVersion, readEvents, readJsonBody } from './event-store.mjs'
import { handleEvaluationApi, initializeManagedEvaluationServices } from './skill-evaluations.mjs'
import { syncCodexDesktopEvents } from './codex-desktop-ingest.mjs'
import { enrichRuntimeConnections, readRuntimeConnections } from './runtime-connections.mjs'
import { scanInstalledSkills } from './skill-scanner.mjs'

const port = Number(process.env.PORT || 4173)
const host = process.env.SKILLOPS_HOST || '127.0.0.1'
const dist = path.resolve(process.cwd(), 'dist')
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const managedEvaluationServices = await initializeManagedEvaluationServices()

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname
  if (await handleEvaluationApi(request, response, pathname)) return

  if (pathname === '/api/connections') {
    response.setHeader('Content-Type', 'application/json')
    if (request.method !== 'GET') {
      response.statusCode = 405
      return response.end(JSON.stringify({ error: 'Method not allowed' }))
    }
    try {
      await syncCodexDesktopEvents()
      const [connections, events] = await Promise.all([readRuntimeConnections(), readEvents()])
      return response.end(JSON.stringify(enrichRuntimeConnections(connections, events)))
    } catch (error) {
      response.statusCode = 500
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Connection inspection failed' }))
    }
  }

  if (pathname === '/api/scan') {
    response.setHeader('Content-Type', 'application/json')
    try {
      if (request.method === 'POST') return response.end(JSON.stringify(await scanInstalledSkills()))
      response.statusCode = 405
      return response.end(JSON.stringify({ error: 'Method not allowed' }))
    } catch (error) {
      response.statusCode = 500
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Scan failed' }))
    }
  }

  if (pathname === '/api/events') {
    response.setHeader('Content-Type', 'application/json')
    try {
      if (request.method === 'GET') {
        await syncCodexDesktopEvents()
        const etag = await eventVersion()
        response.setHeader('ETag', etag)
        if (request.headers['if-none-match'] === etag) {
          response.statusCode = 304
          return response.end()
        }
        return response.end(JSON.stringify(await readEvents()))
      }
      if (request.method === 'POST') {
        response.statusCode = 201
        return response.end(JSON.stringify(await appendEvent(await readJsonBody(request))))
      }
      if (request.method === 'DELETE') return response.end(JSON.stringify(await clearEvents()))
      response.statusCode = 405
      return response.end(JSON.stringify({ error: 'Method not allowed' }))
    } catch (error) {
      response.statusCode = request.method === 'POST' ? 400 : 500
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid event' }))
    }
  }

  if (pathname === '/api/import') {
    response.setHeader('Content-Type', 'application/json')
    try {
      if (request.method === 'POST') {
        const created = await appendEvents(await readJsonBody(request))
        response.statusCode = 201
        return response.end(JSON.stringify({ created, importedCount: created.length }))
      }
      response.statusCode = 405
      return response.end(JSON.stringify({ error: 'Method not allowed' }))
    } catch (error) {
      response.statusCode = request.method === 'POST' ? 400 : 500
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid import' }))
    }
  }

  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  let file = path.resolve(dist, relative)
  if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
    response.statusCode = 403
    return response.end('Forbidden')
  }
  try {
    if (!(await stat(file)).isFile()) file = path.join(dist, 'index.html')
  } catch {
    if (path.extname(relative)) {
      response.statusCode = 404
      return response.end('Not found')
    }
    file = path.join(dist, 'index.html')
  }
  response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
  createReadStream(file).pipe(response)
}).listen(port, host, () => {
  console.log(`SkillOps is running at http://${host}:${port}`)
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await managedEvaluationServices.manager.shutdown().catch(() => undefined)
  server.close()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
