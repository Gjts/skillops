import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeArtifactDefinition } from '../app/shared/evaluation-schema.mjs'
import { createArtifactResolver } from '../app/backend/evaluations/artifact-resolver.mjs'
import { createEvaluationManager } from '../app/backend/evaluations/evaluation-manager.mjs'
import { computeEvaluationEvidenceHash, createEvaluationStore } from '../app/backend/evaluations/evaluation-store.mjs'
import { EvaluationError } from '../app/backend/evaluations/errors.mjs'
import { renderEvaluationHtmlReport } from '../app/backend/evaluations/evaluation-report.mjs'
import { createSuiteRegistry } from '../app/backend/evaluations/suite-registry.mjs'
import { DEFAULT_GATE_POLICY, evidenceIsStale } from '../app/backend/governance/capability-policy.mjs'
import { flags } from './cli-flags.mjs'

function required(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || !value.trim()) throw new EvaluationError(`Missing required --${name}.`, 422)
  return value.trim()
}

function fixtureArtifact(id, version, contents) {
  return {
    artifact: normalizeArtifactDefinition({
      kind: 'skill',
      artifactId: id,
      version,
      source: 'local-scan',
      sourceRef: `local-scan:deterministic-fixture#${id}`,
      contentHash: createHash('sha256').update(contents, 'utf8').digest('hex'),
    }),
    contents,
  }
}

function deterministicInputs(suite, baselineRef, candidateRef) {
  if (suite.id !== 'deterministic-smoke') throw new EvaluationError('--deterministic is limited to the deterministic-smoke suite.', 422)
  const outputs = Object.fromEntries(suite.cases.map((testCase) => [testCase.id, { output: 'Lifecycle completion is an observation.', tokens: { total: 4, prompt: 2, completion: 2 }, delayMs: 100 }]))
  const candidateOutputs = Object.fromEntries(suite.cases.map((testCase) => [testCase.id, { output: 'Evidence is required before a lifecycle completion can be called successful.', tokens: { total: 5, prompt: 2, completion: 3 }, delayMs: 1 }]))
  return {
    baseline: fixtureArtifact(baselineRef, '1.0.0', 'Deterministic baseline fixture.'),
    candidate: fixtureArtifact(candidateRef, '2.0.0', 'Deterministic candidate fixture.'),
    provider: { provider: 'ollama', model: 'deterministic-fixture', baseUrl: 'http://127.0.0.1:11434/v1' },
    runnerOptions: { fakeOutputs: { baseline: outputs, candidate: candidateOutputs } },
  }
}

async function contentAuditInputs(suite, baselineRef, candidateRef, artifacts) {
  const [baseline, candidate] = await Promise.all([artifacts.resolve(baselineRef), artifacts.resolve(candidateRef)])
  return {
    baseline,
    candidate,
    provider: { provider: 'ollama', model: 'content-audit', baseUrl: 'http://127.0.0.1:11434/v1' },
    runnerOptions: { contentAudit: true },
  }
}

function configuredProvider(options, environment) {
  if (options['api-key']) throw new EvaluationError('Use --api-key-env or SKILLOPS_EVAL_API_KEY instead of putting a key on the command line.', 422)
  const provider = required(options, 'provider')
  const variable = typeof options['api-key-env'] === 'string' ? options['api-key-env'] : 'SKILLOPS_EVAL_API_KEY'
  return {
    provider,
    model: typeof options.model === 'string' ? options.model : environment.SKILLOPS_EVAL_MODEL,
    apiKey: environment[variable],
    baseUrl: typeof options['base-url'] === 'string' ? options['base-url'] : environment.SKILLOPS_EVAL_BASE_URL,
    reasoningEffort: typeof options['reasoning-effort'] === 'string' ? options['reasoning-effort'] : undefined,
  }
}

