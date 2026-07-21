export class EvaluationError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'EvaluationError'
    this.status = status
  }
}

export function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is required.`)
  const normalized = value.trim()
  if (maxLength && normalized.length > maxLength) throw new EvaluationError(`${label} is too long.`)
  return normalized
}

export function optionalString(value, maxLength = 2_000) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new EvaluationError('Configuration fields must be strings.')
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new EvaluationError('A configuration field is too long.')
  return normalized || undefined
}
