import { sendApiError, sendJson, setJsonApiHeaders } from './api-response.mjs'
import { initializeArtifactRegistry } from './evaluations/artifact-registry-api.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from './evaluations/request-guard.mjs'
import { initializeGovernanceServices } from './governance/governance-api.mjs'
import { resolveGovernancePrincipal } from './governance/principal.mjs'
import { createTeamControlPlane } from './team-control-plane.mjs'

const ENTITY_FIELDS = Object.freeze({
  workspace: new Set(['id', 'name']),
  project: new Set(['id', 'workspaceId', 'name', 'projectRoot', 'repository', 'artifactIds', 'template']),
  environment: new Set(['id', 'projectId', 'name', 'channel']),
  member: new Set(['id', 'displayName', 'role', 'status']),
  policyPack: new Set(['id', 'version', 'sourceRef', 'contentHash', 'gatePolicy']),
})
const PROJECT_TEMPLATE_FIELDS = new Set(['id', 'version', 'status', 'candidateVersion'])

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}

function header(request, name) {
  return request.headers?.get ? request.headers.get(name) : request.headers?.[name.toLowerCase()]
}

function bearerToken(request) {
  const authorization = header(request, 'authorization')
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i) : null
  if (!match) throw new EvaluationError('Collector credentials are required.', 403)
  return match[1]
}

function route(pathname, expression) {
  const match = pathname.match(expression)
  if (!match) return null
  try { return match.slice(1).map(decodeURIComponent) } catch { throw new EvaluationError('Team route is invalid.', 422) }
}

let defaultTeamControlPlanePromise
export function initializeTeamControlPlane(options = {}) {
  if (!defaultTeamControlPlanePromise) {
    defaultTeamControlPlanePromise = (async () => {
      const artifactRegistry = options.artifactRegistry || initializeArtifactRegistry(options)
      const { governance } = options.governanceServices || await initializeGovernanceServices(options)
      return createTeamControlPlane({ ...options, artifactRegistry, governance })
    })()
  }
  return defaultTeamControlPlanePromise
}

export async function handleTeamControlPlaneApi(request, response, pathname, options = {}) {
  if (!pathname.startsWith('/api/team')) return false
  const entityRoute = route(pathname, /^\/api\/team\/entities\/(workspace|project|environment|member|policyPack)(?:\/([^/]+))?$/)
  const revokeRoute = route(pathname, /^\/api\/team\/devices\/([^/]+)\/revoke$/)
  const exceptionReviewRoute = route(pathname, /^\/api\/team\/exceptions\/([^/]+)\/review$/)
  const known = new Set([
    '/api/team', '/api/team/catalog', '/api/team/queues', '/api/team/devices', '/api/team/collector',
    '/api/team/exceptions', '/api/team/audit', '/api/team/export', '/api/team/backup', '/api/team/restore', '/api/team/retention',
  ])
  if (!known.has(pathname) && !entityRoute && !revokeRoute && !exceptionReviewRoute) return false
  setJsonApiHeaders(response)
  try {
    const mutating = request.method !== 'GET'
    assertLocalApiRequest(request, { requireJson: mutating && request.method !== 'DELETE' })
    const controlPlane = options.teamControlPlane || await initializeTeamControlPlane(options)

    if (pathname === '/api/team/collector') {
      method(request, 'POST')
      sendJson(response, 202, await controlPlane.collect(bearerToken(request), await readEvaluationJsonBody(request)))
      return true
    }

    const principal = await resolveGovernancePrincipal(request, options)
    if (pathname === '/api/team') {
      if (request.method === 'GET') sendJson(response, 200, await controlPlane.snapshot(principal))
      else {
        method(request, 'POST')
        const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['id', 'name']), 'Team creation request')
        sendJson(response, 201, await controlPlane.initialize(body, principal))
      }
    } else if (pathname === '/api/team/catalog') {
      method(request, 'GET')
      sendJson(response, 200, { items: await controlPlane.catalog(principal) })
    } else if (pathname === '/api/team/queues') {
      method(request, 'GET')
      sendJson(response, 200, await controlPlane.queues(principal))
    } else if (pathname === '/api/team/audit') {
      method(request, 'GET')
      sendJson(response, 200, { items: await controlPlane.audit(principal) })
    } else if (pathname === '/api/team/export') {
      method(request, 'GET')
      sendJson(response, 200, await controlPlane.exportTeam(principal))
    } else if (pathname === '/api/team/backup') {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Team backup request')
      sendJson(response, 201, await controlPlane.backup(principal))
    } else if (pathname === '/api/team/restore') {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['file']), 'Team restore request')
      sendJson(response, 200, await controlPlane.restoreBackup(body.file, principal))
    } else if (pathname === '/api/team/retention') {
      method(request, 'PUT')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['days']), 'Team retention request')
      sendJson(response, 200, await controlPlane.applyRetention(body.days, principal))
    } else if (pathname === '/api/team/devices') {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['id', 'name', 'memberId']), 'Device registration request')
      sendJson(response, 201, await controlPlane.registerDevice(body, principal))
    } else if (revokeRoute) {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Device revocation request')
      sendJson(response, 200, await controlPlane.revokeDevice(revokeRoute[0], principal))
    } else if (pathname === '/api/team/exceptions') {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['id', 'projectId', 'policyId', 'reason']), 'Policy exception request')
      sendJson(response, 201, await controlPlane.requestException(body, principal))
    } else if (exceptionReviewRoute) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['decision']), 'Policy exception review')
      sendJson(response, 200, await controlPlane.reviewException(exceptionReviewRoute[0], body.decision, principal))
    } else if (entityRoute) {
      const [kind, entityId] = entityRoute
      if (request.method === 'PUT') {
        const body = onlyKeys(await readEvaluationJsonBody(request), ENTITY_FIELDS[kind], `Team ${kind} request`)
        if (kind === 'project' && body.template !== undefined && body.template !== null) onlyKeys(body.template, PROJECT_TEMPLATE_FIELDS, 'Project Template status')
        if (entityId && body?.id !== undefined && body.id !== entityId) throw new EvaluationError('Team entity route and body IDs do not match.', 422)
        sendJson(response, 200, await controlPlane.saveEntity(kind, { ...body, ...(entityId ? { id: entityId } : {}) }, principal))
      } else {
        method(request, 'DELETE')
        if (!entityId) throw new EvaluationError('Team entity ID is required.', 422)
        sendJson(response, 200, await controlPlane.removeEntity(kind, entityId, principal))
      }
    }
  } catch (error) {
    sendApiError(response, error, 'Team control-plane request failed.')
  }
  return true
}
