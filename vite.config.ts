import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { themeBootstrapConfig } from './app/frontend/skillops/src/lib/themeCatalog'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { appendEvent, appendEvents, clearEvents, eventVersion, readEvents, readJsonBody } from './app/backend/event-store.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { initializeConflictServices } from './app/backend/conflicts/conflict-api.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleEvaluationApi, initializeManagedEvaluationServices, initializeTeamControlPlane } from './app/backend/skill-evaluations.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { syncCodexDesktopEvents } from './app/backend/codex-desktop-ingest.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { enrichRuntimeConnections, readRuntimeConnections } from './app/backend/runtime-connections.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { scanSkillInventory } from './app/backend/skill-scanner.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { assertLocalApiRequest } from './app/backend/evaluations/request-guard.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleRunsApi } from './app/backend/runs-api.mjs'

function themeBootstrap(): Plugin {
  return {
    name: 'skillops-theme-bootstrap',
    transformIndexHtml(html) {
      return html.replace('__SKILLOPS_THEME_BOOTSTRAP__', JSON.stringify(themeBootstrapConfig))
    },
  }
}

function stripNodeShebangs(): Plugin {
  return {
    name: 'skillops-strip-node-shebangs',
    enforce: 'pre',
    transform(source, id) {
      if (!id.endsWith('.mjs') || !source.startsWith('#!')) return
      return source.replace(/^#![^\r\n]*(?:\r?\n|$)/, '')
    },
  }
}

function localEventApi(): Plugin {
  return {
    name: 'skillops-local-event-api',
    configureServer(server) {
      initializeConflictServices()
      const managedServices = initializeManagedEvaluationServices()
      const teamControlPlane = initializeTeamControlPlane()
      server.httpServer?.once('close', () => { void managedServices.then((services: { manager: { shutdown(): Promise<void> } }) => services.manager.shutdown()) })
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname
        if (await handleEvaluationApi(request, response, pathname, { managedEvaluationServices: await managedServices, teamControlPlane: await teamControlPlane })) return
        if (await handleRunsApi(request, response, pathname)) return
        if (pathname === '/api/connections' || pathname === '/api/scan' || pathname === '/api/events' || pathname === '/api/import') {
          try {
            assertLocalApiRequest(request, { requireJson: request.method === 'POST' && (pathname === '/api/events' || pathname === '/api/import') })
          } catch (error) {
            const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : NaN
            response.setHeader('Content-Type', 'application/json')
            response.statusCode = Number.isInteger(status) ? status : 403
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Local API request rejected.' }))
            return
          }
        }
        if (pathname === '/api/connections') {
          response.setHeader('Content-Type', 'application/json')
          if (request.method !== 'GET') {
            response.statusCode = 405
            response.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }
          try {
            await syncCodexDesktopEvents()
            const [connections, events] = await Promise.all([readRuntimeConnections(), readEvents()])
            response.end(JSON.stringify(enrichRuntimeConnections(connections, events)))
          } catch (error) {
            response.statusCode = 500
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Connection inspection failed' }))
          }
          return
        }
        if (pathname === '/api/scan') {
          response.setHeader('Content-Type', 'application/json')
          try {
            if (request.method !== 'POST') {
              response.statusCode = 405
              response.end(JSON.stringify({ error: 'Method not allowed' }))
              return
            }
            response.end(JSON.stringify(await scanSkillInventory()))
          } catch (error) {
            response.statusCode = 500
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Scan failed' }))
          }
          return
        }
        if (pathname === '/api/import') {
          response.setHeader('Content-Type', 'application/json')
          try {
            if (request.method !== 'POST') {
              response.statusCode = 405
              response.end(JSON.stringify({ error: 'Method not allowed' }))
              return
            }
            const created = await appendEvents(await readJsonBody(request))
            response.statusCode = 201
            response.end(JSON.stringify({ created, importedCount: created.length }))
          } catch (error) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid import' }))
          }
          return
        }
        if (pathname !== '/api/events') {
          next()
          return
        }
        response.setHeader('Content-Type', 'application/json')
        try {
          if (request.method === 'GET') {
            await syncCodexDesktopEvents()
            const etag = await eventVersion()
            response.setHeader('ETag', etag)
            if (request.headers['if-none-match'] === etag) {
              response.statusCode = 304
              response.end()
              return
            }
            response.end(JSON.stringify(await readEvents()))
            return
          }
          if (request.method === 'POST') {
            const event = await appendEvent(await readJsonBody(request))
            response.statusCode = 201
            response.end(JSON.stringify(event))
            return
          }
          if (request.method === 'DELETE') {
            response.end(JSON.stringify(await clearEvents()))
            return
          }
          response.statusCode = 405
          response.end(JSON.stringify({ error: 'Method not allowed' }))
        } catch (error) {
          response.statusCode = request.method === 'POST' ? 400 : 500
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid event' }))
        }
      })
    },
  }
}

export default defineConfig({
  root: path.resolve('app/frontend/skillops'),
  plugins: [stripNodeShebangs(), themeBootstrap(), react(), localEventApi()],
  server: { port: 5173 },
  test: { maxWorkers: 2, testTimeout: 30_000, setupFiles: [path.resolve('scripts/test-no-egress.mjs')] },
  build: {
    outDir: path.resolve('dist'),
    emptyOutDir: true,
  },
})
