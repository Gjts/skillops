import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { aiProviderDefinition } from '../shared/ai-provider-catalog.mjs'
import { runEvaluationAgent } from './evaluation-agent.mjs'
import { AiSettingsError, readAiSettings, writeAiSettings } from './ai-settings-store.mjs'
import { scanInstalledSkills } from './skill-scanner.mjs'

const MAX_SKILL_BYTES = 256_000
const MAX_TASK_CHARS = 12_000
const MAX_CRITERIA_CHARS = 6_000
const MAX_CHAT_MESSAGES = 24
const MAX_CHAT_MESSAGE_CHARS = 8_000
const MAX_GITHUB_JSON_BYTES = 8_000_000
const MAX_PROVIDER_RESPONSE_BYTES = 4_000_000
const MAX_EVALUATION_REQUEST_BYTES = 512_000
const MAX_AI_SETTINGS_REQUEST_BYTES = 64_000
const REQUEST_TIMEOUT_MS = 120_000
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

const stopWords = new Set([
  'about', 'after', 'also', 'and', 'are', 'been', 'before', 'being', 'can', 'codex', 'claude',
  'does', 'each', 'file', 'for', 'from', 'have', 'into', 'its', 'more', 'must', 'not', 'only',
  'other', 'should', 'skill', 'skills', 'that', 'the', 'their', 'then', 'these', 'this', 'through',
  'use', 'used', 'user', 'using', 'when', 'where', 'which', 'will', 'with', 'you', 'your',
])

