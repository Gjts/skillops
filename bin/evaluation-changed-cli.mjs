import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { computeEvaluationEvidenceHash } from '../app/backend/evaluations/evaluation-store.mjs'
import { classifyGitArtifactPath, createGitArtifactSource } from '../app/backend/evaluations/git-artifact-source.mjs'
import { EvaluationError } from '../app/backend/evaluations/errors.mjs'
import { normalizeEvaluationSuite } from '../app/backend/evaluations/suite-schema.mjs'
import { sha256Json } from '../app/backend/evaluations/suite-registry.mjs'
import { flags } from './cli-flags.mjs'
import { evaluationRun } from './evaluation-cli.mjs'

const execute = promisify(execFile)
const SUITES = Object.freeze({
  skill: 'deterministic-smoke',
  prompt: 'local-prompt-quality',
  workflow: 'ci-workflow-quality',
  rules: 'ci-rules-quality',
  agent: 'ci-agent-quality',
  'evaluation-suite': 'ci-evaluation-suite-quality',
  'policy-pack': 'ci-policy-pack-quality',
})
const BOOTSTRAP_SUITE = 'local-prompt-quality'

function revision(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes('..') || value.includes('@{')) {
    throw new EvaluationError(`${label} is invalid.`, 422)
  }
  return value
}

async function gitChangedPaths(workspace, base, head) {
  try {
    const result = await execute('git', ['-C', workspace, 'diff', '--name-status', '--find-renames', '-z', '--diff-filter=ADMRT', base, head, '--'], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const fields = result.stdout.split('\0')
    const changed = []
    for (let index = 0; index < fields.length && fields[index];) {
      const status = fields[index++]
      const baselinePath = fields[index++]
      if (/^R\d+$/.test(status)) changed.push({ baselinePath, path: fields[index++] })
      else changed.push({ baselinePath, path: baselinePath })
    }
    return changed
  } catch {
    throw new EvaluationError('Changed Artifact paths could not be resolved from Git.', 409)
  }
}

function artifactPathsForChange(changedPath, items) {
  const paths = new Set()
  if (classifyGitArtifactPath(changedPath)) paths.add(changedPath)
  for (const item of items) {
    if (item.artifact.kind !== 'skill') continue
    const root = path.posix.dirname(item.relativePath)
    if (root === '.' || changedPath === item.relativePath || changedPath.startsWith(`${root}/`)) paths.add(item.relativePath)
  }
  return [...paths]
}

function governedChanges(rawChanges, baseState, headState) {
  const changes = new Map()
  for (const raw of rawChanges) {
    const change = typeof raw === 'string' ? { path: raw, baselinePath: raw } : raw
    const candidatePaths = artifactPathsForChange(change.path, headState.items)
    const baselinePaths = artifactPathsForChange(change.baselinePath, baseState.items)
    if (!candidatePaths.length) {
      for (const baselinePath of baselinePaths) changes.set(change.path, { path: change.path, baselinePath })
      continue
    }
    for (const candidatePath of candidatePaths) {
      const baselinePath = baselinePaths.includes(candidatePath)
        ? candidatePath
        : baselinePaths.find((item) => item === change.baselinePath)
          || baselinePaths[0]
          || change.baselinePath
      changes.set(candidatePath, { path: candidatePath, baselinePath })
    }
  }
  return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path))
}

async function fixedSuiteAtBase(source, baseState, suiteId, artifactKind) {
  let item = baseState.items.find((candidate) => candidate.artifact.kind === 'evaluation-suite'
    && candidate.artifact.artifactId === suiteId)
  const bootstrapped = !item && suiteId !== BOOTSTRAP_SUITE
  if (bootstrapped) {
    item = baseState.items.find((candidate) => candidate.artifact.kind === 'evaluation-suite'
      && candidate.artifact.artifactId === BOOTSTRAP_SUITE)
  }
  if (!item || item.artifact.gitCommit !== baseState.commit) {
    throw new EvaluationError(`Fixed CI Suite ${suiteId} was not found at the base commit.`, 409)
  }
  const resolved = await source.resolveArtifact(item.artifact.sourceRef)
  if (!resolved || resolved.artifact.sourceRef !== item.artifact.sourceRef
    || resolved.artifact.contentHash !== item.artifact.contentHash
    || resolved.artifact.gitCommit !== baseState.commit) {
    throw new EvaluationError(`Fixed CI Suite ${suiteId} is not pinned to the base commit.`, 409)
  }
  let raw
  try { raw = JSON.parse(resolved.contents) } catch {
    throw new EvaluationError(`Fixed CI Suite ${suiteId} contains invalid JSON.`, 409)
  }
  let suite = normalizeEvaluationSuite(raw)
  if (bootstrapped) {
    if (suite.id !== BOOTSTRAP_SUITE || suite.artifactKind !== 'prompt' || suite.dataset) {
      throw new EvaluationError(`Fixed CI Suite ${suiteId} has no valid base bootstrap Suite.`, 409)
    }
    suite = normalizeEvaluationSuite({
      ...suite,
      id: suiteId,
      artifactKind,
      repeats: Math.max(2, suite.repeats),
      // ponytail: first-rollout schema gate only; the base-pinned dedicated Suite replaces it after merge.
      ...(artifactKind === 'evaluation-suite' ? {
        cases: [{
          id: 'suite-schema',
          input: 'Validate the exact Evaluation Suite schema.',
          weight: 1,
          assertions: [
            { type: 'contains', value: 'schemaVersion', label: 'has-schema-version' },
            { type: 'contains', value: 'artifactKind', label: 'has-artifact-kind' },
          ],
        }],
      } : {}),
    })
  }
  if (suite.id !== suiteId || suite.artifactKind !== artifactKind || suite.dataset) {
    throw new EvaluationError(`Fixed CI Suite ${suiteId} does not match the changed Artifact kind or uses an external dataset.`, 409)
  }
  return { ...suite, suiteHash: sha256Json(suite), datasetHash: null, datasetId: null }
}

