import { EvaluationError } from './evaluations/errors.mjs'

const RUNTIMES = ['codex', 'claude-code', 'cursor']
const SOURCES = ['global', 'project', 'plugin']
const ATTENTION = ['all', 'attention', 'conflict', 'duplicate', 'disabled', 'missing']
const STATUSES = ['enabled', 'disabled', 'all']
const KINDS = ['skill', 'command', 'rules', 'agent']
const DEFINITION_STATUSES = ['active', 'disabled', 'shadowed', 'inactive', 'missing']
const CONFIGURATION_SOURCES = ['user', 'project', 'local', 'managed', 'plugin', 'admin']
const DISABLED_REASONS = ['plugin', 'skill-config', 'plugin-and-skill-config']
const MAX_FACET_VALUES = 100
const MAX_DIAGNOSTIC_ITEMS = 100
const MAX_METADATA_ITEMS = 100

function normalizedSkillId(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizedPath(value) {
  const sourcePath = String(value || '').trim()
  const windowsPath = /^[a-z]:[\\/]/i.test(sourcePath) || /^\\\\/.test(sourcePath)
  const normalized = windowsPath ? sourcePath.replace(/\\/g, '/').toLowerCase() : sourcePath
  return normalized.replace(/\/+$/, '')
}

function hasKnownPath(value) {
  const sourcePath = String(value || '').trim()
  return sourcePath !== '' && sourcePath !== 'Unknown location'
}

function definitionKey(row) {
  if (hasKnownPath(row.sourcePath)) return `${row.runtime}:${row.kind}:path:${normalizedPath(row.sourcePath)}`
  return `${row.runtime}:${row.kind}:historical:${JSON.stringify([
    normalizedSkillId(row.skillId),
    String(row.source || '').trim(),
    String(row.provider || '').trim(),
    String(row.skillVersion || '').trim(),
  ])}`
}

function inventoryGroupKey(row) {
  const kind = row.kind === 'skill' || row.kind === 'command' ? 'invocable' : row.kind
  return `${row.runtime}:${kind}:${normalizedSkillId(row.skillId)}`
}

function normalizeDefinition(value) {
  const row = value && typeof value === 'object' ? value : {}
  const runtime = RUNTIMES.includes(row.runtime) ? row.runtime : 'codex'
  const source = SOURCES.includes(row.source) ? row.source : 'global'
  const enabled = typeof row.enabled === 'boolean' ? row.enabled : true
  const optionalText = (field) => typeof row[field] === 'string' ? row[field] : undefined
  const optionalList = (field) => Array.isArray(row[field])
    ? row[field].filter((item) => typeof item === 'string').slice(0, MAX_METADATA_ITEMS)
    : undefined
  return {
    skillId: typeof row.skillId === 'string' && row.skillId ? row.skillId : 'unknown-skill',
    skillVersion: typeof row.skillVersion === 'string' && row.skillVersion ? row.skillVersion : 'unversioned',
    runtime,
    source,
    sourcePath: typeof row.sourcePath === 'string' && row.sourcePath ? row.sourcePath : 'Unknown location',
    provider: typeof row.provider === 'string' && row.provider
      ? row.provider
      : source === 'project' ? 'Project' : runtime === 'claude-code' ? 'Claude Code' : runtime === 'cursor' ? 'Cursor' : 'Codex',
    kind: KINDS.includes(row.kind) ? row.kind : 'skill',
    enabled,
    disabledReason: DISABLED_REASONS.includes(row.disabledReason) ? row.disabledReason : undefined,
    status: DEFINITION_STATUSES.includes(row.status) ? row.status : enabled ? 'active' : 'disabled',
    shadowedBy: optionalText('shadowedBy'),
    configurationSource: CONFIGURATION_SOURCES.includes(row.configurationSource)
      ? row.configurationSource
      : source === 'plugin' ? 'plugin' : source === 'project' ? 'project' : 'user',
    scope: CONFIGURATION_SOURCES.includes(row.scope) ? row.scope : undefined,
    originConfigs: optionalList('originConfigs'),
    projectRoot: optionalText('projectRoot'),
    contentHash: optionalText('contentHash'),
    description: optionalText('description'),
    tags: optionalList('tags'),
  }
}

function boundedFacet(items, selected = '') {
  const values = items.slice(0, MAX_FACET_VALUES)
  const selectedItem = selected && items.find((item) => item.provider === selected)
  if (selectedItem && !values.includes(selectedItem)) {
    if (values.length === MAX_FACET_VALUES) values[values.length - 1] = selectedItem
    else values.push(selectedItem)
  }
  return { values, truncated: items.length > values.length }
}

function normalizeScanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { scan: null, truncated: false }
  const coverageSource = Array.isArray(value.coverage) ? value.coverage : []
  const errorSource = Array.isArray(value.errors) ? value.errors : []
  const observabilitySource = Array.isArray(value.observability) ? value.observability : []
  const coverage = coverageSource.slice(0, MAX_DIAGNOSTIC_ITEMS).map((item) => ({
    runtime: RUNTIMES.includes(item?.runtime) ? item.runtime : 'codex',
    directory: typeof item?.directory === 'string' ? item.directory : 'Unknown location',
    source: SOURCES.includes(item?.source) ? item.source : 'global',
    configurationSource: CONFIGURATION_SOURCES.includes(item?.configurationSource) ? item.configurationSource : 'user',
    state: ['scanned', 'partial', 'missing', 'inaccessible', 'error'].includes(item?.state) ? item.state : 'error',
  }))
  const errors = errorSource.slice(0, MAX_DIAGNOSTIC_ITEMS).map((item) => ({
    code: typeof item?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(item.code) ? item.code : 'SCAN_PATH_ERROR',
    path: typeof item?.path === 'string' ? item.path : 'Unknown location',
    runtime: RUNTIMES.includes(item?.runtime) ? item.runtime : 'codex',
    message: 'Scan location could not be inspected.',
  }))
  const observability = observabilitySource.slice(0, MAX_DIAGNOSTIC_ITEMS).map((item) => ({
    runtime: RUNTIMES.includes(item?.runtime) ? item.runtime : 'codex',
    state: item?.state === 'complete' ? 'complete' : 'partial',
    reason: typeof item?.reason === 'string' ? item.reason : undefined,
  }))
  return {
    scan: {
      id: typeof value.id === 'string' ? value.id : 'scan_unknown',
      projectStart: typeof value.projectStart === 'string' ? value.projectStart : undefined,
      projectRoot: typeof value.projectRoot === 'string' ? value.projectRoot : '',
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
      completedAt: typeof value.completedAt === 'string' ? value.completedAt : '',
      durationMs: Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : 0,
      coverage,
      errors,
      observability,
    },
    truncated: coverage.length < coverageSource.length
      || errors.length < errorSource.length
      || observability.length < observabilitySource.length,
  }
}

