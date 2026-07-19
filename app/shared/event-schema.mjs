const eventNames = new Set([
  'skill.discovered', 'skill.matched', 'skill.started', 'skill.completed', 'skill.failed', 'skill.skipped',
  'session.started', 'session.completed', 'turn.completed', 'prompt.submitted', 'tool.started', 'tool.completed',
  'subagent.started', 'subagent.completed',
])
const runtimes = new Set(['codex', 'claude-code', 'cursor'])
const outcomes = new Set(['success', 'failed', 'unknown'])
const sources = new Set(['global', 'project', 'plugin'])
const kinds = new Set(['skill', 'command'])
const detectionMethods = new Set(['explicit_prompt', 'slash_command', 'skill_tool', 'skill_path', 'manual', 'hook'])
const allowedFields = new Set([
  'id', 'event', 'skillId', 'skillVersion', 'runtime', 'timestamp', 'durationMs', 'costUsd', 'tokens',
  'sessionId', 'project', 'sourcePath', 'source', 'error', 'turnId', 'promptId', 'model', 'toolName',
  'toolUseId', 'subagentType', 'subagentId', 'permissionMode', 'outcome', 'detectionMethod', 'confidence',
  'promptLength', 'skillArgsLength', 'commandSource', 'reason', 'startSource', 'provider', 'kind', 'enabled',
  'description', 'tags',
])
const numericFields = ['durationMs', 'costUsd', 'tokens', 'confidence', 'promptLength', 'skillArgsLength']
const stringFields = [
  'skillId', 'skillVersion', 'sessionId', 'project', 'sourcePath', 'error', 'turnId', 'promptId', 'model',
  'toolName', 'toolUseId', 'subagentType', 'subagentId', 'permissionMode', 'commandSource', 'reason',
  'startSource', 'provider', 'description',
]

function randomId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `event-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Event body must be an object.')
  const event = value
  if (!eventNames.has(event.event)) throw new Error('Unknown or unsupported event name.')
  if (!runtimes.has(event.runtime)) throw new Error('Unknown or unsupported runtime.')
  if (event.event.startsWith('skill.') && (typeof event.skillId !== 'string' || !event.skillId.trim())) {
    throw new Error('skillId is required for Skill events.')
  }
  if (event.id !== undefined && (typeof event.id !== 'string' || !event.id.trim())) throw new Error('id must be a non-empty string.')
  if (event.timestamp !== undefined && (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp)))) {
    throw new Error('invalid timestamp: timestamp must be a valid date string.')
  }
  for (const field of stringFields) {
    if (event[field] !== undefined && typeof event[field] !== 'string') throw new Error(`${field} must be a string.`)
  }
  for (const field of numericFields) {
    if (event[field] !== undefined && (typeof event[field] !== 'number' || !Number.isFinite(event[field]))) {
      throw new Error(`${field} must be a finite number.`)
    }
  }
  if (event.tags !== undefined && (!Array.isArray(event.tags) || event.tags.some((tag) => typeof tag !== 'string'))) {
    throw new Error('tags must be an array of strings.')
  }
  if (event.enabled !== undefined && typeof event.enabled !== 'boolean') throw new Error('enabled must be a boolean.')
  if (event.source !== undefined && !sources.has(event.source)) throw new Error('source is unsupported.')
  if (event.kind !== undefined && !kinds.has(event.kind)) throw new Error('kind is unsupported.')
  if (event.detectionMethod !== undefined && !detectionMethods.has(event.detectionMethod)) throw new Error('detectionMethod is unsupported.')
  if (event.outcome !== undefined && !outcomes.has(event.outcome)) throw new Error('outcome is unsupported.')
  if (event.event === 'skill.completed' && event.outcome === 'failed') {
    throw new Error('skill.completed outcome must be success or unknown.')
  }
  if (event.event === 'skill.failed' && event.outcome !== undefined && event.outcome !== 'failed') {
    throw new Error('skill.failed outcome must be failed.')
  }

  const normalized = Object.fromEntries(Object.entries(event).filter(([key]) => allowedFields.has(key)))
  normalized.id = event.id?.trim() || randomId()
  normalized.timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()
  if (event.event === 'skill.completed') normalized.outcome = event.outcome ?? 'unknown'
  if (event.event === 'skill.failed') normalized.outcome = 'failed'
  return normalized
}

export function normalizeEvents(value) {
  if (!Array.isArray(value)) throw new Error('The selected file must contain an event array or JSONL records.')
  return value.map((event, index) => {
    try {
      return normalizeEvent(event)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid event.'
      throw new Error(`Event ${index + 1}: ${message}`)
    }
  })
}
