import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createArtifactResolver } from '../evaluations/artifact-resolver.mjs'
import { createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from '../evaluations/request-guard.mjs'
import { createGovernanceService } from './governance-service.mjs'

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}

function capabilityRoute(pathname) {
  const match = pathname.match(/^\/api\/capabilities\/([^/]+)(?:\/(evaluate|approve|canary|promote|rollback))?$/)
  if (!match) return null
  try { return { id: decodeURIComponent(match[1]), action: match[2] || null } } catch { throw new EvaluationError('Capability ID is invalid.', 422) }
}

export async function createGovernanceServices(options = {}) {
  const evaluations = options.evaluations || createEvaluationStore(options)
  const artifacts = options.artifacts || createArtifactResolver(options)
  return { governance: options.governance || createGovernanceService({ ...options, evaluations, artifacts }), artifacts }
}

let defaultServicesPromise

export function initializeGovernanceServices(options = {}) {
  if (!defaultServicesPromise) defaultServicesPromise = createGovernanceServices(options)
  return defaultServicesPromise
}

export async function handleGovernanceApi(request, response, pathname, options = {}) {
  const collection = pathname === '/api/capabilities'
  const route = capabilityRoute(pathname)
  const lockRoute = pathname === '/api/project-skeleton-lock'
  if (!collection && !route && !lockRoute) return false
  setJsonApiHeaders(response)
  try {
    const post = request.method === 'POST'
    assertLocalApiRequest(request, { requireJson: post })
    const { governance, artifacts } = options.governanceServices || await initializeGovernanceServices(options)
    if (collection && request.method === 'GET') sendJson(response, 200, { items: await governance.list() })
    else if (collection) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['artifact', 'sourceRef', 'baseline', 'owner', 'targetSkeleton', 'policyId']), 'Capability nomination')
      if (Boolean(body.artifact) === Boolean(body.sourceRef)) throw new EvaluationError('Capability nomination requires exactly one artifact or sourceRef.', 422)
      const resolved = body.sourceRef ? await artifacts.resolve(body.sourceRef) : null
      const result = await governance.nominate({
        ...body,
        artifact: resolved?.artifact || body.artifact,
        targetSkeleton: body.targetSkeleton || body.sourceRef,
      })
      sendJson(response, result.reused ? 200 : 201, result)
    } else if (lockRoute) {
      method(request, 'GET')
      sendJson(response, 200, await governance.lockState())
    } else if (!route.action) {
      method(request, 'GET')
      sendJson(response, 200, await governance.get(route.id))
    } else {
      method(request, 'POST')
      const body = await readEvaluationJsonBody(request)
      if (route.action === 'evaluate') {
        onlyKeys(body, new Set(['runId', 'redteamRunId']), 'Evidence binding request')
        sendJson(response, 200, await governance.bindEvidence(route.id, body))
      } else if (route.action === 'approve') {
        onlyKeys(body, new Set(['reviewer', 'decision', 'note']), 'Approval request')
        sendJson(response, 200, await governance.approve(route.id, body))
      } else if (route.action === 'canary') {
        onlyKeys(body, new Set(), 'Canary request')
        sendJson(response, 200, await governance.canary(route.id))
      } else if (route.action === 'promote') {
        onlyKeys(body, new Set(['action', 'previewToken', 'confirm']), 'Promotion request')
        if (body.action === 'preview') sendJson(response, 200, await governance.previewPromotion(route.id))
        else if (body.action === 'apply') sendJson(response, 200, await governance.promote(route.id, body))
        else throw new EvaluationError('Promotion action must be preview or apply.', 422)
      } else if (route.action === 'rollback') {
        onlyKeys(body, new Set(['action', 'previewToken', 'confirm']), 'Rollback request')
        if (body.action === 'preview') sendJson(response, 200, await governance.previewRollback(route.id))
        else if (body.action === 'apply') sendJson(response, 200, await governance.rollback(route.id, body))
        else throw new EvaluationError('Rollback action must be preview or apply.', 422)
      }
    }
  } catch (error) {
    sendApiError(response, error, 'Governance request failed.')
  }
  return true
}
