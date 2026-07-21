import type { InstalledSkill, Runtime } from '../types'

export type InventoryIssue = 'conflict' | 'duplicate' | 'disabled' | 'missing'

function normalizedPath(value: string) {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function normalizedSkillId(value: string) {
  return value.trim().toLocaleLowerCase()
}

export function definitionKey(row: InstalledSkill) {
  return `${row.runtime}:${row.kind}:${normalizedPath(row.sourcePath)}`
}

export function inventoryGroupKey(row: InstalledSkill) {
  return `${row.runtime}:${normalizedSkillId(row.skillId)}`
}

function hasMissingMetadata(row: InstalledSkill) {
  return !row.skillId.trim() || row.skillId === 'unknown-skill' ||
    !row.sourcePath.trim() || row.sourcePath === 'Unknown location'
}

export function buildInventoryIssues(rows: InstalledSkill[]) {
  const issues = new Map<string, Set<InventoryIssue>>()
  const enabledByRuntimeAndName = new Map<string, InstalledSkill[]>()

  const add = (row: InstalledSkill, issue: InventoryIssue) => {
    const key = definitionKey(row)
    const current = issues.get(key) ?? new Set<InventoryIssue>()
    current.add(issue)
    issues.set(key, current)
  }

  for (const row of rows) {
    if (!row.enabled) add(row, 'disabled')
    if (hasMissingMetadata(row)) add(row, 'missing')
    if (!row.enabled || hasMissingMetadata(row)) continue
    const key = inventoryGroupKey(row)
    const definitions = enabledByRuntimeAndName.get(key) ?? []
    definitions.push(row)
    enabledByRuntimeAndName.set(key, definitions)
  }

  for (const definitions of enabledByRuntimeAndName.values()) {
    if (definitions.length < 2) continue
    const hasCompleteHashes = definitions.every((row) => /^[a-f0-9]{64}$/i.test(row.contentHash ?? ''))
    const fingerprints = new Set(definitions.map((row) => hasCompleteHashes
      ? row.contentHash!.toLocaleLowerCase()
      : `version:${row.skillVersion.trim().toLocaleLowerCase()}`))
    const issue: InventoryIssue = fingerprints.size > 1 ? 'conflict' : 'duplicate'
    definitions.forEach((row) => add(row, issue))
  }

  return issues
}

export function issuesForDefinition(issues: Map<string, Set<InventoryIssue>>, row: InstalledSkill) {
  return issues.get(definitionKey(row)) ?? new Set<InventoryIssue>()
}

export function countInventoryIssues(
  rows: InstalledSkill[],
  issues: Map<string, Set<InventoryIssue>>,
  runtime: Runtime | 'all',
) {
  const scopedRows = rows.filter((row) => runtime === 'all' || row.runtime === runtime)
  const withIssues = scopedRows.filter((row) => issues.has(definitionKey(row)))
  const count = (issue: InventoryIssue) => withIssues.filter((row) => issuesForDefinition(issues, row).has(issue)).length
  return {
    attention: withIssues.length,
    conflict: count('conflict'),
    duplicate: count('duplicate'),
    disabled: count('disabled'),
    missing: count('missing'),
  }
}
