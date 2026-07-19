import type { Runtime, SkillEvent } from '../types'

export interface SkillDefinition {
  id: string
  version: string
  runtime: Runtime
  description: string
  tags: string[]
  source: 'global' | 'project' | 'plugin'
  path: string
}

const topSkills = [
  { id: 'database-migration', version: '1.3.0', runtime: 'codex' as const, count: 312, success: 299, description: 'Generates safe database migrations with rollback support.', tags: ['database', 'schema', 'migration'] },
  { id: 'frontend-builder', version: '2.1.0', runtime: 'cursor' as const, count: 298, success: 267, description: 'Turns product requirements into responsive frontend implementations.', tags: ['react', 'ui', 'frontend'] },
  { id: 'test-generator', version: '1.0.4', runtime: 'claude-code' as const, count: 256, success: 224, description: 'Creates focused unit and integration tests from changed code.', tags: ['testing', 'coverage', 'quality'] },
  { id: 'security-review', version: '1.2.1', runtime: 'codex' as const, count: 198, success: 185, description: 'Reviews changes for exploitable security regressions.', tags: ['security', 'review', 'risk'] },
]

const secondaryNames = [
  'api-contract', 'accessibility-audit', 'release-notes', 'incident-triage', 'sql-review',
  'performance-profile', 'dependency-upgrade', 'code-review', 'docs-writer', 'pr-description',
  'design-system', 'deployment-check', 'schema-inspector', 'bug-reproducer', 'log-analyzer',
  'refactor-planner', 'typescript-fix', 'e2e-runner', 'visual-qa', 'commit-writer',
  'changelog-check', 'container-review', 'cloudflare-worker', 'supabase-review', 'api-tester',
  'fixture-builder', 'query-optimizer', 'rollback-plan', 'feature-flag', 'prompt-evaluator',
  'repo-onboarding', 'architecture-map', 'localization-check', 'data-validator',
]

const runtimes: Runtime[] = ['codex', 'claude-code', 'cursor']

export const skillRegistry: SkillDefinition[] = [
  ...topSkills.map((skill, index) => ({
    id: skill.id,
    version: skill.version,
    runtime: skill.runtime,
    description: skill.description,
    tags: skill.tags,
    source: (index % 2 ? 'project' : 'global') as SkillDefinition['source'],
    path: index % 2 ? `.agents/skills/${skill.id}/SKILL.md` : `~/.codex/skills/${skill.id}/SKILL.md`,
  })),
  ...secondaryNames.map((id, index) => ({
    id,
    version: `0.${1 + (index % 4)}.${index % 7}`,
    runtime: runtimes[index % runtimes.length],
    description: `Team capability for ${id.replaceAll('-', ' ')} workflows.`,
    tags: [id.split('-')[0], 'team'],
    source: (index % 5 === 0 ? 'plugin' : index % 2 === 0 ? 'global' : 'project') as SkillDefinition['source'],
    path: index % 2 === 0 ? `~/.agents/skills/${id}/SKILL.md` : `.agents/skills/${id}/SKILL.md`,
  })),
]

export const skillDefinitionById = new Map(skillRegistry.map((skill) => [skill.id, skill]))

function shuffled<T>(items: T[], seed: number) {
  const output = [...items]
  let value = seed
  for (let index = output.length - 1; index > 0; index -= 1) {
    value = (value * 1664525 + 1013904223) % 4294967296
    const target = value % (index + 1)
    ;[output[index], output[target]] = [output[target], output[index]]
  }
  return output
}

export function createSeedEvents(): SkillEvent[] {
  const skillIds = topSkills.flatMap((skill) => Array.from({ length: skill.count }, () => skill.id))
  const secondaryRuns = 220
  for (let index = 0; index < secondaryRuns; index += 1) {
    skillIds.push(secondaryNames[index % secondaryNames.length])
  }

  const runtimeSequence = shuffled<Runtime>([
    ...Array.from({ length: 712 }, () => 'codex' as const),
    ...Array.from({ length: 358 }, () => 'claude-code' as const),
    ...Array.from({ length: 214 }, () => 'cursor' as const),
  ], 17)
  const daySequence = shuffled<number>([
    ...Array.from({ length: 170 }, () => 6),
    ...Array.from({ length: 210 }, () => 5),
    ...Array.from({ length: 180 }, () => 4),
    ...Array.from({ length: 350 }, () => 3),
    ...Array.from({ length: 265 }, () => 2),
    ...Array.from({ length: 69 }, () => 1),
    ...Array.from({ length: 40 }, () => 0),
  ], 41)
  const sequence = shuffled(skillIds, 29)
  const counters = new Map<string, number>()
  const base = new Date()
  base.setHours(17, 30, 0, 0)

  return sequence.map((skillId, index) => {
    const definition = skillDefinitionById.get(skillId)!
    const seen = counters.get(skillId) ?? 0
    counters.set(skillId, seen + 1)
    const top = topSkills.find((skill) => skill.id === skillId)
    const successful = top ? seen < top.success : index % 220 < 204
    const timestamp = new Date(base)
    timestamp.setDate(timestamp.getDate() - daySequence[index])
    timestamp.setMinutes(timestamp.getMinutes() - ((index * 13) % 510))
    const runtime = runtimeSequence[index]
    const tokens = 680 + ((index * 137) % 4100)
    const rate = runtime === 'codex' ? 0.00006 : runtime === 'claude-code' ? 0.000045 : 0.000035

    return {
      id: `run_${(index + 48193).toString(16)}`,
      event: successful ? 'skill.completed' : 'skill.failed',
      skillId,
      skillVersion: definition.version,
      runtime,
      timestamp: timestamp.toISOString(),
      durationMs: 24_000 + ((index * 977) % 390_000),
      costUsd: Number((tokens * rate).toFixed(4)),
      tokens,
      sessionId: `ses_${((index * 97) + 1000).toString(16)}`,
      project: ['platform-api', 'web-console', 'billing-service', 'developer-tools'][index % 4],
      error: successful ? undefined : ['Assertion mismatch in 2 tests', 'Type check failed', 'Tool permission denied'][index % 3],
    }
  })
}
