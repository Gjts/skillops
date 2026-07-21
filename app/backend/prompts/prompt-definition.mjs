import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { artifactContentHash, normalizeArtifactContent } from '../evaluations/artifact-definition.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { normalizePromptVariableName, promptVariableNames } from '../evaluations/prompt-variables.mjs'
import { canonicalJson } from '../evaluations/suite-registry.mjs'

const MODEL_CONFIGURATION_FIELDS = new Set([
  'max_tokens', 'max_tokens_to_sample', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed', 'stop',
])
const TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'id', 'name', 'description', 'system', 'template', 'messages', 'model', 'variables'])

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  return value
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
}

function text(value, label, { required = false, maxLength = 100_000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new EvaluationError(`${label} is required.`, 422)
    return ''
  }
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\u0000')) throw new EvaluationError(`${label} is invalid.`, 422)
  const normalized = normalizeArtifactContent(value)
  if (required && !normalized.trim()) throw new EvaluationError(`${label} is required.`, 422)
  return normalized
}

function identifier(value, label) {
  const normalized = text(value, label, { required: true, maxLength: 200 }).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(normalized)) throw new EvaluationError(`${label} is invalid.`, 422)
  return normalized
}

function messages(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new EvaluationError('Prompt messages must contain 1 to 100 entries.', 422)
  return value.map((entry, index) => {
    const message = object(entry, `Prompt message ${index + 1}`)
    onlyKeys(message, new Set(['role', 'content']), `Prompt message ${index + 1}`)
    if (!['system', 'user', 'assistant'].includes(message.role)) throw new EvaluationError(`Prompt message ${index + 1} role is invalid.`, 422)
    return { role: message.role, content: text(message.content, `Prompt message ${index + 1} content`, { required: true }) }
  })
}

function model(value) {
  if (value === undefined) return { provider: '', name: '', configuration: {} }
  const input = object(value, 'Prompt model')
  onlyKeys(input, new Set(['provider', 'name', 'configuration']), 'Prompt model')
  const configuration = input.configuration === undefined ? {} : object(input.configuration, 'Prompt model configuration')
  onlyKeys(configuration, MODEL_CONFIGURATION_FIELDS, 'Prompt model configuration')
  const normalizedConfiguration = {}
  for (const [key, item] of Object.entries(configuration)) {
    if (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) normalizedConfiguration[key] = item
    else if (Array.isArray(item) && item.length <= 20 && item.every((part) => typeof part === 'string' && part.length <= 500)) normalizedConfiguration[key] = [...item]
    else throw new EvaluationError(`Prompt model configuration ${key} is invalid.`, 422)
  }
  return {
    provider: text(input.provider, 'Prompt model provider', { maxLength: 100 }).trim(),
    name: text(input.name, 'Prompt model name', { maxLength: 200 }).trim(),
    configuration: Object.fromEntries(Object.entries(normalizedConfiguration).sort(([left], [right]) => left.localeCompare(right))),
  }
}

function declaredVariables(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new EvaluationError('Prompt variables must contain at most 100 names.', 422)
  return value.map(normalizePromptVariableName)
}

export function promptRegistrySourceRef(commit, relativePath, contentHash) {
  if (!/^[a-f0-9]{40,64}$/i.test(commit) || !relativePath || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new EvaluationError('Prompt Registry source reference is invalid.', 422)
  }
  return `prompt-registry:${commit.toLowerCase()}:${encodeURIComponent(relativePath)}:${contentHash}`
}

export function parsePromptRegistrySourceRef(value) {
  if (typeof value !== 'string') throw new EvaluationError('Prompt Registry source reference is invalid.', 422)
  const match = value.match(/^prompt-registry:([a-f0-9]{40,64}):([^:]+):([a-f0-9]{64})$/i)
  if (!match) throw new EvaluationError('Prompt Registry source reference is invalid.', 422)
  try {
    const relativePath = decodeURIComponent(match[2])
    if (!relativePath || relativePath.length > 1_000 || relativePath.includes('\\') || relativePath.split('/').includes('..')) throw new Error('invalid')
    return { commit: match[1].toLowerCase(), relativePath, contentHash: match[3] }
  } catch {
    throw new EvaluationError('Prompt Registry source reference is invalid.', 422)
  }
}

export function adaptPromptDefinition(value, { commit, relativePath }) {
  const input = object(value, 'Prompt definition')
  onlyKeys(input, TOP_LEVEL_FIELDS, 'Prompt definition')
  if (input.schemaVersion !== 1) throw new EvaluationError('Prompt definition schemaVersion must be 1.', 422)
  const promptMessages = messages(input.messages)
  const template = input.template === undefined ? undefined : text(input.template, 'Prompt template', { required: true })
  if (Boolean(promptMessages) === Boolean(template)) throw new EvaluationError('Prompt definition requires exactly one template or messages field.', 422)
  const system = text(input.system, 'Prompt system message')
  const normalizedModel = model(input.model)
  const usedVariables = promptVariableNames(system, template, ...(promptMessages || []).map((message) => message.content))
  const variables = [...new Set([...declaredVariables(input.variables), ...usedVariables])].sort()
  const prompt = {
    schemaVersion: 1,
    system,
    ...(promptMessages ? { messages: promptMessages } : { template }),
    model: normalizedModel,
    variables,
  }
  const canonical = canonicalJson(prompt)
  const contentHash = artifactContentHash(canonical)
  const componentHashes = {
    system: artifactContentHash(canonicalJson(prompt.system)),
    prompt: artifactContentHash(canonicalJson(prompt.messages || prompt.template || '')),
    model: artifactContentHash(canonicalJson({ provider: prompt.model.provider, name: prompt.model.name })),
    configuration: artifactContentHash(canonicalJson(prompt.model.configuration)),
    variables: artifactContentHash(canonicalJson(prompt.variables)),
  }
  const sourceRef = promptRegistrySourceRef(commit, relativePath, contentHash)
  const name = text(input.name, 'Prompt name', { required: true, maxLength: 200 }).trim()
  const description = text(input.description, 'Prompt description', { maxLength: 2_000 }) || undefined
  return {
    artifact: normalizeArtifactDefinition({
      kind: 'prompt',
      artifactId: identifier(input.id, 'Prompt ID'),
      version: commit.toLowerCase(),
      description,
      source: 'prompt-registry',
      sourceRef,
      contentHash,
      providerHint: normalizedModel.provider || undefined,
      modelHint: normalizedModel.name || undefined,
      variables,
      componentHashes,
    }),
    prompt,
    metadata: { id: input.id, name, description, relativePath, commit: commit.toLowerCase() },
  }
}
