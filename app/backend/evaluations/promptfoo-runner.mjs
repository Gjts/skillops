import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { normalizePromptfooEvaluation } from './evaluation-normalizer.mjs'
import { EvaluationError } from './errors.mjs'
import { parseBlindJudgeResult } from './evaluation-judge.mjs'
import { normalizeProvider } from './provider-client.mjs'
import { PROMPTFOO_VERSION, runPromptfooIsolated } from './promptfoo-runtime.mjs'

export function compilePromptfooSuite(suite) {
  if (!suite || !Array.isArray(suite.cases) || !suite.cases.length) throw new EvaluationError('A normalized evaluation Suite is required.', 422)
  const repeats = suite.repeats || 1
  const tests = suite.cases.flatMap((testCase) => Array.from({ length: repeats }, (_, repeat) => ({
    vars: {
      input: testCase.input,
      __skillopsCaseId: testCase.id,
      __skillopsRepeat: repeat,
    },
    assert: testCase.assertions.map((assertion) => ({
      type: assertion.type,
      ...(assertion.value !== undefined ? { value: assertion.value } : {}),
      metric: assertion.label,
    })),
    metadata: { skillopsCaseId: testCase.id, skillopsRepeat: repeat },
  })))
  return {
    prompts: ['{{input}}'],
    tests,
    writeLatestResults: false,
    sharing: false,
  }
}

function contentForAudit(record) {
  if (typeof record?.contents === 'string') return record.contents
  if (record?.prompt) return JSON.stringify(record.prompt)
  return ''
}

export async function runPromptfooSuite(input, options = {}) {
  if (!input || typeof input !== 'object') throw new EvaluationError('A managed evaluation run is required.', 422)
  const baseline = normalizeArtifactDefinition(input.baseline?.artifact)
  const candidate = normalizeArtifactDefinition(input.candidate?.artifact)
  if (baseline.kind !== input.suite.artifactKind || candidate.kind !== input.suite.artifactKind) {
    throw new EvaluationError('Suite artifact kind does not match the selected baseline and candidate.', 422)
  }
  const provider = normalizeProvider(input.provider)
  const startedAt = new Date().toISOString()
  const { result: raw, runtimeAudit } = await runPromptfooIsolated({
    operation: 'suite',
    suite: input.suite,
    baseline: input.baseline,
    candidate: input.candidate,
    provider,
    fakeOutputs: options.fakeOutputs,
  }, {
    runtimeRoot: options.runtimeRoot,
    signal: options.signal,
    forbiddenValues: {
      apiKey: provider.apiKey,
      baselineContent: contentForAudit(input.baseline),
      candidateContent: contentForAudit(input.candidate),
    },
    auditResultStrings: true,
  })
  return {
    ...normalizePromptfooEvaluation(raw, {
      runId: input.runId,
      mode: input.mode || 'suite',
      capabilityId: input.capabilityId,
      suite: input.suite,
      baseline,
      candidate,
      provider,
      engineVersion: PROMPTFOO_VERSION,
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      startedAt,
    }),
    runtimeAudit,
  }
}

function quickVariant(result, definition, score) {
  if (!result || typeof result.response?.output !== 'string') throw new EvaluationError('Promptfoo returned an invalid Quick Compare variant.', 502)
  const usage = result.response.tokenUsage
  return {
    skillId: definition.skillId,
    skillVersion: definition.skillVersion,
    score,
    durationMs: typeof result.latencyMs === 'number' && Number.isFinite(result.latencyMs) ? result.latencyMs : 0,
    tokens: typeof usage?.total === 'number' && Number.isFinite(usage.total) ? usage.total : 0,
    output: result.response.output,
  }
}

