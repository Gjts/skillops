import { describe, expect, it } from 'vitest'
import {
  artifactContentHash,
  normalizeArtifactContent,
  renderArtifactEvaluationPrompt,
} from './artifact-definition.mjs'
import { discoverCandidateArtifact, parseSkillDefinition } from './candidate-source.mjs'
import {
  ARTIFACT_KINDS,
  normalizeArtifactDefinition,
  normalizeArtifactRecord,
  normalizeArtifactVersionRecord,
} from '../../shared/evaluation-schema.mjs'

describe('artifact definitions', () => {
  it('hashes UTF-8 content after BOM and line-ending normalization', () => {
    const lf = '---\nname: demo\n---\n# Demo\n'
    expect(normalizeArtifactContent(`\uFEFF${lf.replaceAll('\n', '\r\n')}`)).toBe(lf)
    expect(artifactContentHash(lf)).toBe(artifactContentHash(lf.replaceAll('\n', '\r\n')))
  })

  it('preserves a complete package hash supplied by the installed scanner', () => {
    const contentHash = 'a'.repeat(64)
    expect(parseSkillDefinition('---\nname: demo\n---\n', 'demo', { contentHash }).artifact.contentHash).toBe(contentHash)
  })

  it('keeps all seven Artifact kinds distinct and binds versions to commit plus content hash', () => {
    const commit = 'b'.repeat(40)
    const records = ARTIFACT_KINDS.map((kind) => normalizeArtifactRecord({
      artifactId: 'review',
      kind,
      name: 'Review',
      owner: 'platform',
      repository: 'https://github.com/acme/assets',
      status: 'candidate',
    }))
    expect(records).toHaveLength(7)
    expect(new Set(records.map((record) => record.id))).toHaveLength(7)

    const definition = normalizeArtifactDefinition({
      kind: 'rules',
      artifactId: 'review',
      version: '2.0.0',
      source: 'github',
      sourceRef: `github:https://github.com/acme/assets/blob/${commit}/AGENTS.md#AGENTS.md`,
      contentHash: 'a'.repeat(64),
      gitCommit: commit,
      repository: 'https://github.com/acme/assets',
      dependencies: ['skill:security-review'],
      runtimeTargets: ['codex', 'claude-code'],
    })
    const version = normalizeArtifactVersionRecord({ artifact: definition, status: 'candidate' })
    expect(version).toEqual(expect.objectContaining({
      id: `rules:review@${commit}:${'a'.repeat(64)}`,
      artifactId: 'rules:review',
      gitCommit: commit,
      dependencies: ['skill:security-review'],
    }))
  })

  it('validates immutable generic Git source references', () => {
    const commit = 'b'.repeat(40)
    const gitDefinition = normalizeArtifactDefinition({
      kind: 'agent',
      artifactId: 'review-agent',
      version: commit,
      source: 'git',
      sourceRef: `git:v1:${'c'.repeat(64)}:${commit}:agents%2Freview.md:${'d'.repeat(64)}`,
      contentHash: 'd'.repeat(64),
      gitCommit: commit,
      repository: `git-root:${'e'.repeat(40)}`,
    })
    expect(normalizeArtifactVersionRecord({ artifact: gitDefinition, status: 'candidate' })).toEqual(expect.objectContaining({
      id: `agent:review-agent@${commit}:${'d'.repeat(64)}`,
      source: 'git',
      status: 'candidate',
    }))
    expect(() => normalizeArtifactDefinition({ ...gitDefinition, gitCommit: 'f'.repeat(40) })).toThrow('immutable Git commit')
  })

  it('renders every instruction-bearing Artifact kind through an isolated definition boundary', () => {
    const base = {
      artifactId: 'review',
      version: '1.0.0',
      source: 'local-scan',
      contentHash: 'a'.repeat(64),
    }
    for (const kind of ['workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack']) {
      const messages = renderArtifactEvaluationPrompt({
        artifact: {
          ...base,
          kind,
          sourceRef: `local-scan:claude-code:/repo/${kind}.md`,
        },
        contents: `# ${kind}\nFollow the ${kind}.`,
      }, 'Review a change.', 'Return actionable feedback.')
      expect(messages).toHaveLength(2)
      expect(messages[0].content).toContain(`<${kind}-definition>`)
      expect(messages[1].content).toContain('Review a change.')
    }
  })

  it('keeps metadata safe and expands partial Runtime compatibility', () => {
    const artifact = {
      kind: 'skill',
      artifactId: 'review',
      version: '1.0.0',
      source: 'local-scan',
      sourceRef: 'local-scan:codex:/repo/SKILL.md',
      contentHash: 'a'.repeat(64),
      compatibility: { codex: 'unsupported' },
    }
    expect(normalizeArtifactVersionRecord({ artifact, status: 'ready' }).compatibility).toEqual({
      codex: 'unsupported',
      'claude-code': 'supported',
      cursor: 'preview',
    })
    expect(() => normalizeArtifactDefinition({ ...artifact, repository: 'https://token@github.com/acme/assets' })).toThrow('credentials')
    expect(() => normalizeArtifactDefinition({
      ...artifact,
      source: 'github',
      sourceRef: 'github:https://user:token@github.com/acme/assets?key=secret#SKILL.md',
    })).toThrow('credentials')
    expect(() => normalizeArtifactDefinition({ ...artifact, source: 'github', sourceRef: 'github:ghp_secret' })).toThrow('source reference is invalid')
    expect(() => normalizeArtifactDefinition({
      ...artifact,
      source: 'github',
      sourceRef: 'github:https://github.com/acme/assets/tree/main/SKILL.md',
      gitCommit: 'f'.repeat(40),
    })).toThrow('immutable Git commit')
    expect(() => normalizeArtifactDefinition({ ...artifact, dependencies: ['not-an-artifact'] })).toThrow('kind-scoped')
    expect(normalizeArtifactDefinition({
      ...artifact,
      dependencies: ['skill:My Skill', 'agent:%E5%AE%A1%E6%A0%B8'],
    }).dependencies).toEqual(['skill:My%20Skill', 'agent:%E5%AE%A1%E6%A0%B8'])
    const unresolved = normalizeArtifactVersionRecord({
      artifact: { ...artifact, source: 'github', sourceRef: 'github:skillops/deterministic-fixture#baseline' },
      status: 'candidate',
    })
    expect(unresolved).toEqual(expect.objectContaining({
      id: `skill:review@unresolved:${'a'.repeat(64)}`,
      gitCommit: null,
      status: 'blocked',
      sourceRef: 'github:https://github.com/skillops/deterministic-fixture',
    }))
  })

  it('resolves candidates through the source adapter seam', async () => {
    const artifact = {
      kind: 'skill',
      artifactId: 'fake',
      version: '1.0.0',
      source: 'github',
      sourceRef: `github:https://github.com/acme/fake/blob/${'f'.repeat(40)}/SKILL.md#SKILL.md`,
      contentHash: 'a'.repeat(64),
      gitCommit: 'f'.repeat(40),
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
