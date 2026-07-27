import { EvaluationSchemaError, normalizeManagedEvaluationRunRequest } from '../../shared/evaluation-schema.mjs'
import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createPageEnvelope } from '../page-envelope.mjs'
import { createArtifactResolver } from './artifact-resolver.mjs'
import { createEvaluationManager } from './evaluation-manager.mjs'
import { createEvaluationStore } from './evaluation-store.mjs'
import { DEFAULT_GATE_POLICY, effectiveGatePolicy, gatePolicyHash } from '../governance/capability-policy.mjs'
import { createEvaluationReport, renderEvaluationHtmlReport } from './evaluation-report.mjs'
import { EvaluationError } from './errors.mjs'
import { normalizeProvider } from './provider-client.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from './request-guard.mjs'
import { createSuiteRegistry } from './suite-registry.mjs'

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function publicManagedEvaluationError(error) {
  if ((error instanceof EvaluationError || error instanceof EvaluationSchemaError)
      && error.message.includes(' contains unsupported field: ')) {
    return new EvaluationError('Evaluation request contains unsupported fields.', error.status)
  }
  return error
}

function routeId(pathname, suffix = '') {
  const match = pathname.match(new RegExp(`^/api/evaluation-runs/([^/]+)${suffix}$`))
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { throw new EvaluationError('Evaluation run ID is invalid.', 422) }
}

function decisionRouteId(pathname) {
  const match = pathname.match(/^\/api\/evaluations\/([^/]+)\/decision$/)
  if (!match) return routeId(pathname, '/decision')
  try { return decodeURIComponent(match[1]) } catch { throw new EvaluationError('Evaluation run ID is invalid.', 422) }
}

function query(request) {
  return new URL(request.url || '/', 'http://127.0.0.1').searchParams
}

