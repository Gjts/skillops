import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { themeBootstrapConfig } from './app/frontend/skillops/src/lib/themeCatalog'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { initializeConflictServices } from './app/backend/conflicts/conflict-api.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleEvaluationApi, initializeManagedEvaluationServices, initializeTeamControlPlane } from './app/backend/skill-evaluations.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleCommandCenterApi } from './app/backend/command-center.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleAgentsApi } from './app/backend/agents-api.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleLocalDataApi } from './app/backend/local-data-api.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleRunsApi } from './app/backend/runs-api.mjs'
// @ts-expect-error Plain JavaScript module is shared with the production server.
import { handleSetupPreflightApi } from './app/backend/setup-preflight.mjs'

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
        if (await handleSetupPreflightApi(request, response, pathname)) return
        if (await handleCommandCenterApi(request, response, pathname)) return
        if (await handleAgentsApi(request, response, pathname)) return
        if (await handleEvaluationApi(request, response, pathname, { managedEvaluationServices: await managedServices, teamControlPlane: await teamControlPlane })) return
        if (await handleRunsApi(request, response, pathname)) return
        if (await handleLocalDataApi(request, response, pathname)) return
        next()
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