function buildIssues(rows) {
  const issues = new Map()
  const definitionsByIdentity = new Map()
  const add = (row, issue) => {
    const key = definitionKey(row)
    const current = issues.get(key) ?? new Set()
    current.add(issue)
    issues.set(key, current)
  }

  for (const row of rows) {
    const missing = !String(row.skillId || '').trim() || row.skillId === 'unknown-skill' || !hasKnownPath(row.sourcePath)
    if (!row.enabled) add(row, 'disabled')
    if (missing) add(row, 'missing')
    if (!row.enabled || missing) continue
    const key = inventoryGroupKey(row)
    const definitions = definitionsByIdentity.get(key) ?? []
    definitions.push(row)
    definitionsByIdentity.set(key, definitions)
  }

  for (const definitions of definitionsByIdentity.values()) {
    if (definitions.length < 2) continue
    const completeHashes = definitions.every((row) => /^[a-f0-9]{64}$/i.test(row.contentHash ?? ''))
    const fingerprints = new Set(definitions.map((row) => completeHashes
      ? row.contentHash.toLowerCase()
      : `version:${String(row.skillVersion || '').trim()}`))
    const issue = fingerprints.size > 1 ? 'conflict' : 'duplicate'
    definitions.forEach((row) => add(row, issue))
  }
  return issues
}

