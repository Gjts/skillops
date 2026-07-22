import { describe, expect, it } from 'vitest'
import { createSuiteRegistry } from './suite-registry.mjs'
import { runPromptfooQuickCompare, runPromptfooSuite } from './promptfoo-runner.mjs'

function record(id, source, contentHash, contents) {
  const gitCommit = source === 'github' ? contentHash.slice(0, 40) : undefined
  return {
    artifact: {
      kind: 'skill',
      artifactId: id,
      version: '1.0.0',
      source,
      sourceRef: source === 'github'
        ? `github:https://github.com/skillops/deterministic-fixture/blob/${gitCommit}/${id}.md#${id}.md`
        : `${source}:${id}`,
      contentHash,
      ...(gitCommit ? { gitCommit } : {}),
    },
    contents,
  }
}

describe('isolated Promptfoo runner', () => {
  it('runs the same managed case against labeled baseline and candidate providers', async () => {
    const suite = await createSuiteRegistry().get('example-skill-quality')
    const result = await runPromptfooSuite({
      runId: 'run-deterministic',
      suite,
      baseline: record('baseline', 'local-scan', 'a'.repeat(64), 'BASELINE_SENTINEL_CONTENT'),
      candidate: record('candidate', 'github', 'b'.repeat(64), 'CANDIDATE_SENTINEL_CONTENT'),
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'SENTINEL_SUITE_API_KEY' },
      requestedBy: 'test-team',
    }, {
      fakeOutputs: {
        baseline: { 'concise-answer': { output: 'Evidence is required.', tokens: { total: 4, prompt: 2, completion: 2 } } },
        candidate: { 'concise-answer': { output: 'Evidence is explicit.', tokens: { total: 6, prompt: 3, completion: 3 } } },
      },
    })

    expect(result.summary).toEqual(expect.objectContaining({
      id: 'run-deterministic',
      status: 'completed',
      engine: { name: 'promptfoo', version: '0.121.19' },
      provider: { id: 'openai', model: 'gpt-test' },
    }))
    expect(result.summary.metrics).toEqual(expect.objectContaining({ casesPassed: suite.repeats, casesTotal: suite.repeats, passRatePct: 100 }))
    expect(result.cases[0]).toEqual(expect.objectContaining({ caseId: 'concise-answer', baseline: expect.objectContaining({ pass: true }), candidate: expect.objectContaining({ pass: true }) }))
    expect(JSON.stringify(result)).not.toContain('Evidence is required.')
    expect(JSON.stringify(result)).not.toContain('SENTINEL_SUITE_API_KEY')
    expect(result.runtimeAudit.forbiddenMatches).toEqual([])
  })

  it('runs every baseline and candidate version across a bounded model matrix', async () => {
    const baseSuite = await createSuiteRegistry().get('example-skill-quality')
    const suite = {
      ...baseSuite,
      matrix: { models: [{ id: 'fast', model: 'gpt-fast' }, { id: 'strong', model: 'gpt-strong' }] },
    }
    const result = await runPromptfooSuite({
      runId: 'run-matrix',
      suite,
      baseline: record('baseline', 'local-scan', 'a'.repeat(64), 'Baseline'),
      candidate: record('candidate', 'github', 'b'.repeat(64), 'Candidate'),
      provider: { provider: 'openai', model: 'ignored', apiKey: 'secret' },
      requestedBy: 'test-team',
    }, {
      fakeOutputs: {
        baseline: { 'concise-answer': { output: 'Evidence is required.' } },
        candidate: { 'concise-answer': { output: 'Evidence is explicit.' } },
      },
    })

    expect(result.summary.provider).toEqual({ id: 'openai', model: 'matrix', models: ['gpt-fast', 'gpt-strong'] })
    expect(result.summary.metrics.casesTotal).toBe(2 * suite.repeats)
    expect(result.cases.map((item) => item.matrixId)).toEqual(['fast', 'fast', 'strong', 'strong'])
    expect(result.cases.map((item) => item.model)).toEqual(['gpt-fast', 'gpt-fast', 'gpt-strong', 'gpt-strong'])
  })

  it('redacts provider output before Promptfoo evaluates assertions', async () => {
    const baseSuite = await createSuiteRegistry().get('example-skill-quality')
    const suite = {
      ...baseSuite,
      redaction: { output: [{ pattern: 'SECRET-[A-Z]+', replacement: '[SAFE]' }] },
      cases: baseSuite.cases.map((testCase) => ({
        ...testCase,
        assertions: [{ type: 'contains', value: '[SAFE]', label: 'redacted-output', blocking: true }],
      })),
    }
    const result = await runPromptfooSuite({
      runId: 'run-redacted',
      suite,
      baseline: record('baseline', 'local-scan', 'a'.repeat(64), 'Baseline'),
      candidate: record('candidate', 'github', 'b'.repeat(64), 'Candidate'),
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'secret' },
      requestedBy: 'test-team',
    }, {
      fakeOutputs: {
        baseline: { 'concise-answer': { output: 'SECRET-BASELINE' } },
        candidate: { 'concise-answer': { output: 'SECRET-CANDIDATE' } },
      },
    })
    expect(result.summary.metrics.passRatePct).toBe(100)
    expect(result.cases[0].baseline.pass).toBe(true)
    expect(result.cases[0].candidate.pass).toBe(true)
  })

  it('keeps the Quick Compare response compatible while reporting the Promptfoo engine', async () => {
    const result = await runPromptfooQuickCompare({
      runId: 'quick-deterministic',
      task: 'QUICK_TASK_SENTINEL',
      criteria: 'QUICK_CRITERIA_SENTINEL',
      mode: 'prompt-only',
      baseline: record('baseline', 'local-scan', 'a'.repeat(64), 'QUICK_BASELINE_CONTENT'),
      candidate: record('candidate', 'github', 'b'.repeat(64), 'QUICK_CANDIDATE_CONTENT'),
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'QUICK_API_KEY_SENTINEL' },
    }, {
      fakeOutputs: {
        baseline: { quick: { output: 'Baseline answer', tokens: { total: 4, prompt: 2, completion: 2 } } },
        candidate: { quick: { output: 'Candidate answer', tokens: { total: 6, prompt: 3, completion: 3 } } },
        judge: { output: '{"winner":"B","scoreA":70,"scoreB":90,"reason":"Candidate is stronger."}', tokens: { total: 5, prompt: 3, completion: 2 } },
      },
    })
    expect(result).toEqual(expect.objectContaining({
      id: 'quick-deterministic',
      winner: 'candidate',
      reason: 'Candidate is stronger.',
      engine: { name: 'promptfoo', version: '0.121.19' },
      baseline: expect.objectContaining({ score: 70, output: 'Baseline answer' }),
      candidate: expect.objectContaining({ score: 90, output: 'Candidate answer' }),
    }))
  })

  it('does not silently fall back when the Promptfoo judge is invalid', async () => {
    await expect(runPromptfooQuickCompare({
      runId: 'quick-invalid', task: 'Task', criteria: 'Criteria', mode: 'prompt-only',
      baseline: record('baseline', 'local-scan', 'a'.repeat(64), 'Baseline'),
      candidate: record('candidate', 'github', 'b'.repeat(64), 'Candidate'),
      provider: { provider: 'openai', model: 'gpt-test', apiKey: 'secret' },
    }, {
      fakeOutputs: {
        baseline: { quick: { output: 'Baseline answer' } },
        candidate: { quick: { output: 'Candidate answer' } },
        judge: { output: 'not-json' },
      },
    })).rejects.toThrow()
  })
})
