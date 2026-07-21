import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { PROMPTFOO_PRIVACY_ENV, runPromptfooIsolated } from './promptfoo-runtime.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixtures/promptfoo-0.121.19-summary.json', import.meta.url), 'utf8'))

function projectSummary(summary) {
  const prompt = summary.prompts[0]
  const result = summary.results[0]
  const component = result.gradingResult.componentResults[0]
  return {
    version: summary.version,
    prompt: {
      raw: prompt.raw,
      label: prompt.label,
      provider: prompt.provider,
      score: prompt.metrics.score,
      testPassCount: prompt.metrics.testPassCount,
      testFailCount: prompt.metrics.testFailCount,
      assertPassCount: prompt.metrics.assertPassCount,
      assertFailCount: prompt.metrics.assertFailCount,
    },
    result: {
      success: result.success,
      score: result.score,
      latencyType: typeof result.latencyMs,
      prompt: { raw: result.prompt.raw, label: result.prompt.label },
      provider: result.provider.id,
      output: result.response.output,
      tokenUsage: {
        total: result.response.tokenUsage.total,
        prompt: result.response.tokenUsage.prompt,
        completion: result.response.tokenUsage.completion,
      },
      grading: {
        pass: result.gradingResult.pass,
        score: result.gradingResult.score,
        reason: result.gradingResult.reason,
        component: {
          pass: component.pass,
          score: component.score,
          reason: component.reason,
          assertion: component.assertion,
        },
      },
      vars: result.vars,
    },
    stats: {
      successes: summary.stats.successes,
      failures: summary.stats.failures,
      errors: summary.stats.errors,
      tokenUsage: {
        total: summary.stats.tokenUsage.total,
        prompt: summary.stats.tokenUsage.prompt,
        completion: summary.stats.tokenUsage.completion,
      },
    },
  }
}

describe('Promptfoo 0.121.19 public Node contract', () => {
  it('evaluates a deterministic one-case fake provider and matches the sanitized fixture', async () => {
    const beforeHome = await readdir(path.join(homedir(), '.promptfoo'), { recursive: true }).catch(() => [])
    const runtimeRoot = path.join(tmpdir(), `skillops-promptfoo-contract-${process.pid}`)
    const { result: summary, runtimeAudit } = await runPromptfooIsolated({ operation: 'contract' }, { runtimeRoot })
    const afterHome = await readdir(path.join(homedir(), '.promptfoo'), { recursive: true }).catch(() => [])

    expect(projectSummary(summary)).toEqual(fixture)
    expect(afterHome).toEqual(beforeHome)
    expect(runtimeAudit.files).toEqual(['promptfoo.yaml'])
    expect(runtimeAudit.forbiddenMatches).toEqual([])
  })

  it('pins every privacy environment switch before the worker imports Promptfoo', () => {
    expect(PROMPTFOO_PRIVACY_ENV).toEqual({
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_DISABLE_SHARING: '1',
      PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true',
      PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
      PROMPTFOO_CACHE_ENABLED: 'false',
      PROMPTFOO_LOG_LEVEL: 'error',
    })
  })

  it('keeps task, criteria, Skill content, API key, and provider output out of runtime files', async () => {
    const values = {
      task: 'SENTINEL_TASK_7b2f',
      criteria: 'SENTINEL_CRITERIA_91a4',
      skill: 'SENTINEL_SKILL_CONTENT_2c6d',
      apiKey: 'SENTINEL_API_KEY_3fa8',
      output: 'SENTINEL_PROVIDER_OUTPUT_80e1',
    }
    const { result, runtimeAudit } = await runPromptfooIsolated({ operation: 'privacy', values }, {
      runtimeRoot: path.join(tmpdir(), `skillops-promptfoo-privacy-${process.pid}`),
      forbiddenValues: values,
    })
    expect(result.results[0].response.output).toBe(values.output)
    expect(runtimeAudit.files).toEqual(['promptfoo.yaml'])
    expect(runtimeAudit.forbiddenMatches).toEqual([])
  })
})
