import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import promptfoo from 'promptfoo'
import { buildPromptfooRedteamProbes, REDTEAM_PROBES } from './promptfoo-redteam-adapter.mjs'
import { runPromptfooRedteam } from './promptfoo-runner.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const artifact = (id, hash) => ({
  artifact: { kind: 'skill', artifactId: id, version: '1.0.0', description: `${id} assistant`, source: 'github', sourceRef: `github:${id}`, contentHash: hash.repeat(64) },
  contents: `sentinel-${id}-definition`,
})

describe('Promptfoo public Red Team adapter', () => {
  it('keeps the four supported probes behind one experimental namespace adapter', () => {
    const probes = buildPromptfooRedteamProbes(promptfoo.redteam, 'a local coding assistant')
    expect(probes.map((probe) => probe.id)).toEqual(['prompt-injection', 'prompt-extraction', 'pii-secret-leakage', 'excessive-agency'])
    expect(probes.every((probe) => probe.rubric.length > 100)).toBe(true)
    expect(REDTEAM_PROBES).toHaveLength(4)
  })

  it('runs separate local-only probes and returns aggregate evidence without attacks or outputs', async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'skillops-redteam-'))
    temporaryDirectories.push(runtimeRoot)
    const fakeRedteam = Object.fromEntries(REDTEAM_PROBES.map((probe, index) => [probe.id, {
      output: `untrusted-output-${index}`,
      grade: {
        pass: index === 1 || index === 2,
        score: index === 1 || index === 2 ? 1 : 0,
        reason: index === 1 || index === 2 ? 'The target resisted.' : 'The target complied.',
        severity: index === 1 || index === 2 ? 'none' : probe.severity,
      },
      targetTokens: { total: 3, prompt: 2, completion: 1 },
      judgeTokens: { total: 2, prompt: 1, completion: 1 },
    }]))
    const result = await runPromptfooRedteam({
      runId: 'redteam-1',
      mode: 'redteam',
      baseline: artifact('baseline', 'a'),
      candidate: artifact('candidate', 'b'),
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'sentinel-redteam-key' },
      requestedBy: 'qa',
      requestedAt: '2026-07-21T00:00:00.000Z',
    }, { runtimeRoot, fakeRedteam })
    expect(result.summary).toEqual(expect.objectContaining({
      mode: 'redteam',
      metrics: expect.objectContaining({
        candidateScore: 50,
        passRatePct: 50,
        attackSuccessRatePct: 50,
        criticalFindings: 1,
        highFindings: 1,
        candidateTokens: 20,
        candidateCostUsd: null,
      }),
    }))
    expect(result.cases).toHaveLength(4)
    const serialized = JSON.stringify({ summary: result.summary, cases: result.cases })
    expect(serialized).not.toContain('untrusted-output')
    expect(serialized).not.toContain('The target')
    expect(result.runtimeAudit.forbiddenMatches).toEqual([])
  }, 30_000)
})
