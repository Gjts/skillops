import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AI_PROVIDER_CATALOG, AI_PROVIDER_IDS } from '../shared/ai-provider-catalog.mjs'

const SETTINGS_VERSION = 1
const MAX_FIELD_CHARS = 2_000
const REASONING_EFFORTS = new Set(['', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])

// Resolve at module load so tests can import a cache-busted copy after setting SKILLOPS_DATA_DIR.
const dataDir = path.resolve(process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
export const aiSettingsFile = path.join(dataDir, 'ai-settings.json')

export class AiSettingsError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'AiSettingsError'
    this.status = status
  }
}

function defaultProviderConfig(provider) {
  return {
    apiKey: '',
    model: provider.defaultModel,
    baseUrl: provider.defaultBaseUrl,
    reasoningEffort: '',
    ...(provider.id === 'azure-openai' ? { apiVersion: 'v1' } : {}),
  }
}

export function createDefaultAiSettings() {
  return {
    version: SETTINGS_VERSION,
    activeProvider: 'gemini',
    providers: Object.fromEntries(AI_PROVIDER_CATALOG.map((provider) => [provider.id, defaultProviderConfig(provider)])),
  }
}

function readString(value, label, { strict, allowEmpty = true } = {}) {
  if (value === undefined || value === null) {
    if (strict && !allowEmpty) throw new AiSettingsError(`${label} is required.`)
    return ''
  }
  if (typeof value !== 'string') {
    if (strict) throw new AiSettingsError(`${label} must be a string.`)
    return null
  }
  if (value.length > MAX_FIELD_CHARS) {
    if (strict) throw new AiSettingsError(`${label} is too long.`)
    return null
  }
  return value
}

function normalizeProviderConfig(providerId, value, defaults, { strict }) {
  if (value === undefined || value === null) return { ...defaults }
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new AiSettingsError(`Provider configuration for ${providerId} must be an object.`)
    return null
  }

  const apiKey = readString(value.apiKey, `${providerId} API key`, { strict })
  const model = readString(value.model, `${providerId} model`, { strict })
  const baseUrl = readString(value.baseUrl, `${providerId} base URL`, { strict })
  const reasoningEffort = readString(value.reasoningEffort, `${providerId} reasoning effort`, { strict })
  if (apiKey === null || model === null || baseUrl === null || reasoningEffort === null) return null
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    if (strict) throw new AiSettingsError(`${providerId} reasoning effort is invalid.`)
    return null
  }

  const normalized = {
    apiKey,
    model,
    baseUrl,
    reasoningEffort,
  }

  if (providerId === 'azure-openai') {
    const apiVersion = readString(value.apiVersion, 'Azure API version', { strict })
    if (apiVersion === null) return null
    normalized.apiVersion = apiVersion || defaults.apiVersion || 'v1'
  }

  return normalized
}

export function normalizeAiSettings(input, { strict = false } = {}) {
  const defaults = createDefaultAiSettings()
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (strict) throw new AiSettingsError('AI settings must be a JSON object.')
    return defaults
  }

  if (strict) {
    if (input.version !== undefined && input.version !== SETTINGS_VERSION) {
      throw new AiSettingsError('Unsupported AI settings version.')
    }
  } else if (input.version !== undefined && input.version !== SETTINGS_VERSION) {
    return defaults
  }

  const activeProvider = input.activeProvider
  if (typeof activeProvider !== 'string' || !AI_PROVIDER_IDS.includes(activeProvider)) {
    if (strict) throw new AiSettingsError('A known active provider is required.')
    return defaults
  }

  if (input.providers !== undefined && (typeof input.providers !== 'object' || Array.isArray(input.providers) || input.providers === null)) {
    if (strict) throw new AiSettingsError('Provider settings must be an object.')
    return defaults
  }

  const sourceProviders = input.providers && typeof input.providers === 'object' && !Array.isArray(input.providers)
    ? input.providers
    : {}

  const providers = {}
  for (const provider of AI_PROVIDER_CATALOG) {
    const normalized = normalizeProviderConfig(
      provider.id,
      sourceProviders[provider.id],
      defaults.providers[provider.id],
      { strict },
    )
    if (normalized === null) return defaults
    providers[provider.id] = normalized
  }

  return {
    version: SETTINGS_VERSION,
    activeProvider,
    providers,
  }
}

export async function readAiSettings() {
  try {
    const contents = await readFile(aiSettingsFile, 'utf8')
    return normalizeAiSettings(JSON.parse(contents), { strict: false })
  } catch (error) {
    if (error?.code === 'ENOENT') return createDefaultAiSettings()
    return createDefaultAiSettings()
  }
}

export async function writeAiSettings(input) {
  const normalized = normalizeAiSettings(input, { strict: true })
  await mkdir(dataDir, { recursive: true })
  const temporary = `${aiSettingsFile}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  await rename(temporary, aiSettingsFile)
  return normalized
}