export class EvaluationError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'EvaluationError'
    this.status = status
  }
}

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is required.`)
  const normalized = value.trim()
  if (maxLength && normalized.length > maxLength) throw new EvaluationError(`${label} is too long.`)
  return normalized
}

function optionalString(value, maxLength = 2_000) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new EvaluationError('Configuration fields must be strings.')
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new EvaluationError('A configuration field is too long.')
  return normalized || undefined
}

function frontmatter(text, key) {
  const block = text.startsWith('---') ? text.split(/^---\s*$/m)[1] ?? '' : ''
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  const value = match?.[1]?.trim()
  if (!value) return undefined
  return value.replace(/^['"]|['"]$/g, '').trim()
}

function headingList(text) {
  return [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1].trim()).slice(0, 24)
}

function stripFrontmatter(text) {
  return text.startsWith('---') ? text.replace(/^---\s*[\s\S]*?^---\s*$/m, '') : text
}

function parseSkillDefinition(contents, fallbackName, metadata = {}) {
  if (typeof contents !== 'string' || !contents.trim()) throw new EvaluationError('The selected SKILL.md is empty.', 422)
  if (Buffer.byteLength(contents, 'utf8') > MAX_SKILL_BYTES) throw new EvaluationError('The selected SKILL.md exceeds the 256 KB evaluation limit.', 413)
  return {
    skillId: frontmatter(contents, 'name') || fallbackName || 'unnamed-skill',
    skillVersion: frontmatter(contents, 'version') || metadata.skillVersion || 'unversioned',
    description: frontmatter(contents, 'description') || metadata.description,
    headings: headingList(contents),
    contents,
    ...metadata,
    contentHash: createHash('sha256').update(contents).digest('hex'),
  }
}

function githubCoordinates(sourceUrl) {
  let url
  try {
    url = new URL(sourceUrl)
  } catch {
    throw new EvaluationError('Enter a valid public GitHub URL.')
  }
  if (url.protocol !== 'https:') throw new EvaluationError('Candidate URLs must use HTTPS.')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4 || parts.at(-1) !== 'SKILL.md') throw new EvaluationError('The raw GitHub URL must point to a SKILL.md file.')
    return { owner: parts[0], repo: parts[1], branch: parts[2], directPath: parts.slice(3).join('/'), directUrl: url.href }
  }
  if (url.hostname !== 'github.com' || parts.length < 2) {
    throw new EvaluationError('Candidate discovery currently supports public github.com repositories and raw SKILL.md URLs.')
  }
  const [owner, repo] = parts
  if (parts[2] === 'blob') {
    const directPath = parts.slice(4).join('/')
    if (!parts[3] || path.posix.basename(directPath) !== 'SKILL.md') throw new EvaluationError('The GitHub file URL must point to a SKILL.md file.')
    return {
      owner,
      repo,
      branch: parts[3],
      directPath,
      directUrl: `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(parts[3])}/${directPath.split('/').map(encodeURIComponent).join('/')}`,
    }
  }
  if (parts[2] === 'tree' && !parts[3]) throw new EvaluationError('The GitHub tree URL is missing a branch.')
  return {
    owner,
    repo,
    branch: parts[2] === 'tree' ? parts[3] : undefined,
    prefix: parts[2] === 'tree' ? parts.slice(4).join('/') : '',
  }
}

async function remoteRequest(url, options = {}, fetchImpl = fetch, timeoutMs = 20_000, consume = (response) => response) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal })
      return await consume(response)
    } catch (error) {
      if (error instanceof EvaluationError) throw error
      lastError = controller.signal.aborted
        ? new EvaluationError('The remote request timed out.', 504)
        : new EvaluationError(error instanceof Error ? `Remote request failed: ${error.message}` : 'Remote request failed.', 502)
      if (attempt === 1) throw lastError
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

async function boundedResponseText(response, maxBytes, limitMessage) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new EvaluationError(limitMessage, 413)
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new EvaluationError(limitMessage, 413)
    return new TextDecoder().decode(bytes)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new EvaluationError(limitMessage, 413)
      }
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function githubJson(url, fetchImpl) {
  return remoteRequest(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SkillOps-local-evaluator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, fetchImpl, 20_000, async (response) => {
    if (!response.ok) throw new EvaluationError(`GitHub returned ${response.status} while discovering candidate Skills.`, response.status === 404 ? 404 : 502)
    const text = await boundedResponseText(response, MAX_GITHUB_JSON_BYTES, 'The GitHub discovery response exceeds the safe evaluation limit.')
    try { return JSON.parse(text) } catch { throw new EvaluationError('GitHub returned invalid discovery data.', 502) }
  })
}

async function remoteText(url, fetchImpl) {
  return remoteRequest(url, { headers: { Accept: 'text/plain', 'User-Agent': 'SkillOps-local-evaluator' } }, fetchImpl, 20_000, async (response) => {
    if (!response.ok) throw new EvaluationError(`GitHub returned ${response.status} while reading the candidate Skill.`, response.status === 404 ? 404 : 502)
    return boundedResponseText(response, MAX_SKILL_BYTES, 'The selected SKILL.md exceeds the 256 KB evaluation limit.')
  })
}

export async function discoverGithubSkill(sourceUrl, candidatePath, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const source = requiredString(sourceUrl, 'Candidate URL', 2_000)
  const coordinates = githubCoordinates(source)
  let branch = coordinates.branch
  let refs
  if (coordinates.directPath) {
    refs = [{ sourcePath: coordinates.directPath, downloadUrl: coordinates.directUrl }]
  } else {
    if (!branch) {
      const repository = await githubJson(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}`, fetchImpl)
      branch = repository.default_branch
    }
    if (typeof branch !== 'string' || !branch) throw new EvaluationError('GitHub did not return a default branch.', 502)
    const tree = await githubJson(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, fetchImpl)
    if (tree.truncated) throw new EvaluationError('This repository tree is too large for safe candidate discovery. Link directly to a SKILL.md file.', 422)
    const prefix = coordinates.prefix ? `${coordinates.prefix.replace(/\/+$/, '')}/` : ''
    refs = (Array.isArray(tree.tree) ? tree.tree : [])
      .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string' && path.posix.basename(entry.path) === 'SKILL.md' && (!prefix || entry.path.startsWith(prefix)))
      .map((entry) => ({
        sourcePath: entry.path,
        sha: entry.sha,
        downloadUrl: `https://raw.githubusercontent.com/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/${encodeURIComponent(branch)}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,
      }))
      .sort((left, right) => left.sourcePath.split('/').length - right.sourcePath.split('/').length || left.sourcePath.localeCompare(right.sourcePath))
      .slice(0, 40)
  }
  if (!refs.length) throw new EvaluationError('No SKILL.md files were found at this GitHub location.', 404)
  const selected = candidatePath ? refs.find((item) => item.sourcePath === candidatePath) : refs[0]
  if (!selected) throw new EvaluationError('The selected candidate is not present at this GitHub location.', 404)
  const contents = await remoteText(selected.downloadUrl, fetchImpl)
  const skillLabel = (sourcePath) => {
    const directory = path.posix.dirname(sourcePath)
    return directory === '.' ? coordinates.repo : path.posix.basename(directory)
  }
  const definition = parseSkillDefinition(contents, skillLabel(selected.sourcePath), {
    sourceUrl: source,
    sourcePath: selected.sourcePath,
    sha: selected.sha,
  })
  return {
    definition,
    candidates: refs.map((item) => ({
      sourcePath: item.sourcePath,
      sha: item.sha,
      label: skillLabel(item.sourcePath),
    })),
  }
}

function wordTokens(text) {
  const normalized = String(text || '').toLowerCase()
  const tokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) || []
  const result = new Set(tokens.filter((token) => token.length > 2 && !stopWords.has(token)))
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < sequence.length - 1; index += 1) result.add(sequence.slice(index, index + 2))
  }
  return result
}

function ngrams(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (!normalized) return new Set()
  if (normalized.length < 3) return new Set([normalized])
  return new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3)))
}

function diceCoefficient(left, right) {
  if (!left.size && !right.size) return 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

function sharedTerms(left, right) {
  return [...left].filter((token) => right.has(token) && token.length > 2).sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 6)
}

export function compareSkillDefinitions(candidate, baseline) {
  const candidateDescription = wordTokens(candidate.description || '')
  const baselineDescription = wordTokens(baseline.description || '')
  const candidateBody = wordTokens(`${candidate.description || ''}\n${candidate.headings?.join('\n') || ''}\n${stripFrontmatter(candidate.contents || '')}`)
  const baselineBody = wordTokens(`${baseline.description || ''}\n${baseline.headings?.join('\n') || ''}\n${stripFrontmatter(baseline.contents || '')}`)
  const nameScore = diceCoefficient(ngrams(candidate.skillId), ngrams(baseline.skillId))
  const descriptionScore = diceCoefficient(candidateDescription, baselineDescription)
  const bodyScore = diceCoefficient(candidateBody, baselineBody)
  const exactNameBoost = candidate.skillId.toLowerCase() === baseline.skillId.toLowerCase() ? 0.18 : 0
  const similarity = Math.min(100, Math.round((nameScore * 0.38 + descriptionScore * 0.27 + bodyScore * 0.35 + exactNameBoost) * 100))
  return {
    similarity,
    relationship: similarity >= 65 ? 'Likely update' : similarity >= 25 ? 'Overlapping purpose' : 'Distinct purpose',
    sharedSignals: sharedTerms(candidateBody, baselineBody),
  }
}

async function installedDefinitions(options = {}) {
  const scan = options.scanInstalledSkills || scanInstalledSkills
  const read = options.readFile || readFile
  const skills = (await scan()).filter((skill) => skill.kind === 'skill' && skill.enabled !== false)
  return (await Promise.all(skills.map(async (skill) => {
    try {
      const contents = await read(skill.sourcePath, 'utf8')
      return parseSkillDefinition(contents, skill.skillId, skill)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.status === 413) return null
      throw error
    }
  }))).filter(Boolean)
}

function publicCandidate(definition) {
  return {
    skillId: definition.skillId,
    skillVersion: definition.skillVersion,
    description: definition.description,
    headings: definition.headings,
    sourceUrl: definition.sourceUrl,
    sourcePath: definition.sourcePath,
    sha: definition.sha,
    contentHash: definition.contentHash,
  }
}

function publicMatch(definition, comparison) {
  return {
    skillId: definition.skillId,
    skillVersion: definition.skillVersion,
    description: definition.description,
    runtime: definition.runtime,
    source: definition.source,
    sourcePath: definition.sourcePath,
    provider: definition.provider,
    ...comparison,
  }
}

export async function analyzeCandidateSkill(body, options = {}) {
  if (!body || typeof body !== 'object') throw new EvaluationError('A JSON request body is required.')
  const [remote, installed] = await Promise.all([
    discoverGithubSkill(body.sourceUrl, optionalString(body.candidatePath), options),
    installedDefinitions(options),
  ])
  const matches = installed
    .map((definition) => publicMatch(definition, compareSkillDefinitions(remote.definition, definition)))
    .sort((left, right) => right.similarity - left.similarity || left.skillId.localeCompare(right.skillId))
    .slice(0, 6)
  const best = matches[0]
  return {
    candidate: publicCandidate(remote.definition),
    candidates: remote.candidates,
    matches,
    recommendation: !best
      ? 'No enabled local Skills were available for comparison.'
      : best.similarity >= 65
        ? `Treat ${best.skillId} as the baseline and run an A/B evaluation before replacing it.`
        : best.similarity >= 25
          ? `Review ${best.skillId} as a possible overlap, then use an A/B task to test the boundary.`
          : 'This candidate appears distinct from the enabled local inventory.',
  }
}

function normalizedAddress(value) {
  const normalized = String(value || '').toLowerCase().replace(/^\[|\]$/g, '')
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
}

function isLoopbackHostname(hostname) {
  const normalized = normalizedAddress(hostname)
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function normalizeBaseUrl(value, label, provider, apiKey) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new EvaluationError(`${label} must be a valid URL.`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new EvaluationError(`${label} must be an HTTP(S) URL without embedded credentials.`)
  }
  if (url.search || url.hash) throw new EvaluationError(`${label} must not include a query string or fragment.`)
  if (url.protocol === 'http:') {
    if (provider === 'ollama' && !apiKey) {
      if (!isLoopbackHostname(url.hostname)) {
        throw new EvaluationError('Ollama HTTP endpoints must use a loopback address such as 127.0.0.1 or localhost.')
      }
    } else {
      throw new EvaluationError(`${label} must use HTTPS so API credentials are not sent in plaintext.`)
    }
  }
  return url.href.replace(/\/+$/, '')
}

function normalizeProvider(config) {
  if (!config || typeof config !== 'object') throw new EvaluationError('AI provider settings are required.')
  const provider = requiredString(config.provider, 'Provider', 40)
  const definition = aiProviderDefinition(provider)
  if (!definition) throw new EvaluationError(`Unsupported AI provider: ${provider}.`)
  const model = optionalString(config.model, 200) || definition.defaultModel
  if (!model) throw new EvaluationError('A model or Azure deployment name is required.')
  const apiKey = optionalString(config.apiKey, 2_000)
  if (definition.requiresKey && !apiKey) throw new EvaluationError(`An API key is required for ${provider}.`)
  const rawBaseUrl = optionalString(config.baseUrl || config.endpoint, 2_000) || definition.defaultBaseUrl
  if (!rawBaseUrl) throw new EvaluationError('An Azure OpenAI endpoint is required.')
  const reasoningEffort = optionalString(config.reasoningEffort, 20)
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new EvaluationError('AI reasoning effort must be none, low, medium, high, xhigh, or max.')
  }
  if (reasoningEffort && definition.transport === 'anthropic') {
    throw new EvaluationError('Reasoning effort is not available through the Anthropic transport.')
  }
  return {
    provider,
    transport: definition.transport,
    model,
    apiKey,
    baseUrl: normalizeBaseUrl(rawBaseUrl, provider === 'azure-openai' ? 'Azure endpoint' : 'Base URL', provider, apiKey),
    apiVersion: optionalString(config.apiVersion, 100) || 'v1',
    reasoningEffort,
  }
}

function responseContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => typeof part === 'string' ? part : part?.text || part?.content || '').join('')
}

function toolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function openAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments || {}) },
        })),
      }
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.content }
    }
    return { role: message.role, content: message.content }
  })
}

function anthropicMessages(messages) {
  const result = []
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      result.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.arguments || {} })),
        ],
      })
    } else if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }
      const previous = result.at(-1)
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((item) => item.type === 'tool_result')) previous.content.push(block)
      else result.push({ role: 'user', content: [block] })
    } else {
      result.push({ role: message.role, content: message.content })
    }
  }
  return result
}

function providerErrorMessage(text, status) {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message || parsed?.message || parsed?.detail
    if (typeof message === 'string') return `AI provider returned ${status}: ${message.slice(0, 500)}`
  } catch {}
  return `AI provider returned ${status}.`
}

export async function callLlmProvider(settings, messages, options = {}) {
  const config = normalizeProvider(settings)
  const fetchImpl = options.fetchImpl || fetch
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let url
  let headers
  let payload
  if (config.transport === 'anthropic') {
    url = `${config.baseUrl}/v1/messages`
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
    payload = {
      model: config.model,
      max_tokens: options.maxTokens || 2_048,
      ...(system ? { system } : {}),
      messages: anthropicMessages(messages),
      ...(options.tools ? { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
    }
    headers = { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
  } else {
    if (options.tools?.length && /^gpt-5\.6(?:-|$)/i.test(config.model) && config.reasoningEffort !== 'none') {
      throw new EvaluationError('GPT-5.6 Chat Completions tools require reasoning effort none. Choose None or use prompt-only mode.')
    }
    let base = config.baseUrl
    if (config.provider === 'azure-openai' && !/\/openai\/v1$/i.test(base)) base = `${base}/openai/v1`
    url = `${base}/chat/completions`
    if (config.provider === 'azure-openai') url += `?api-version=${encodeURIComponent(config.apiVersion)}`
    payload = {
      model: config.model,
      messages: openAiMessages(messages),
      max_tokens: options.maxTokens || 2_048,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      ...(options.tools ? {
        tools: options.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: 'auto',
      } : {}),
    }
    headers = {
      'Content-Type': 'application/json',
      ...(config.provider === 'azure-openai'
        ? { 'api-key': config.apiKey }
        : { Authorization: `Bearer ${config.apiKey || 'ollama'}` }),
      ...(config.provider === 'openrouter' ? { 'X-OpenRouter-Title': 'SkillOps' } : {}),
    }
  }
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal })
    const text = await boundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES, 'AI provider response exceeded the safe size limit.')
    if (!response.ok) throw new EvaluationError(providerErrorMessage(text, response.status), 502)
    let data
    try { data = JSON.parse(text) } catch { throw new EvaluationError('AI provider returned invalid JSON.', 502) }
    const content = config.transport === 'anthropic'
      ? responseContent(data.content)
      : responseContent(data.choices?.[0]?.message?.content)
    const toolCalls = config.transport === 'anthropic'
      ? (Array.isArray(data.content) ? data.content : []).filter((part) => part?.type === 'tool_use').map((part) => ({ id: part.id, name: part.name, arguments: toolArguments(part.input) }))
      : (Array.isArray(data.choices?.[0]?.message?.tool_calls) ? data.choices[0].message.tool_calls : []).map((toolCall) => ({ id: toolCall.id, name: toolCall.function?.name, arguments: toolArguments(toolCall.function?.arguments) }))
    if (!content.trim() && !toolCalls.length) throw new EvaluationError('AI provider returned an empty response.', 502)
    const inputTokens = Number(data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0)
    const outputTokens = Number(data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0)
    return {
      content,
      toolCalls,
      usage: {
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
        totalTokens: Number.isFinite(inputTokens + outputTokens) ? inputTokens + outputTokens : 0,
      },
      provider: config.provider,
      model: config.model,
    }
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    if (controller.signal.aborted) throw new EvaluationError('AI provider request timed out.', 504)
    throw new EvaluationError(error instanceof Error ? `AI provider request failed: ${error.message}` : 'AI provider request failed.', 502)
  } finally {
    clearTimeout(timer)
  }
}

function evaluationPrompt(definition, task, criteria) {
  return [
    {
      role: 'system',
      content: `You are executing a coding-agent Skill in a controlled evaluation. Follow the Skill instructions exactly. Do not discuss the evaluation harness.\n\n<skill-definition>\n${definition.contents}\n</skill-definition>`,
    },
    {
      role: 'user',
      content: `Evaluation task:\n${task}\n\nAcceptance criteria:\n${criteria}\n\nReturn the best final answer the Skill would produce.`,
    },
  ]
}

function judgeResult(text) {
  const normalized = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const objectText = normalized.match(/\{[\s\S]*\}/)?.[0] || normalized
  let parsed
  try { parsed = JSON.parse(objectText) } catch { throw new EvaluationError('The judge model did not return valid JSON. Try another model or rerun the evaluation.', 502) }
  const scoreA = Number(parsed.scoreA)
  const scoreB = Number(parsed.scoreB)
  if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || !['A', 'B', 'tie'].includes(parsed.winner)) {
    throw new EvaluationError('The judge model returned an invalid score payload.', 502)
  }
  const normalizedScoreA = Math.max(0, Math.min(100, Math.round(scoreA)))
  const normalizedScoreB = Math.max(0, Math.min(100, Math.round(scoreB)))
  const scoreWinner = normalizedScoreA === normalizedScoreB ? 'tie' : normalizedScoreA > normalizedScoreB ? 'A' : 'B'
  if (parsed.winner !== scoreWinner) throw new EvaluationError('The judge winner contradicts its normalized scores. Rerun the evaluation.', 502)
  return {
    scoreA: normalizedScoreA,
    scoreB: normalizedScoreB,
    winner: scoreWinner,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 800) : 'No judge rationale was returned.',
  }
}

function stableSwap(value) {
  return [...String(value || '')].reduce((total, char) => total + char.charCodeAt(0), 0) % 2 === 1
}

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
  const [remote, installed] = await Promise.all([
    discoverGithubSkill(body.sourceUrl, optionalString(body.candidatePath), options),
    installedDefinitions(options),
  ])
  if (remote.definition.contentHash !== candidateContentHash) {
    throw new EvaluationError('The candidate changed since analysis. Analyze it again before running the A/B evaluation.', 409)
  }
  const baseline = installed.find((definition) => definition.sourcePath === baselineSourcePath)
  if (!baseline) throw new EvaluationError('The selected baseline is no longer present in the enabled local inventory.', 404)
  const callProvider = options.callProvider || callLlmProvider
  const runVariant = (definition) => mode === 'agent'
    ? runEvaluationAgent(callProvider, providerConfig, evaluationPrompt(definition, task, criteria), options)
    : callProvider(providerConfig, evaluationPrompt(definition, task, criteria), { ...options, maxTokens: 1_800 })
  const runTimedVariant = async (definition) => {
    const started = Date.now()
    const run = await runVariant(definition)
    return { run, durationMs: Date.now() - started }
  }
  const { run: baselineRun, durationMs: baselineDuration } = await runTimedVariant(baseline)
  const { run: candidateRun, durationMs: candidateDuration } = await runTimedVariant(remote.definition)
  const swapped = stableSwap(remote.definition.contentHash)
  const answerA = swapped ? candidateRun.content : baselineRun.content
  const answerB = swapped ? baselineRun.content : candidateRun.content
  const judge = await callProvider(providerConfig, [
    {
      role: 'system',
      content: 'You are an impartial A/B evaluator. Score both answers against the stated task and acceptance criteria. Ignore answer order and writing style unless the criteria require it. Return only JSON with keys winner (A, B, or tie), scoreA (0-100), scoreB (0-100), and reason.',
    },
    {
      role: 'user',
      content: `Task:\n${task}\n\nAcceptance criteria:\n${criteria}\n\nAnswer A:\n${answerA}\n\nAnswer B:\n${answerB}`,
    },
  ], { ...options, maxTokens: 700 })
  const judged = judgeResult(judge.content)
  const baselineScore = swapped ? judged.scoreB : judged.scoreA
  const candidateScore = swapped ? judged.scoreA : judged.scoreB
  const winner = judged.winner === 'tie'
    ? 'tie'
    : (judged.winner === 'A') === swapped ? 'candidate' : 'baseline'
  return {
    id: `eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    mode,
    winner,
    reason: judged.reason,
    baseline: resultSummary(baselineRun, baselineScore, baseline, baselineDuration),
    candidate: resultSummary(candidateRun, candidateScore, remote.definition, candidateDuration),
    judge: { tokens: judge.usage.totalTokens, provider: judge.provider, model: judge.model },
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
      content: `You are the SkillOps assistant. Help the user interpret installed Skill inventory, candidate similarity, and A/B evaluation results. Be precise about evidence: inventory proves installation, not execution; an A/B result covers only its stated task and criteria. Never claim that a Skill was installed, promoted, or changed. Current enabled inventory metadata:\n${JSON.stringify(inventoryContext)}\n\nCurrent evaluation context:\n${JSON.stringify(context || {})}`,
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

function requestHeader(request, name) {
  const headers = request.headers
  if (headers?.get) return headers.get(name)
  return headers?.[name.toLowerCase()]
}

function assertLocalBrowserRequest(request, { requireJsonBody = true } = {}) {
  if (!isLoopbackHostname(request.socket?.remoteAddress)) {
    throw new EvaluationError('Evaluation APIs accept loopback socket peers only.', 403)
  }
  const host = requestHeader(request, 'host')
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    throw new EvaluationError('A valid loopback Host header is required.', 403)
  }
  if (hostUrl.username || hostUrl.password || hostUrl.pathname !== '/' || hostUrl.search || hostUrl.hash || !isLoopbackHostname(hostUrl.hostname)) {
    throw new EvaluationError('Evaluation APIs accept loopback requests only.', 403)
  }
  if (String(requestHeader(request, 'sec-fetch-site') || '').toLowerCase() === 'cross-site') throw new EvaluationError('Cross-site evaluation requests are not allowed.', 403)
  const origin = requestHeader(request, 'origin')
  if (origin) {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      throw new EvaluationError('The request Origin is invalid.', 403)
    }
    if (originUrl.protocol !== 'http:' || !isLoopbackHostname(originUrl.hostname) || originUrl.host !== hostUrl.host) {
      throw new EvaluationError('Cross-origin evaluation requests are not allowed.', 403)
    }
  }
  if (!requireJsonBody) return
  const contentType = requestHeader(request, 'content-type') || ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new EvaluationError('Evaluation requests must use application/json.', 415)
}

async function readJsonBody(request, maxBytes, limitLabel) {
  const declaredLength = Number(requestHeader(request, 'content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new EvaluationError(`Evaluation request body exceeds the ${limitLabel} limit.`, 413)
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBytes) throw new EvaluationError(`Evaluation request body exceeds the ${limitLabel} limit.`, 413)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new EvaluationError('Evaluation request body must contain valid JSON.')
  }
}

async function readEvaluationJsonBody(request) {
  return readJsonBody(request, MAX_EVALUATION_REQUEST_BYTES, '512 KB')
}

async function readAiSettingsJsonBody(request) {
  return readJsonBody(request, MAX_AI_SETTINGS_REQUEST_BYTES, '64 KB')
}

function evaluationHttpError(error) {
  if (error instanceof EvaluationError || error instanceof AiSettingsError) {
    return { status: error.status || 400, message: error.message }
  }
  if (typeof error?.status === 'number' && error.status >= 400 && error.status < 600) {
    return { status: error.status, message: error instanceof Error ? error.message : 'Evaluation request failed' }
  }
  return { status: 500, message: error instanceof Error ? error.message : 'Evaluation request failed' }
}


export async function handleEvaluationApi(request, response, pathname, options = {}) {
  const setJsonHeaders = () => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
  }

  if (pathname === '/api/ai-settings') {
    setJsonHeaders()
    try {
      if (request.method === 'GET') {
        assertLocalBrowserRequest(request, { requireJsonBody: false })
        const read = options.readAiSettings || readAiSettings
        response.end(JSON.stringify(await read()))
        return true
      }
      if (request.method === 'PUT') {
        assertLocalBrowserRequest(request, { requireJsonBody: true })
        const write = options.writeAiSettings || writeAiSettings
        response.end(JSON.stringify(await write(await readAiSettingsJsonBody(request))))
        return true
      }
      response.statusCode = 405
      response.end(JSON.stringify({ error: 'Method not allowed' }))
      return true
    } catch (error) {
      const mapped = evaluationHttpError(error)
      response.statusCode = mapped.status
      response.end(JSON.stringify({ error: mapped.message }))
      return true
    }
  }

  const handlers = {
    '/api/evaluations/compare': analyzeCandidateSkill,
    '/api/evaluations/run': runSkillABTest,
    '/api/assistant/chat': chatWithSkillOps,
  }
  const handler = handlers[pathname]
  if (!handler) return false
  setJsonHeaders()
  if (request.method !== 'POST') {
    response.statusCode = 405
    response.end(JSON.stringify({ error: 'Method not allowed' }))
    return true
  }
  try {
    assertLocalBrowserRequest(request)
    response.end(JSON.stringify(await handler(await readEvaluationJsonBody(request), options)))
  } catch (error) {
    const mapped = evaluationHttpError(error)
    response.statusCode = mapped.status
    response.end(JSON.stringify({ error: mapped.message }))
  }
  return true
}
