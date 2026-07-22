import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createArtifactResolver } from '../evaluations/artifact-resolver.mjs'
import { createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from '../evaluations/request-guard.mjs'
import { createTeamControlPlane } from '../team-control-plane.mjs'
import { createGovernanceService } from './governance-service.mjs'
import { resolveAuthenticatedGovernancePrincipal, resolveGovernancePrincipal } from './principal.mjs'

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
  const match = pathname.match(/^\/api\/capabilities\/([^/]+)(?:\/(evaluate|approve|canary|install|promote|deprecate|rollback))?$/)
  if (!match) return null
  try { return { id: decodeURIComponent(match[1]), action: match[2] || null } } catch { throw new EvaluationError('Capability ID is invalid.', 422) }
}

export async function createGovernanceServices(options = {}) {
  const evaluations = options.evaluations || createEvaluationStore(options)
  const artifacts = options.artifacts || createArtifactResolver(options)
  const teamControlPlane = options.teamControlPlane || createTeamControlPlane(options)
  const governance = options.governance || createGovernanceService({
    ...options,
    evaluations,
    artifacts,
    resolveGatePolicy: options.resolveGatePolicy || teamControlPlane.resolveGatePolicy,
    resolveProjectRoot: options.resolveProjectRoot || teamControlPlane.resolveProjectRoot,
  })
  await governance.initialize?.()
  return { governance, artifacts, teamControlPlane }
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
  const auditRoute = pathname === '/api/governance-audit'
  if (!collection && !route && !lockRoute && !auditRoute) return false
  setJsonApiHeaders(response)
  try {
    const post = request.method === 'POST'
    assertLocalApiRequest(request, { requireJson: post })
    const { governance, artifacts, teamControlPlane } = options.governanceServices || await initializeGovernanceServices(options)
    let principal = post ? await resolveGovernancePrincipal(request, options) : null
    const authorize = async (minimumRole) => {
      if (!teamControlPlane?.authorize) return
      principal ||= await resolveGovernancePrincipal(request, options)
      await teamControlPlane.authorize(principal, minimumRole)
    }
    if (auditRoute) {
      method(request, 'GET')
      principal = await resolveAuthenticatedGovernancePrincipal(request, options)
      await authorize('Viewer')
      sendJson(response, 200, { items: await governance.listAudit() })
    } else if (collection && request.method === 'GET') {
      await authorize('Viewer')
      sendJson(response, 200, { items: await governance.list() })
    } else if (collection) {
      method(request, 'POST')
      await authorize('Developer')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['artifact', 'sourceRef', 'baseline', 'targetSkeleton', 'projectId', 'policyId']), 'Capability nomination')
      const targetSkeleton = body.targetSkeleton || (body.sourceRef?.startsWith('local-scan:') ? body.sourceRef : null)
      if (!targetSkeleton) throw new EvaluationError('Capability nomination requires an explicit target skeleton.', 422)
      if (Boolean(body.artifact) === Boolean(body.sourceRef)) throw new EvaluationError('Capability nomination requires exactly one artifact or sourceRef.', 422)
      const resolved = body.sourceRef ? await artifacts.resolve(body.sourceRef) : null
      const result = await governance.nominate({
        artifact: resolved?.artifact || body.artifact,
        ...(body.baseline ? { baseline: body.baseline } : {}),
        ...(body.policyId ? { policyId: body.policyId } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        owner: principal.id,
        ownerIdentityAssurance: principal.assurance,
        targetSkeleton,
      })
      sendJson(response, result.reused ? 200 : 201, result)
    } else if (lockRoute) {
      method(request, 'GET')
      principal = await resolveAuthenticatedGovernancePrincipal(request, options)
      await authorize('Viewer')
      sendJson(response, 200, await governance.lockState())
    } else if (!route.action) {
      method(request, 'GET')
      await authorize('Viewer')
      sendJson(response, 200, await governance.get(route.id))
    } else {
      method(request, 'POST')
      if (route.action === 'evaluate') {
        const capability = await governance.get(route.id)
        await authorize(capability?.stage === 'canary' ? 'Maintainer' : 'Developer')
      } else {
        await authorize(route.action === 'approve' ? 'Reviewer' : ['canary', 'install', 'promote', 'deprecate', 'rollback'].includes(route.action) ? 'Maintainer' : 'Developer')
      }
      const body = await readEvaluationJsonBody(request)
      if (route.action === 'evaluate') {
        onlyKeys(body, new Set(['runId', 'redteamRunId']), 'Evidence binding request')
        sendJson(response, 200, await governance.bindEvidence(route.id, { ...body, actor: principal.id }))
      } else if (route.action === 'approve') {
        onlyKeys(body, new Set(['decision']), 'Approval request')
        sendJson(response, 200, await governance.approve(route.id, {
          ...body,
          reviewer: principal.id,
          reviewerIdentityAssurance: principal.assurance,
        }))
      } else {
        const actions = {
          canary: ['previewCanary', 'canary'],
          install: ['previewInstallation', 'install'],
          promote: ['previewPromotion', 'promote'],
          deprecate: ['previewDeprecation', 'deprecate'],
          rollback: ['previewRollback', 'rollback'],
        }
        const methods = actions[route.action]
        const allowed = new Set(['action', 'previewToken', 'confirm', ...(route.action === 'canary' ? ['targetSkeleton', 'projectRoot'] : [])])
        onlyKeys(body, allowed, 'Release request')
        if (body.action === 'preview') {
          sendJson(response, 200, await governance[methods[0]](route.id, route.action === 'canary'
            ? { targetSkeleton: body.targetSkeleton, projectRoot: body.projectRoot }
            : undefined))
        } else if (body.action === 'apply') {
          sendJson(response, 200, await governance[methods[1]](route.id, { ...body, actor: principal.id }))
        }
        else throw new EvaluationError('Release action must be preview or apply.', 422)
      }
    }
  } catch (error) {
    sendApiError(response, error, 'Governance request failed.')
  }
  return true
}