export async function runPromptfooQuickCompare(input, options = {}) {
  const provider = normalizeProvider(input.provider)
  const createdAt = new Date().toISOString()
  const { result: raw, runtimeAudit } = await runPromptfooIsolated({
    operation: 'quick',
    task: input.task,
    criteria: input.criteria,
    mode: input.mode,
    baseline: input.baseline,
    candidate: input.candidate,
    provider,
    workspaceRoot: options.workspaceRoot,
    fakeOutputs: options.fakeOutputs,
  }, {
    runtimeRoot: options.runtimeRoot,
    signal: options.signal,
    forbiddenValues: {
      apiKey: provider.apiKey,
      task: input.task,
      criteria: input.criteria,
      baselineContent: contentForAudit(input.baseline),
      candidateContent: contentForAudit(input.candidate),
    },
    auditResultStrings: true,
  })
  if (runtimeAudit.forbiddenMatches.length) throw new EvaluationError('Promptfoo privacy audit found evaluation content in its runtime directory.', 500)
  const baselineRaw = raw.variants?.results?.find((result) => result.provider?.id === 'skillops:baseline')
  const candidateRaw = raw.variants?.results?.find((result) => result.provider?.id === 'skillops:candidate')
  const judgeRaw = raw.judge?.results?.[0]
  const judged = parseBlindJudgeResult(judgeRaw?.response?.output || '')
  const baselineScore = raw.swapped ? judged.scoreB : judged.scoreA
  const candidateScore = raw.swapped ? judged.scoreA : judged.scoreB
  const winner = judged.winner === 'tie'
    ? 'tie'
    : (judged.winner === 'A') === raw.swapped ? 'candidate' : 'baseline'
  const judgeUsage = judgeRaw?.response?.tokenUsage
  return {
    id: input.runId,
    createdAt,
    mode: input.mode,
    winner,
    reason: judged.reason,
    baseline: quickVariant(baselineRaw, input.baseline, baselineScore),
    candidate: quickVariant(candidateRaw, input.candidate, candidateScore),
    judge: {
      tokens: typeof judgeUsage?.total === 'number' && Number.isFinite(judgeUsage.total) ? judgeUsage.total : 0,
      provider: provider.provider,
      model: provider.model,
    },
    engine: { name: 'promptfoo', version: PROMPTFOO_VERSION },
    privacy: 'Task text, acceptance criteria, generated answers, and chat were not written to disk by SkillOps. Saved AI provider settings may exist in local data/ai-settings.json.',
  }
}

function strictRedteamGrade(value) {
  let grade
  try { grade = JSON.parse(value) } catch { throw new EvaluationError('Promptfoo Red Team grader returned invalid JSON.', 502) }
  if (!grade || typeof grade !== 'object' || Array.isArray(grade) || typeof grade.pass !== 'boolean') {
    throw new EvaluationError('Promptfoo Red Team grader returned an invalid verdict.', 502)
  }
  if (typeof grade.score !== 'number' || !Number.isFinite(grade.score) || grade.score < 0 || grade.score > 1) {
    throw new EvaluationError('Promptfoo Red Team grader returned an invalid score.', 502)
  }
  if (typeof grade.reason !== 'string' || !grade.reason.trim() || grade.reason.length > 1_000) {
    throw new EvaluationError('Promptfoo Red Team grader returned an invalid reason.', 502)
  }
  if (!['critical', 'high', 'medium', 'low', 'none'].includes(grade.severity)) {
    throw new EvaluationError('Promptfoo Red Team grader returned an invalid severity.', 502)
  }
  return grade
}

function reportedMetric(results, getter, reported) {
  if (results.some((result) => !reported(result))) return null
  return results.reduce((total, result) => total + getter(result), 0)
}

function redteamP95(results) {
  const values = results.map((result) => result.latencyMs)
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null
  return [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * 0.95) - 1)]
}

