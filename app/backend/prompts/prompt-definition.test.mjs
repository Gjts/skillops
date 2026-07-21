import { describe, expect, it } from 'vitest'
import { renderArtifactEvaluationPrompt } from '../evaluations/artifact-definition.mjs'
import { adaptPromptDefinition, parsePromptRegistrySourceRef } from './prompt-definition.mjs'

const commit = 'a'.repeat(40)

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'release-summary',
    name: 'Release summary',
    description: 'Summarizes a release for a selected audience.',
    system: 'Be precise for {{audience}}.',
    template: 'Summarize {{release}}.',
    model: { provider: 'openai', name: 'gpt-5.6-sol', configuration: { temperature: 0.2 } },
    variables: ['audience'],
    ...overrides,
  }
}

describe('local Prompt definition', () => {
  it('normalizes a strict definition into an immutable Prompt Artifact', () => {
    const record = adaptPromptDefinition(definition(), { commit, relativePath: 'prompts/release.prompt.json' })
    expect(record.artifact).toEqual(expect.objectContaining({
      kind: 'prompt', source: 'prompt-registry', artifactId: 'release-summary', version: commit,
      variables: ['audience', 'release'], providerHint: 'openai', modelHint: 'gpt-5.6-sol',
    }))
    expect(parsePromptRegistrySourceRef(record.artifact.sourceRef)).toEqual({
      commit, relativePath: 'prompts/release.prompt.json', contentHash: record.artifact.contentHash,
    })
    expect(record.artifact.componentHashes).toEqual(expect.objectContaining({ system: expect.stringMatching(/^[a-f0-9]{64}$/), prompt: expect.stringMatching(/^[a-f0-9]{64}$/) }))
  })

  it('renders declared and discovered variables as inert scalar substitutions', () => {
    const record = adaptPromptDefinition(definition(), { commit, relativePath: 'prompts/release.prompt.json' })
    const messages = renderArtifactEvaluationPrompt(record, 'Write the summary.', 'Be concise.', { audience: 'engineering', release: 'v2' })
    expect(messages).toContainEqual({ role: 'system', content: 'Be precise for engineering.' })
    expect(messages).toContainEqual({ role: 'user', content: 'Summarize v2.' })
    expect(messages.map((message) => message.content).join('\n')).not.toContain('{{')
  })

  it('rejects ambiguous bodies, unknown fields, unsafe variables, and invalid model configuration', () => {
    expect(() => adaptPromptDefinition(definition({ messages: [{ role: 'user', content: 'Hi' }] }), { commit, relativePath: 'prompts/a.prompt.json' })).toThrow('exactly one')
    expect(() => adaptPromptDefinition(definition({ unexpected: true }), { commit, relativePath: 'prompts/a.prompt.json' })).toThrow('unsupported field')
    expect(() => adaptPromptDefinition(definition({ variables: ['constructor.value'] }), { commit, relativePath: 'prompts/a.prompt.json' })).toThrow('unsafe')
    expect(() => adaptPromptDefinition(definition({ model: { provider: 'openai', name: 'gpt', configuration: { executable: 'calc' } } }), { commit, relativePath: 'prompts/a.prompt.json' })).toThrow('unsupported field')
  })
})
