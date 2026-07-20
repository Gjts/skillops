// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  analyzeCandidateSkill,
  callLlmProvider,
  EvaluationError,
  chatWithSkillOps,
  compareSkillDefinitions,
  discoverGithubSkill,
  handleEvaluationApi,
  runSkillABTest,
} from './skill-evaluations.mjs'

const candidateText = `---
name: security-review
version: 2.0.0
description: Review code for security vulnerabilities and attack paths.
---
# Security review
Find vulnerabilities, trace attack paths, and explain mitigations.
`

const baselineText = `---
name: security-scan
version: 1.0.0
description: Scan code for security vulnerabilities.
---
# Security scan
Find vulnerabilities and trace attacks through the application.
`

const candidateHash = createHash('sha256').update(candidateText).digest('hex')

const localSkill = {
  skillId: 'security-scan',
  skillVersion: '1.0.0',
  runtime: 'codex',
  source: 'global',
  sourcePath: 'C:\\skills\\security-scan\\SKILL.md',
  provider: 'Codex',
  kind: 'skill',
  enabled: true,
  description: 'Scan code for security vulnerabilities.',
}

function rawCandidateFetch() {
  return vi.fn().mockResolvedValue(new Response(candidateText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Content-Length': String(candidateText.length) },
  }))
}

function fakeJsonRequest(body, headers = {}, remoteAddress = '127.0.0.1') {
  const bytes = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield bytes },
  }
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value = '') { this.body += value },
  }
}

