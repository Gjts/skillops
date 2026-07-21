import { analyzeCandidateSkill } from './evaluations/candidate-source.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalBrowserRequest, readEvaluationJsonBody } from './evaluations/request-guard.mjs'
import { chatWithSkillOps, runSkillABTest } from './evaluations/session-evaluator.mjs'
import { handleManagedEvaluationApi } from './evaluations/suite-api.mjs'
import { handleGovernanceApi } from './governance/governance-api.mjs'
import { handlePromptRegistryApi } from './prompts/prompt-registry-api.mjs'
import { EvaluationSchemaError, normalizeEvaluationApiBody } from '../shared/evaluation-schema.mjs'

export { analyzeCandidateSkill, compareSkillDefinitions, discoverGithubSkill } from './evaluations/candidate-source.mjs'
export { EvaluationError } from './evaluations/errors.mjs'
export { callLlmProvider } from './evaluations/provider-client.mjs'
export { chatWithSkillOps, runSkillABTest } from './evaluations/session-evaluator.mjs'
export { createManagedEvaluationServices, initializeManagedEvaluationServices } from './evaluations/suite-api.mjs'

export async function handleEvaluationApi(request, response, pathname, options = {}) {
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
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
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
    response.statusCode = error instanceof EvaluationError || error instanceof EvaluationSchemaError ? error.status : 500
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Evaluation request failed' }))
  }
  return true
}
