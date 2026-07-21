import type { AiProviderId } from '../../../../shared/ai-provider-catalog.mjs'
import type { CandidateAnalysis, CandidateSummary, QuickEvaluationMode, QuickEvaluationResult, SkillMatch } from '../types'
import type { ReasoningEffort } from './ai-settings'

export interface EvaluationProviderRequest {
  provider: AiProviderId
  apiKey: string
  model: string
  baseUrl: string
  apiVersion?: string
  reasoningEffort: ReasoningEffort
}

export interface CompareCandidateRequest {
  sourceUrl: string
  candidatePath?: string
}

export interface RunQuickEvaluationRequest {
  sourceUrl: string
  candidatePath: string
  candidateContentHash: string
  baselineSourcePath: string
  mode: QuickEvaluationMode
  task: string
  criteria: string
  provider: EvaluationProviderRequest
}

export interface AssistantRequest {
  provider: EvaluationProviderRequest
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  context: {
    task?: string
    criteria?: string
    candidate?: CandidateSummary
    match?: SkillMatch
    evaluation?: {
      winner: QuickEvaluationResult['winner']
      reason: string
      baselineScore: number
      candidateScore: number
      baselineOutput: string
      candidateOutput: string
    }
  }
}

interface ApiErrorBody {
  error?: string | { message?: string }
}

async function postJson<TResponse, TRequest>(url: string, body: TRequest): Promise<TResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json() as TResponse & ApiErrorBody
  if (!response.ok) {
    const message = typeof result.error === 'string' ? result.error : result.error?.message
    throw new Error(message || `Local API returned ${response.status}.`)
  }
  return result
}

export const evaluationApi = {
  compare(request: CompareCandidateRequest) {
    return postJson<CandidateAnalysis, CompareCandidateRequest>('/api/evaluations/compare', request)
  },
  run(request: RunQuickEvaluationRequest) {
    return postJson<QuickEvaluationResult, RunQuickEvaluationRequest>('/api/evaluations/run', request)
  },
  chat(request: AssistantRequest) {
    return postJson<{ message: string }, AssistantRequest>('/api/assistant/chat', request)
  },
}
