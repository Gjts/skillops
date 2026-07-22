import { describe, expect, it } from 'vitest'
import {
  EvaluationSchemaError,
  normalizeArtifactDefinition,
  normalizeAssistantChatRequest,
  normalizeManagedEvaluationRunRequest,
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

  it('accepts only a SHA-256 subject binding for managed runs', () => {
    const request = {
      suiteId: 'suite-1',
      baselineRef: 'baseline',
      candidateRef: 'candidate',
      requestedBy: 'qa',
      provider,
      subjectHash: 'f'.repeat(64),
    }
    expect(normalizeManagedEvaluationRunRequest(request).subjectHash).toBe(request.subjectHash)
    expect(() => normalizeManagedEvaluationRunRequest({ ...request, subjectHash: 'mutable-tag' })).toThrow('SHA-256')
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
    const commit = 'c'.repeat(40)
    const artifact = {
      kind: 'skill',
      artifactId: 'commit-standard',
      version: '1.0.0',
      source: 'github',
      sourceRef: `github:https://github.com/owner/repo/blob/${commit}/skills/review/SKILL.md#skills%2Freview%2FSKILL.md`,
      contentHash: 'b'.repeat(64),
      gitCommit: commit,
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

  it('accepts exact PromptHub v1 revisions without treating them as Git commits', () => {
    const artifact = normalizeArtifactDefinition({
      kind: 'prompt',
      artifactId: 'prompthub-4948',
      version: 'ed651609',
      source: 'prompthub',
      sourceRef: `prompthub:v1:4948:ed651609:${'a'.repeat(64)}`,
      contentHash: 'a'.repeat(64),
    })
    expect(artifact.source).toBe('prompthub')
    expect(artifact).not.toHaveProperty('gitCommit')
    expect(() => normalizeArtifactDefinition({ ...artifact, sourceRef: `prompthub:v1:4948:bad/revision:${'a'.repeat(64)}` })).toThrow('source reference')
    const branchRef = `prompthub:v1:4948:branch:feature%2Freview:ed651609:${'a'.repeat(64)}`
    expect(normalizeArtifactDefinition({ ...artifact, sourceRef: branchRef }).sourceRef).toBe(branchRef)
    expect(() => normalizeArtifactDefinition({ ...artifact, sourceRef: branchRef.replace('feature%2Freview', '..%2Freview') })).toThrow('source reference')
  })
})
