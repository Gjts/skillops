import { AI_PROVIDER_CATALOG, type AiProviderId } from '../../../../shared/ai-provider-catalog.mjs'

export type { AiProviderId } from '../../../../shared/ai-provider-catalog.mjs'

export type ReasoningEffort = '' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AiProviderConfig {
  apiKey: string
  model: string
  baseUrl: string
  apiVersion?: string
  reasoningEffort: ReasoningEffort
}

export interface AiSettings {
  activeProvider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
}

export const AI_PROVIDERS = AI_PROVIDER_CATALOG

const defaults = Object.fromEntries(AI_PROVIDERS.map((provider) => [provider.id, {
  apiKey: '',
  model: provider.defaultModel,
  baseUrl: provider.defaultBaseUrl,
  reasoningEffort: '',
  ...(provider.id === 'azure-openai' ? { apiVersion: 'v1' } : {}),
}])) as Record<AiProviderId, AiProviderConfig>

export function createDefaultAiSettings(): AiSettings {
  return {
    activeProvider: 'gemini',
    providers: structuredClone(defaults),
  }
}

export function activeProviderRequest(settings: AiSettings) {
  const config = settings.providers[settings.activeProvider]
  return { provider: settings.activeProvider, ...config }
}

export function providerIsConfigured(settings: AiSettings) {
  const definition = AI_PROVIDERS.find((provider) => provider.id === settings.activeProvider)!
  const config = settings.providers[settings.activeProvider]
  return Boolean(config.model.trim() && config.baseUrl.trim() && (!definition.requiresKey || config.apiKey.trim()))
}
