import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactContentHash } from '../evaluations/artifact-definition.mjs'
import { createEvaluationManager } from '../evaluations/evaluation-manager.mjs'
import { createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { runPromptfooSuite } from '../evaluations/promptfoo-runner.mjs'
import { createSuiteRegistry } from '../evaluations/suite-registry.mjs'
import { createGovernanceService } from './governance-service.mjs'
import { createSkeletonInstaller } from './skeleton-installer.mjs'

const temporaryDirectories = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

function artifact(version, contents, source = 'github') {
  const contentHash = artifactContentHash(contents)
  const gitCommit = contentHash.slice(0, 40)
  const sourcePath = `versions/${version}/SKILL.md`
  const sourceRef = source === 'github'
    ? `github:https://github.com/acme/review/blob/${gitCommit}/${sourcePath}#${encodeURIComponent(sourcePath)}`
    : `local-scan:codex:versions/${version}/SKILL.md`
  return {
    artifact: {
      kind: 'skill', artifactId: 'review-skill', version, source, sourceRef,
      contentHash,
      ...(source === 'github' ? { gitCommit, repository: 'https://github.com/acme/review' } : {}),
    },
    contents,
  }
}

async function waitForCompleted(store, runId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const run = await store.getRun(runId)
    if (run?.status === 'completed') return run
    if (run && ['failed', 'cancelled', 'interrupted'].includes(run.status)) {
      throw new Error(`Evaluation ended as ${run.status}${run.errorCode ? ` (${run.errorCode})` : ''}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for Promptfoo evidence.')
}

describe('governance end-to-end', () => {
  it('moves GitHub candidates through Promptfoo, approval, Canary, Stable, and immutable rollback', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-e2e-'))
    temporaryDirectories.push(dataDir)
    const stableRoot = path.join(dataDir, 'stable-project')
    const canaryRoot = path.join(dataDir, 'canary-project')
    const targetFile = path.join(stableRoot, 'SKILL.md')
    const canaryFile = path.join(canaryRoot, 'SKILL.md')
    await Promise.all([mkdir(stableRoot), mkdir(canaryRoot)])
    const v1 = artifact('1.0.0', '---\nname: review-skill\nversion: 1.0.0\n---\nEvidence-based review v1.\n')
    const v2 = artifact('2.0.0', '---\nname: review-skill\nversion: 2.0.0\n---\nEvidence-based review v2.\n')
    const baseline = artifact('0.9.0', v1.contents, 'local-scan')
    let evaluationBaseline = baseline
    await writeFile(targetFile, baseline.contents, 'utf8')

    const records = new Map([v1, v2].map((item) => [item.artifact.sourceRef, item]))
    const artifacts = { resolve: async (sourceRef) => records.get(sourceRef) }
    const scannedRoots = []
    const installer = createSkeletonInstaller({
      artifacts,
      dataDir,
      skeletonRoot: stableRoot,
      resolveTarget: async (_target, projectRoot) => path.join(projectRoot || stableRoot, 'SKILL.md'),
      scanInstalledSkills: async ({ projectRoot }) => {
        scannedRoots.push(projectRoot)
        const sourcePath = path.join(projectRoot, 'SKILL.md')
        return readFile(sourcePath).then(() => [{ sourcePath, kind: 'skill', runtime: 'codex' }], () => [])
      },
    })
    const store = createEvaluationStore({ dataDir })
    const manager = createEvaluationManager({ store, runner: runPromptfooSuite })
    await manager.initialize()
    const suite = await createSuiteRegistry().get('deterministic-smoke')
    const governance = createGovernanceService({ dataDir, evaluations: store, installer })
    const fakeOutputs = {
      baseline: { 'evidence-boundary': { output: 'Lifecycle completion is only an observation.', tokens: { total: 4, prompt: 2, completion: 2 }, delayMs: 100 } },
      candidate: { 'evidence-boundary': { output: 'Evidence is required before declaring success.', tokens: { total: 5, prompt: 2, completion: 3 }, delayMs: 1 } },
    }

    async function evaluateAndPromote(candidate, reviewer) {
      const nominated = await governance.nominate({ artifact: candidate.artifact, owner: 'artifact-owner', targetSkeleton: 'local-target' })
      const queued = await manager.enqueue({
        suite, baseline: evaluationBaseline, candidate, provider: { provider: 'ollama', model: 'deterministic-fixture', baseUrl: 'http://127.0.0.1:11434/v1' },
        requestedBy: 'governance-e2e', capabilityId: nominated.capability.id,
      }, { fakeOutputs, runtimeRoot: path.join(dataDir, 'promptfoo-runtime') })
      const run = await waitForCompleted(store, queued.summary.id)
      expect(run).toEqual(expect.objectContaining({ gateResult: 'passed', engine: { name: 'promptfoo', version: '0.121.19' } }))
      expect((await governance.bindEvidence(nominated.capability.id, { runId: run.id, actor: 'operator' })).stage).toBe('ready')
      expect((await governance.approve(nominated.capability.id, { reviewer })).stage).toBe('approved')
      await expect(governance.previewCanary(nominated.capability.id, { targetSkeleton: 'SKILL.md', projectRoot: stableRoot })).rejects.toThrow('separate')
      const scanStart = scannedRoots.length
      const canaryPreview = await governance.previewCanary(nominated.capability.id, { targetSkeleton: 'SKILL.md', projectRoot: canaryRoot })
      expect((await governance.canary(nominated.capability.id, { previewToken: canaryPreview.previewToken, targetSkeleton: 'SKILL.md', projectRoot: canaryRoot, confirm: true, actor: 'operator' })).capability.stage).toBe('canary')
      expect(await readFile(canaryFile, 'utf8')).toBe(candidate.contents)
      expect(scannedRoots.slice(scanStart)).toContain(canaryRoot)
      expect((await governance.lockState()).targets['local-target'].canary.projectRoot).toBe(canaryRoot)
      const preview = await governance.previewPromotion(nominated.capability.id)
      const promoted = await governance.promote(nominated.capability.id, { previewToken: preview.previewToken, confirm: true, actor: 'operator' })
      expect(promoted.capability.stage).toBe('stable')
      evaluationBaseline = candidate
      return promoted.capability
    }
    async function requalifyForRollback(candidate, baseline, capabilityId, reviewer) {
      const queued = await manager.enqueue({
        suite,
        baseline,
        candidate,
        provider: { provider: 'ollama', model: 'deterministic-fixture', baseUrl: 'http://127.0.0.1:11434/v1' },
        requestedBy: 'governance-e2e',
        capabilityId,
      }, { fakeOutputs, runtimeRoot: path.join(dataDir, 'promptfoo-runtime') })
      const run = await waitForCompleted(store, queued.summary.id)
      expect((await governance.bindEvidence(capabilityId, { runId: run.id, actor: 'operator' })).requalifiesStage).toBeTruthy()
      expect((await governance.approve(capabilityId, { reviewer })).stage).toBe('approved')
    }


    const first = await evaluateAndPromote(v1, 'reviewer-one')
    const second = await evaluateAndPromote(v2, 'reviewer-two')
    expect((await governance.get(first.id)).stage).toBe('superseded')
    expect(await readFile(targetFile, 'utf8')).toBe(v2.contents)
    expect(await readFile(path.join(dataDir, 'project-skeleton.lock.json'), 'utf8')).toContain('restoreToken')
    expect(JSON.stringify(await governance.lockState())).not.toContain('restoreToken')

    const rollbackPreview = await governance.previewRollback(second.id)
    expect(rollbackPreview.restoredCapabilityId).toBe(first.id)
    const rolledBack = await governance.rollback(second.id, { previewToken: rollbackPreview.previewToken, confirm: true, actor: 'operator' })
    expect(rolledBack.restoredCapabilityId).toBe(first.id)
    expect((await governance.get(second.id)).stage).toBe('rolled-back')
    expect((await governance.get(first.id)).stage).toBe('stable')
    expect(await readFile(targetFile, 'utf8')).toBe(v1.contents)

    const removalPreview = await governance.previewDeprecation(first.id)
    expect((await governance.deprecate(first.id, { previewToken: removalPreview.previewToken, confirm: true, actor: 'operator' })).capability.stage).toBe('deprecated')
    await expect(readFile(targetFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(governance.previewRollback(first.id)).rejects.toThrow('fresh evaluation')
    await requalifyForRollback(v1, baseline, first.id, 'reviewer-four')
    const restorePreview = await governance.previewRollback(first.id)
    expect((await governance.rollback(first.id, { previewToken: restorePreview.previewToken, confirm: true, actor: 'operator' })).capability.stage).toBe('stable')
    expect(await readFile(targetFile, 'utf8')).toBe(v1.contents)
    await manager.shutdown()
  }, 60_000)
})
