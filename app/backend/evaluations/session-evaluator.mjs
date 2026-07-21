import { runEvaluationAgent } from '../evaluation-agent.mjs'
import { scanInstalledSkills } from '../skill-scanner.mjs'
import { aiProviderDefinition } from '../../shared/ai-provider-catalog.mjs'
import { renderArtifactEvaluationPrompt } from './artifact-definition.mjs'
import { discoverCandidateArtifact, installedDefinitions } from './candidate-source.mjs'
import { EvaluationError, optionalString, requiredString } from './errors.mjs'
import { blindJudgeMessages, parseBlindJudgeResult, stableBlindSwap } from './evaluation-judge.mjs'
import { callLlmProvider, normalizeProvider } from './provider-client.mjs'
import { runPromptfooQuickCompare } from './promptfoo-runner.mjs'

const MAX_TASK_CHARS = 12_000
const MAX_CRITERIA_CHARS = 6_000
const MAX_CHAT_MESSAGES = 24
const MAX_CHAT_MESSAGE_CHARS = 8_000

function resultSummary(run, score, definition, durationMs) {
  return {
    skillId: definition.skillId,
    skillVersion: definition.skillVersion,
    score,
    durationMs,
    tokens: run.usage.totalTokens,
    output: run.content,
  }
}

export async function runSkillABTest(body, options = {}) {
  if (!body || typeof body !== 'object') throw new EvaluationError('A JSON request body is required.')
  const task = requiredString(body.task, 'Evaluation task', MAX_TASK_CHARS)
  const criteria = requiredString(body.criteria, 'Acceptance criteria', MAX_CRITERIA_CHARS)
  const baselineSourcePath = requiredString(body.baselineSourcePath, 'Baseline Skill', 4_000)
  const candidateContentHash = requiredString(body.candidateContentHash, 'Candidate content hash', 64)
  if (!/^[a-f0-9]{64}$/.test(candidateContentHash)) throw new EvaluationError('Candidate content hash must be a SHA-256 digest.')
  const mode = body.mode === undefined ? 'prompt-only' : requiredString(body.mode, 'Evaluation mode', 20)
  if (!['prompt-only', 'agent'].includes(mode)) throw new EvaluationError('Evaluation mode must be prompt-only or agent.')
  const providerConfig = normalizeProvider(body.provider)
  const engine = options.engine || (options.callProvider ? 'legacy' : process.env.SKILLOPS_EVALUATION_ENGINE || 'promptfoo')
  if (!['legacy', 'promptfoo'].includes(engine)) throw new EvaluationError('Evaluation engine must be legacy or promptfoo.', 422)
  const [remote, installed] = await Promise.all([
    discoverCandidateArtifact({ sourceUrl: body.sourceUrl, candidatePath: optionalString(body.candidatePath) }, options),
    installedDefinitions(options),
  ])
  if (remote.definition.contentHash !== candidateContentHash) {
    throw new EvaluationError('The candidate changed since analysis. Analyze it again before running the A/B evaluation.', 409)
  }
  const baseline = installed.find((definition) => definition.sourcePath === baselineSourcePath)
  if (!baseline) throw new EvaluationError('The selected baseline is no longer present in the enabled local inventory.', 404)
  const runId = `eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  if (engine === 'promptfoo') {
    return runPromptfooQuickCompare({
      runId,
      task,
      criteria,
      mode,
      baseline,
      candidate: remote.definition,
      provider: providerConfig,
    }, options)
  }
  const callProvider = options.callProvider || callLlmProvider
  const runVariant = (definition) => mode === 'agent'
    ? runEvaluationAgent(callProvider, providerConfig, renderArtifactEvaluationPrompt(definition, task, criteria), options)
    : callProvider(providerConfig, renderArtifactEvaluationPrompt(definition, task, criteria), { ...options, maxTokens: 1_800 })
  const runTimedVariant = async (definition) => {
    const started = Date.now()
    const run = await runVariant(definition)
    return { run, durationMs: Date.now() - started }
  }
  const { run: baselineRun, durationMs: baselineDuration } = await runTimedVariant(baseline)
  const { run: candidateRun, durationMs: candidateDuration } = await runTimedVariant(remote.definition)
  const swapped = stableBlindSwap(remote.definition.contentHash)
  const answerA = swapped ? candidateRun.content : baselineRun.content
  const answerB = swapped ? baselineRun.content : candidateRun.content
  const judge = await callProvider(providerConfig, blindJudgeMessages(task, criteria, answerA, answerB), { ...options, maxTokens: 700 })
  const judged = parseBlindJudgeResult(judge.content)
  const baselineScore = swapped ? judged.scoreB : judged.scoreA
  const candidateScore = swapped ? judged.scoreA : judged.scoreB
  const winner = judged.winner === 'tie'
    ? 'tie'
    : (judged.winner === 'A') === swapped ? 'candidate' : 'baseline'
  return {
    id: runId,
    createdAt: new Date().toISOString(),
    mode,
    winner,
    reason: judged.reason,
    baseline: resultSummary(baselineRun, baselineScore, baseline, baselineDuration),
    candidate: resultSummary(candidateRun, candidateScore, remote.definition, candidateDuration),
    judge: { tokens: judge.usage.totalTokens, provider: judge.provider, model: judge.model },
    engine: { name: 'skillops-legacy', version: '0.3.1' },
    privacy: 'Task text, acceptance criteria, generated answers, and chat were not written to disk by SkillOps. Saved AI provider settings may exist in local data/ai-settings.json.',
  }
}

function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new EvaluationError('At least one chat message is required.')
  if (messages.length > MAX_CHAT_MESSAGES) throw new EvaluationError(`Chat is limited to ${MAX_CHAT_MESSAGES} messages per request.`)
  return messages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role)) throw new EvaluationError('Chat messages must use user or assistant roles.')
    return { role: message.role, content: requiredString(message.content, 'Chat message', MAX_CHAT_MESSAGE_CHARS) }
  })
}

function contextString(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new EvaluationError(`${label} must be a string.`)
  if (value.length > maxLength) throw new EvaluationError(`${label} is too long.`)
  return value
}

function contextScore(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new EvaluationError(`${label} must be between 0 and 100.`)
  return value
}

function contextSignals(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 12) throw new EvaluationError('Shared signals must contain at most 12 items.')
  return value.map((item) => contextString(item, 'Shared signal', 100)).filter(Boolean)
}

function contextObject(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`)
  return value
}

