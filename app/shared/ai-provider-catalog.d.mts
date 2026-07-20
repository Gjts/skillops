export type AiProviderId = 'openai' | 'gemini' | 'anthropic' | 'azure-openai' | 'ollama' | 'openrouter' | 'minimax' | 'glm' | 'deepseek'

export interface AiProviderCatalogEntry {
  readonly id: AiProviderId
  readonly label: string
  readonly icon: string
  readonly defaultModel: string
  readonly defaultBaseUrl: string
  readonly keyUrl?: string
  readonly requiresKey: boolean
  readonly baseUrlLabel?: string
  readonly transport: 'openai-compatible' | 'anthropic' | 'azure-openai'
}

export const AI_PROVIDER_CATALOG: readonly AiProviderCatalogEntry[]
export const AI_PROVIDER_IDS: readonly AiProviderId[]
export function aiProviderDefinition(providerId: string): AiProviderCatalogEntry | undefined
