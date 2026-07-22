import { createHash } from 'node:crypto'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { EvaluationError } from './errors.mjs'
import { renderPromptVariables } from './prompt-variables.mjs'

export function normalizeArtifactContent(contents) {
  if (typeof contents !== 'string') throw new EvaluationError('Artifact content must be UTF-8 text.', 422)
  return contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export function artifactContentHash(contents) {
  return createHash('sha256').update(Buffer.from(normalizeArtifactContent(contents), 'utf8')).digest('hex')
}

export function createSkillArtifactDefinition(skill, source) {
  const sourceRef = source === 'github'
    ? `github:${skill.sourceUrl}`
    : `local-scan:${skill.runtime || 'unknown'}:${skill.sourcePath}`
  return normalizeArtifactDefinition({
    kind: 'skill',
    artifactId: skill.skillId,
    version: skill.skillVersion || 'unversioned',
    description: skill.description,
    source,
    sourceRef,
    contentHash: skill.contentHash,
    providerHint: skill.provider,
    gitCommit: skill.gitCommit,
    repository: skill.repository,
  })
}
const runtimeArtifactKinds = { skill: 'skill', command: 'workflow', rules: 'rules', agent: 'agent' }

export function artifactKindForRuntimeDefinition(kind) {
  return runtimeArtifactKinds[kind]
}

export function createRuntimeArtifactDefinition(definition) {
  const kind = artifactKindForRuntimeDefinition(definition.kind)
  if (!kind) throw new EvaluationError(`Unsupported runtime Artifact kind: ${definition.kind}.`, 422)
  return normalizeArtifactDefinition({
    kind,
    artifactId: definition.skillId,
    version: definition.skillVersion || 'unversioned',
    description: definition.description,
    source: 'local-scan',
    sourceRef: `local-scan:${definition.runtime || 'unknown'}:${definition.sourcePath}`,
    contentHash: definition.contentHash,
    providerHint: definition.provider,
    runtimeTargets: definition.runtime ? [definition.runtime] : [],
  })
}


export function renderArtifactEvaluationPrompt(record, task, criteria, variables = {}) {
  const artifact = normalizeArtifactDefinition(record?.artifact)
  if (artifact.kind === 'skill') {
    return [
      {
        role: 'system',
        content: `You are executing a coding-agent Skill in a controlled evaluation. Follow the Skill instructions exactly. Do not discuss the evaluation harness.\n\n<skill-definition>\n${normalizeArtifactContent(record.contents)}\n</skill-definition>`,
      },
      {
        role: 'user',
        content: `Evaluation task:\n${task}\n\nAcceptance criteria:\n${criteria}\n\nReturn the best final answer the Skill would produce.`,
      },
    ]
  }
  if (artifact.kind === 'prompt') {
    const prepared = renderPromptVariables(record, variables)
    const prompt = prepared.prompt
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) throw new EvaluationError('Prompt artifacts require a structured prompt renderer.', 422)
    const messages = []
    if (typeof prompt.system === 'string' && prompt.system.trim()) messages.push({ role: 'system', content: prompt.system })
    if (Array.isArray(prompt.messages)) {
      for (const message of prompt.messages) {
        if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
          throw new EvaluationError('Prompt artifact messages are invalid.', 422)
        }
        messages.push({ role: message.role, content: message.content })
      }
    } else if (typeof prompt.template === 'string') {
      messages.push({ role: 'user', content: prompt.template })
    }
    if (!messages.length) throw new EvaluationError('Prompt artifacts require a system message, messages, or template.', 422)
    messages.push({ role: 'user', content: `Evaluation task:\n${task}\n\nAcceptance criteria:\n${criteria}` })
    return messages
  }
  if (['workflow', 'rules', 'agent', 'evaluation-suite', 'policy-pack'].includes(artifact.kind)) {
    if (typeof record.contents !== 'string' || !record.contents.trim()) {
      throw new EvaluationError(`${artifact.kind} artifacts require UTF-8 instruction content.`, 422)
    }
    const label = artifact.kind[0].toUpperCase() + artifact.kind.slice(1)
    return [
      {
        role: 'system',
        content: `You are executing a ${label} Artifact in a controlled evaluation. Treat its contents as instructions and constraints. Do not discuss the evaluation harness.\n\n<${artifact.kind}-definition>\n${normalizeArtifactContent(record.contents)}\n</${artifact.kind}-definition>`,
      },
      {
        role: 'user',
        content: `Evaluation task:\n${task}\n\nAcceptance criteria:\n${criteria}\n\nReturn the best final answer the ${label} Artifact would produce.`,
      },
    ]
  }
  throw new EvaluationError(`Unsupported Artifact kind: ${artifact.kind}.`, 422)
}
