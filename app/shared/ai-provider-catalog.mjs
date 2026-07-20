export const AI_PROVIDER_CATALOG = Object.freeze([
  { id: 'openai', label: 'OpenAI', icon: '🤖', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', requiresKey: true, transport: 'openai-compatible' },
  { id: 'gemini', label: 'Google Gemini', icon: '💎', defaultModel: 'gemini-3.5-flash', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/app/apikey', requiresKey: true, transport: 'openai-compatible' },
  { id: 'anthropic', label: 'Anthropic', icon: '🧠', defaultModel: 'claude-sonnet-4-6', defaultBaseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys', requiresKey: true, transport: 'anthropic' },
  { id: 'azure-openai', label: 'Azure OpenAI', icon: '☁️', defaultModel: '', defaultBaseUrl: '', keyUrl: 'https://portal.azure.com', requiresKey: true, baseUrlLabel: 'Azure endpoint', transport: 'azure-openai' },
  { id: 'ollama', label: 'Ollama (Local)', icon: '🦙', defaultModel: 'llama3.2', defaultBaseUrl: 'http://127.0.0.1:11434/v1', requiresKey: false, transport: 'openai-compatible' },
  { id: 'openrouter', label: 'OpenRouter', icon: '🌐', defaultModel: 'openai/gpt-4o-mini', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys', requiresKey: true, transport: 'openai-compatible' },
  { id: 'minimax', label: 'MiniMax', icon: '⚡', defaultModel: 'MiniMax-M2.7', defaultBaseUrl: 'https://api.minimax.io/v1', keyUrl: 'https://platform.minimax.io', requiresKey: true, transport: 'openai-compatible' },
  { id: 'glm', label: 'GLM (Z.AI)', icon: '🔮', defaultModel: 'GLM-5', defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list', requiresKey: true, transport: 'openai-compatible' },
  { id: 'deepseek', label: 'DeepSeek', icon: '🐋', defaultModel: 'deepseek-v4-flash', defaultBaseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', requiresKey: true, transport: 'openai-compatible' },
].map(Object.freeze))

export const AI_PROVIDER_IDS = Object.freeze(AI_PROVIDER_CATALOG.map((provider) => provider.id))

export function aiProviderDefinition(providerId) {
  return AI_PROVIDER_CATALOG.find((provider) => provider.id === providerId)
}