export async function evaluationChanged(args, dependencies = {}) {
  const options = flags(args)
  const base = revision(options.base, 'Evaluation base revision')
  const head = revision(typeof options.head === 'string' ? options.head : 'HEAD', 'Evaluation head revision')
  const source = dependencies.gitSource || createGitArtifactSource(dependencies)
  const rawChanges = await (dependencies.changedPaths || gitChangedPaths)(source.workspace || process.cwd(), base, head)
  const [baseState, headState] = await Promise.all([source.list({ revision: base }), source.list({ revision: head })])
  const changes = governedChanges(rawChanges, baseState, headState)
  if (changes.length > 100) throw new EvaluationError('A single CI evaluation may contain at most 100 changed Artifacts.', 422)
  const baselineByPath = new Map(baseState.items.map((item) => [item.relativePath, item]))
  const candidateByPath = new Map(headState.items.map((item) => [item.relativePath, item]))
  const outputDir = path.resolve(typeof options['output-dir'] === 'string' ? options['output-dir'] : 'artifacts/changed-evaluations')
  const runEvaluation = dependencies.evaluationRun || evaluationRun
  const evaluated = []
  const fixedSuites = new Map()

  for (const [index, change] of changes.entries()) {
    const { path: relativePath, baselinePath } = change
    const candidate = candidateByPath.get(relativePath)
    if (!candidate) throw new EvaluationError(`Changed Artifact ${relativePath} could not be resolved at the head commit.`, 409)
    if (candidate.artifact.gitCommit !== headState.commit) throw new EvaluationError(`Changed Artifact ${relativePath} is not pinned to the head commit.`, 409)
    if (candidate.artifact.kind === 'evaluation-suite') {
      const resolvedCandidate = await source.resolveArtifact(candidate.artifact.sourceRef)
      if (!resolvedCandidate || resolvedCandidate.artifact.sourceRef !== candidate.artifact.sourceRef
        || resolvedCandidate.artifact.contentHash !== candidate.artifact.contentHash
        || resolvedCandidate.artifact.gitCommit !== headState.commit) {
        throw new EvaluationError(`Changed Evaluation Suite ${relativePath} is not pinned to the head commit.`, 409)
      }
      try {
        const candidateSuite = normalizeEvaluationSuite(JSON.parse(resolvedCandidate.contents))
        if (candidateSuite.id !== candidate.artifact.artifactId) throw new Error('Suite ID mismatch')
      } catch {
        throw new EvaluationError(`Changed Evaluation Suite ${relativePath} is invalid.`, 409)
      }
    }
    const baseline = baselineByPath.get(baselinePath)
    const suiteId = SUITES[candidate.artifact.kind]
    if (!suiteId) throw new EvaluationError(`Changed Artifact ${relativePath} has no fixed CI Suite.`, 409)
    let suite = fixedSuites.get(suiteId)
    if (!suite) {
      suite = await fixedSuiteAtBase(source, baseState, suiteId, candidate.artifact.kind)
      fixedSuites.set(suiteId, suite)
    }
    const prefix = path.join(outputDir, String(index + 1).padStart(3, '0'))
    const summary = await runEvaluation([
      '--suite', suiteId,
      '--baseline', (baseline || candidate).artifact.sourceRef,
      '--candidate', candidate.artifact.sourceRef,
      '--content-audit',
      '--requested-by', 'skillops-ci',
      '--summary', `${prefix}-summary.json`,
      '--junit', `${prefix}-junit.xml`,
      '--html', `${prefix}-report.html`,
    ], {
      ...dependencies,
      suites: { get: async (requestedId) => {
        if (requestedId !== suite.id) throw new EvaluationError('Evaluation requested a different CI Suite.', 409)
        return suite
      } },
      artifacts: { resolve: source.resolveArtifact },
    })
    if (summary.candidate?.contentHash !== candidate.artifact.contentHash || summary.candidate?.sourceRef !== candidate.artifact.sourceRef) {
      throw new EvaluationError(`Changed Artifact ${relativePath} candidate hash does not match its evaluation evidence.`, 409)
    }
    if (summary.suiteId !== suite.id || summary.suiteVersion !== suite.version
      || summary.suiteHash !== suite.suiteHash || summary.datasetHash !== suite.datasetHash) {
      throw new EvaluationError(`Changed Artifact ${relativePath} evidence is not pinned to the base CI Suite.`, 409)
    }
    if (summary.status !== 'completed' || summary.gateResult !== 'passed'
      || summary.evidenceHash !== computeEvaluationEvidenceHash({ ...summary, evidenceHash: null })) {
      throw new EvaluationError(`Changed Artifact ${relativePath} failed its fixed CI Suite.`, 409)
    }
    evaluated.push({
      path: relativePath,
      ...(baselinePath === relativePath ? {} : { baselinePath }),
      kind: candidate.artifact.kind,
      contentHash: candidate.artifact.contentHash,
      sourceRef: candidate.artifact.sourceRef,
      suiteId,
      suiteHash: suite.suiteHash,
      runId: summary.id,
      evidenceHash: summary.evidenceHash,
    })
  }

  return { baseCommit: baseState.commit, headCommit: headState.commit, evaluated }
}
