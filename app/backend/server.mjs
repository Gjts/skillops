import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { initializeConflictServices } from './conflicts/conflict-api.mjs'
import { handleEvaluationApi, initializeGovernanceServices, initializeManagedEvaluationServices, initializeTeamControlPlane } from './skill-evaluations.mjs'
import { handleCommandCenterApi } from './command-center.mjs'
import { handleAgentsApi } from './agents-api.mjs'
import { isLoopbackHostname } from './evaluations/provider-client.mjs'
import { handleLocalDataApi } from './local-data-api.mjs'
import { handleRunsApi } from './runs-api.mjs'
import { handleSetupPreflightApi } from './setup-preflight.mjs'

const port = Number(process.env.PORT || 4173)
const host = process.env.SKILLOPS_HOST || '127.0.0.1'
if (!isLoopbackHostname(host)) throw new Error('SKILLOPS_HOST must remain a loopback hostname until authenticated network APIs are implemented.')
const dist = path.resolve(process.cwd(), 'dist')
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const managedEvaluationServices = await initializeManagedEvaluationServices()
await initializeGovernanceServices()
const teamControlPlane = await initializeTeamControlPlane()
initializeConflictServices()

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  if (await handleSetupPreflightApi(request, response, pathname)) return
  if (await handleCommandCenterApi(request, response, pathname)) return
  if (await handleAgentsApi(request, response, pathname)) return
  if (await handleEvaluationApi(request, response, pathname, { managedEvaluationServices, teamControlPlane })) return
  if (await handleRunsApi(request, response, pathname)) return
  if (await handleLocalDataApi(request, response, pathname)) return

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
