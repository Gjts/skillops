import { EvaluationError } from './errors.mjs'

export const SUITE_SCHEMA_VERSION = 1
export const MAX_SUITE_CASES = 200
export const MAX_SUITE_REPEATS = 5
export const MAX_MATRIX_MODELS = 8
export const MAX_EVALUATION_CELLS = 2_000
export const ALLOWED_ASSERTION_TYPES = Object.freeze([
  'contains', 'not-contains', 'icontains', 'regex', 'is-json', 'json-schema', 'llm-rubric', 'cost', 'latency',
])

const assertionTypes = new Set(ALLOWED_ASSERTION_TYPES)
const artifactKinds = new Set(['skill', 'prompt', 'workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack'])
const sensitivities = new Set(['synthetic', 'sanitized'])

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new EvaluationError(`${label} must be an object.`, 422)
  }
  return value
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`${label} is required.`, 422)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new EvaluationError(`${label} is too long.`, 422)
  return normalized
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, label, maxLength)
}

function identifier(value, label) {
  const normalized = requiredText(value, label, 120)
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(normalized)) throw new EvaluationError(`${label} contains unsupported characters.`, 422)
  return normalized
}

function assertSafeData(value, label, depth = 0) {
  if (depth > 20) throw new EvaluationError(`${label} is too deeply nested.`, 422)
  if (Array.isArray(value)) {
    for (const item of value) assertSafeData(item, label, depth + 1)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new EvaluationError(`${label} contains an unsafe key.`, 422)
    assertSafeData(child, label, depth + 1)
  }
}

function normalizeRegex(value, label = 'Regex assertion') {
  const pattern = requiredText(value, `${label} value`, 500)
  if (/\\[1-9]/.test(pattern) || /\(\?<([=!])/.test(pattern) || /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) || /\.\*.*\.\*/.test(pattern)) {
    throw new EvaluationError(`${label} is too complex.`, 422)
  }
  try { new RegExp(pattern, 'u') } catch { throw new EvaluationError(`${label} is invalid.`, 422) }
  return pattern
}

function normalizeAssertion(value, caseId, index) {
  const assertion = plainObject(value, `Assertion ${index + 1} in case ${caseId}`)
  onlyKeys(assertion, new Set(['type', 'value', 'label', 'blocking']), `Assertion ${index + 1} in case ${caseId}`)
  const type = requiredText(assertion.type, 'Assertion type', 40)
  if (!assertionTypes.has(type)) throw new EvaluationError(`Assertion type ${type} is not allowed by Suite Schema v1.`, 422)
  let normalizedValue
  if (['contains', 'not-contains', 'icontains'].includes(type)) normalizedValue = requiredText(assertion.value, `${type} assertion value`, 4_000)
  else if (type === 'regex') normalizedValue = normalizeRegex(assertion.value)
  else if (type === 'llm-rubric') normalizedValue = requiredText(assertion.value, 'LLM rubric', 4_000)
  else if (type === 'json-schema') {
    normalizedValue = plainObject(assertion.value, 'JSON schema assertion value')
    assertSafeData(normalizedValue, 'JSON schema assertion value')
    if (Buffer.byteLength(JSON.stringify(normalizedValue), 'utf8') > 32_000) throw new EvaluationError('JSON schema assertion value is too large.', 422)
  } else if (['cost', 'latency'].includes(type)) {
    if (typeof assertion.value !== 'number' || !Number.isFinite(assertion.value) || assertion.value < 0) {
      throw new EvaluationError(`${type} assertion value must be a non-negative finite number.`, 422)
    }
    normalizedValue = assertion.value
  } else if (assertion.value !== undefined) {
    throw new EvaluationError(`${type} assertion does not accept a value.`, 422)
  }
  if (assertion.blocking !== undefined && typeof assertion.blocking !== 'boolean') throw new EvaluationError('Assertion blocking must be a boolean.', 422)
  return {
    type,
    ...(normalizedValue !== undefined ? { value: normalizedValue } : {}),
    label: optionalText(assertion.label, 'Assertion label', 200) || `${type}-${index + 1}`,
    blocking: assertion.blocking ?? true,
  }
}

