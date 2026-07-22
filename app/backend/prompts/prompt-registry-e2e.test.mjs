import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEvaluationManager } from '../evaluations/evaluation-manager.mjs'
import { createEvaluationStore } from '../evaluations/evaluation-store.mjs'
import { runPromptfooSuite } from '../evaluations/promptfoo-runner.mjs'
import { createSuiteRegistry } from '../evaluations/suite-registry.mjs'
import { createGovernanceService } from '../governance/governance-service.mjs'
import { createSkeletonInstaller } from '../governance/skeleton-installer.mjs'
import { adaptPromptDefinition } from './prompt-definition.mjs'

const temporaryDirectories = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function waitForCompleted(store, runId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const run = await store.getRun(runId)
    if (run?.status === 'completed') return run
    if (run && ['failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error(`Run ended as ${run.status}.`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for Promptfoo.')
}

function version(commit, template) {
  return adaptPromptDefinition({
    schemaVersion: 1,
    id: 'release-summary',
    name: 'Release summary',
    description: 'Synthetic local Prompt.',
    system: 'Return text for {{channel}}.',
    template,
    model: { provider: 'openai', name: 'gpt-test', configuration: { temperature: 0 } },
  }, { commit, relativePath: 'prompts/release.prompt.json' })
}

describe('local Prompt Registry governance end-to-end', () => {
  it('runs Promptfoo, gates, approves, promotes two immutable references, and rolls back without the source', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-prompt-registry-e2e-'))
    temporaryDirectories.push(dataDir)
    const stableRoot = path.join(dataDir, 'stable-project')
    const canaryRoot = path.join(dataDir, 'canary-project')
    await Promise.all([mkdir(stableRoot), mkdir(canaryRoot)])
    const baseline = version('a'.repeat(40), 'Write a generic note for {{audience}}.')
    let evaluationBaseline = baseline
    const v1 = version('b'.repeat(40), 'Summarize the status for {{audience}}.')
    const v2 = version('c'.repeat(40), 'Summarize the verified release status for {{audience}}.')
    let offline = false
    const records = new Map([baseline, v1, v2].map((record) => [record.artifact.sourceRef, record]))
    const artifacts = { resolve: async (sourceRef) => {
      if (offline) throw new Error('Prompt source unavailable')
      return records.get(sourceRef)
    } }
    const store = createEvaluationStore({ dataDir })
    const manager = createEvaluationManager({ store, runner: runPromptfooSuite })
    await manager.initialize()
    const governance = createGovernanceService({ dataDir, evaluations: store, installer: createSkeletonInstaller({ artifacts, dataDir, skeletonRoot: stableRoot }) })
    const suite = await createSuiteRegistry().get('local-prompt-quality')
    const fakeOutputs = {
      baseline: { 'concise-summary': { output: 'A generic summary.', tokens: { total: 4, prompt: 2, completion: 2 }, delayMs: 50 } },
      candidate: { 'concise-summary': { output: 'The release status is ready for engineering leaders.', tokens: { total: 5, prompt: 2, completion: 3 }, delayMs: 1 } },
    }

    async function promote(candidate, reviewer) {
      const nominated = await governance.nominate({ artifact: candidate.artifact, owner: 'prompt-owner', targetSkeleton: 'prompt:release-summary' })
      const queued = await manager.enqueue({
        suite, baseline: evaluationBaseline, candidate,
        provider: { provider: 'ollama', model: 'deterministic-fixture', baseUrl: 'http://127.0.0.1:11434/v1' },
        requestedBy: 'prompt-registry-e2e', capabilityId: nominated.capability.id,
      }, { fakeOutputs, runtimeRoot: path.join(dataDir, 'promptfoo-runtime') })
      const run = await waitForCompleted(store, queued.summary.id)
      expect(run).toEqual(expect.objectContaining({ gateResult: 'passed', candidate: expect.objectContaining({ source: 'prompt-registry', sourceRef: candidate.artifact.sourceRef }) }))
      await governance.bindEvidence(nominated.capability.id, { runId: run.id, actor: 'operator' })
      await governance.approve(nominated.capability.id, { reviewer })
      const canaryPreview = await governance.previewCanary(nominated.capability.id, { targetSkeleton: 'prompt-canary:release-summary', projectRoot: canaryRoot })
      await governance.canary(nominated.capability.id, { previewToken: canaryPreview.previewToken, targetSkeleton: 'prompt-canary:release-summary', projectRoot: canaryRoot, confirm: true, actor: 'operator' })
      expect((await governance.lockState()).targets['prompt:release-summary'].canary.projectRoot).toBe(canaryRoot)
      const preview = await governance.previewPromotion(nominated.capability.id)
      const stable = await governance.promote(nominated.capability.id, { previewToken: preview.previewToken, confirm: true, actor: 'operator' })
      expect(stable.applied.referenceOnly).toBe(true)
      evaluationBaseline = candidate
      return stable.capability
    }

    const first = await promote(v1, 'reviewer-one')
    const second = await promote(v2, 'reviewer-two')
    expect((await governance.lockState()).targets['prompt:release-summary'].stable.artifact.sourceRef).toBe(v2.artifact.sourceRef)
    offline = true
    const rollbackPreview = await governance.previewRollback(second.id)
    const rollback = await governance.rollback(second.id, { previewToken: rollbackPreview.previewToken, confirm: true, actor: 'operator' })
    expect(rollback.restoredCapabilityId).toBe(first.id)
    expect((await governance.lockState()).targets['prompt:release-summary'].stable.artifact.sourceRef).toBe(v1.artifact.sourceRef)
    await manager.shutdown()
  }, 60_000)
})
