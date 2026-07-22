import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { initializeGovernanceServices } from '../governance/governance-api.mjs'
import { resolveGovernancePrincipal } from '../governance/principal.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from '../evaluations/request-guard.mjs'
import { promptRegistry } from './prompt-registry.mjs'

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function required(value, label, maxLength = 4_000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError(`${label} is invalid.`, 422)
  }
  return value.trim()
}

function optional(value, label, maxLength = 200) {
  if (value === undefined || value === null || value === '') return undefined
  return required(value, label, maxLength)
}

export async function handlePromptRegistryApi(request, response, pathname, options = {}) {
  const statusRoute = pathname === '/api/prompt-registry/status'
  const listRoute = pathname === '/api/prompt-registry/prompts'
  const compareRoute = pathname === '/api/prompt-registry/compare'
  const nominateRoute = pathname === '/api/prompt-registry/nominate'
  if (!statusRoute && !listRoute && !compareRoute && !nominateRoute) return false
  setJsonApiHeaders(response)
  try {
    const post = request.method === 'POST'
    assertLocalApiRequest(request, { requireJson: post })
    const registry = options.promptRegistry || promptRegistry(options)
    if (statusRoute) {
      if (request.method !== 'GET') throw new EvaluationError('Method not allowed.', 405)
      sendJson(response, 200, await registry.status())
    } else if (listRoute) {
      if (!post) throw new EvaluationError('Method not allowed.', 405)
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['revision', 'search', 'provider', 'model']), 'Prompt Registry list')
      sendJson(response, 200, await registry.list({
        revision: optional(body.revision, 'Prompt Registry revision'),
        search: optional(body.search, 'Prompt search'),
        provider: optional(body.provider, 'Prompt provider'),
        model: optional(body.model, 'Prompt model'),
      }))
    } else if (compareRoute) {
      if (!post) throw new EvaluationError('Method not allowed.', 405)
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['leftRef', 'rightRef']), 'Prompt Registry comparison')
      sendJson(response, 200, await registry.compare(required(body.leftRef, 'Left Prompt reference'), required(body.rightRef, 'Right Prompt reference')))
    } else {
      if (!post) throw new EvaluationError('Method not allowed.', 405)
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['sourceRef', 'targetSkeleton', 'projectId']), 'Prompt Candidate nomination')
      const principal = await resolveGovernancePrincipal(request, options)
      const record = await registry.resolveArtifact(required(body.sourceRef, 'Prompt reference'))
      const { governance, teamControlPlane } = options.governanceServices || await initializeGovernanceServices(options)
      await teamControlPlane?.authorize?.(principal, 'Developer')
      const result = await governance.nominate({
        artifact: record.artifact,
        owner: principal.id,
        ownerIdentityAssurance: principal.assurance,
        ...(body.projectId ? { projectId: required(body.projectId, 'Project ID', 200) } : {}),
        targetSkeleton: required(body.targetSkeleton, 'Target reference', 4_000),
      })
      sendJson(response, result.reused ? 200 : 201, result)
    }
  } catch (error) {
    sendApiError(response, error, 'Prompt Registry request failed.')
  }
  return true
}