describe('Skill candidate comparison', () => {
  it('ranks purpose overlap above unrelated definitions', () => {
    const candidate = { skillId: 'security-review', description: 'Review code for security vulnerabilities', headings: ['Security review'], contents: candidateText }
    const related = { skillId: 'security-scan', description: 'Scan code for security vulnerabilities', headings: ['Security scan'], contents: baselineText }
    const unrelated = { skillId: 'spreadsheet', description: 'Create Excel workbooks', headings: ['Workbook'], contents: 'Format cells and formulas.' }

    const relatedResult = compareSkillDefinitions(candidate, related)
    const unrelatedResult = compareSkillDefinitions(candidate, unrelated)

    expect(relatedResult.similarity).toBeGreaterThan(unrelatedResult.similarity)
    expect(relatedResult.relationship).toBe('Overlapping purpose')
    expect(relatedResult.sharedSignals).toContain('security')
  })

  it('loads a public raw GitHub SKILL.md without exposing its full contents', async () => {
    const result = await discoverGithubSkill(
      'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      undefined,
      { fetchImpl: rawCandidateFetch() },
    )

    expect(result.definition.skillId).toBe('security-review')
    expect(result.definition.skillVersion).toBe('2.0.0')
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourcePath: 'skills/security-review/SKILL.md', label: 'security-review' }),
    ])
  })

  it('loads a repository-root raw GitHub SKILL.md URL', async () => {
    const result = await discoverGithubSkill(
      'https://raw.githubusercontent.com/example/repo/main/SKILL.md',
      undefined,
      { fetchImpl: rawCandidateFetch() },
    )

    expect(result.definition.skillId).toBe('security-review')
    expect(result.definition.sourcePath).toBe('SKILL.md')
  })

  it('uses the repository name for a root SKILL.md without name frontmatter', async () => {
    const rootSkillText = `---
description: Repository root skill.
---
# Root skill
Run the repository-level workflow.
`
    const fetchImpl = vi.fn().mockResolvedValue(new Response(rootSkillText, {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(rootSkillText.length) },
    }))

    const result = await discoverGithubSkill(
      'https://raw.githubusercontent.com/example/repo/main/SKILL.md',
      undefined,
      { fetchImpl },
    )

    expect(result.definition.skillId).toBe('repo')
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourcePath: 'SKILL.md', label: 'repo' }),
    ])
  })

  it('rejects direct raw and blob URLs whose final file is not exactly SKILL.md', async () => {
    for (const sourceUrl of [
      'https://raw.githubusercontent.com/example/repo/main/skills/security-review/NOTSKILL.md',
      'https://github.com/example/repo/blob/main/skills/security-review/NOTSKILL.md',
    ]) {
      const fetchImpl = vi.fn()
      await expect(discoverGithubSkill(sourceUrl, undefined, { fetchImpl })).rejects.toThrow('SKILL.md file')
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('ignores repository tree entries whose final file is not exactly SKILL.md', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const href = String(url)
      if (href.includes('/git/trees/main?recursive=1')) {
        return new Response(JSON.stringify({
          tree: [
            { type: 'blob', path: 'skills/security-review/NOTSKILL.md', sha: 'bad' },
            { type: 'blob', path: 'skills/security-review/SKILL.md', sha: 'good' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(candidateText, {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Content-Length': String(candidateText.length) },
      })
    })

    const result = await discoverGithubSkill(
      'https://github.com/example/repo/tree/main/skills',
      undefined,
      { fetchImpl },
    )

    expect(result.definition.sourcePath).toBe('skills/security-review/SKILL.md')
    expect(result.candidates).toEqual([
      expect.objectContaining({ sourcePath: 'skills/security-review/SKILL.md', sha: 'good' }),
    ])
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).some((url) => url.includes('NOTSKILL.md'))).toBe(false)
  })

  it('retries one transient GitHub read failure before giving up', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(candidateText, {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Content-Length': String(candidateText.length) },
      }))

    const result = await discoverGithubSkill(
      'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      undefined,
      { fetchImpl },
    )

    expect(result.definition.skillId).toBe('security-review')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops reading a candidate stream as soon as the byte limit is crossed', async () => {
    let pulls = 0
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(new Uint8Array(200_000).fill(65))
        else if (pulls === 2) controller.enqueue(new Uint8Array(70_000).fill(66))
        else throw new Error('reader pulled beyond the configured limit')
      },
    }, { highWaterMark: 0 })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/plain' } }))

    await expect(discoverGithubSkill(
      'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      undefined,
      { fetchImpl },
    )).rejects.toThrow('exceeds the 256 KB evaluation limit')
    expect(pulls).toBe(2)
  })

  it('returns live local baselines ordered by similarity', async () => {
    const result = await analyzeCandidateSkill({
      sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
    }, {
      fetchImpl: rawCandidateFetch(),
      scanInstalledSkills: async () => [localSkill, { ...localSkill, skillId: 'spreadsheet', sourcePath: 'C:\\skills\\spreadsheet\\SKILL.md', description: 'Create spreadsheets.' }],
      readFile: async (sourcePath) => sourcePath.includes('spreadsheet') ? '# Spreadsheet\nCreate Excel workbooks and formulas.' : baselineText,
    })

    expect(result.candidate).not.toHaveProperty('contents')
    expect(result.candidate.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.matches[0]).toEqual(expect.objectContaining({ skillId: 'security-scan', sourcePath: localSkill.sourcePath }))
    expect(result.recommendation).toContain('security-scan')
  })

  it('rejects a baseline that is not present in the current enabled scan', async () => {
    await expect(runSkillABTest({
      sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      baselineSourcePath: 'C:\\skills\\missing\\SKILL.md',
      candidateContentHash: candidateHash,
      task: 'Review the authentication flow.',
      criteria: 'Find the highest-risk path.',
      provider: { provider: 'openai', apiKey: 'session-key', model: 'test-model' },
    }, {
      fetchImpl: rawCandidateFetch(),
      scanInstalledSkills: async () => [localSkill],
      readFile: async () => baselineText,
    })).rejects.toThrow('no longer present')
  })
})

