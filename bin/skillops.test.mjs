// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeEvaluationEvidenceHash, createEvaluationStore } from '../app/backend/evaluations/evaluation-store.mjs'
import { evaluationRun, evaluationVerify } from './evaluation-cli.mjs'
import { flags, main } from './skillops.mjs'

const temporaryDirectories = []

afterEach(async () => {
  process.exitCode = undefined
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SkillOps CLI flags', () => {
  it('treats a trailing flag and a flag followed by another flag as booleans', () => {
    expect(flags(['--verbose'])).toEqual({ verbose: true })
    expect(flags(['--verbose', '--runtime', 'codex', '--dry-run'])).toEqual({
      verbose: true,
      runtime: 'codex',
      'dry-run': true,
    })
  })

  it('runs and verifies the deterministic Promptfoo suite without a provider call', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-cli-test-'))
    temporaryDirectories.push(dataDir)
    const store = createEvaluationStore({ dataDir })
    const summaryFile = path.join(dataDir, 'summary.json')
    const junitFile = path.join(dataDir, 'junit.xml')
    const summary = await evaluationRun([
      '--suite', 'deterministic-smoke', '--baseline', 'baseline-fixture', '--candidate', 'candidate-fixture', '--deterministic',
      '--summary', summaryFile, '--junit', junitFile,
    ], { store })
    expect(summary).toEqual(expect.objectContaining({ status: 'completed', gateResult: 'passed', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }))
    expect(await evaluationVerify(['--run', summary.id], { store })).toEqual(expect.objectContaining({ ok: true, stale: false, evidenceHashValid: true }))
    expect(await readFile(summaryFile, 'utf8')).not.toContain('Deterministic candidate fixture')
    expect(await readFile(junitFile, 'utf8')).toContain('<testsuite name="SkillOps"')
  }, 30_000)

  it('sets a non-zero exit code when eval:verify sees a failed gate', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-cli-verify-'))
    temporaryDirectories.push(dataDir)
    const store = createEvaluationStore({ dataDir })
    const passed = await evaluationRun(['--suite', 'deterministic-smoke', '--baseline', 'baseline', '--candidate', 'candidate', '--deterministic'], { store })
    const failed = { ...passed, gateResult: 'failed', evidenceHash: null }
    failed.evidenceHash = computeEvaluationEvidenceHash(failed)
    await store.appendRun(failed)
    const previousDataDir = process.env.SKILLOPS_DATA_DIR
    process.env.SKILLOPS_DATA_DIR = dataDir
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await main(['eval:verify', '--run', passed.id])
      expect(process.exitCode).toBe(1)
    } finally {
      log.mockRestore()
      if (previousDataDir === undefined) delete process.env.SKILLOPS_DATA_DIR
      else process.env.SKILLOPS_DATA_DIR = previousDataDir
    }
  }, 30_000)
})