function compareSuites(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
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
    ...(suite.gate ? { gate: suite.gate } : {}),
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

function publicRun(run, policyHash) {
  if (!run || policyHash === undefined) return run
  return {
    ...run,
    evidenceFresh: run.status === 'completed' && Boolean(run.policyHash)
      ? Boolean(policyHash) && run.policyHash === policyHash
      : null,
  }
}

function suitePolicyHash(services, suite) {
  return services.policy
    ? gatePolicyHash(effectiveGatePolicy(services.policy, suite?.gate))
    : services.policyHash
}

async function runPolicyHash(services, run) {
  if (!services.policy || !run?.suiteId) return services.policyHash
  try {
    return suitePolicyHash(services, await services.suites.get(run.suiteId))
  } catch (error) {
    if (error instanceof EvaluationError && error.status === 404) return null
    throw error
  }
}

function passedRequiredGate(run, id) {
  return run.gates?.some((gate) => gate.id === id && gate.blocking === true && gate.status === 'passed') === true
}

function publicDecision(decision) {
  if (!decision) return null
  return {
    decisionId: decision.decisionId,
    evaluationRunId: decision.evaluationRunId,
    artifactId: decision.artifactId,
    candidateRefHash: decision.candidateRefHash,
    decision: decision.decision,
    recordedAt: decision.recordedAt,
  }
}

export async function createManagedEvaluationServices(options = {}) {
  const store = options.store || createEvaluationStore(options)
  const suites = options.suites || createSuiteRegistry(options)
  const artifacts = options.artifacts || createArtifactResolver(options)
  const policy = options.policy || DEFAULT_GATE_POLICY
  const manager = options.manager || createEvaluationManager({ store, runner: options.runner, concurrency: options.concurrency, policy })
  await manager.initialize()
  return { store, suites, artifacts, manager, policy, policyHash: gatePolicyHash(policy) }
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
  const decisionId = decisionRouteId(pathname)
  const runId = !cancelId && !casesId && !reportId && !decisionId ? routeId(pathname) : null
  if (!isSuiteList && !suiteMatch && !isRunList && !cancelId && !casesId && !reportId && !decisionId && !runId) return false
  setJsonApiHeaders(response)
  try {
    const isPost = request.method === 'POST' && (isRunList || Boolean(cancelId) || Boolean(decisionId))
    assertLocalApiRequest(request, { requireJson: isPost })
    const services = options.managedEvaluationServices || await initializeManagedEvaluationServices(options)
    if (isSuiteList) {
      method(request, 'GET')
      const search = query(request)
      const result = createPageEnvelope(await services.suites.list(), {
        page: search.get('page'),
        pageSize: search.get('pageSize'),
        compare: compareSuites,
      })
      sendJson(response, 200, {
        ...result,
        items: result.items.map((suite) => ({ ...suite, policyHash: suitePolicyHash(services, suite) })),
        generatedAt: new Date().toISOString(),
      })
    } else if (suiteMatch) {
      method(request, 'GET')
      let suiteId
      try { suiteId = decodeURIComponent(suiteMatch[1]) } catch { throw new EvaluationError('Suite ID is invalid.', 422) }
      const suite = await services.suites.get(suiteId)
      sendJson(response, 200, { ...publicSuite(suite), policyHash: suitePolicyHash(services, suite) })
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
      sendJson(response, 202, { run: publicRun(created.summary, suitePolicyHash(services, suite)), reused: created.reused })
    } else if (isRunList) {
      method(request, 'GET')
      const search = query(request)
      const result = await services.store.listRuns({
        status: search.get('status') || undefined,
        suiteId: search.get('suiteId') || undefined,
        capabilityId: search.get('capabilityId') || undefined,
        limit: search.get('limit') || undefined,
        cursor: search.get('cursor') || undefined,
      })
      sendJson(response, 200, {
        ...result,
        items: await Promise.all(result.items.map(async (run) => publicRun(run, await runPolicyHash(services, run)))),
        generatedAt: new Date().toISOString(),
      })
    } else if (cancelId) {
      method(request, 'POST')
      await readEvaluationJsonBody(request)
      const cancelled = await services.manager.cancel(cancelId)
      sendJson(response, 200, { ...cancelled, summary: publicRun(cancelled.summary, await runPolicyHash(services, cancelled.summary)) })
    } else if (decisionId) {
      const run = await services.store.getRun(decisionId)
      if (!run) throw new EvaluationError('Evaluation run was not found.', 404)
      if (request.method === 'POST') {
        const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['decision']), 'Managed evaluation decision')
        if (body.decision === 'create-candidate') {
          const policyHash = await runPolicyHash(services, run)
          if (run.status !== 'completed'
            || run.gateResult !== 'passed'
            || run.policyHash !== policyHash
            || !passedRequiredGate(run, 'sample-size')
            || !passedRequiredGate(run, 'suite-case-coverage')) {
            throw new EvaluationError('Create Candidate requires current evidence that passed the sample-size and Suite case coverage gates.', 409)
          }
        }
        const result = await services.store.appendDecision(decisionId, body.decision)
        const decision = publicDecision(result.decision)
        sendJson(response, result.reused ? 200 : 201, {
          decision,
          reused: result.reused,
          generatedAt: new Date().toISOString(),
          revision: decision.decisionId,
        })
      } else {
        method(request, 'GET')
        const decision = publicDecision(await services.store.getDecision(decisionId))
        sendJson(response, 200, {
          decision,
          generatedAt: new Date().toISOString(),
          revision: decision?.decisionId || null,
        })
      }
    } else if (reportId) {
      method(request, 'GET')
      const run = await services.store.getRun(reportId)
      if (!run) throw new EvaluationError('Evaluation run was not found.', 404)
      const cases = await services.store.getCases(reportId)
      const format = query(request).get('format') || 'json'
      if (format === 'json') {
        const report = createEvaluationReport(run, cases)
        const decision = publicDecision(await services.store.getDecision(reportId))
        sendJson(response, 200, decision ? { ...report, decision } : report)
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
      sendJson(response, 200, {
        ...pageCases(await services.store.getCases(casesId), query(request)),
        generatedAt: new Date().toISOString(),
      })
    } else {
      method(request, 'GET')
      const run = await services.store.getRun(runId)
      if (!run) throw new EvaluationError('Evaluation run was not found.', 404)
      sendJson(response, 200, publicRun(run, await runPolicyHash(services, run)))
    }
  } catch (error) {
    const publicError = error instanceof EvaluationError && error.message.startsWith('Unsupported AI provider: ')
      ? new EvaluationError('Unsupported AI provider.', error.status)
      : publicManagedEvaluationError(error)
    sendApiError(response, publicError, 'Evaluation request failed.')
  }
  return true
}
