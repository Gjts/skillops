import { describe, expect, it } from 'vitest'
import {
  artifactContentHash,
  normalizeArtifactContent,
  renderArtifactEvaluationPrompt,
} from './artifact-definition.mjs'
import { discoverCandidateArtifact } from './candidate-source.mjs'

describe('artifact definitions', () => {
  it('hashes UTF-8 content after BOM and line-ending normalization', () => {
    const lf = '---\nname: demo\n---\n# Demo\n'
    expect(normalizeArtifactContent(`\uFEFF${lf.replaceAll('\n', '\r\n')}`)).toBe(lf)
    expect(artifactContentHash(lf)).toBe(artifactContentHash(lf.replaceAll('\n', '\r\n')))
  })

  it('resolves candidates through the source adapter seam', async () => {
    const artifact = {
      kind: 'skill',
      artifactId: 'fake',
      version: '1.0.0',
      source: 'github',
      sourceRef: 'github:fake',
      contentHash: 'a'.repeat(64),
    }
    const result = await discoverCandidateArtifact({ sourceUrl: 'unused' }, {
      candidateSourceAdapter: { discover: async () => ({ definition: { artifact }, candidates: [] }) },
    })
    expect(result.definition.artifact).toEqual(artifact)
  })

  it('renders Prompt artifacts without presenting them as SKILL.md', () => {
    const messages = renderArtifactEvaluationPrompt({
      artifact: {
        kind: 'prompt',
        artifactId: 'reviewer',
        version: 'commit-a',
        source: 'prompt-registry',
        sourceRef: `prompt-registry:${'a'.repeat(40)}:prompts%2Freviewer.prompt.json:${'b'.repeat(64)}`,
        contentHash: 'b'.repeat(64),
      },
      prompt: { system: 'You are a reviewer.', template: 'Review {{change}}.' },
    }, 'Review a change.', 'Return actionable feedback.')
    expect(messages.map((message) => message.content).join('\n')).not.toContain('<skill-definition>')
    expect(messages).toContainEqual({ role: 'system', content: 'You are a reviewer.' })
  })
})
