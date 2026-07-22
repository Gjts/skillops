export const ARTIFACT_KINDS = Object.freeze(['skill', 'prompt', 'workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack'])
export const ARTIFACT_REFERENCE_ONLY_KINDS = Object.freeze(['prompt', 'evaluation-suite', 'policy-pack'])
export const ARTIFACT_SOURCES = Object.freeze(['local-scan', 'git', 'github', 'prompt-registry', 'prompthub'])
export const ARTIFACT_STATUSES = Object.freeze(['draft', 'candidate', 'ready', 'canary', 'stable', 'deprecated', 'blocked'])
export const ARTIFACT_RUNTIME_COMPATIBILITY = Object.freeze({
  skill: Object.freeze({ codex: 'supported', 'claude-code': 'supported', cursor: 'preview' }),
  prompt: Object.freeze({ codex: 'preview', 'claude-code': 'preview', cursor: 'unsupported' }),
  workflow: Object.freeze({ codex: 'supported', 'claude-code': 'supported', cursor: 'preview' }),
  rules: Object.freeze({ codex: 'supported', 'claude-code': 'supported', cursor: 'preview' }),
  agent: Object.freeze({ codex: 'supported', 'claude-code': 'supported', cursor: 'preview' }),
  'evaluation-suite': Object.freeze({ codex: 'unsupported', 'claude-code': 'unsupported', cursor: 'unsupported' }),
  'policy-pack': Object.freeze({ codex: 'unsupported', 'claude-code': 'unsupported', cursor: 'unsupported' }),
})
export const QUICK_EVALUATION_MODES = Object.freeze(['prompt-only', 'agent'])
export const QUICK_EVALUATION_WINNERS = Object.freeze(['baseline', 'candidate', 'tie'])
export const EVALUATION_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
export const EVALUATION_RUN_MODES = Object.freeze(['quick', 'suite', 'redteam'])

const artifactKinds = new Set(ARTIFACT_KINDS)
const artifactSources = new Set(ARTIFACT_SOURCES)
const artifactStatuses = new Set(ARTIFACT_STATUSES)
const runtimeTargets = new Set(['codex', 'claude-code', 'cursor'])
const compatibilityStatuses = new Set(['supported', 'preview', 'unsupported'])
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

