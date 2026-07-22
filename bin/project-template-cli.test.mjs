// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { projectTemplateInit } from './project-template-cli.mjs'

const manifest = {
  id: 'team-default',
  version: '2.0.0',
  templateHash: 'a'.repeat(64),
  evaluationSuites: [{ id: 'template-suite', baselineRef: 'skill:baseline', candidateRef: 'skill:candidate', deterministic: false }],
}

describe('skillops init', () => {
  it('previews by default and routes status and rollback without mutation', async () => {
    const manager = {
      preview: vi.fn(async (mode) => ({ operation: 'initialize', mode })),
      apply: vi.fn(),
      status: vi.fn(async () => ({ state: 'current' })),
      previewRollback: vi.fn(async () => ({ operation: 'rollback', canApply: true })),
      rollback: vi.fn(),
    }
    const dependencies = {
      loadTemplate: vi.fn(async () => manifest),
      createManager: vi.fn(() => manager),
      loadDraft: vi.fn(async () => manifest),
      computeHash: vi.fn(() => 'a'.repeat(64)),
    }

    await expect(projectTemplateInit(['--manifest', 'team.json', '--hash'], dependencies)).resolves.toEqual({ id: 'team-default', version: '2.0.0', contentHash: 'a'.repeat(64) })
    await expect(projectTemplateInit(['--manifest', 'team.json', '--target', 'project', '--mode', 'adopt-existing'], dependencies)).resolves.toEqual({ operation: 'initialize', mode: 'adopt-existing' })
    await expect(projectTemplateInit(['--manifest', 'team.json', '--target', 'project', '--status'], dependencies)).resolves.toEqual({ state: 'current' })
    await expect(projectTemplateInit(['--manifest', 'team.json', '--target', 'project', '--rollback'], dependencies)).resolves.toEqual({ operation: 'rollback', canApply: true })
    await expect(projectTemplateInit(['--manifest', 'team.json', '--apply=false'], dependencies)).rejects.toThrow('--apply does not accept a value')
    await expect(projectTemplateInit(['--manifest', 'team.json', '--rollback=false', '--apply'], dependencies)).rejects.toThrow('--rollback does not accept a value')
    expect(manager.apply).not.toHaveBeenCalled()
    expect(manager.rollback).not.toHaveBeenCalled()
  })

  it('runs the configured evaluation seam before an explicit apply and never accepts a command-line key', async () => {
    const evaluationRun = vi.fn(async () => ({ suiteId: 'template-suite', status: 'completed', gateResult: 'passed', evidenceHash: 'f'.repeat(64) }))
    let managerOptions
    const manager = {
      apply: vi.fn(async () => ({ applied: true, evaluation: await managerOptions.evaluateSuite(manifest.evaluationSuites[0], { manifest, currentLock: { template: { version: '1.0.0' } } }) })),
    }
    const dependencies = {
      loadTemplate: vi.fn(async () => manifest),
      createManager: vi.fn((options) => { managerOptions = options; return manager }),
      evaluationRun,
    }

    await expect(projectTemplateInit([
      '--manifest', 'team.json', '--target', 'project', '--mode', 'migration', '--apply',
      '--provider', 'openai', '--model', 'gpt-test', '--api-key-env', 'TEAM_API_KEY',
    ], dependencies)).resolves.toMatchObject({ applied: true })
    expect(evaluationRun).toHaveBeenCalledWith([
      '--suite', 'template-suite', '--baseline', 'skill:baseline', '--candidate', 'skill:candidate',
      '--subject-hash', 'a'.repeat(64), '--provider', 'openai', '--model', 'gpt-test', '--api-key-env', 'TEAM_API_KEY',
    ])
    await expect(projectTemplateInit(['--manifest', 'team.json', '--apply', '--api-key', 'secret'], dependencies)).rejects.toThrow('--api-key-env')
    await expect(projectTemplateInit(['--manifest', 'team.json', '--apply', '--api-key=secret'], dependencies)).rejects.toThrow('--api-key-env')
  })

  it('nominates and approves through persisted records and the resolved local principal', async () => {
    const governed = {
      ...manifest,
      release: { evidence: { runId: 'run-1', suiteId: 'template-suite', evidenceHash: 'b'.repeat(64) } },
    }
    const nomination = { id: 'template-approval-1', status: 'pending' }
    const approved = { ...nomination, status: 'approved' }
    const templateApprovals = {
      nominate: vi.fn(async () => nomination),
      approve: vi.fn(async () => approved),
    }
    const principal = { id: 'os:host\\submitter', assurance: 'local-os-account' }
    const dependencies = {
      loadNomination: vi.fn(async () => governed),
      verifyNomination: vi.fn(async () => ({ verified: true })),
      resolvePrincipal: vi.fn(async () => principal),
      templateApprovals,
    }

    await expect(projectTemplateInit(['--manifest', 'team.json', '--nominate'], dependencies)).resolves.toBe(nomination)
    expect(templateApprovals.nominate).toHaveBeenCalledWith(expect.objectContaining({
      templateHash: governed.templateHash,
      runId: 'run-1',
      submitter: principal,
    }))
    await expect(projectTemplateInit(['--approve', '--approval', nomination.id], dependencies)).resolves.toBe(approved)
    expect(templateApprovals.approve).toHaveBeenCalledWith(nomination.id, { reviewer: principal })
  })
})