async function waitForTerminal(store, runId) {
  for (;;) {
    const run = await store.getRun(runId)
    if (!run) throw new EvaluationError('Evaluation run disappeared from the local store.', 500)
    if (store.isTerminal(run.status)) return run
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

async function writeSanitizedArtifacts(summary, cases, options) {
  if (typeof options.summary === 'string') {
    const file = path.resolve(options.summary)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
  if (typeof options.junit === 'string') {
    const file = path.resolve(options.junit)
    await mkdir(path.dirname(file), { recursive: true })
    const failures = cases.filter((item) => !item.candidate.pass).length
    const testcases = cases.map((item) => `  <testcase classname="${xml(summary.suiteId || summary.mode)}" name="${xml(item.caseId)}">${item.candidate.pass ? '' : '<failure message="Candidate case failed" />'}</testcase>`).join('\n')
    await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SkillOps" tests="${cases.length}" failures="${failures}">\n${testcases}\n</testsuite>\n`, 'utf8')
  }
  if (typeof options.html === 'string') {
    const file = path.resolve(options.html)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, renderEvaluationHtmlReport(summary, cases), 'utf8')
  }
}

export async function evaluationList(options = {}) {
  const suites = options.suites || createSuiteRegistry(options)
  return suites.list()
}

export async function evaluationRun(args, dependencies = {}) {
  const options = flags(args)
  const suites = dependencies.suites || createSuiteRegistry(dependencies)
  const store = dependencies.store || createEvaluationStore(dependencies)
  const suite = await suites.get(required(options, 'suite'))
  const baselineRef = required(options, 'baseline')
  const candidateRef = required(options, 'candidate')
  const deterministic = options.deterministic === true
  const contentAudit = options['content-audit'] === true
  if (deterministic && contentAudit) throw new EvaluationError('--deterministic and --content-audit cannot be combined.', 422)
  const artifacts = dependencies.artifacts || createArtifactResolver(dependencies)
  const inputs = deterministic
    ? deterministicInputs(suite, baselineRef, candidateRef)
    : contentAudit
      ? await contentAuditInputs(suite, baselineRef, candidateRef, artifacts)
      : {
          baseline: await artifacts.resolve(baselineRef),
          candidate: await artifacts.resolve(candidateRef),
          provider: configuredProvider(options, dependencies.environment || process.env),
          runnerOptions: {},
        }
  const manager = dependencies.manager || createEvaluationManager({ store, runner: dependencies.runner, policy: dependencies.policy })
  await manager.initialize()
  const created = await manager.enqueue({
    mode: options.mode === 'redteam' ? 'redteam' : 'suite',
    suite,
    baseline: inputs.baseline,
    candidate: inputs.candidate,
    provider: inputs.provider,
    requestedBy: typeof options['requested-by'] === 'string' ? options['requested-by'] : 'skillops-cli',
    clientRequestId: typeof options['request-id'] === 'string' ? options['request-id'] : undefined,
    subjectHash: typeof options['subject-hash'] === 'string' ? options['subject-hash'] : undefined,
    timeoutMs: options['timeout-ms'] === undefined ? undefined : Number(options['timeout-ms']),
  }, inputs.runnerOptions)
  const summary = await waitForTerminal(store, created.summary.id)
  const cases = await store.getCases(summary.id)
  await writeSanitizedArtifacts(summary, cases, options)
  return summary
}

export async function evaluationVerify(args, dependencies = {}) {
  const options = flags(args)
  const runId = required(options, 'run')
  const store = dependencies.store || createEvaluationStore(dependencies)
  const summary = await store.getRun(runId)
  if (!summary) throw new EvaluationError('Evaluation run was not found.', 404)
  const validHash = summary.evidenceHash && summary.evidenceHash === computeEvaluationEvidenceHash({ ...summary, evidenceHash: null })
  const stale = evidenceIsStale(summary, dependencies.policy || DEFAULT_GATE_POLICY)
  return {
    ok: summary.status === 'completed' && summary.gateResult === 'passed' && Boolean(validHash) && !stale,
    runId,
    status: summary.status,
    gateResult: summary.gateResult,
    evidenceHashValid: Boolean(validHash),
    stale,
  }
}