describe('Skill A/B runner', () => {
  it('runs both definitions, judges them blind, and returns session-only outputs', async () => {
    const callProvider = vi.fn().mockImplementation(async (_provider, messages) => {
      const system = messages[0].content
      if (system.includes('impartial A/B evaluator')) {
        const prompt = messages[1].content
        const candidateIsA = prompt.indexOf('Answer A:\ncandidate output') >= 0
        return {
          content: JSON.stringify({ winner: candidateIsA ? 'A' : 'B', scoreA: candidateIsA ? 92 : 61, scoreB: candidateIsA ? 61 : 92, reason: 'Candidate follows the acceptance criteria more completely.' }),
          usage: { totalTokens: 30 }, provider: 'openai', model: 'test-model',
        }
      }
      const candidate = system.includes('security-review')
      return {
        content: candidate ? 'candidate output' : 'baseline output',
        usage: { totalTokens: candidate ? 20 : 18 }, provider: 'openai', model: 'test-model',
      }
    })

    const result = await runSkillABTest({
      sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      baselineSourcePath: localSkill.sourcePath,
      candidateContentHash: candidateHash,
      task: 'Review the authentication flow.',
      criteria: 'Identify the highest-risk path and give a concrete mitigation.',
      provider: { provider: 'openai', apiKey: 'session-key', model: 'test-model' },
    }, {
      fetchImpl: rawCandidateFetch(),
      scanInstalledSkills: async () => [localSkill],
      readFile: async () => baselineText,
      callProvider,
    })

    expect(callProvider).toHaveBeenCalledTimes(3)
    const providerArgs = callProvider.mock.calls.map(([provider]) => provider)
    expect(providerArgs).toEqual([
      expect.objectContaining({ provider: 'openai', transport: 'openai-compatible', apiKey: 'session-key', model: 'test-model', baseUrl: 'https://api.openai.com/v1' }),
      expect.objectContaining({ provider: 'openai', transport: 'openai-compatible', apiKey: 'session-key', model: 'test-model', baseUrl: 'https://api.openai.com/v1' }),
      expect.objectContaining({ provider: 'openai', transport: 'openai-compatible', apiKey: 'session-key', model: 'test-model', baseUrl: 'https://api.openai.com/v1' }),
    ])
    expect(result.winner).toBe('candidate')
    expect(result.candidate).toEqual(expect.objectContaining({ score: 92, output: 'candidate output' }))
    expect(result.baseline).toEqual(expect.objectContaining({ score: 61, output: 'baseline output' }))
    expect(result.privacy).toContain('not written to disk')
    expect(result.mode).toBe('prompt-only')
  })

  it('runs provider variants without requiring concurrent request capacity', async () => {
    let inFlight = 0
    const callProvider = vi.fn().mockImplementation(async (_provider, messages) => {
      if (inFlight > 0) throw new Error('provider concurrency limit reached')
      inFlight += 1
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const system = messages[0].content
        if (system.includes('impartial A/B evaluator')) {
          return { content: JSON.stringify({ winner: 'tie', scoreA: 80, scoreB: 80, reason: 'Equivalent.' }), usage: { totalTokens: 4 }, provider: 'openai', model: 'test-model' }
        }
        return { content: system.includes('security-review') ? 'candidate output' : 'baseline output', usage: { totalTokens: 3 }, provider: 'openai', model: 'test-model' }
      } finally {
        inFlight -= 1
      }
    })

    const result = await runSkillABTest({
      sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      baselineSourcePath: localSkill.sourcePath,
      candidateContentHash: candidateHash,
      task: 'Review the authentication flow.',
      criteria: 'Find the highest-risk path.',
      provider: { provider: 'openai', apiKey: 'session-key', model: 'test-model' },
    }, {
      fetchImpl: rawCandidateFetch(),
      scanInstalledSkills: async () => [localSkill],
      readFile: async () => baselineText,
      callProvider,
    })

    expect(result.winner).toBe('tie')
    expect(callProvider).toHaveBeenCalledTimes(3)
  })

  it('rejects a candidate that changed after analysis', async () => {
    await expect(runSkillABTest({
      sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
      baselineSourcePath: localSkill.sourcePath,
      candidateContentHash: '0'.repeat(64),
      task: 'Review the authentication flow.',
      criteria: 'Find the highest-risk path.',
      provider: { provider: 'openai', apiKey: 'session-key', model: 'test-model' },
    }, {
      fetchImpl: rawCandidateFetch(),
      scanInstalledSkills: async () => [localSkill],
      readFile: async () => baselineText,
      callProvider: vi.fn(),
    })).rejects.toThrow('changed since analysis')
  })

  it('rejects a judge winner that contradicts its normalized scores', async () => {
    const callProvider = vi.fn().mockImplementation(async (_provider, messages) => {
      if (messages[0].content.includes('impartial A/B evaluator')) {
        return { content: JSON.stringify({ winner: 'A', scoreA: 10, scoreB: 90, reason: 'Contradictory.' }), usage: { totalTokens: 4 }, provider: 'openai', model: 'test-model' }
      }
      return { content: 'answer', usage: { totalTokens: 3 }, provider: 'openai', model: 'test-model' }
    })
    const analysis = await analyzeCandidateSkill({ sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md' }, {
      fetchImpl: rawCandidateFetch(), scanInstalledSkills: async () => [localSkill], readFile: async () => baselineText,
    })

    await expect(runSkillABTest({
      sourceUrl: analysis.candidate.sourceUrl,
      baselineSourcePath: localSkill.sourcePath,
      candidateContentHash: analysis.candidate.contentHash,
      task: 'Review the authentication flow.',
      criteria: 'Find the highest-risk path.',
      provider: { provider: 'openai', apiKey: 'session-key', model: 'test-model' },
    }, {
      fetchImpl: rawCandidateFetch(), scanInstalledSkills: async () => [localSkill], readFile: async () => baselineText, callProvider,
    })).rejects.toThrow('contradicts')
  })

  it('runs a bounded read-only tool loop in agent mode', async () => {
    const executeWorkspaceTool = vi.fn().mockResolvedValue('fixture workspace contents')
    const callProvider = vi.fn().mockImplementation(async (_provider, messages) => {
      if (messages[0].content.includes('impartial A/B evaluator')) {
        return { content: JSON.stringify({ winner: 'A', scoreA: 90, scoreB: 70, reason: 'More grounded.' }), usage: { totalTokens: 5 }, provider: 'openai', model: 'test-model' }
      }
      if (messages.some((message) => message.role === 'tool')) {
        return { content: 'grounded final answer', usage: { totalTokens: 8 }, provider: 'openai', model: 'test-model' }
      }
      return {
        content: '',
        toolCalls: [{ id: `tool-${callProvider.mock.calls.length}`, name: 'read_workspace_file', arguments: { path: 'README.md' } }],
        usage: { totalTokens: 6 }, provider: 'openai', model: 'test-model',
      }
    })
    const analysis = await analyzeCandidateSkill({ sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md' }, {
      fetchImpl: rawCandidateFetch(), scanInstalledSkills: async () => [localSkill], readFile: async () => baselineText,
    })

    const result = await runSkillABTest({
      sourceUrl: analysis.candidate.sourceUrl,
      baselineSourcePath: localSkill.sourcePath,
      candidateContentHash: analysis.candidate.contentHash,
      mode: 'agent',
      task: 'Review the authentication flow.',
      criteria: 'Find the highest-risk path.',
      provider: { provider: 'openai', apiKey: 'session-key', model: 'test-model' },
    }, {
      fetchImpl: rawCandidateFetch(), scanInstalledSkills: async () => [localSkill], readFile: async () => baselineText, callProvider, executeWorkspaceTool,
    })

    expect(result.mode).toBe('agent')
    expect(result.baseline.output).toBe('grounded final answer')
    expect(result.candidate.output).toBe('grounded final answer')
    expect(executeWorkspaceTool).toHaveBeenCalledTimes(2)
    expect(callProvider).toHaveBeenCalledTimes(5)
  })

  it('validates agent providers before GitHub, inventory, or workspace access', async () => {
    for (const provider of [undefined, { provider: 'not-a-provider', model: 'test-model' }]) {
      const fetchImpl = rawCandidateFetch()
      const scanInstalledSkills = vi.fn().mockResolvedValue([localSkill])
      const readFile = vi.fn().mockResolvedValue(baselineText)
      const executeWorkspaceTool = vi.fn()
      let error

      try {
        await runSkillABTest({
          sourceUrl: 'https://raw.githubusercontent.com/example/repo/main/skills/security-review/SKILL.md',
          baselineSourcePath: localSkill.sourcePath,
          candidateContentHash: candidateHash,
          mode: 'agent',
          task: 'Review the authentication flow.',
          criteria: 'Find the highest-risk path.',
          ...(provider ? { provider } : {}),
        }, { fetchImpl, scanInstalledSkills, readFile, executeWorkspaceTool })
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(EvaluationError)
      expect(error.message).toMatch(/provider/i)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(scanInstalledSkills).not.toHaveBeenCalled()
      expect(readFile).not.toHaveBeenCalled()
      expect(executeWorkspaceTool).not.toHaveBeenCalled()
    }
  })
})

