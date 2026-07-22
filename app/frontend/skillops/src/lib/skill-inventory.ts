import type { InstalledSkill, Runtime } from '../types'

export type InventoryIssue = 'conflict' | 'duplicate' | 'disabled' | 'missing'

function normalizedPath(value: string) {
  const path = value.trim()
  const windowsPath = /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path)
  const normalized = windowsPath ? path.replace(/\\/g, '/').toLowerCase() : path
  return normalized.replace(/\/+$/, '')
}

export function normalizedSkillId(value: string) {
  return value.trim().toLowerCase()
}

function hasKnownPath(value: string) {
  const path = value.trim()
  return path !== '' && path !== 'Unknown location'
}

function historicalDefinitionKey(row: InstalledSkill) {
  return JSON.stringify([
    normalizedSkillId(row.skillId),
    row.source.trim(),
    row.provider.trim(),
    row.skillVersion.trim(),
  ])
}

export function definitionKey(row: InstalledSkill) {
  return hasKnownPath(row.sourcePath)
    ? `${row.runtime}:${row.kind}:path:${normalizedPath(row.sourcePath)}`
    : `${row.runtime}:${row.kind}:historical:${historicalDefinitionKey(row)}`
}

export function inventoryGroupKey(row: InstalledSkill) {
  const kind = ['skill', 'command'].includes(row.kind) ? 'invocable' : row.kind
  return `${row.runtime}:${kind}:${normalizedSkillId(row.skillId)}`
}

function hasMissingMetadata(row: InstalledSkill) {
  return !row.skillId.trim() || row.skillId === 'unknown-skill' || !hasKnownPath(row.sourcePath)
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
      ? row.contentHash!.toLowerCase()
      : `version:${row.skillVersion.trim()}`))
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
