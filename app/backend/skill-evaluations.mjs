import { EvaluationSchemaError, normalizeEvaluationApiBody } from '../shared/evaluation-schema.mjs'
import { AiSettingsError, readAiSettings, writeAiSettings } from './ai-settings-store.mjs'
import { analyzeCandidateSkill } from './evaluations/candidate-source.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest, assertLocalBrowserRequest, readEvaluationJsonBody } from './evaluations/request-guard.mjs'
import { chatWithSkillOps, runSkillABTest } from './evaluations/session-evaluator.mjs'
import { handleManagedEvaluationApi } from './evaluations/suite-api.mjs'
import { handleGovernanceApi } from './governance/governance-api.mjs'
import { handlePromptRegistryApi } from './prompts/prompt-registry-api.mjs'

const MAX_AI_SETTINGS_REQUEST_BYTES = 64_000

export { analyzeCandidateSkill, compareSkillDefinitions, discoverGithubSkill } from './evaluations/candidate-source.mjs'
export { EvaluationError } from './evaluations/errors.mjs'
export { callLlmProvider } from './evaluations/provider-client.mjs'
export { chatWithSkillOps, runSkillABTest } from './evaluations/session-evaluator.mjs'
export { createManagedEvaluationServices, initializeManagedEvaluationServices } from './evaluations/suite-api.mjs'

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
  if (await handleAiSettingsApi(request, response, pathname, options)) return true
  if (await handlePromptRegistryApi(request, response, pathname, options)) return true
  if (await handleManagedEvaluationApi(request, response, pathname, options)) return true
  if (await handleGovernanceApi(request, response, pathname, options)) return true
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