function readChoice(params, name, choices, fallback) {
  const value = params.get(name)
  if (value === null || value === '') return fallback
  if (!choices.includes(value)) throw new EvaluationError(`${name} is invalid.`, 400)
  return value
}

function readText(params, name, fallback) {
  const value = params.get(name)
  if (value === null || value === '') return fallback
  if (value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new EvaluationError(`${name} is invalid.`, 400)
  return value
}

function readInteger(params, name, fallback, maximum) {
  const value = params.get(name)
  if (value === null || value === '') return fallback
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
    throw new EvaluationError(`${name} must be an integer from 1 to ${maximum}.`, 400)
  }
  return Number(value)
}

export function parseRegistryScanQuery(url) {
  const params = new URL(url || '/api/scan', 'http://127.0.0.1').searchParams
  const attention = readChoice(params, 'attention', ATTENTION, 'all')
  const refresh = params.get('refresh')
  if (refresh !== null && refresh !== '1') throw new EvaluationError('refresh is invalid.', 400)
  return {
    query: readText(params, 'query', ''),
    runtime: readChoice(params, 'runtime', ['all', ...RUNTIMES], 'all'),
    source: readChoice(params, 'source', ['all', ...SOURCES], 'all'),
    provider: readText(params, 'provider', 'all'),
    status: readChoice(params, 'status', STATUSES, attention === 'all' ? 'enabled' : 'all'),
    attention,
    page: readInteger(params, 'page', 1, 1_000_000),
    pageSize: readInteger(params, 'pageSize', 50, 100),
    refresh: refresh === '1',
  }
}

function countBy(rows, values, read) {
  return values.map((value) => ({ value, count: rows.filter((row) => read(row) === value).length }))
}

function stableCompare(left, right) {
  const runtime = RUNTIMES.indexOf(left.runtime) - RUNTIMES.indexOf(right.runtime)
  if (runtime) return runtime
  if (left.enabled !== right.enabled) return Number(right.enabled) - Number(left.enabled)
  for (const field of ['skillId', 'sourcePath', 'kind', 'provider', 'skillVersion', 'contentHash']) {
    const a = String(left[field] ?? '')
    const b = String(right[field] ?? '')
    if (a < b) return -1
    if (a > b) return 1
  }
  return 0
}

