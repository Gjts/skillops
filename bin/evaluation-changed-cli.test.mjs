// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeEvaluationEvidenceHash, createEvaluationStore } from '../app/backend/evaluations/evaluation-store.mjs'
import { createGitArtifactSource, gitArtifactSourceRef } from '../app/backend/evaluations/git-artifact-source.mjs'
import { evaluationChanged } from './evaluation-changed-cli.mjs'

const repository = 'https://github.com/acme/skillops'
const baseCommit = 'a'.repeat(40)
const headCommit = 'b'.repeat(40)
const execute = promisify(execFile)
const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function git(root, ...args) {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}

function item(commit, contentHash) {
  const relativePath = 'skills/review/SKILL.md'
  return {
    relativePath,
    artifact: {
      kind: 'skill',
      artifactId: 'review',
      version: '1.0.0',
      source: 'git',
      sourceRef: gitArtifactSourceRef(repository, commit, relativePath, contentHash),
      contentHash,
      gitCommit: commit,
      repository,
    },
  }
}
function suiteItem(commit, id = 'deterministic-smoke', artifactKind = 'skill', assertion = 'evidence') {
  const relativePath = `evals/suites/${id}.json`
  const contents = JSON.stringify({
    schemaVersion: 1,
    id,
    name: `${artifactKind} CI gate`,
    version: '1.0.0',
    owner: 'skillops-maintainers',
    sensitivity: 'synthetic',
    artifactKind,
    repeats: 2,
    cases: [{
      id: 'candidate-evidence',
      input: 'Validate immutable candidate evidence.',
      weight: 1,
      assertions: [
        { type: 'icontains', value: assertion, label: 'base-gate', blocking: false },
        { type: 'not-contains', value: 'API_KEY', label: 'no-secret-placeholder' },
      ],
    }],
  })
  const contentHash = (assertion === 'evidence' ? '8' : '9').repeat(64)
  return {
    relativePath,
    contents,
    artifact: {
      kind: 'evaluation-suite',
      artifactId: id,
      version: '1.0.0',
      source: 'git',
      sourceRef: gitArtifactSourceRef(repository, commit, relativePath, contentHash),
      contentHash,
      gitCommit: commit,
      repository,
    },
  }
}

function summary(candidate, baseline) {
  const value = {
    id: 'run-candidate',
    mode: 'suite',
    status: 'completed',
    suiteId: 'deterministic-smoke',
    suiteVersion: '1.0.0',
    suiteHash: 'c'.repeat(64),
    datasetHash: null,
    baseline: baseline.artifact,
    candidate: candidate.artifact,
    engine: { name: 'promptfoo', version: '0.121.19' },
    provider: { id: 'ollama', model: 'content-audit' },
    metrics: { baselineScore: 50, candidateScore: 100, scoreDeltaPp: 50, casesPassed: 2, casesTotal: 2, passRatePct: 100, regressionRatePct: 0, baselineTokens: 10, candidateTokens: 10, baselineCostUsd: null, candidateCostUsd: null, costDeltaPct: null, baselineP95LatencyMs: 100, candidateP95LatencyMs: 1, latencyDeltaPct: -99, criticalFindings: 0, highFindings: 0 },
    policyHash: 'd'.repeat(64),
    gates: [{ id: 'pass-rate', status: 'passed', blocking: true }],
    evidenceHash: null,
    gateResult: 'passed',
    requestedBy: 'ci',
    requestedAt: '2026-07-21T00:00:00.000Z',
    startedAt: '2026-07-21T00:00:01.000Z',
    completedAt: '2026-07-21T00:00:02.000Z',
    errorCode: null,
  }
  value.evidenceHash = computeEvaluationEvidenceHash(value)
  return value
}

