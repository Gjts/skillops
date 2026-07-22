import { EvaluationSchemaError, normalizeEvaluationApiBody } from '../shared/evaluation-schema.mjs'
import { AiSettingsError, readAiSettings, writeAiSettings } from './ai-settings-store.mjs'
import { handleConflictApi } from './conflicts/conflict-api.mjs'
import { handleArtifactRegistryApi } from './evaluations/artifact-registry-api.mjs'
import { analyzeCandidateSkill } from './evaluations/candidate-source.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest, assertLocalBrowserRequest, readEvaluationJsonBody } from './evaluations/request-guard.mjs'
import { chatWithSkillOps, runSkillABTest } from './evaluations/session-evaluator.mjs'
import { handleManagedEvaluationApi } from './evaluations/suite-api.mjs'
import { handleGovernanceApi, initializeGovernanceServices } from './governance/governance-api.mjs'
import { resolveGovernancePrincipal } from './governance/principal.mjs'
import { handlePromptRegistryApi } from './prompts/prompt-registry-api.mjs'
import { handlePromptHubApi } from './prompts/prompthub-api.mjs'
import { handleTeamControlPlaneApi, initializeTeamControlPlane } from './team-control-plane-api.mjs'

const MAX_AI_SETTINGS_REQUEST_BYTES = 64_000

function minimumTeamRole(pathname, requestMethod) {
  if (pathname === '/api/ai-settings' || pathname === '/api/connectors/prompthub/credential') return 'Owner'
  if (/^\/api\/capabilities\/[^/]+\/approve$/.test(pathname)) return 'Reviewer'
  if (/^\/api\/capabilities\/[^/]+\/(?:canary|install|promote|deprecate|rollback)$/.test(pathname)
      || pathname === '/api/connectors/prompthub/publish'
      || requestMethod !== 'GET' && (pathname.startsWith('/api/conflicts') || pathname.startsWith('/api/artifacts/migration'))) {
    return 'Maintainer'
  }
  return requestMethod === 'GET' ? 'Viewer' : 'Developer'
}

async function authorizeTeamApiRequest(request, response, pathname, options) {
  if (!options.teamControlPlane || !pathname.startsWith('/api/') || pathname.startsWith('/api/team')) return options
  try {
    const principal = await resolveGovernancePrincipal(request, options)
    const member = await options.teamControlPlane.authorize(principal, minimumTeamRole(pathname, request.method))
    return member ? { ...options, teamPrincipal: principal } : options
  } catch (error) {
    const mapped = evaluationHttpError(error)
    setJsonHeaders(response)
    response.statusCode = mapped.status
    response.end(JSON.stringify({ error: mapped.message }))
    return null
  }
}

export { createArtifactRegistry } from './evaluations/artifact-registry.mjs'
export { analyzeCandidateSkill, compareSkillDefinitions, discoverGithubSkill } from './evaluations/candidate-source.mjs'
export { EvaluationError } from './evaluations/errors.mjs'
export { callLlmProvider } from './evaluations/provider-client.mjs'
export { chatWithSkillOps, runSkillABTest } from './evaluations/session-evaluator.mjs'
export { createManagedEvaluationServices, initializeManagedEvaluationServices } from './evaluations/suite-api.mjs'
export { initializeGovernanceServices, initializeTeamControlPlane }

function requestHeader(request, name) {
  const headers = request.headers
  if (headers?.get) return headers.get(name)
  return headers?.[name.toLowerCase()]
}

async function readAiSettingsJsonBody(request) {
  const declaredLength = Number(requestHeader(request, 'content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AI_SETTINGS_REQUEST_BYTES) {
    throw new EvaluationError('Evaluation request body exceeds the 64 KB limit.', 413)
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_AI_SETTINGS_REQUEST_BYTES) throw new EvaluationError('Evaluation request body exceeds the 64 KB limit.', 413)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new EvaluationError('Evaluation request body must contain valid JSON.')
  }
}

function setJsonHeaders(response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function evaluationHttpError(error) {
  if (error instanceof EvaluationError || error instanceof EvaluationSchemaError || error instanceof AiSettingsError) {
    return { status: error.status || 400, message: error.message }
  }
  if (typeof error?.status === 'number' && error.status >= 400 && error.status < 600) {
    return { status: error.status, message: error instanceof Error ? error.message : 'Evaluation request failed' }
  }
  return { status: 500, message: error instanceof Error ? error.message : 'Evaluation request failed' }
}

async function handleAiSettingsApi(request, response, pathname, options) {
  if (pathname !== '/api/ai-settings') return false
  setJsonHeaders(response)
  try {
    if (request.method === 'GET') {
      assertLocalApiRequest(request)
      const read = options.readAiSettings || readAiSettings
      response.end(JSON.stringify(await read()))
      return true
    }
    if (request.method === 'PUT') {
      assertLocalApiRequest(request, { requireJson: true })
      const write = options.writeAiSettings || writeAiSettings
      response.end(JSON.stringify(await write(await readAiSettingsJsonBody(request))))
      return true
    }
    response.statusCode = 405
    response.end(JSON.stringify({ error: 'Method not allowed' }))
  } catch (error) {
    const mapped = evaluationHttpError(error)
    response.statusCode = mapped.status
    response.end(JSON.stringify({ error: mapped.message }))
  }
  return true
}

export async function handleEvaluationApi(request, response, pathname, options = {}) {
  const authorizedOptions = await authorizeTeamApiRequest(request, response, pathname, options)
  if (!authorizedOptions) return true
  options = authorizedOptions
  if (await handleConflictApi(request, response, pathname)) return true
  if (await handleArtifactRegistryApi(request, response, pathname, options)) return true
  if (await handleAiSettingsApi(request, response, pathname, options)) return true
  if (await handlePromptRegistryApi(request, response, pathname, options)) return true
  if (await handlePromptHubApi(request, response, pathname, options)) return true
  if (await handleManagedEvaluationApi(request, response, pathname, options)) return true
  if (await handleGovernanceApi(request, response, pathname, options)) return true
  if (await handleTeamControlPlaneApi(request, response, pathname, options)) return true
  const handlers = {
    '/api/evaluations/compare': analyzeCandidateSkill,
    '/api/evaluations/run': runSkillABTest,
    '/api/assistant/chat': chatWithSkillOps,
  }
  const handler = handlers[pathname]
  if (!handler) return false
  setJsonHeaders(response)
  if (request.method !== 'POST') {
    response.statusCode = 405
    response.end(JSON.stringify({ error: 'Method not allowed' }))
    return true
  }
  try {
    assertLocalBrowserRequest(request)
    const body = normalizeEvaluationApiBody(pathname, await readEvaluationJsonBody(request))
    response.end(JSON.stringify(await handler(body, options)))
  } catch (error) {
    const mapped = evaluationHttpError(error)
    response.statusCode = mapped.status
    response.end(JSON.stringify({ error: mapped.message }))
  }
  return true
}
