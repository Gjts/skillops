import { describe, expect, it } from 'vitest'
import {
  EvaluationSchemaError,
  normalizeArtifactDefinition,
  normalizeAssistantChatRequest,
  normalizeQuickEvaluationRequest,
} from './evaluation-schema.mjs'

const provider = { provider: 'openai', model: 'gpt-test', apiKey: 'session-only' }

describe('evaluation schema', () => {
  it('normalizes a quick evaluation request through a narrow contract', () => {
    expect(normalizeQuickEvaluationRequest({
      sourceUrl: ' https://github.com/example/repo ',
      candidateContentHash: 'a'.repeat(64),
      baselineSourcePath: ' C:/skills/example/SKILL.md ',
      task: ' Test the candidate. ',
      criteria: ' It passes. ',
      provider: { ...provider, ignored: { unsafe: true } },
      ignored: 'not part of the contract',
    })).toEqual({
      sourceUrl: 'https://github.com/example/repo',
      candidatePath: undefined,
      candidateContentHash: 'a'.repeat(64),
      baselineSourcePath: 'C:/skills/example/SKILL.md',
      task: 'Test the candidate.',
      criteria: 'It passes.',
      mode: 'prompt-only',
      provider: {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'session-only',
        baseUrl: undefined,
        endpoint: undefined,
        apiVersion: undefined,
        reasoningEffort: undefined,
      },
    })
  })

  it('rejects invalid nested provider data before evaluation logic', () => {
    expect(() => normalizeQuickEvaluationRequest({
      sourceUrl: 'https://github.com/example/repo',
      candidateContentHash: 'a'.repeat(64),
      baselineSourcePath: 'C:/skills/example/SKILL.md',
      task: 'Task',
      criteria: 'Criteria',
      provider: ['openai'],
    })).toThrow(new EvaluationSchemaError('AI provider settings must be an object.'))
  })

  it('rejects invalid nested chat context and messages', () => {
    expect(() => normalizeAssistantChatRequest({ provider, messages: ['hello'] })).toThrow('Chat message must be an object.')
    expect(() => normalizeAssistantChatRequest({
      provider,
      messages: [{ role: 'user', content: 'hello' }],
      context: { candidate: [] },
    })).toThrow('Candidate context must be an object.')
  })

  it('normalizes the shared artifact contract and rejects invalid hashes', () => {
    const artifact = {
      kind: 'skill',
      artifactId: 'commit-standard',
      version: '1.0.0',
      source: 'github',
      sourceRef: 'github:owner/repo/SKILL.md@commit',
      contentHash: 'b'.repeat(64),
      variables: ['language'],
    }
    expect(normalizeArtifactDefinition(artifact)).toEqual({
      ...artifact,
      description: undefined,
      providerHint: undefined,
      modelHint: undefined,
    })
    expect(() => normalizeArtifactDefinition({ ...artifact, contentHash: 'remote-hash' })).toThrow('SHA-256')
  })
})
