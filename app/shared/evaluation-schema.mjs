export const ARTIFACT_KINDS = Object.freeze(['skill', 'prompt', 'workflow'])
export const ARTIFACT_SOURCES = Object.freeze(['local-scan', 'github', 'prompt-registry'])
export const QUICK_EVALUATION_MODES = Object.freeze(['prompt-only', 'agent'])
export const QUICK_EVALUATION_WINNERS = Object.freeze(['baseline', 'candidate', 'tie'])
export const EVALUATION_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
export const EVALUATION_RUN_MODES = Object.freeze(['quick', 'suite', 'redteam'])

const artifactKinds = new Set(ARTIFACT_KINDS)
const artifactSources = new Set(ARTIFACT_SOURCES)
const quickModes = new Set(QUICK_EVALUATION_MODES)

export class EvaluationSchemaError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'EvaluationSchemaError'
    this.status = status
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationSchemaError(`${label} must be an object.`)
  return value
}

function string(value, label, { required = false, maxLength, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new EvaluationSchemaError(`${label} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new EvaluationSchemaError(`${label} must be a string.`)
  const normalized = trim ? value.trim() : value
  if (required && !normalized) throw new EvaluationSchemaError(`${label} is required.`)
  if (maxLength && normalized.length > maxLength) throw new EvaluationSchemaError(`${label} is too long.`)
  return normalized || (required ? normalized : undefined)
}

function finiteNumber(value, label, { min, max } = {}) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new EvaluationSchemaError(`${label} must be a finite number.`)
  if (min !== undefined && value < min || max !== undefined && value > max) throw new EvaluationSchemaError(`${label} is out of range.`)
  return value
}

function stringList(value, label, { maxItems = 100, maxLength = 2_000 } = {}) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new EvaluationSchemaError(`${label} must contain at most ${maxItems} items.`)
  return value.map((item) => string(item, `${label} item`, { required: true, maxLength }))
}

function normalizeProviderRequest(value) {
  const provider = object(value, 'AI provider settings')
  return {
    provider: string(provider.provider, 'Provider', { required: true, maxLength: 40 }),
    model: string(provider.model, 'Model', { maxLength: 200 }),
    apiKey: string(provider.apiKey, 'API key', { maxLength: 2_000 }),
    baseUrl: string(provider.baseUrl, 'Base URL', { maxLength: 2_000 }),
    endpoint: string(provider.endpoint, 'Endpoint', { maxLength: 2_000 }),
    apiVersion: string(provider.apiVersion, 'API version', { maxLength: 100 }),
    reasoningEffort: string(provider.reasoningEffort, 'Reasoning effort', { maxLength: 20 }),
  }
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationSchemaError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
}

export function normalizeManagedEvaluationRunRequest(value) {
  const input = object(value, 'Evaluation run request body')
  assertOnlyKeys(input, new Set(['mode', 'suiteId', 'baselineRef', 'candidateRef', 'provider', 'requestedBy', 'clientRequestId', 'capabilityId']), 'Evaluation run request')
  if (!input.provider || typeof input.provider !== 'object' || Array.isArray(input.provider)) {
    throw new EvaluationSchemaError('AI provider settings are required.', 422)
  }
  const providerInput = object(input.provider, 'AI provider settings')
  assertOnlyKeys(providerInput, new Set(['provider', 'model', 'apiKey', 'baseUrl', 'endpoint', 'apiVersion', 'reasoningEffort']), 'AI provider settings')
  const provider = normalizeProviderRequest(providerInput)
  if (!provider.provider) throw new EvaluationSchemaError('AI provider settings are required.', 422)
  const mode = input.mode === undefined ? 'suite' : string(input.mode, 'Evaluation run mode', { required: true, maxLength: 20 })
  if (!['suite', 'redteam'].includes(mode)) throw new EvaluationSchemaError('Managed evaluation mode must be suite or redteam.', 422)
  return {
    mode,
    suiteId: string(input.suiteId, 'Suite ID', { required: true, maxLength: 120 }),
    baselineRef: string(input.baselineRef, 'Baseline reference', { required: true, maxLength: 4_000 }),
    candidateRef: string(input.candidateRef, 'Candidate reference', { required: true, maxLength: 4_000 }),
    provider,
    requestedBy: string(input.requestedBy, 'Requested by', { required: true, maxLength: 200 }),
    clientRequestId: string(input.clientRequestId, 'Client request ID', { maxLength: 200 }),
    capabilityId: string(input.capabilityId, 'Capability ID', { maxLength: 200 }),
  }
}

export function normalizeCandidateAnalysisRequest(value) {
  const input = object(value, 'Evaluation request body')
  return {
    sourceUrl: string(input.sourceUrl, 'Candidate URL', { required: true, maxLength: 2_000 }),
    candidatePath: string(input.candidatePath, 'Candidate path', { maxLength: 4_000 }),
  }
}

export function normalizeQuickEvaluationRequest(value) {
  const input = object(value, 'Evaluation request body')
  const mode = input.mode === undefined ? 'prompt-only' : string(input.mode, 'Evaluation mode', { required: true, maxLength: 20 })
  if (!quickModes.has(mode)) throw new EvaluationSchemaError('Evaluation mode must be prompt-only or agent.')
  return {
    sourceUrl: string(input.sourceUrl, 'Candidate URL', { required: true, maxLength: 2_000 }),
    candidatePath: string(input.candidatePath, 'Candidate path', { maxLength: 4_000 }),
    candidateContentHash: string(input.candidateContentHash, 'Candidate content hash', { required: true, maxLength: 64 }),
    baselineSourcePath: string(input.baselineSourcePath, 'Baseline Skill', { required: true, maxLength: 4_000 }),
    task: string(input.task, 'Evaluation task', { required: true, maxLength: 12_000 }),
    criteria: string(input.criteria, 'Acceptance criteria', { required: true, maxLength: 6_000 }),
    mode,
    provider: normalizeProviderRequest(input.provider),
  }
}

function normalizeAssistantContext(value) {
  if (value === undefined || value === null) return undefined
  const context = object(value, 'Assistant context')
  const candidateInput = context.candidate === undefined ? undefined : object(context.candidate, 'Candidate context')
  const matchInput = context.match === undefined ? undefined : object(context.match, 'Match context')
  const evaluationInput = context.evaluation === undefined ? undefined : object(context.evaluation, 'Evaluation context')
  return {
    task: string(context.task, 'Evaluation task', { maxLength: 12_000, trim: false }),
    criteria: string(context.criteria, 'Acceptance criteria', { maxLength: 6_000, trim: false }),
    candidate: candidateInput && {
      skillId: string(candidateInput.skillId, 'Candidate Skill ID', { maxLength: 300, trim: false }),
      skillVersion: string(candidateInput.skillVersion, 'Candidate version', { maxLength: 100, trim: false }),
      description: string(candidateInput.description, 'Candidate description', { maxLength: 2_000, trim: false }),
    },
    match: matchInput && {
      skillId: string(matchInput.skillId, 'Baseline Skill ID', { maxLength: 300, trim: false }),
      skillVersion: string(matchInput.skillVersion, 'Baseline version', { maxLength: 100, trim: false }),
      description: string(matchInput.description, 'Baseline description', { maxLength: 2_000, trim: false }),
      similarity: finiteNumber(matchInput.similarity, 'Similarity', { min: 0, max: 100 }),
      relationship: string(matchInput.relationship, 'Relationship', { maxLength: 200, trim: false }),
      sharedSignals: stringList(matchInput.sharedSignals, 'Shared signals', { maxItems: 12, maxLength: 100 }),
    },
    evaluation: evaluationInput && {
      winner: string(evaluationInput.winner, 'Evaluation winner', { maxLength: 20, trim: false }),
      reason: string(evaluationInput.reason, 'Evaluation reason', { maxLength: 800, trim: false }),
      baselineScore: finiteNumber(evaluationInput.baselineScore, 'Baseline score', { min: 0, max: 100 }),
      candidateScore: finiteNumber(evaluationInput.candidateScore, 'Candidate score', { min: 0, max: 100 }),
      baselineOutput: string(evaluationInput.baselineOutput, 'Baseline output', { maxLength: 6_000, trim: false }),
      candidateOutput: string(evaluationInput.candidateOutput, 'Candidate output', { maxLength: 6_000, trim: false }),
    },
  }
}

export function normalizeAssistantChatRequest(value) {
  const input = object(value, 'Evaluation request body')
  if (!Array.isArray(input.messages) || !input.messages.length) throw new EvaluationSchemaError('At least one chat message is required.')
  if (input.messages.length > 24) throw new EvaluationSchemaError('Chat is limited to 24 messages per request.')
  return {
    provider: normalizeProviderRequest(input.provider),
    messages: input.messages.map((entry) => {
      const message = object(entry, 'Chat message')
      const role = string(message.role, 'Chat role', { required: true, maxLength: 20 })
      if (!['user', 'assistant'].includes(role)) throw new EvaluationSchemaError('Chat messages must use user or assistant roles.')
      return { role, content: string(message.content, 'Chat message', { required: true, maxLength: 8_000 }) }
    }),
    context: normalizeAssistantContext(input.context),
  }
}

export function normalizeEvaluationApiBody(pathname, value) {
  if (pathname === '/api/evaluations/compare') return normalizeCandidateAnalysisRequest(value)
  if (pathname === '/api/evaluations/run') return normalizeQuickEvaluationRequest(value)
  if (pathname === '/api/assistant/chat') return normalizeAssistantChatRequest(value)
  throw new EvaluationSchemaError('Unsupported evaluation route.', 404)
}

export function normalizeArtifactDefinition(value) {
  const artifact = object(value, 'Artifact definition')
  const kind = string(artifact.kind, 'Artifact kind', { required: true, maxLength: 20 })
  const source = string(artifact.source, 'Artifact source', { required: true, maxLength: 20 })
  if (!artifactKinds.has(kind)) throw new EvaluationSchemaError('Artifact kind is unsupported.')
  if (!artifactSources.has(source)) throw new EvaluationSchemaError('Artifact source is unsupported.')
  const contentHash = string(artifact.contentHash, 'Artifact content hash', { required: true, maxLength: 64 })
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new EvaluationSchemaError('Artifact content hash must be a SHA-256 digest.')
  let componentHashes
  if (artifact.componentHashes !== undefined) {
    const input = object(artifact.componentHashes, 'Artifact component hashes')
    const allowed = new Set(['system', 'prompt', 'model', 'configuration', 'variables'])
    assertOnlyKeys(input, allowed, 'Artifact component hashes')
    componentHashes = {}
    for (const [key, hash] of Object.entries(input)) {
      const normalized = string(hash, `Artifact ${key} hash`, { required: true, maxLength: 64 })
      if (!/^[a-f0-9]{64}$/.test(normalized)) throw new EvaluationSchemaError(`Artifact ${key} hash must be a SHA-256 digest.`)
      componentHashes[key] = normalized
    }
  }
  return {
    kind,
    artifactId: string(artifact.artifactId, 'Artifact ID', { required: true, maxLength: 300 }),
    version: string(artifact.version, 'Artifact version', { required: true, maxLength: 100 }),
    description: string(artifact.description, 'Artifact description', { maxLength: 2_000, trim: false }),
    source,
    sourceRef: string(artifact.sourceRef, 'Artifact source reference', { required: true, maxLength: 4_000 }),
    contentHash,
    providerHint: string(artifact.providerHint, 'Provider hint', { maxLength: 100 }),
    modelHint: string(artifact.modelHint, 'Model hint', { maxLength: 200 }),
    variables: stringList(artifact.variables, 'Artifact variables', { maxItems: 100, maxLength: 200 }),
    ...(componentHashes ? { componentHashes } : {}),
  }
}