describe('AI provider and assistant boundaries', () => {
  it('uses the OpenAI-compatible chat endpoint and returns normalized usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'Hello from the provider.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-test', baseUrl: 'https://example.test/v1' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl, timeoutMs: 1_000 },
    )

    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.objectContaining({ method: 'POST' }))
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret')
    expect(result).toEqual(expect.objectContaining({ content: 'Hello from the provider.', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }))
  })

  it('passes an explicit reasoning effort to OpenAI-compatible chat requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'Reasoned response.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-5.6-sol', baseUrl: 'https://example.test/v1', reasoningEffort: 'high' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl, timeoutMs: 1_000 },
    )

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(expect.objectContaining({ reasoning_effort: 'high' }))
  })

  it('rejects unsupported reasoning efforts and GPT-5.6 tools without effective none reasoning', async () => {
    await expect(callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-5.6-sol', baseUrl: 'https://example.test/v1', reasoningEffort: 'extreme' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl: vi.fn() },
    )).rejects.toThrow('reasoning effort')

    await expect(callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-5.6-sol', baseUrl: 'https://example.test/v1' },
      [{ role: 'user', content: 'Inspect the workspace.' }],
      { fetchImpl: vi.fn(), tools: [{ name: 'read_workspace_file', description: 'Read a file.', inputSchema: { type: 'object' } }] },
    )).rejects.toThrow('reasoning effort none')
  })

  it('normalizes OpenAI-compatible workspace tool calls without executing them in the provider client', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_workspace_file', arguments: '{"path":"README.md"}' } }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-test', baseUrl: 'https://example.test/v1' },
      [{ role: 'user', content: 'Inspect the workspace.' }],
      { fetchImpl, tools: [{ name: 'read_workspace_file', description: 'Read a file.', inputSchema: { type: 'object' } }] },
    )

    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(payload.tools[0].function.name).toBe('read_workspace_file')
    expect(result.content).toBe('')
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'read_workspace_file', arguments: { path: 'README.md' } }])
  })

  it('maps Anthropic tool-use blocks to the same bounded agent contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu-1', name: 'search_workspace', input: { query: 'auth' } }],
      usage: { input_tokens: 9, output_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await callLlmProvider(
      { provider: 'anthropic', apiKey: 'secret', model: 'claude-test' },
      [{ role: 'user', content: 'Inspect the workspace.' }],
      { fetchImpl, tools: [{ name: 'search_workspace', description: 'Search files.', inputSchema: { type: 'object' } }] },
    )

    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(payload.tools[0]).toEqual(expect.objectContaining({ name: 'search_workspace', input_schema: { type: 'object' } }))
    expect(result.toolCalls).toEqual([{ id: 'toolu-1', name: 'search_workspace', arguments: { query: 'auth' } }])
  })

  it('rejects embedded URL credentials and plaintext remote credential delivery', async () => {
    await expect(callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-test', baseUrl: 'https://user:pass@example.test/v1' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl: vi.fn() },
    )).rejects.toThrow('without embedded credentials')

    await expect(callLlmProvider(
      { provider: 'openai', apiKey: 'secret', model: 'gpt-test', baseUrl: 'http://example.test/v1' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl: vi.fn() },
    )).rejects.toThrow('HTTPS')
  })

  it('allows keyless Ollama only on a loopback HTTP endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'Local response' } }] }), { status: 200 }))
    await expect(callLlmProvider(
      { provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl },
    )).resolves.toEqual(expect.objectContaining({ content: 'Local response' }))

    await expect(callLlmProvider(
      { provider: 'ollama', model: 'llama3.2', baseUrl: 'http://192.168.1.10:11434/v1' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl: vi.fn() },
    )).rejects.toThrow('loopback')
  })

  it('rejects keyed Ollama loopback HTTP before sending credentials', async () => {
    const fetchImpl = vi.fn()

    await expect(callLlmProvider(
      { provider: 'ollama', apiKey: 'secret', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1' },
      [{ role: 'user', content: 'Hello' }],
      { fetchImpl },
    )).rejects.toThrow('HTTPS')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('validates chat providers before scanning local inventory', async () => {
    const scanInstalledSkills = vi.fn()
    const callProvider = vi.fn()

    await expect(chatWithSkillOps({
      messages: [{ role: 'user', content: 'Which Skill should I compare?' }],
    }, { scanInstalledSkills, callProvider })).rejects.toBeInstanceOf(EvaluationError)

    expect(scanInstalledSkills).not.toHaveBeenCalled()
    expect(callProvider).not.toHaveBeenCalled()
  })

  it('sends inventory metadata to chat without leaking local source paths', async () => {
    let systemPrompt = ''
    const result = await chatWithSkillOps({
      provider: { provider: 'openai', apiKey: 'secret', model: 'test-model' },
      messages: [{ role: 'user', content: 'Which Skill should I compare?' }],
      context: {
        task: 'Review authentication.',
        criteria: 'Find concrete risks.',
        candidate: { skillId: 'security-review', skillVersion: '2.0.0', description: 'Review authentication security.' },
        match: { ...localSkill, similarity: 78, relationship: 'Likely update', sharedSignals: ['security', 'authentication'] },
        evaluation: { winner: 'candidate', reason: 'More concrete.', baselineScore: 60, candidateScore: 90, baselineOutput: 'baseline', candidateOutput: 'candidate' },
      },
    }, {
      scanInstalledSkills: async () => [localSkill],
      callProvider: async (_provider, messages) => {
        systemPrompt = messages[0].content
        return { content: 'Compare the closest overlapping Skill.', usage: { totalTokens: 8 }, provider: 'openai', model: 'test-model' }
      },
    })

    expect(systemPrompt).toContain('security-scan')
    expect(systemPrompt).toContain('Review authentication security.')
    expect(systemPrompt).toContain('Find concrete risks.')
    expect(systemPrompt).toContain('candidateOutput')
    expect(systemPrompt).not.toContain(localSkill.sourcePath)
    expect(result.message).toContain('closest')
  })

  it('rejects oversized nested assistant context', async () => {
    await expect(chatWithSkillOps({
      provider: { provider: 'openai', apiKey: 'secret', model: 'test-model' },
      messages: [{ role: 'user', content: 'Explain the result.' }],
      context: { evaluation: { reason: 'x'.repeat(10_000) } },
    }, {
      scanInstalledSkills: async () => [localSkill],
      callProvider: vi.fn(),
    })).rejects.toThrow('too long')
  })
})

describe('Evaluation HTTP boundary', () => {
  it('rejects non-loopback browser origins before reading local inventory', async () => {
    const request = fakeJsonRequest({}, { host: 'evil.example:4173', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
    const response = fakeResponse()

    await handleEvaluationApi(request, response, '/api/evaluations/compare')

    expect(response.statusCode).toBe(403)
  })

  it('rejects a forged loopback Host when the real peer is not loopback', async () => {
    const request = fakeJsonRequest({}, { host: '127.0.0.1:4173', origin: undefined }, '10.0.0.5')
    const response = fakeResponse()

    await handleEvaluationApi(request, response, '/api/assistant/chat')

    expect(response.statusCode).toBe(403)
  })

  it('accepts Node/Vite loopback socket peers', async () => {
    for (const remoteAddress of ['127.0.0.1', '127.24.0.9', '::1', '::ffff:127.0.0.1']) {
      const request = fakeJsonRequest({}, {}, remoteAddress)
      const response = fakeResponse()

      await handleEvaluationApi(request, response, '/api/assistant/chat')

      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('At least one chat message')
    }
  })

  it('fails closed when the socket peer address is missing', async () => {
    const request = fakeJsonRequest({})
    delete request.socket
    const response = fakeResponse()

    await handleEvaluationApi(request, response, '/api/assistant/chat')

    expect(response.statusCode).toBe(403)
  })

  it('requires application/json for evaluation POST requests', async () => {
    const request = fakeJsonRequest({}, { 'content-type': 'text/plain' })
    const response = fakeResponse()

    await handleEvaluationApi(request, response, '/api/evaluations/compare')

    expect(response.statusCode).toBe(415)
  })

  it('rejects oversized evaluation request bodies before parsing them', async () => {
    const request = fakeJsonRequest({}, { 'content-length': '600000' })
    const response = fakeResponse()

    await handleEvaluationApi(request, response, '/api/assistant/chat')

    expect(response.statusCode).toBe(413)
    expect(response.body).toContain('512 KB')
  })
})
