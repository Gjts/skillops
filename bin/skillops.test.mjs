// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('runs the explicit recoverable legacy event migration', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-cli-migrate-'))
    temporaryDirectories.push(dataDir)
    const eventFile = path.join(dataDir, 'events.jsonl')
    await writeFile(eventFile, `${JSON.stringify({
      id: 'legacy-failure',
      event: 'skill.failed',
      skillId: 'privacy-test',
      runtime: 'codex',
      timestamp: '2026-07-22T00:00:00.000Z',
      error: 'private provider error details',
    })}\nnot-json\n`, 'utf8')

    const result = spawnSync(process.execPath, ['bin/skillops.mjs', 'events:migrate'], {
      cwd: process.cwd(),
      env: { ...process.env, SKILLOPS_DATA_DIR: dataDir },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ migrated: 1, removed: 1, backupFile: expect.stringContaining('.backup-') })
    expect(await readFile(eventFile, 'utf8')).not.toContain('private provider error details')
  })

  it('runs and verifies the deterministic Promptfoo suite without a provider call', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-cli-test-'))
    temporaryDirectories.push(dataDir)
    const store = createEvaluationStore({ dataDir })
    const summaryFile = path.join(dataDir, 'summary.json')
    const junitFile = path.join(dataDir, 'junit.xml')
    const htmlFile = path.join(dataDir, 'report.html')
    const summary = await evaluationRun([
      '--suite', 'deterministic-smoke', '--baseline', 'baseline-fixture', '--candidate', 'candidate-fixture', '--deterministic',
      '--summary', summaryFile, '--junit', junitFile, '--html', htmlFile,
    ], { store })
    expect(summary).toEqual(expect.objectContaining({ status: 'completed', gateResult: 'passed', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }))
    expect(await evaluationVerify(['--run', summary.id], { store })).toEqual(expect.objectContaining({ ok: true, stale: false, evidenceHashValid: true }))
    expect(await readFile(summaryFile, 'utf8')).not.toContain('Deterministic candidate fixture')
    expect(await readFile(junitFile, 'utf8')).toContain('<testsuite name="SkillOps"')
    expect(await readFile(htmlFile, 'utf8')).toContain('SkillOps Evaluation Report')
    expect(await readFile(htmlFile, 'utf8')).not.toContain('Deterministic candidate fixture')
  }, 30_000)

  it('binds deterministic CI evidence to the resolved immutable candidate', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'skillops-cli-candidate-'))
    temporaryDirectories.push(dataDir)
    const store = createEvaluationStore({ dataDir })
    const artifact = (id, contentHash) => ({
      artifact: {
        kind: 'skill',
        artifactId: id,
        version: '1.0.0',
        source: 'local-scan',
        sourceRef: `local-scan:codex:sha256:${contentHash}`,
        contentHash,
      },
      contents: referenceContents(id),
    })
    const referenceContents = (id) => id === 'candidate' ? 'private-candidate-body evidence' : 'private-baseline-body'
    const artifacts = {
      resolve: vi.fn(async (reference) => reference === 'candidate-ref'
        ? artifact('candidate', 'f'.repeat(64))
        : artifact('baseline', 'a'.repeat(64))),
    }

    const summary = await evaluationRun([
      '--suite', 'deterministic-smoke',
      '--baseline', 'baseline-ref',
      '--candidate', 'candidate-ref',
      '--content-audit',
    ], { store, artifacts })

    expect(artifacts.resolve).toHaveBeenCalledWith('candidate-ref')
    expect(summary).toEqual(expect.objectContaining({
      status: 'completed',
      gateResult: 'passed',
      candidate: expect.objectContaining({ contentHash: 'f'.repeat(64) }),
    }))
    expect(await readFile(store.storeFile, 'utf8')).not.toContain('private-candidate-body')
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
