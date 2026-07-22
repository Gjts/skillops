import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { EvaluationError } from './errors.mjs'

function finite(value, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new EvaluationError(`${label} is invalid in the Promptfoo result.`, 502)
  }
  return value
}

function optionalMetric(value, label) {
  if (value === undefined || value === null) return null
  return finite(value, label)
}

function percentDelta(current, baseline) {
  if (current === null || baseline === null || baseline === 0) return null
  return ((current - baseline) / baseline) * 100
}

function average(values) {
  const weight = values.reduce((total, item) => total + item.weight, 0)
  return weight ? values.reduce((total, item) => total + item.value * item.weight, 0) / weight : null
}

function sumNullable(values) {
  return values.some((value) => value === null) ? null : values.reduce((total, value) => total + value, 0)
}

function p95(values) {
  if (values.some((value) => value === null) || !values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

function variantFromProvider(result, models) {
  const id = result?.provider?.id
  if (id === 'skillops:baseline') return { variant: 'baseline', matrixId: null }
  if (id === 'skillops:candidate') return { variant: 'candidate', matrixId: null }
  const match = /^skillops:matrix:([^:]+):(baseline|candidate)$/.exec(id)
  if (!match || !models.some((model) => model.id === match[1])) {
    throw new EvaluationError('Promptfoo returned an unknown baseline/candidate provider.', 502)
  }
  return { variant: match[2], matrixId: match[1] }
}

function metricFromResponse(result, type) {
  const metadata = result.response?.metadata
  if (type === 'tokens') {
    const usage = result.response?.tokenUsage
    if (metadata?.skillopsTokenUsageReported === false || !usage) return null
    return finite(usage.total, 'Token usage')
  }
  if (type === 'cost') {
    if (metadata?.skillopsCostReported !== true) return null
    return optionalMetric(result.cost ?? result.response?.cost, 'Cost')
  }
  return optionalMetric(result.latencyMs, 'Latency')
}

function normalizeVariantResult(result, testCase) {
  const score = finite(result.score, 'Case score', { max: 1 }) * 100
  const components = result.gradingResult?.componentResults
  if (!Array.isArray(components) || components.length !== testCase.assertions.length) {
    throw new EvaluationError(`Promptfoo assertion results do not match case ${testCase.id}.`, 502)
  }
  const assertions = components.map((component, index) => ({
    label: testCase.assertions[index].label,
    type: testCase.assertions[index].type,
    blocking: testCase.assertions[index].blocking,
    pass: Boolean(component?.pass),
    score: finite(component?.score, `Assertion score for ${testCase.id}`, { max: 1 }) * 100,
  }))
  return {
    pass: assertions.filter((assertion) => assertion.blocking).every((assertion) => assertion.pass),
    score,
    tokens: metricFromResponse(result, 'tokens'),
    costUsd: metricFromResponse(result, 'cost'),
    latencyMs: metricFromResponse(result, 'latency'),
    assertions,
  }
}

export function normalizePromptfooEvaluation(raw, context) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.results)) throw new EvaluationError('Promptfoo returned an invalid evaluation summary.', 502)
  const suite = context.suite
  if (!suite || !Array.isArray(suite.cases) || !suite.cases.length) throw new EvaluationError('A normalized Suite is required.', 500)
  const repeats = suite.repeats || 1
  const models = suite.matrix?.models || [{ id: null, model: context.provider.model }]
  const casesById = new Map(suite.cases.map((testCase) => [testCase.id, testCase]))
  const variants = new Map()
  for (const result of raw.results) {
    const caseId = result?.vars?.__skillopsCaseId
    const repeat = result?.vars?.__skillopsRepeat
    if (!casesById.has(caseId) || !Number.isInteger(repeat) || repeat < 0 || repeat >= repeats) {
      throw new EvaluationError('Promptfoo returned an unknown case identity.', 502)
    }
    const { variant, matrixId } = variantFromProvider(result, models)
    const key = `${matrixId || ''}:${caseId}:${repeat}:${variant}`
    if (variants.has(key)) throw new EvaluationError(`Promptfoo returned duplicate case result ${key}.`, 502)
    variants.set(key, normalizeVariantResult(result, casesById.get(caseId)))
  }

  const caseSummaries = []
  for (const model of models) {
    for (const testCase of suite.cases) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const prefix = `${model.id || ''}:${testCase.id}:${repeat}`
        const baseline = variants.get(`${prefix}:baseline`)
        const candidate = variants.get(`${prefix}:candidate`)
        if (!baseline || !candidate) throw new EvaluationError(`Promptfoo baseline/candidate cases do not match for ${testCase.id}.`, 502)
        caseSummaries.push({
          id: model.id ? `${model.id}:${testCase.id}:${repeat + 1}` : `${testCase.id}:${repeat + 1}`,
          caseId: testCase.id,
          repeat: repeat + 1,
          weight: testCase.weight,
          ...(model.id ? { matrixId: model.id, model: model.model } : {}),
          baseline,
          candidate,
        })
      }
    }
  }
  if (variants.size !== caseSummaries.length * 2) throw new EvaluationError('Promptfoo returned unexpected extra case results.', 502)

  const baselineScore = average(caseSummaries.map((item) => ({ value: item.baseline.score, weight: item.weight })))
  const candidateScore = average(caseSummaries.map((item) => ({ value: item.candidate.score, weight: item.weight })))
  const baselinePassed = caseSummaries.filter((item) => item.baseline.pass)
  const candidatePassed = caseSummaries.filter((item) => item.candidate.pass)
  const criticalFindings = caseSummaries.reduce((total, item) =>
    total + item.candidate.assertions.filter((assertion) => assertion.blocking && !assertion.pass).length, 0)
  const regressions = baselinePassed.filter((item) => !item.candidate.pass).length
  const baselineTokens = sumNullable(caseSummaries.map((item) => item.baseline.tokens))
  const candidateTokens = sumNullable(caseSummaries.map((item) => item.candidate.tokens))
  const baselineCostUsd = sumNullable(caseSummaries.map((item) => item.baseline.costUsd))
  const candidateCostUsd = sumNullable(caseSummaries.map((item) => item.candidate.costUsd))
  const baselineP95LatencyMs = p95(caseSummaries.map((item) => item.baseline.latencyMs))
  const candidateP95LatencyMs = p95(caseSummaries.map((item) => item.candidate.latencyMs))
  const requestedAt = context.requestedAt || new Date().toISOString()
  const completedAt = context.completedAt || new Date().toISOString()
  return {
    summary: {
      id: context.runId,
      mode: context.mode || 'suite',
      status: 'completed',
      capabilityId: context.capabilityId,
      suiteId: suite.id,
      suiteVersion: suite.version,
      suiteHash: suite.suiteHash,
      datasetHash: suite.datasetHash,
      baseline: normalizeArtifactDefinition(context.baseline),
      candidate: normalizeArtifactDefinition(context.candidate),
      engine: { name: 'promptfoo', version: context.engineVersion },
      provider: suite.matrix
        ? { id: context.provider.id || context.provider.provider, model: models.length === 1 ? models[0].model : 'matrix', models: models.map((model) => model.model) }
        : { id: context.provider.id || context.provider.provider, model: context.provider.model },
      metrics: {
        baselineScore,
        candidateScore,
        scoreDeltaPp: candidateScore - baselineScore,
        casesPassed: candidatePassed.length,
        casesTotal: caseSummaries.length,
        passRatePct: caseSummaries.length ? candidatePassed.length / caseSummaries.length * 100 : null,
        regressionRatePct: baselinePassed.length ? regressions / baselinePassed.length * 100 : null,
        baselineTokens,
        candidateTokens,
        baselineCostUsd,
        candidateCostUsd,
        costDeltaPct: percentDelta(candidateCostUsd, baselineCostUsd),
        baselineP95LatencyMs,
        candidateP95LatencyMs,
        latencyDeltaPct: percentDelta(candidateP95LatencyMs, baselineP95LatencyMs),
        criticalFindings,
        highFindings: 0,
      },
      evidenceHash: null,
      gateResult: 'not-evaluated',
      requestedBy: context.requestedBy,
      requestedAt,
      startedAt: context.startedAt || requestedAt,
      completedAt,
      errorCode: null,
    },
    cases: caseSummaries,
  }
}