function normalizeCase(value, index) {
  const testCase = plainObject(value, `Suite case ${index + 1}`)
  onlyKeys(testCase, new Set(['id', 'input', 'weight', 'variables', 'assertions']), `Suite case ${index + 1}`)
  const id = identifier(testCase.id, `Suite case ${index + 1} ID`)
  const input = requiredText(testCase.input, `Input for case ${id}`, 20_000)
  if (/^(?:exec:|file:\/\/)/i.test(input)) throw new EvaluationError(`Input for case ${id} uses a forbidden executable source.`, 422)
  const weight = testCase.weight === undefined ? 1 : testCase.weight
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100) throw new EvaluationError(`Weight for case ${id} must be between 0 and 100.`, 422)
  if (!Array.isArray(testCase.assertions) || !testCase.assertions.length || testCase.assertions.length > 50) {
    throw new EvaluationError(`Case ${id} must contain between 1 and 50 assertions.`, 422)
  }
  let variables
  if (testCase.variables !== undefined) {
    const input = plainObject(testCase.variables, `Variables for case ${id}`)
    if (Object.keys(input).length > 100) throw new EvaluationError(`Variables for case ${id} exceed the 100-variable limit.`, 422)
    variables = {}
    for (const [key, value] of Object.entries(input)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key) || key.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new EvaluationError(`Variables for case ${id} contain an unsafe name.`, 422)
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new EvaluationError(`Variable ${key} for case ${id} must be a scalar value.`, 422)
      variables[key] = value
    }
  }
  return { id, input, weight, ...(variables ? { variables } : {}), assertions: testCase.assertions.map((assertion, assertionIndex) => normalizeAssertion(assertion, id, assertionIndex)) }
}

function normalizeCases(value, label) {
  if (!Array.isArray(value) || !value.length) throw new EvaluationError(`${label} must contain at least one case.`, 422)
  if (value.length > MAX_SUITE_CASES) throw new EvaluationError(`${label} exceeds the ${MAX_SUITE_CASES}-case limit.`, 413)
  const cases = value.map(normalizeCase)
  const ids = new Set()
  for (const testCase of cases) {
    if (ids.has(testCase.id)) throw new EvaluationError(`Duplicate suite case ID: ${testCase.id}.`, 422)
    ids.add(testCase.id)
  }
  return cases
}

function normalizeRedaction(value) {
  if (value === undefined) return undefined
  const redaction = plainObject(value, 'Suite redaction')
  onlyKeys(redaction, new Set(['task', 'input', 'output']), 'Suite redaction')
  const normalized = {}
  for (const scope of ['task', 'input', 'output']) {
    if (redaction[scope] === undefined) continue
    if (!Array.isArray(redaction[scope]) || !redaction[scope].length || redaction[scope].length > 20) {
      throw new EvaluationError(`Suite redaction ${scope} must contain between 1 and 20 rules.`, 422)
    }
    normalized[scope] = redaction[scope].map((value, index) => {
      const label = `Redaction ${scope} rule ${index + 1}`
      const rule = plainObject(value, label)
      onlyKeys(rule, new Set(['pattern', 'replacement']), label)
      return {
        pattern: normalizeRegex(rule.pattern, `${label} pattern`),
        replacement: optionalText(rule.replacement, `${label} replacement`, 200) || '[REDACTED]',
      }
    })
  }
  if (!Object.keys(normalized).length) throw new EvaluationError('Suite redaction requires at least one scoped rule.', 422)
  return normalized
}

