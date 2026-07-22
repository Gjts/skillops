import { EvaluationError } from './errors.mjs'

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export function normalizePromptVariableName(value) {
  if (typeof value !== 'string' || !VARIABLE_NAME.test(value) || value.split('.').some((part) => UNSAFE_SEGMENTS.has(part))) {
    throw new EvaluationError('Prompt variable name is unsafe.', 422)
  }
  return value
}

export function promptVariableNames(...contents) {
  const names = []
  const expression = /{{\s*([A-Za-z][A-Za-z0-9_.-]{0,99})\s*}}/g
  for (const content of contents) {
    if (typeof content !== 'string') continue
    for (const match of content.matchAll(expression)) names.push(normalizePromptVariableName(match[1]))
  }
  return [...new Set(names)].sort()
}

export function renderPromptVariables(record, supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new EvaluationError('Prompt variables must be an object.', 422)
  const normalized = Object.create(null)
  for (const [key, value] of Object.entries(record.prompt.variableDefaults || {})) {
    const name = normalizePromptVariableName(key)
    if (value === null) continue
    if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) {
      throw new EvaluationError(`Prompt variable default ${name} must be a scalar value.`, 422)
    }
    normalized[name] = String(value)
  }
  for (const [key, value] of Object.entries(supplied)) {
    const name = normalizePromptVariableName(key)
    if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) {
      throw new EvaluationError(`Prompt variable ${name} must be a scalar value.`, 422)
    }
    normalized[name] = String(value)
  }
  const missing = (record.artifact.variables || []).filter((name) => normalized[name] === undefined)
  if (missing.length) throw new EvaluationError(`Prompt variables are missing: ${missing.join(', ')}.`, 422)
  const replace = (text) => text.replace(/{{\s*([A-Za-z][A-Za-z0-9_.-]{0,99})\s*}}/g, (_match, name) => normalized[name] ?? _match)
  return {
    ...record,
    prompt: {
      ...record.prompt,
      system: replace(record.prompt.system || ''),
      ...(record.prompt.messages ? { messages: record.prompt.messages.map((message) => ({ ...message, content: replace(message.content) })) } : {}),
      ...(record.prompt.template !== undefined ? { template: replace(record.prompt.template) } : {}),
    },
  }
}
