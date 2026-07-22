import { normalizeManagedEvaluationRunRequest } from '../../shared/evaluation-schema.mjs'
import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createArtifactResolver } from './artifact-resolver.mjs'
import { createEvaluationManager } from './evaluation-manager.mjs'
import { createEvaluationStore } from './evaluation-store.mjs'
import { createEvaluationReport, renderEvaluationHtmlReport } from './evaluation-report.mjs'
import { EvaluationError } from './errors.mjs'
import { normalizeProvider } from './provider-client.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from './request-guard.mjs'
import { createSuiteRegistry } from './suite-registry.mjs'

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}

function routeId(pathname, suffix = '') {
  const match = pathname.match(new RegExp(`^/api/evaluation-runs/([^/]+)${suffix}$`))
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { throw new EvaluationError('Evaluation run ID is invalid.', 422) }
}

function query(request) {
  return new URL(request.url || '/', 'http://127.0.0.1').searchParams
}

function pageCases(cases, search) {
  const limit = Math.min(100, Math.max(1, Number(search.get('limit')) || 20))
  const cursor = search.get('cursor')
  const start = cursor ? cases.findIndex((item) => item.id === cursor) + 1 : 0
  const available = cursor && start === 0 ? [] : cases.slice(start)
  const items = available.slice(0, limit)
  return { items, nextCursor: available.length > limit ? items.at(-1).id : null }
}

function publicSuite(suite) {
  return {
    schemaVersion: suite.schemaVersion,
    id: suite.id,
    name: suite.name,
    version: suite.version,
    owner: suite.owner,
    sensitivity: suite.sensitivity,
    artifactKind: suite.artifactKind,
    repeats: suite.repeats,
    ...(suite.matrix ? { matrix: suite.matrix } : {}),
    caseCount: suite.cases.length,
    suiteHash: suite.suiteHash,
    datasetHash: suite.datasetHash,
    datasetId: suite.datasetId,
    cases: suite.cases.map((testCase) => ({
      id: testCase.id,
      weight: testCase.weight,
      assertions: testCase.assertions.map((assertion) => ({
        label: assertion.label,
        type: assertion.type,
        blocking: assertion.blocking,
      })),
    })),
  }
}

export async function createManagedEvaluationServices(options = {}) {
  const store = options.store || createEvaluationStore(options)
  const suites = options.suites || createSuiteRegistry(options)
  const artifacts = options.artifacts || createArtifactResolver(options)
  const manager = options.manager || createEvaluationManager({ store, runner: options.runner, concurrency: options.concurrency, policy: options.policy })
  await manager.initialize()
  return { store, suites, artifacts, manager }
}

let defaultServicesPromise

export function initializeManagedEvaluationServices(options = {}) {
  if (!defaultServicesPromise) defaultServicesPromise = createManagedEvaluationServices(options)
  return defaultServicesPromise
}

export async function handleManagedEvaluationApi(request, response, pathname, options = {}) {
  const isSuiteList = pathname === '/api/evaluation-suites'
  const suiteMatch = pathname.match(/^\/api\/evaluation-suites\/([^/]+)$/)
  const isRunList = pathname === '/api/evaluation-runs'
  const cancelId = routeId(pathname, '/cancel')
  const casesId = routeId(pathname, '/cases')
  const reportId = routeId(pathname, '/report')
  const runId = !cancelId && !casesId && !reportId ? routeId(pathname) : null
  if (!isSuiteList && !suiteMatch && !isRunList && !cancelId && !casesId && !reportId && !runId) return false
  setJsonApiHeaders(response)
  try {
    const isPost = request.method === 'POST' && (isRunList || Boolean(cancelId))
    assertLocalApiRequest(request, { requireJson: isPost })
    const services = options.managedEvaluationServices || await initializeManagedEvaluationServices(options)
    if (isSuiteList) {
      method(request, 'GET')
      sendJson(response, 200, { items: await services.suites.list() })
    } else if (suiteMatch) {
      method(request, 'GET')
      let suiteId
      try { suiteId = decodeURIComponent(suiteMatch[1]) } catch { throw new EvaluationError('Suite ID is invalid.', 422) }
      sendJson(response, 200, publicSuite(await services.suites.get(suiteId)))
    } else if (isRunList && request.method === 'POST') {
      const body = normalizeManagedEvaluationRunRequest(await readEvaluationJsonBody(request))
      const provider = normalizeProvider(body.provider)
      const suite = await services.suites.get(body.suiteId)
      const [baseline, candidate] = await Promise.all([
        services.artifacts.resolve(body.baselineRef),
        services.artifacts.resolve(body.candidateRef),
      ])
      if (baseline.artifact.kind !== suite.artifactKind || candidate.artifact.kind !== suite.artifactKind) {
        throw new EvaluationError('Suite artifact kind does not match the selected baseline and candidate.', 422)
      }
      const created = await services.manager.enqueue({ ...body, requestedBy: options.teamPrincipal?.id || body.requestedBy, suite, baseline, candidate, provider })
      sendJson(response, 202, { run: created.summary, reused: created.reused })
    } else if (isRunList) {
      method(request, 'GET')
      const search = query(request)
      sendJson(response, 200, await services.store.listRuns({
        status: search.get('status') || undefined,
        suiteId: search.get('suiteId') || undefined,
        capabilityId: search.get('capabilityId') || undefined,
        limit: search.get('limit') || undefined,
        cursor: search.get('cursor') || undefined,
      }))
    } else if (cancelId) {
      method(request, 'POST')
      await readEvaluationJsonBody(request)
      const cancelled = await services.manager.cancel(cancelId)
      sendJson(response, 200, cancelled)
    } else if (reportId) {
      method(request, 'GET')
      const run = await services.store.getRun(reportId)
      if (!run) throw new EvaluationError('Evaluation run was not found.', 404)
      const cases = await services.store.getCases(reportId)
      const format = query(request).get('format') || 'json'
      if (format === 'json') {
        sendJson(response, 200, createEvaluationReport(run, cases))
      } else if (format === 'html') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        response.statusCode = 200
        response.end(renderEvaluationHtmlReport(run, cases))
      } else {
        throw new EvaluationError('Report format must be json or html.', 422)
      }
    } else if (casesId) {
      method(request, 'GET')
      if (!await services.store.getRun(casesId)) throw new EvaluationError('Evaluation run was not found.', 404)
      sendJson(response, 200, pageCases(await services.store.getCases(casesId), query(request)))
    } else {
      method(request, 'GET')
      const run = await services.store.getRun(runId)
      if (!run) throw new EvaluationError('Evaluation run was not found.', 404)
      sendJson(response, 200, run)
    }
  } catch (error) {
    sendApiError(response, error, 'Evaluation request failed.')
  }
  return true
}