function normalizeMatrix(value) {
  if (value === undefined) return undefined
  const matrix = plainObject(value, 'Evaluation matrix')
  onlyKeys(matrix, new Set(['models']), 'Evaluation matrix')
  if (!Array.isArray(matrix.models) || !matrix.models.length || matrix.models.length > MAX_MATRIX_MODELS) {
    throw new EvaluationError(`Evaluation matrix models must contain between 1 and ${MAX_MATRIX_MODELS} entries.`, 422)
  }
  const models = matrix.models.map((value, index) => {
    const model = plainObject(value, `Evaluation matrix model ${index + 1}`)
    onlyKeys(model, new Set(['id', 'model']), `Evaluation matrix model ${index + 1}`)
    return {
      id: identifier(model.id, `Evaluation matrix model ${index + 1} ID`),
      model: requiredText(model.model, `Evaluation matrix model ${index + 1} name`, 200),
    }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new EvaluationError('Evaluation matrix model IDs must be unique.', 422)
  return { models }
}

export function assertEvaluationMatrixSize(suite, cases) {
  const cells = cases.length * suite.repeats * (suite.matrix?.models.length || 1) * 2
  if (cells > MAX_EVALUATION_CELLS) throw new EvaluationError('Evaluation matrix exceeds the 2,000-cell limit.', 413)
}


export function normalizeSuiteDataset(value) {
  const dataset = plainObject(value, 'Suite dataset')
  onlyKeys(dataset, new Set(['schemaVersion', 'id', 'cases']), 'Suite dataset')
  if (dataset.schemaVersion !== SUITE_SCHEMA_VERSION) throw new EvaluationError('Suite dataset schemaVersion must be 1.', 422)
  return { schemaVersion: 1, id: identifier(dataset.id, 'Dataset ID'), cases: normalizeCases(dataset.cases, 'Suite dataset') }
}

export function normalizeEvaluationSuite(value) {
  const suite = plainObject(value, 'Evaluation suite')
  onlyKeys(suite, new Set(['schemaVersion', 'id', 'name', 'version', 'owner', 'sensitivity', 'artifactKind', 'repeats', 'matrix', 'cases', 'dataset', 'redaction']), 'Evaluation suite')
  if (suite.schemaVersion !== SUITE_SCHEMA_VERSION) throw new EvaluationError('Evaluation suite schemaVersion must be 1.', 422)
  const sensitivity = requiredText(suite.sensitivity, 'Suite sensitivity', 40)
  if (!sensitivities.has(sensitivity)) throw new EvaluationError('Suite sensitivity must be synthetic or sanitized.', 422)
  const artifactKind = requiredText(suite.artifactKind, 'Suite artifact kind', 20)
  if (!artifactKinds.has(artifactKind)) throw new EvaluationError('Suite artifact kind is unsupported.', 422)
  const repeats = suite.repeats === undefined ? 1 : suite.repeats
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_SUITE_REPEATS) throw new EvaluationError(`Suite repeats must be between 1 and ${MAX_SUITE_REPEATS}.`, 422)
  const matrix = normalizeMatrix(suite.matrix)
  const dataset = optionalText(suite.dataset, 'Suite dataset path', 500)
  if (dataset && (pathIsAbsolute(dataset) || dataset.split(/[\\/]+/).some((part) => part === '..') || !/\.json$/i.test(dataset))) {
    throw new EvaluationError('Suite dataset path must be a relative JSON path inside evals/datasets.', 422)
  }
  if (dataset && suite.cases !== undefined) throw new EvaluationError('Evaluation suite must use either inline cases or one dataset, not both.', 422)
  if (!dataset && suite.cases === undefined) throw new EvaluationError('Evaluation suite requires inline cases or a dataset.', 422)
  const redaction = normalizeRedaction(suite.redaction)
  const normalized = {
    schemaVersion: 1,
    id: identifier(suite.id, 'Suite ID'),
    name: requiredText(suite.name, 'Suite name', 200),
    version: requiredText(suite.version, 'Suite version', 100),
    owner: requiredText(suite.owner, 'Suite owner', 200),
    sensitivity,
    artifactKind,
    repeats,
    ...(matrix ? { matrix } : {}),
    ...(redaction ? { redaction } : {}),
    ...(dataset ? { dataset: dataset.replace(/\\/g, '/') } : { cases: normalizeCases(suite.cases, 'Evaluation suite') }),
  }
  if (normalized.cases) assertEvaluationMatrixSize(normalized, normalized.cases)
  return normalized
}

function pathIsAbsolute(value) {
  return /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)
}