export async function runPromptfooRedteam(input, options = {}) {
  if (!input || typeof input !== 'object') throw new EvaluationError('A managed Red Team run is required.', 422)
  const baseline = normalizeArtifactDefinition(input.baseline?.artifact)
  const candidate = normalizeArtifactDefinition(input.candidate?.artifact)
  const provider = normalizeProvider(input.provider)
  const startedAt = new Date().toISOString()
  const { result: raw, runtimeAudit } = await runPromptfooIsolated({
    operation: 'redteam',
    baseline: input.baseline,
    candidate: input.candidate,
    provider,
    fakeRedteam: options.fakeRedteam,
  }, {
    runtimeRoot: options.runtimeRoot,
    signal: options.signal,
    forbiddenValues: {
      apiKey: provider.apiKey,
      baselineContent: contentForAudit(input.baseline),
      candidateContent: contentForAudit(input.candidate),
    },
    auditResultStrings: true,
  })
  if (!Array.isArray(raw?.probes) || raw.probes.length !== 4 || !Array.isArray(raw.targets?.results) || !Array.isArray(raw.judges?.results)) {
    throw new EvaluationError('Promptfoo returned an invalid Red Team result.', 502)
  }
  const targets = new Map(raw.targets.results.map((result) => [result.vars?.__skillopsRedteamId, result]))
  const judges = new Map(raw.judges.results.map((result) => [result.vars?.__skillopsRedteamId, result]))
  const cases = raw.probes.map((probe) => {
    const target = targets.get(probe.id)
    const judge = judges.get(probe.id)
    if (!target || !judge || typeof target.response?.output !== 'string' || typeof judge.response?.output !== 'string') {
      throw new EvaluationError(`Promptfoo Red Team result is incomplete for ${probe.id}.`, 502)
    }
    const grade = strictRedteamGrade(judge.response.output)
    return {
      id: `${probe.id}:1`,
      caseId: probe.id,
      repeat: 1,
      weight: 1,
      baseline: { pass: false, score: null, assertions: [] },
      candidate: {
        pass: grade.pass,
        score: grade.score * 100,
        assertions: [{ label: probe.id, type: 'redteam', blocking: true, pass: grade.pass, score: grade.score * 100 }],
      },
      severity: probe.severity,
      target,
      judge,
    }
  })
  const findings = cases.filter((item) => !item.candidate.pass)
  const allResults = [...targets.values(), ...judges.values()]
  const tokens = reportedMetric(allResults, (result) => result.response.tokenUsage.total, (result) => result.response?.metadata?.skillopsTokenUsageReported !== false && typeof result.response?.tokenUsage?.total === 'number')
  const cost = reportedMetric(allResults, (result) => result.cost ?? result.response.cost, (result) => result.response?.metadata?.skillopsCostReported === true && typeof (result.cost ?? result.response?.cost) === 'number')
  const requestedAt = input.requestedAt || new Date().toISOString()
  const completedAt = new Date().toISOString()
  return {
    summary: {
      id: input.runId,
      mode: 'redteam',
      status: 'completed',
      capabilityId: input.capabilityId,
      suiteId: input.suite?.id || 'skillops-redteam-v1',
      suiteVersion: input.suite?.version || '1.0.0',
      suiteHash: input.suite?.suiteHash || null,
      datasetHash: input.suite?.datasetHash || null,
      baseline,
      candidate,
      engine: { name: 'promptfoo', version: PROMPTFOO_VERSION },
      provider: { id: provider.provider, model: provider.model },
      metrics: {
        baselineScore: null,
        candidateScore: cases.filter((item) => item.candidate.pass).length / cases.length * 100,
        scoreDeltaPp: null,
        casesPassed: cases.filter((item) => item.candidate.pass).length,
        casesTotal: cases.length,
        passRatePct: cases.filter((item) => item.candidate.pass).length / cases.length * 100,
        regressionRatePct: null,
        baselineTokens: null,
        candidateTokens: tokens,
        baselineCostUsd: null,
        candidateCostUsd: cost,
        costDeltaPct: null,
        baselineP95LatencyMs: null,
        candidateP95LatencyMs: redteamP95([...targets.values()]),
        latencyDeltaPct: null,
        attackSuccessRatePct: findings.length / cases.length * 100,
        criticalFindings: findings.filter((item) => item.severity === 'critical').length,
        highFindings: findings.filter((item) => item.severity === 'high').length,
      },
      evidenceHash: null,
      gateResult: 'not-evaluated',
      requestedBy: input.requestedBy,
      requestedAt,
      startedAt,
      completedAt,
      errorCode: null,
    },
    cases: cases.map(({ severity: _severity, target: _target, judge: _judge, ...item }) => item),
    runtimeAudit,
  }
}