describe('changed Artifact evaluation gate', () => {
  it('evaluates the exact immutable head candidate and rejects mismatched evidence', async () => {
    const baseline = item(baseCommit, '1'.repeat(64))
    const candidate = item(headCommit, '2'.repeat(64))
    const baseSuite = suiteItem(baseCommit)
    const poisonedSuite = suiteItem(headCommit, 'deterministic-smoke', 'skill', 'NEVER_MATCH')
    const source = {
      list: vi.fn(async ({ revision }) => revision === 'base'
        ? { commit: baseCommit, items: [baseline, baseSuite], warnings: [] }
        : { commit: headCommit, items: [candidate, poisonedSuite], warnings: [] }),
      resolveArtifact: vi.fn(async (sourceRef) => [baseSuite, poisonedSuite].find((item) => item.artifact.sourceRef === sourceRef)),
    }
    let forged = false
    const run = vi.fn(async (_args, runtimeDependencies) => {
      const pinnedSuite = await runtimeDependencies.suites.get('deterministic-smoke')
      expect(pinnedSuite.cases[0].assertions[0].value).toBe('evidence')
      const result = { ...summary(candidate, baseline), suiteVersion: pinnedSuite.version, suiteHash: pinnedSuite.suiteHash, datasetHash: pinnedSuite.datasetHash }
      result.evidenceHash = computeEvaluationEvidenceHash({ ...result, evidenceHash: null })
      return forged ? { ...result, candidate: baseline.artifact } : result
    })
    const dependencies = {
      gitSource: source,
      changedPaths: vi.fn(async () => [candidate.relativePath]),
      evaluationRun: run,
    }

    await expect(evaluationChanged(['--base', 'base', '--head', 'head', '--output-dir', 'artifacts'], dependencies)).resolves.toMatchObject({
      baseCommit,
      headCommit,
      evaluated: [{ path: candidate.relativePath, contentHash: candidate.artifact.contentHash, suiteId: 'deterministic-smoke' }],
    })
    expect(run.mock.calls[0][0]).toEqual(expect.arrayContaining([
      '--candidate', candidate.artifact.sourceRef,
      '--content-audit',
    ]))

    forged = true
    await expect(evaluationChanged(['--base', 'base', '--head', 'head'], dependencies)).rejects.toThrow('candidate hash')
  })

  it('evaluates a Skill when only a file inside its package changes', async () => {
    const baseline = item(baseCommit, '1'.repeat(64))
    const candidate = item(headCommit, '2'.repeat(64))
    const baseSuite = suiteItem(baseCommit)
    const run = vi.fn(async (_args, runtimeDependencies) => {
      const suite = await runtimeDependencies.suites.get('deterministic-smoke')
      const result = {
        ...summary(candidate, baseline),
        suiteVersion: suite.version,
        suiteHash: suite.suiteHash,
        datasetHash: suite.datasetHash,
      }
      result.evidenceHash = computeEvaluationEvidenceHash({ ...result, evidenceHash: null })
      return result
    })

    await expect(evaluationChanged(['--base', 'base', '--head', 'head'], {
      gitSource: {
        list: vi.fn(async ({ revision }) => revision === 'base'
          ? { commit: baseCommit, items: [baseline, baseSuite], warnings: [] }
          : { commit: headCommit, items: [candidate], warnings: [] }),
        resolveArtifact: vi.fn(async () => baseSuite),
      },
      changedPaths: vi.fn(async () => ['skills/review/scripts/check.mjs']),
      evaluationRun: run,
    })).resolves.toMatchObject({
      evaluated: [{ path: 'skills/review/SKILL.md', contentHash: candidate.artifact.contentHash }],
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('bootstraps a new Evaluation Suite gate from the exact base Prompt Suite', async () => {
    const baseSuite = suiteItem(baseCommit, 'local-prompt-quality', 'prompt')
    const candidate = suiteItem(headCommit, 'custom-suite', 'skill')
    const run = vi.fn(async (_args, runtimeDependencies) => {
      const suite = await runtimeDependencies.suites.get('ci-evaluation-suite-quality')
      expect(suite).toMatchObject({
        id: 'ci-evaluation-suite-quality',
        artifactKind: 'evaluation-suite',
        repeats: 2,
        cases: [{
          assertions: [
            { type: 'contains', value: 'schemaVersion' },
            { type: 'contains', value: 'artifactKind' },
          ],
        }],
      })
      const result = {
        ...summary(candidate, candidate),
        suiteId: suite.id,
        suiteVersion: suite.version,
        suiteHash: suite.suiteHash,
        datasetHash: suite.datasetHash,
        evidenceHash: null,
      }
      result.evidenceHash = computeEvaluationEvidenceHash(result)
      return result
    })

    await expect(evaluationChanged(['--base', 'base', '--head', 'head'], {
      gitSource: {
        list: vi.fn(async ({ revision }) => revision === 'base'
          ? { commit: baseCommit, items: [baseSuite], warnings: [] }
          : { commit: headCommit, items: [candidate], warnings: [] }),
        resolveArtifact: vi.fn(async (sourceRef) => [baseSuite, candidate].find((item) => item.artifact.sourceRef === sourceRef)),
      },
      changedPaths: vi.fn(async () => [candidate.relativePath]),
      evaluationRun: run,
    })).resolves.toMatchObject({
      evaluated: [{ kind: 'evaluation-suite', suiteId: 'ci-evaluation-suite-quality' }],
    })
  })

  it('rejects an invalid exact Evaluation Suite candidate before execution', async () => {
    const baseSuite = suiteItem(baseCommit, 'ci-evaluation-suite-quality', 'evaluation-suite')
    const candidate = suiteItem(headCommit, 'custom-suite', 'skill')
    candidate.contents = JSON.stringify({ ...JSON.parse(candidate.contents), unsupported: true })
    const run = vi.fn()

    await expect(evaluationChanged(['--base', 'base', '--head', 'head'], {
      gitSource: {
        list: vi.fn(async ({ revision }) => revision === 'base'
          ? { commit: baseCommit, items: [baseSuite], warnings: [] }
          : { commit: headCommit, items: [candidate], warnings: [] }),
        resolveArtifact: vi.fn(async (sourceRef) => [baseSuite, candidate].find((item) => item.artifact.sourceRef === sourceRef)),
      },
      changedPaths: vi.fn(async () => [candidate.relativePath]),
      evaluationRun: run,
    })).rejects.toThrow('Changed Evaluation Suite')
    expect(run).not.toHaveBeenCalled()
  })

  it('binds every supported Artifact kind to a fixed deterministic Suite', async () => {
    const cases = [
      ['skills/review/SKILL.md', 'skill', 'deterministic-smoke'],
      ['prompts/review.prompt.json', 'prompt', 'local-prompt-quality'],
      ['workflows/release.md', 'workflow', 'ci-workflow-quality'],
      ['AGENTS.md', 'rules', 'ci-rules-quality'],
      ['.claude/agents/reviewer.md', 'agent', 'ci-agent-quality'],
      ['evals/suites/custom.json', 'evaluation-suite', 'ci-evaluation-suite-quality'],
      ['policies/custom.json', 'policy-pack', 'ci-policy-pack-quality'],
    ]
    const artifact = ([relativePath, kind], commit, contentHash) => ({
      relativePath,
      ...(kind === 'evaluation-suite' ? { contents: suiteItem(commit, `${kind}-fixture`, 'skill').contents } : {}),
      artifact: {
        kind,
        artifactId: `${kind}-fixture`,
        version: commit,
        source: 'git',
        sourceRef: gitArtifactSourceRef(repository, commit, relativePath, contentHash),
        contentHash,
        gitCommit: commit,
        repository,
      },
    })
    const baselines = cases.map((entry) => artifact(entry, baseCommit, 'a'.repeat(64)))
    const candidates = cases.map((entry, index) => artifact(entry, headCommit, String(index + 1).repeat(64)))
    const fixedSuites = cases.map(([, kind, suiteId]) => suiteItem(baseCommit, suiteId, kind))
    const run = vi.fn(async (args, runtimeDependencies) => {
      const sourceRef = args[args.indexOf('--candidate') + 1]
      const candidate = candidates.find((entry) => entry.artifact.sourceRef === sourceRef)
      const baseline = baselines.find((entry) => entry.relativePath === candidate.relativePath)
      const pinnedSuite = await runtimeDependencies.suites.get(args[args.indexOf('--suite') + 1])
      const result = { ...summary(candidate, baseline), suiteId: pinnedSuite.id, suiteVersion: pinnedSuite.version, suiteHash: pinnedSuite.suiteHash, datasetHash: pinnedSuite.datasetHash, evidenceHash: null }
      result.evidenceHash = computeEvaluationEvidenceHash(result)
      return result
    })

    const result = await evaluationChanged(['--base', 'base', '--head', 'head'], {
      gitSource: {
        list: vi.fn(async ({ revision }) => revision === 'base'
          ? { commit: baseCommit, items: [...baselines, ...fixedSuites], warnings: [] }
          : { commit: headCommit, items: candidates, warnings: [] }),
        resolveArtifact: vi.fn(async (sourceRef) => [...fixedSuites, ...candidates].find((item) => item.artifact.sourceRef === sourceRef)),
      },
      changedPaths: vi.fn(async () => cases.map(([relativePath]) => relativePath)),
      evaluationRun: run,
    })

    expect(result.evaluated.map(({ kind, suiteId }) => `${kind}:${suiteId}`).sort()).toEqual(cases.map(([, kind, suiteId]) => `${kind}:${suiteId}`).sort())
    expect(run).toHaveBeenCalledTimes(cases.length)
  })

  it('fails closed when a governed Artifact is deleted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-deleted-evaluation-'))
    directories.push(root)
    await git(root, 'init', '-b', 'main')
    await git(root, 'config', 'remote.origin.url', repository)
    const skillFile = path.join(root, 'skills', 'review', 'SKILL.md')
    const suiteFile = path.join(root, 'evals', 'suites', 'deterministic-smoke.json')
    await Promise.all([mkdir(path.dirname(skillFile), { recursive: true }), mkdir(path.dirname(suiteFile), { recursive: true })])
    await Promise.all([
      writeFile(skillFile, '---\nname: review\nversion: 1.0.0\n---\n\nReview carefully.\n'),
      writeFile(suiteFile, `${suiteItem(baseCommit).contents}\n`),
    ])
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'baseline')
    const base = await git(root, 'rev-parse', 'HEAD')
    await rm(skillFile)
    await git(root, 'add', '-A')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'delete governed skill')
    const head = await git(root, 'rev-parse', 'HEAD')

    await expect(evaluationChanged(['--base', base, '--head', head], {
      gitSource: createGitArtifactSource({ artifactWorkspace: root }),
    })).rejects.toThrow('could not be resolved at the head commit')
  })

  it('runs the fixed suite against resolved Candidate contents in a real Git repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-changed-evaluation-'))
    directories.push(root)
    await git(root, 'init', '-b', 'main')
    await git(root, 'config', 'core.quotePath', 'true')
    await git(root, 'config', 'remote.origin.url', repository)
    const skillFile = path.join(root, 'skills', 'review', 'SKILL.md')
    await mkdir(path.dirname(skillFile), { recursive: true })
    await writeFile(skillFile, '---\nname: review\nversion: 1.0.0\n---\n\nReview carefully.\n')
    const suiteFile = path.join(root, 'evals', 'suites', 'deterministic-smoke.json')
    await mkdir(path.dirname(suiteFile), { recursive: true })
    await writeFile(suiteFile, `${suiteItem(baseCommit).contents}\n`)
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'baseline')
    const base = await git(root, 'rev-parse', 'HEAD')
    await writeFile(skillFile, '---\nname: review\nversion: 1.1.0\n---\n\nReview carefully and require evidence.\n')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'candidate')
    const head = await git(root, 'rev-parse', 'HEAD')
    const dataDir = path.join(root, 'data')
    const outputDir = path.join(root, 'artifacts')
    const result = await evaluationChanged([
      '--base', base,
      '--head', head,
      '--output-dir', outputDir,
    ], {
      gitSource: createGitArtifactSource({ artifactWorkspace: root }),
      store: createEvaluationStore({ dataDir }),
    })

    expect(result.evaluated).toEqual([expect.objectContaining({
      path: 'skills/review/SKILL.md',
      kind: 'skill',
      suiteId: 'deterministic-smoke',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })])
    const evidence = await readFile(path.join(outputDir, '001-summary.json'), 'utf8')
    expect(evidence).toContain(result.evaluated[0].contentHash)
    expect(evidence).not.toContain('Review carefully')
    const renamedSkillFile = path.join(root, 'skills', '评审', 'SKILL.md')
    await mkdir(path.dirname(renamedSkillFile), { recursive: true })
    await git(root, 'mv', 'skills/review/SKILL.md', 'skills/评审/SKILL.md')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'rename governed skill')
    const renamedHead = await git(root, 'rev-parse', 'HEAD')
    const renamed = await evaluationChanged([
      '--base', head,
      '--head', renamedHead,
      '--output-dir', path.join(root, 'renamed-artifacts'),
    ], {
      gitSource: createGitArtifactSource({ artifactWorkspace: root }),
      store: createEvaluationStore({ dataDir }),
    })
    expect(renamed.evaluated).toEqual([expect.objectContaining({
      path: 'skills/评审/SKILL.md',
      baselinePath: 'skills/review/SKILL.md',
    })])
    await writeFile(renamedSkillFile, '---\nname: review\nversion: 1.2.0\n---\n\nReview API_KEY directly.\n')
    await git(root, 'add', '.')
    await git(root, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'unsafe candidate')
    const unsafeHead = await git(root, 'rev-parse', 'HEAD')
    await expect(evaluationChanged([
      '--base', renamedHead,
      '--head', unsafeHead,
      '--output-dir', path.join(root, 'unsafe-artifacts'),
    ], {
      gitSource: createGitArtifactSource({ artifactWorkspace: root }),
      store: createEvaluationStore({ dataDir }),
    })).rejects.toThrow('failed its fixed CI Suite')
  }, 30_000)
})
