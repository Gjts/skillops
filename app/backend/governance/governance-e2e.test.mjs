import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const sourceRef = `${source}:https://github.com/acme/review#versions/${version}/SKILL.md`
  return {
    artifact: {
      kind: 'skill', artifactId: 'review-skill', version, source, sourceRef,
      contentHash: artifactContentHash(contents),
    },
    contents,
  }
}

async function waitForCompleted(store, runId) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = await store.getRun(runId)
    if (run?.status === 'completed') return run
    if (run && ['failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error(`Evaluation ended as ${run.status}.`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for Promptfoo evidence.')
}

describe('governance end-to-end', () => {
  it('moves GitHub candidates through Promptfoo, approval, Canary, Stable, and immutable rollback', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-governance-e2e-'))
    temporaryDirectories.push(dataDir)
    const targetFile = path.join(dataDir, 'SKILL.md')
    const v1 = artifact('1.0.0', '---\nname: review-skill\nversion: 1.0.0\n---\nEvidence-based review v1.\n')
    const v2 = artifact('2.0.0', '---\nname: review-skill\nversion: 2.0.0\n---\nEvidence-based review v2.\n')
    const baseline = artifact('0.9.0', v1.contents, 'local-scan')
    await writeFile(targetFile, baseline.contents, 'utf8')

    const records = new Map([v1, v2].map((item) => [item.artifact.sourceRef, item]))
    const artifacts = { resolve: async (sourceRef) => records.get(sourceRef) }
    const installer = createSkeletonInstaller({
      artifacts,
      resolveTarget: async () => targetFile,
      scanInstalledSkills: async () => [{ sourcePath: targetFile }],
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
        suite, baseline, candidate, provider: { provider: 'ollama', model: 'deterministic-fixture', baseUrl: 'http://127.0.0.1:11434/v1' },
        requestedBy: 'governance-e2e', capabilityId: nominated.capability.id,
      }, { fakeOutputs, runtimeRoot: path.join(dataDir, 'promptfoo-runtime') })
      const run = await waitForCompleted(store, queued.summary.id)
      expect(run).toEqual(expect.objectContaining({ gateResult: 'passed', engine: { name: 'promptfoo', version: '0.121.19' } }))
      expect((await governance.bindEvidence(nominated.capability.id, { runId: run.id })).stage).toBe('ready')
      expect((await governance.approve(nominated.capability.id, { reviewer })).stage).toBe('approved')
      expect((await governance.canary(nominated.capability.id)).stage).toBe('canary')
      const preview = await governance.previewPromotion(nominated.capability.id)
      const promoted = await governance.promote(nominated.capability.id, { previewToken: preview.previewToken, confirm: true })
      expect(promoted.capability.stage).toBe('stable')
      return promoted.capability
    }

    const first = await evaluateAndPromote(v1, 'reviewer-one')
    const second = await evaluateAndPromote(v2, 'reviewer-two')
    expect((await governance.get(first.id)).stage).toBe('superseded')
    expect(await readFile(targetFile, 'utf8')).toBe(v2.contents)

    const rollbackPreview = await governance.previewRollback(second.id)
    expect(rollbackPreview.restoredCapabilityId).toBe(first.id)
    const rolledBack = await governance.rollback(second.id, { previewToken: rollbackPreview.previewToken, confirm: true })
    expect(rolledBack.restoredCapabilityId).toBe(first.id)
    expect((await governance.get(second.id)).stage).toBe('rolled-back')
    expect((await governance.get(first.id)).stage).toBe('stable')
    expect(await readFile(targetFile, 'utf8')).toBe(v1.contents)
    await manager.shutdown()
  }, 20_000)
})