function artifactRepository(value) {
  const identity = string(value, 'Artifact repository', { required: true, maxLength: 2_000 })
  if (/^git-root:[a-f0-9]{40,64}$/i.test(identity)) return identity.toLowerCase()
  let url
  try { url = new URL(identity) } catch { throw new EvaluationSchemaError('Artifact repository must be a canonical HTTPS URL or Git root identity.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new EvaluationSchemaError('Artifact repository must not contain credentials, query parameters, or fragments.')
  }
  return url.toString().replace(/\/$/, '')
}

function artifactSourceCommit(source, reference) {
  if (source === 'prompt-registry') return /^prompt-registry:([a-f0-9]{40,64}):/i.exec(reference)?.[1]?.toLowerCase()
  if (source === 'git') return /^git:v1:[a-f0-9]{64}:([a-f0-9]{40,64}):/i.exec(reference)?.[1]?.toLowerCase()
  if (source !== 'github') return undefined
  return (/\/blob\/([a-f0-9]{40,64})(?:\/|$)/i.exec(reference)
    || /^github:https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([a-f0-9]{40,64})(?:\/|$)/i.exec(reference)
    || /:([a-f0-9]{40,64}):[^:]+$/i.exec(reference))?.[1]?.toLowerCase()
}

function githubReferencePath(url) {
  let parts
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch {
    throw new EvaluationSchemaError('Artifact source reference path is invalid.')
  }
  const offset = url.hostname === 'github.com' && parts[2] === 'blob'
    ? 4
    : url.hostname === 'raw.githubusercontent.com'
      ? 3
      : -1
  const commit = parts[offset - 1]
  const sourcePath = offset > 0 ? parts.slice(offset).join('/') : ''
  if (!/^[a-f0-9]{40,64}$/i.test(commit || '') || !sourcePath) {
    throw new EvaluationSchemaError('GitHub Artifact source references must contain an immutable Git commit and path.')
  }
  return sourcePath
}

export function normalizeArtifactSourceReference(value, source) {
  const reference = string(value, 'Artifact source reference', { required: true, maxLength: 4_000 })
  if (!reference.startsWith(`${source}:`) || /[\u0000\r\n]/.test(reference)) {
    throw new EvaluationSchemaError('Artifact source reference is invalid.')
  }
  const payload = reference.slice(source.length + 1)
  if (source === 'prompt-registry') {
    if (!/^[a-f0-9]{40,64}:[^:]+:[a-f0-9]{64}$/i.test(payload)) throw new EvaluationSchemaError('Artifact source reference is invalid.')
    return reference
  }
  if (source === 'git') {
    const match = /^v1:([a-f0-9]{64}):([a-f0-9]{40,64}):([^:]+):([a-f0-9]{64})$/i.exec(payload)
    if (!match) throw new EvaluationSchemaError('Artifact source reference is invalid.')
    let sourcePath
    try { sourcePath = decodeURIComponent(match[3]) } catch {
      throw new EvaluationSchemaError('Artifact source reference path is invalid.')
    }
    if (!sourcePath || sourcePath.length > 1_000 || sourcePath.startsWith('/') || sourcePath.includes('\\')
      || /[\u0000\r\n]/.test(sourcePath) || sourcePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new EvaluationSchemaError('Artifact source reference path is invalid.')
    }
    return `git:v1:${match[1].toLowerCase()}:${match[2].toLowerCase()}:${encodeURIComponent(sourcePath)}:${match[4].toLowerCase()}`
  }
  if (source === 'prompthub') {
    const direct = /^v1:([1-9]\d{0,19}):([A-Za-z0-9._-]{1,100}):([a-f0-9]{64})$/i.exec(payload)
    if (direct) return `prompthub:v1:${direct[1]}:${direct[2]}:${direct[3].toLowerCase()}`
    const branched = /^v1:([1-9]\d{0,19}):branch:([^:]{1,600}):([A-Za-z0-9._-]{1,100}):([a-f0-9]{64})$/i.exec(payload)
    if (!branched) throw new EvaluationSchemaError('Artifact source reference is invalid.')
    let branch
    try { branch = decodeURIComponent(branched[2]) } catch {
      throw new EvaluationSchemaError('Artifact source reference is invalid.')
    }
    if (branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//')) {
      throw new EvaluationSchemaError('Artifact source reference is invalid.')
    }
    return `prompthub:v1:${branched[1]}:branch:${encodeURIComponent(branch)}:${branched[3]}:${branched[4].toLowerCase()}`
  }
  if (source === 'github' && /^skillops\/deterministic-fixture#(?:baseline|candidate)$/.test(payload)) {
    return 'github:https://github.com/skillops/deterministic-fixture'
  }
  if (source === 'github' && payload.startsWith('https://')) {
    const separator = payload.lastIndexOf('#')
    const sourceUrl = separator > 0 ? payload.slice(0, separator) : payload
    const suppliedPath = separator > 0 ? payload.slice(separator + 1) : null
    let url
    try { url = new URL(sourceUrl) } catch { throw new EvaluationSchemaError('Artifact source reference is invalid.') }
    if (url.protocol !== 'https:' || !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash) {
      throw new EvaluationSchemaError('Artifact source reference must not contain credentials, query parameters, fragments, or use an unsupported GitHub host.')
    }
    const sourcePath = githubReferencePath(url)
    let candidatePath = sourcePath
    if (suppliedPath !== null) {
      try { candidatePath = decodeURIComponent(suppliedPath) } catch {
        throw new EvaluationSchemaError('Artifact source reference path is invalid.')
      }
    }
    if (!candidatePath || candidatePath.length > 1_000 || candidatePath.startsWith('/')
      || candidatePath.includes('\\') || /[\u0000\r\n]/.test(candidatePath)
      || candidatePath.split('/').some((part) => !part || part === '.' || part === '..')
      || candidatePath !== sourcePath) {
      throw new EvaluationSchemaError('Artifact source reference path is invalid.')
    }
    return `github:${url.toString()}#${encodeURIComponent(candidatePath)}`
  }
  if (source === 'github') throw new EvaluationSchemaError('Artifact source reference is invalid.')
  return reference
}

function artifactDependencies(value) {
  const dependencies = stringList(value, 'Artifact dependencies', { maxItems: 100, maxLength: 3_000 })
  if (!dependencies) return undefined
  const normalized = dependencies.map((item) => {
    const separator = item.indexOf(':')
    const kind = item.slice(0, separator)
    let sourceId
    try { sourceId = decodeURIComponent(item.slice(separator + 1)) } catch {
      throw new EvaluationSchemaError('Artifact dependencies must use kind-scoped Artifact IDs.')
    }
    if (!artifactKinds.has(kind) || !sourceId || sourceId.length > 300) {
      throw new EvaluationSchemaError('Artifact dependencies must use kind-scoped Artifact IDs.')
    }
    return artifactKey(kind, sourceId)
  })
  return [...new Set(normalized)]
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
  assertOnlyKeys(input, new Set(['mode', 'suiteId', 'baselineRef', 'candidateRef', 'provider', 'requestedBy', 'clientRequestId', 'capabilityId', 'subjectHash', 'timeoutMs']), 'Evaluation run request')
  if (!input.provider || typeof input.provider !== 'object' || Array.isArray(input.provider)) {
    throw new EvaluationSchemaError('AI provider settings are required.', 422)
  }
  const providerInput = object(input.provider, 'AI provider settings')
  assertOnlyKeys(providerInput, new Set(['provider', 'model', 'apiKey', 'baseUrl', 'endpoint', 'apiVersion', 'reasoningEffort']), 'AI provider settings')
  const provider = normalizeProviderRequest(providerInput)
  if (!provider.provider) throw new EvaluationSchemaError('AI provider settings are required.', 422)
  const mode = input.mode === undefined ? 'suite' : string(input.mode, 'Evaluation run mode', { required: true, maxLength: 20 })
  if (!['suite', 'redteam'].includes(mode)) throw new EvaluationSchemaError('Managed evaluation mode must be suite or redteam.', 422)
  const timeoutMs = finiteNumber(input.timeoutMs, 'Evaluation timeout', { min: 1_000, max: 3_600_000 })
  if (timeoutMs !== undefined && !Number.isInteger(timeoutMs)) throw new EvaluationSchemaError('Evaluation timeout must be an integer.', 422)
  return {
    mode,
    suiteId: string(input.suiteId, 'Suite ID', { required: true, maxLength: 120 }),
    baselineRef: string(input.baselineRef, 'Baseline reference', { required: true, maxLength: 4_000 }),
    candidateRef: string(input.candidateRef, 'Candidate reference', { required: true, maxLength: 4_000 }),
    provider,
    requestedBy: string(input.requestedBy, 'Requested by', { required: true, maxLength: 200 }),
    clientRequestId: string(input.clientRequestId, 'Client request ID', { maxLength: 200 }),
    capabilityId: string(input.capabilityId, 'Capability ID', { maxLength: 200 }),
    subjectHash: input.subjectHash === undefined ? undefined : (() => {
      const value = string(input.subjectHash, 'Evaluation subject hash', { required: true, maxLength: 64 })
      if (!/^[a-f0-9]{64}$/.test(value)) throw new EvaluationSchemaError('Evaluation subject hash must be a SHA-256 digest.')
      return value
    })(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
  const gitCommit = string(artifact.gitCommit, 'Artifact Git commit', { maxLength: 64 })
  if (gitCommit && !/^[a-f0-9]{40,64}$/i.test(gitCommit)) throw new EvaluationSchemaError('Artifact Git commit is invalid.')
  const targets = stringList(artifact.runtimeTargets, 'Artifact runtime targets', { maxItems: 3, maxLength: 40 })
  if (targets?.some((target) => !runtimeTargets.has(target))) throw new EvaluationSchemaError('Artifact runtime target is unsupported.')
  let compatibility
  if (artifact.compatibility !== undefined) {
    const input = object(artifact.compatibility, 'Artifact compatibility')
    assertOnlyKeys(input, runtimeTargets, 'Artifact compatibility')
    compatibility = {}
    for (const [runtime, status] of Object.entries(input)) {
      if (!compatibilityStatuses.has(status)) throw new EvaluationSchemaError(`Artifact compatibility for ${runtime} is invalid.`)
      compatibility[runtime] = status
    }
  }
  const schemaVersion = finiteNumber(artifact.schemaVersion, 'Artifact schema version', { min: 1, max: 1_000 })
  if (schemaVersion !== undefined && !Number.isInteger(schemaVersion)) throw new EvaluationSchemaError('Artifact schema version must be an integer.')
  const createdAt = string(artifact.createdAt, 'Artifact creation time', { maxLength: 100 })
  if (createdAt && Number.isNaN(Date.parse(createdAt))) throw new EvaluationSchemaError('Artifact creation time is invalid.')
  const sourceRef = normalizeArtifactSourceReference(artifact.sourceRef, source)
  const sourceCommit = artifactSourceCommit(source, sourceRef)
  const normalizedGitCommit = gitCommit?.toLowerCase()
  if (['git', 'github'].includes(source) && normalizedGitCommit && sourceCommit !== normalizedGitCommit) {
    throw new EvaluationSchemaError('Git Artifact source reference must contain its immutable Git commit.')
  }
  if (source === 'git' && sourceRef.split(':').at(-1) !== contentHash) {
    throw new EvaluationSchemaError('Git Artifact source reference must contain its content hash.')
  }
  if (source === 'git' && !artifact.repository) throw new EvaluationSchemaError('Git Artifacts require a repository identity.')
  return {
    kind,
    artifactId: string(artifact.artifactId, 'Artifact ID', { required: true, maxLength: 300 }),
    version: string(artifact.version, 'Artifact version', { required: true, maxLength: 100 }),
    description: string(artifact.description, 'Artifact description', { maxLength: 2_000, trim: false }),
    source,
    sourceRef,
    contentHash,
    providerHint: string(artifact.providerHint, 'Provider hint', { maxLength: 100 }),
    modelHint: string(artifact.modelHint, 'Model hint', { maxLength: 200 }),
    variables: stringList(artifact.variables, 'Artifact variables', { maxItems: 100, maxLength: 200 }),
    ...(componentHashes ? { componentHashes } : {}),
    ...((normalizedGitCommit || sourceCommit) ? { gitCommit: normalizedGitCommit || sourceCommit } : {}),
    ...(artifact.repository ? { repository: artifactRepository(artifact.repository) } : {}),
    ...(artifact.dependencies ? { dependencies: artifactDependencies(artifact.dependencies) } : {}),
    ...(targets ? { runtimeTargets: [...new Set(targets)] } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(createdAt ? { createdAt: new Date(createdAt).toISOString() } : {}),
  }
}

function artifactKey(kind, artifactId) {
  return `${kind}:${encodeURIComponent(artifactId)}`
}

function artifactStatus(value) {
  const status = string(value, 'Artifact status', { required: true, maxLength: 20 })
  if (!artifactStatuses.has(status)) throw new EvaluationSchemaError('Artifact status is unsupported.')
  return status
}

export function normalizeArtifactRecord(value) {
  const input = object(value, 'Artifact')
  const kind = string(input.kind, 'Artifact kind', { required: true, maxLength: 20 })
  if (!artifactKinds.has(kind)) throw new EvaluationSchemaError('Artifact kind is unsupported.')
  const sourceId = string(input.artifactId, 'Artifact ID', { required: true, maxLength: 300 })
  const createdAt = string(input.createdAt, 'Artifact creation time', { maxLength: 100 })
  const updatedAt = string(input.updatedAt, 'Artifact update time', { maxLength: 100 })
  if (createdAt && Number.isNaN(Date.parse(createdAt))) throw new EvaluationSchemaError('Artifact creation time is invalid.')
  if (updatedAt && Number.isNaN(Date.parse(updatedAt))) throw new EvaluationSchemaError('Artifact update time is invalid.')
  return {
    id: artifactKey(kind, sourceId),
    artifactId: sourceId,
    kind,
    name: string(input.name, 'Artifact name', { required: true, maxLength: 300 }),
    owner: string(input.owner, 'Artifact owner', { required: true, maxLength: 200 }),
    repository: input.repository ? artifactRepository(input.repository) : undefined,
    status: artifactStatus(input.status),
    description: string(input.description, 'Artifact description', { maxLength: 2_000, trim: false }),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  }
}

export function normalizeArtifactVersionRecord(value) {
  const input = object(value, 'Artifact version')
  const artifact = normalizeArtifactDefinition(input.artifact)
  const unresolvedGit = ['git', 'github', 'prompt-registry'].includes(artifact.source) && !artifact.gitCommit
  const compatibility = { ...ARTIFACT_RUNTIME_COMPATIBILITY[artifact.kind], ...artifact.compatibility }
  const commit = unresolvedGit ? 'unresolved' : artifact.gitCommit || 'working-tree'
  const createdAt = input.createdAt || artifact.createdAt
  if (createdAt && Number.isNaN(Date.parse(createdAt))) throw new EvaluationSchemaError('Artifact version creation time is invalid.')
  return {
    id: `${artifactKey(artifact.kind, artifact.artifactId)}@${commit}:${artifact.contentHash}`,
    artifactId: artifactKey(artifact.kind, artifact.artifactId),
    sourceArtifactId: artifact.artifactId,
    kind: artifact.kind,
    version: artifact.version,
    contentHash: artifact.contentHash,
    gitCommit: artifact.gitCommit || null,
    repository: artifact.repository,
    schemaVersion: artifact.schemaVersion || 1,
    runtimeTargets: artifact.runtimeTargets || Object.keys(compatibility).filter((runtime) => compatibility[runtime] !== 'unsupported'),
    compatibility,
    dependencies: artifact.dependencies || [],
    source: artifact.source,
    sourceRef: artifact.sourceRef,
    description: artifact.description,
    componentHashes: artifact.componentHashes,
    status: unresolvedGit ? 'blocked' : artifactStatus(input.status),
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
  }
}

export function normalizeInstallationRecord(value) {
  const input = object(value, 'Artifact installation')
  const desiredState = string(input.desiredState, 'Desired state', { required: true, maxLength: 20 })
  const observedState = string(input.observedState, 'Observed state', { required: true, maxLength: 20 })
  if (!['present', 'absent', 'unmanaged'].includes(desiredState)) throw new EvaluationSchemaError('Desired state is unsupported.')
  if (!['present', 'missing', 'drifted', 'unmanaged'].includes(observedState)) throw new EvaluationSchemaError('Observed state is unsupported.')
  const observedHash = string(input.observedHash, 'Observed hash', { maxLength: 64 })
  if (observedHash && !/^[a-f0-9]{64}$/.test(observedHash)) throw new EvaluationSchemaError('Observed hash must be a SHA-256 digest.')
  return {
    id: string(input.id, 'Installation ID', { required: true, maxLength: 4_000 }),
    artifactId: string(input.artifactId, 'Installation Artifact ID', { required: true, maxLength: 400 }),
    artifactVersionId: string(input.artifactVersionId, 'Installation Artifact version ID', { maxLength: 1_000 }),
    runtime: string(input.runtime, 'Installation runtime', { required: true, maxLength: 40 }),
    scope: string(input.scope, 'Installation scope', { required: true, maxLength: 100 }),
    targetPath: string(input.targetPath, 'Installation target path', { required: true, maxLength: 4_000 }),
    desiredState,
    observedState,
    observedHash,
  }
}