function safeAssistantContext(context) {
  if (!context || typeof context !== 'object') return undefined
  if (Array.isArray(context)) throw new EvaluationError('Assistant context must be an object.')
  const candidateContext = contextObject(context.candidate, 'Candidate context')
  const matchContext = contextObject(context.match, 'Match context')
  const evaluationContext = contextObject(context.evaluation, 'Evaluation context')
  const candidate = candidateContext
    ? {
        skillId: contextString(candidateContext.skillId, 'Candidate Skill ID', 300),
        skillVersion: contextString(candidateContext.skillVersion, 'Candidate version', 100),
        description: contextString(candidateContext.description, 'Candidate description', 2_000),
      }
    : undefined
  const match = matchContext
    ? {
        skillId: contextString(matchContext.skillId, 'Baseline Skill ID', 300),
        skillVersion: contextString(matchContext.skillVersion, 'Baseline version', 100),
        description: contextString(matchContext.description, 'Baseline description', 2_000),
        similarity: contextScore(matchContext.similarity, 'Similarity'),
        relationship: contextString(matchContext.relationship, 'Relationship', 200),
        sharedSignals: contextSignals(matchContext.sharedSignals),
      }
    : undefined
  const evaluation = evaluationContext
    ? {
        winner: contextString(evaluationContext.winner, 'Evaluation winner', 20),
        reason: contextString(evaluationContext.reason, 'Evaluation reason', 800),
        baselineScore: contextScore(evaluationContext.baselineScore, 'Baseline score'),
        candidateScore: contextScore(evaluationContext.candidateScore, 'Candidate score'),
        baselineOutput: contextString(evaluationContext.baselineOutput, 'Baseline output', 6_000),
        candidateOutput: contextString(evaluationContext.candidateOutput, 'Candidate output', 6_000),
      }
    : undefined
  return {
    task: contextString(context.task, 'Evaluation task', MAX_TASK_CHARS),
    criteria: contextString(context.criteria, 'Acceptance criteria', MAX_CRITERIA_CHARS),
    candidate,
    match,
    evaluation,
  }
}

export async function chatWithSkillOps(body, options = {}) {
  if (!body || typeof body !== 'object') throw new EvaluationError('A JSON request body is required.')
  const messages = sanitizeChatMessages(body.messages)
  const providerConfig = normalizeProvider(body.provider)
  const providerDefinition = aiProviderDefinition(providerConfig.provider)
  const providerLabel = providerDefinition?.label || providerConfig.provider
  const scan = options.scanInstalledSkills || scanInstalledSkills
  const inventory = (await scan()).filter((skill) => skill.kind === 'skill' && skill.enabled !== false)
  const inventoryContext = inventory.slice(0, 120).map((skill) => ({
    skillId: typeof skill.skillId === 'string' ? skill.skillId.slice(0, 300) : undefined,
    version: typeof skill.skillVersion === 'string' ? skill.skillVersion.slice(0, 100) : undefined,
    runtime: typeof skill.runtime === 'string' ? skill.runtime.slice(0, 50) : undefined,
    description: typeof skill.description === 'string' ? skill.description.slice(0, 2_000) : undefined,
  }))
  const context = safeAssistantContext(body.context)
  const callProvider = options.callProvider || callLlmProvider
  const response = await callProvider(providerConfig, [
    {
      role: 'system',
      content: `You are the SkillOps assistant. Help the user interpret installed Skill inventory, candidate similarity, and A/B evaluation results. Be precise about evidence: inventory proves installation, not execution; an A/B result covers only its stated task and criteria. Never claim that a Skill was installed, promoted, or changed. When asked which model or provider you are, answer with the configured provider and model for this chat session: ${providerLabel} · ${providerConfig.model}. Do not invent another model name, and do not treat inventory runtime values such as codex as your model identity. Current enabled inventory metadata:\n${JSON.stringify(inventoryContext)}\n\nCurrent evaluation context:\n${JSON.stringify(context || {})}`,
    },
    ...messages,
  ], { ...options, maxTokens: 1_400 })
  return {
    message: response.content,
    usage: response.usage,
    provider: response.provider,
    model: response.model,
    privacy: 'Chat messages and model output remain in browser memory and are not stored by SkillOps.',
  }
}