export function projectRegistryScan(snapshot, filters, generatedAt = new Date()) {
  const definitions = Array.isArray(snapshot) ? snapshot : snapshot?.definitions
  if (!Array.isArray(definitions)) throw new EvaluationError('Skill scan returned an invalid result.', 500)
  const rows = definitions.map(normalizeDefinition)
  const metadataTruncated = definitions.some((row) =>
    Array.isArray(row?.originConfigs) && row.originConfigs.length > MAX_METADATA_ITEMS
    || Array.isArray(row?.tags) && row.tags.length > MAX_METADATA_ITEMS)
  const scanMetadata = normalizeScanMetadata(Array.isArray(snapshot) ? null : snapshot.scan)
  const issues = buildIssues(rows)
  const issueSet = (row) => issues.get(definitionKey(row)) ?? new Set()
  const allEnabledDefinitions = rows.filter((row) => row.enabled)
  const allEnabledSkills = allEnabledDefinitions.filter((row) => row.kind === 'skill')
  const runtimeBySkill = new Map()
  for (const row of allEnabledSkills) {
    const id = normalizedSkillId(row.skillId)
    const runtimes = runtimeBySkill.get(id) ?? new Set()
    runtimes.add(row.runtime)
    runtimeBySkill.set(id, runtimes)
  }
  const sharedSkillIds = new Set([...runtimeBySkill].filter(([, runtimes]) => runtimes.size > 1).map(([id]) => id))
  const runtimeStats = RUNTIMES.map((runtime) => {
    const definitionsForRuntime = allEnabledDefinitions.filter((row) => row.runtime === runtime)
    return {
      runtime,
      count: definitionsForRuntime.length,
      unique: new Set(definitionsForRuntime.filter((row) => row.kind === 'skill').map((row) => normalizedSkillId(row.skillId))).size,
      sources: countBy(definitionsForRuntime, SOURCES, (row) => row.source),
    }
  })
  const scopeRows = rows.filter((row) => filters.runtime === 'all' || row.runtime === filters.runtime)
  const enabledSkills = scopeRows.filter((row) => row.kind === 'skill' && row.enabled)
  const enabledDefinitions = scopeRows.filter((row) => row.enabled)
  const categoryDefinitions = scopeRows.filter((row) =>
    filters.status === 'all' || (filters.status === 'enabled' ? row.enabled : !row.enabled))
  const providerRows = categoryDefinitions.filter((row) => filters.source === 'all' || row.source === filters.source)
  const providerTotals = new Map()
  providerRows.forEach((row) => providerTotals.set(row.provider, (providerTotals.get(row.provider) ?? 0) + 1))
  const providers = [...providerTotals]
    .map(([provider, count]) => ({ provider, count }))
    .sort((left, right) => right.count - left.count || stableCompare({ skillId: left.provider }, { skillId: right.provider }))
  const providerFacet = boundedFacet(providers, filters.provider === 'all' ? '' : filters.provider)
  const scopedIssues = scopeRows.filter((row) => issueSet(row).size)
  const countIssue = (issue) => scopedIssues.filter((row) => issueSet(row).has(issue)).length
  const needle = filters.query.trim().toLowerCase()
  const filtered = rows.filter((row) =>
    (filters.runtime === 'all' || row.runtime === filters.runtime) &&
    (filters.source === 'all' || row.source === filters.source) &&
    (filters.provider === 'all' || row.provider === filters.provider) &&
    (filters.status === 'all' || (filters.status === 'enabled' ? row.enabled : !row.enabled)) &&
    (filters.attention === 'all' || (filters.attention === 'attention' ? issueSet(row).size > 0 : issueSet(row).has(filters.attention))) &&
    (!needle || `${row.skillId} ${row.provider} ${row.sourcePath}`.toLowerCase().includes(needle)))
    .sort(stableCompare)
  const totalPages = Math.max(1, Math.ceil(filtered.length / filters.pageSize))
  const page = Math.min(filters.page, totalPages)
  const pageRows = filtered.slice((page - 1) * filters.pageSize, page * filters.pageSize)

  return {
    generatedAt: generatedAt.toISOString(),
    sourceStatus: providerFacet.truncated || scanMetadata.truncated || metadataTruncated ? 'partial' : 'complete',
    definitions: pageRows,
    scan: scanMetadata.scan,
    page: {
      page,
      pageSize: filters.pageSize,
      totalItems: filtered.length,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
    aggregates: {
      totalDefinitions: rows.length,
      sharedSkillCount: sharedSkillIds.size,
      enabledDefinitionCount: allEnabledDefinitions.length,
      runtimes: runtimeStats,
      metrics: {
        uniqueEnabledSkills: new Set(enabledSkills.map((row) => normalizedSkillId(row.skillId))).size,
        enabledDefinitions: enabledDefinitions.length,
        pluginEnabledSkills: enabledSkills.filter((row) => row.source === 'plugin').length,
        disabledSkills: scopeRows.filter((row) => row.kind === 'skill' && !row.enabled).length,
      },
      attention: {
        attention: scopedIssues.length,
        conflict: countIssue('conflict'),
        duplicate: countIssue('duplicate'),
        disabled: countIssue('disabled'),
        missing: countIssue('missing'),
      },
      sources: countBy(categoryDefinitions, SOURCES, (row) => row.source),
      providers: providerFacet.values,
      visibleRuntimes: RUNTIMES.map((runtime) => ({ runtime, count: filtered.filter((row) => row.runtime === runtime).length })),
    },
    definitionIssues: Object.fromEntries(pageRows
      .map((row) => [definitionKey(row), [...issueSet(row)]])
      .filter(([, rowIssues]) => rowIssues.length)),
    sharedDefinitionKeys: pageRows
      .filter((row) => sharedSkillIds.has(normalizedSkillId(row.skillId)))
      .map(definitionKey),
  }
}
