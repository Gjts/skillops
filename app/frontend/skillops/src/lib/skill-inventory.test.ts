import { describe, expect, it } from 'vitest'
import type { InstalledSkill } from '../types'
import { buildInventoryIssues, countInventoryIssues, definitionKey, normalizedSkillId } from './skill-inventory'

const definition = (overrides: Partial<InstalledSkill> = {}): InstalledSkill => ({
  skillId: 'review',
  skillVersion: '1.0.0',
  runtime: 'codex',
  source: 'global',
  sourcePath: '/home/me/.agents/skills/review/SKILL.md',
  provider: 'Agents',
  kind: 'skill',
  enabled: true,
  ...overrides,
})

describe('Skill inventory health', () => {
  it('classifies same-version enabled definitions as duplicates only', () => {
    const rows = [definition(), definition({ source: 'project', sourcePath: '/repo/.agents/skills/review/SKILL.md' })]
    const issues = buildInventoryIssues(rows)

    for (const row of rows) expect([...issues.get(definitionKey(row)) ?? []]).toEqual(['duplicate'])
  })

  it('classifies different enabled versions as conflicts instead of double-counting duplicates', () => {
    const rows = [definition(), definition({ skillVersion: '2.0.0', sourcePath: '/repo/.agents/skills/review/SKILL.md' })]
    const issues = buildInventoryIssues(rows)

    for (const row of rows) expect([...issues.get(definitionKey(row)) ?? []]).toEqual(['conflict'])
  })

  it('detects divergent contents even when definitions claim the same version', () => {
    const rows = [
      definition({ contentHash: 'a'.repeat(64) }),
      definition({ sourcePath: '/repo/.agents/skills/review/SKILL.md', contentHash: 'b'.repeat(64) }),
    ]
    const issues = buildInventoryIssues(rows)

    for (const row of rows) expect([...issues.get(definitionKey(row)) ?? []]).toEqual(['conflict'])
  })

  it('excludes disabled definitions from duplicate and conflict groups', () => {
    const enabled = definition()
    const disabled = definition({ skillVersion: '2.0.0', source: 'plugin', sourcePath: '/plugins/review/SKILL.md', enabled: false })
    const issues = buildInventoryIssues([enabled, disabled])

    expect(issues.has(definitionKey(enabled))).toBe(false)
    expect([...issues.get(definitionKey(disabled)) ?? []]).toEqual(['disabled'])
  })

  it('groups Skills and commands with the same runtime name as invocable definitions', () => {
    const skill = definition()
    const command = definition({ kind: 'command', sourcePath: '/repo/.agents/commands/review.md' })
    const issues = buildInventoryIssues([skill, command])

    expect([...issues.get(definitionKey(skill)) ?? []]).toEqual(['duplicate'])
    expect([...issues.get(definitionKey(command)) ?? []]).toEqual(['duplicate'])
  })

  it('keeps same names in different runtimes independent and scopes health counts', () => {
    const codex = definition()
    const claude = definition({ runtime: 'claude-code', provider: 'Claude Code', sourcePath: '/home/me/.claude/skills/review/SKILL.md' })
    const claudeConflict = definition({ runtime: 'claude-code', skillVersion: '2.0.0', sourcePath: '/repo/.claude/skills/review/SKILL.md' })
    const rows = [codex, claude, claudeConflict]
    const issues = buildInventoryIssues(rows)

    expect(issues.has(definitionKey(codex))).toBe(false)
    expect(countInventoryIssues(rows, issues, 'codex').conflict).toBe(0)
    expect(countInventoryIssues(rows, issues, 'claude-code').conflict).toBe(2)
  })

  it('keeps unknown-location historical definitions distinct by Skill metadata', () => {
    const alpha = definition({ skillId: 'alpha', sourcePath: 'Unknown location' })
    const beta = definition({ skillId: 'beta', sourcePath: 'Unknown location' })

    expect(definitionKey(alpha)).not.toBe(definitionKey(beta))
    expect(new Map([[definitionKey(alpha), alpha], [definitionKey(beta), beta]]).size).toBe(2)
  })

  it('keeps historical fallback keys distinct from known source paths', () => {
    const unknown = definition({ sourcePath: 'Unknown location' })
    const known = definition({ sourcePath: 'historical:["review","global","Agents","1.0.0"]' })

    expect(definitionKey(unknown)).not.toBe(definitionKey(known))
  })

  it('treats exact-case historical versions without hashes as conflicts', () => {
    const rc = definition({ skillVersion: '1.0.0-RC', sourcePath: '/repo/a/review/SKILL.md' })
    const lowerRc = definition({ skillVersion: '1.0.0-rc', sourcePath: '/repo/b/review/SKILL.md' })
    const issues = buildInventoryIssues([rc, lowerRc])

    expect([...issues.get(definitionKey(rc)) ?? []]).toEqual(['conflict'])
    expect([...issues.get(definitionKey(lowerRc)) ?? []]).toEqual(['conflict'])
  })

  it('normalizes Skill names without locale-sensitive lowercasing', () => {
    const original = String.prototype.toLocaleLowerCase

    try {
      String.prototype.toLocaleLowerCase = () => 'sentinel'
      expect(normalizedSkillId(' I ')).toBe('i')
    } finally {
      String.prototype.toLocaleLowerCase = original
    }
  })

  it('normalizes Skill names and Windows paths without collapsing distinct Unix paths', () => {
    const upper = definition({ skillId: 'Review', sourcePath: 'C:\\Users\\ME\\.agents\\skills\\review\\SKILL.md' })
    const lower = definition({ skillId: ' review ', sourcePath: 'c:/users/me/project/.agents/skills/review/SKILL.md' })
    const unixBackslash = definition({ sourcePath: '/repo/a\\b/SKILL.md' })
    const unixSeparator = definition({ sourcePath: '/repo/a/b/SKILL.md' })
    const issues = buildInventoryIssues([upper, lower])

    expect(definitionKey(upper)).toBe('codex:skill:path:c:/users/me/.agents/skills/review/skill.md')
    expect([...issues.get(definitionKey(upper)) ?? []]).toEqual(['duplicate'])
    expect(definitionKey(unixBackslash)).not.toBe(definitionKey(unixSeparator))
    expect(new Map([[definitionKey(unixBackslash), unixBackslash], [definitionKey(unixSeparator), unixSeparator]]).size).toBe(2)
  })
})
