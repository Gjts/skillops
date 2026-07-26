import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { ARTIFACT_KINDS, ARTIFACT_RUNTIME_COMPATIBILITY, ARTIFACT_SOURCES, ARTIFACT_STATUSES } from '../../shared/evaluation-schema.mjs'
import { createArtifactRegistry } from './artifact-registry.mjs'
import { EvaluationError } from './errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from './request-guard.mjs'

const RUNTIMES = new Set(['codex', 'claude-code', 'cursor'])
const RUNTIME_ORDER = [...RUNTIMES]
const COMPATIBILITY = new Set(['supported', 'preview', 'unsupported'])
const COMPONENT_HASH_KEYS = ['system', 'prompt', 'model', 'configuration', 'variables']
const MAX_FACET_VALUES = 100
const MAX_RELATED_PER_ARTIFACT = 100
const MAX_RELATED_PER_RESPONSE = 500
const MAX_WARNINGS = 10
const registrySnapshots = new WeakMap()
const registryRefreshes = new WeakMap()

function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} must be an object.`, 422)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new EvaluationError(`${label} contains unsupported field: ${unknown[0]}.`, 422)
  return value
}

function required(value, label, maxLength = 4_000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new EvaluationError(`${label} is invalid.`, 422)
  return value.trim()
}

function method(request, expected) {
  if (request.method !== expected) throw new EvaluationError('Method not allowed.', 405)
}

function queryInteger(params, name, fallback, maximum) {
  const value = params.get(name)
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) throw new EvaluationError(`${name} must be a positive integer.`, 400)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new EvaluationError(`${name} must be between 1 and ${maximum}.`, 400)
  }
  return parsed
}

function queryText(params, name, maximum) {
  const value = (params.get(name) || '').trim()
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError(`${name} is invalid.`, 400)
  }
  return value
}

function queryChoice(params, name, allowed) {
  const value = queryText(params, name, 120)
  if (value && !allowed.has(value)) throw new EvaluationError(`${name} is not supported.`, 400)
  return value
}

function artifactQuery(params) {
  return {
    query: queryText(params, 'query', 200).toLocaleLowerCase('en-US'),
    kind: queryChoice(params, 'kind', new Set(ARTIFACT_KINDS)),
    source: queryChoice(params, 'source', new Set(ARTIFACT_SOURCES)),
    status: queryChoice(params, 'status', new Set(ARTIFACT_STATUSES)),
    runtime: queryChoice(params, 'runtime', RUNTIMES),
    owner: queryText(params, 'owner', 120),
    page: queryInteger(params, 'page', 1, 1_000_000),
    pageSize: queryInteger(params, 'pageSize', 50, 100),
  }
}

function facetCounts(artifacts, values) {
  const counts = new Map()
  for (const artifact of artifacts) {
    for (const value of new Set(values(artifact).filter(Boolean))) counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([value, count]) => ({ value, count }))
}

async function cachedSnapshot(registry) {
  let pending = registrySnapshots.get(registry)
  if (!pending) {
    pending = Promise.resolve().then(() => registry.list())
    registrySnapshots.set(registry, pending)
  }
  try {
    return await pending
  } catch (error) {
    if (registrySnapshots.get(registry) === pending) registrySnapshots.delete(registry)
    throw error
  }
}

async function refreshedSnapshot(registry) {
  const active = registryRefreshes.get(registry)
  if (active) return active
  const previous = registrySnapshots.get(registry)
  const pending = Promise.resolve().then(() => registry.refresh())
  const cached = previous ? pending.catch(() => previous) : pending
  registryRefreshes.set(registry, pending)
  registrySnapshots.set(registry, cached)
  try {
    return await pending
  } catch (error) {
    if (registrySnapshots.get(registry) === cached) {
      if (previous) registrySnapshots.set(registry, previous)
      else registrySnapshots.delete(registry)
    }
    throw error
  } finally {
    if (registryRefreshes.get(registry) === pending) registryRefreshes.delete(registry)
  }
}

function boundedFacet(items, selected = '') {
  const values = items.slice(0, MAX_FACET_VALUES)
  const selectedItem = selected && items.find((item) => item.value === selected)
  if (selectedItem && !values.includes(selectedItem)) {
    if (values.length === MAX_FACET_VALUES) values[values.length - 1] = selectedItem
    else values.push(selectedItem)
  }
  return { values, truncated: items.length > values.length }
}

function boundedRelated(items, artifactIds, maximum) {
  const groups = new Map([...artifactIds].map((artifactId) => [artifactId, []]))
  for (const item of items) {
    const group = groups.get(item.artifactId)
    if (group) group.push(item)
  }
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const leftId = String(left.id)
      const rightId = String(right.id)
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
    })
  }
  const values = []
  outer: for (let index = 0; index < MAX_RELATED_PER_ARTIFACT; index += 1) {
    for (const group of groups.values()) {
      if (values.length === maximum) break outer
      if (group[index]) values.push(group[index])
    }
  }
  const total = [...groups.values()].reduce((sum, group) => sum + group.length, 0)
  return { values, truncated: values.length < total }
}

function relatedBudgets(versionCount, installationCount) {
  const half = Math.floor(MAX_RELATED_PER_RESPONSE / 2)
  let versions = Math.min(versionCount, half)
  let installations = Math.min(installationCount, half)
  let remaining = MAX_RELATED_PER_RESPONSE - versions - installations
  const extraVersions = Math.min(remaining, versionCount - versions)
  versions += extraVersions
  remaining -= extraVersions
  installations += Math.min(remaining, installationCount - installations)
  return { versions, installations }
}

function publicCompatibility(value, kind) {
  const fallback = ARTIFACT_RUNTIME_COMPATIBILITY[kind] || ARTIFACT_RUNTIME_COMPATIBILITY.skill
  return Object.fromEntries(RUNTIME_ORDER.map((runtime) => [
    runtime,
    COMPATIBILITY.has(value?.[runtime]) ? value[runtime] : fallback[runtime],
  ]))
}

function publicArtifact(artifact, versionIds) {
  return {
    id: artifact.id,
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    name: artifact.name,
    owner: artifact.owner,
    repository: artifact.repository,
    status: artifact.status,
    description: artifact.description,
    createdAt: artifact.createdAt ?? null,
    updatedAt: artifact.updatedAt ?? null,
    versionIds,
  }
}

function publicVersion(version) {
  const componentHashes = Object.fromEntries(COMPONENT_HASH_KEYS
    .filter((key) => typeof version.componentHashes?.[key] === 'string')
    .map((key) => [key, version.componentHashes[key]]))
  return {
    id: version.id,
    artifactId: version.artifactId,
    sourceArtifactId: version.sourceArtifactId,
    kind: version.kind,
    version: version.version,
    contentHash: version.contentHash,
    gitCommit: version.gitCommit ?? null,
    repository: version.repository,
    schemaVersion: version.schemaVersion,
    runtimeTargets: [...new Set(version.runtimeTargets || [])].filter((runtime) => RUNTIMES.has(runtime)).slice(0, RUNTIME_ORDER.length),
    compatibility: publicCompatibility(version.compatibility, version.kind),
    dependencies: Array.isArray(version.dependencies) ? version.dependencies.filter((item) => typeof item === 'string').slice(0, 100) : [],
    source: version.source,
    sourceRef: version.sourceRef,
    description: version.description,
    componentHashes: Object.keys(componentHashes).length ? componentHashes : undefined,
    status: version.status,
    createdAt: version.createdAt ?? null,
  }
}

function publicInstallation(installation) {
  return {
    id: installation.id,
    artifactId: installation.artifactId,
    artifactVersionId: installation.artifactVersionId,
    runtime: installation.runtime,
    scope: installation.scope,
    targetPath: installation.targetPath,
    desiredState: installation.desiredState,
    observedState: installation.observedState,
    observedHash: installation.observedHash,
  }
}

function publicWarnings(items) {
  const allowed = new Map([
    ['git:GIT_ARTIFACT_SOURCE_UNAVAILABLE', { source: 'git', code: 'GIT_ARTIFACT_SOURCE_UNAVAILABLE' }],
    ['prompt-registry:PROMPT_SOURCE_UNAVAILABLE', { source: 'prompt-registry', code: 'PROMPT_SOURCE_UNAVAILABLE' }],
  ])
  const values = []
  for (const item of items) {
    const warning = allowed.get(`${item?.source}:${item?.code}`)
    if (warning && !values.includes(warning)) values.push(warning)
    if (values.length === MAX_WARNINGS) break
  }
  return { values, truncated: items.length > values.length }
}

function artifactPage(snapshot, filters) {
  const versionsByArtifact = new Map()
  for (const version of snapshot.versions || []) {
    const current = versionsByArtifact.get(version.artifactId)
    if (current) current.push(version)
    else versionsByArtifact.set(version.artifactId, [version])
  }
  const allArtifacts = [...(snapshot.artifacts || [])].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const matches = allArtifacts.filter((artifact) => {
    const versions = versionsByArtifact.get(artifact.id) || []
    return (!filters.kind || artifact.kind === filters.kind)
      && (!filters.source || versions.some((version) => version.source === filters.source))
      && (!filters.status || artifact.status === filters.status)
      && (!filters.runtime || versions.some((version) => version.runtimeTargets?.includes(filters.runtime)))
      && (!filters.owner || artifact.owner === filters.owner)
      && (!filters.query || `${artifact.id} ${artifact.name} ${artifact.description || ''} ${artifact.repository || ''}`
        .toLocaleLowerCase('en-US').includes(filters.query))
  })
  const offset = (filters.page - 1) * filters.pageSize
  const pageArtifacts = matches.slice(offset, offset + filters.pageSize)
  const artifactIds = new Set(pageArtifacts.map((artifact) => artifact.id))
  const valuesForVersions = (artifact, read) => (versionsByArtifact.get(artifact.id) || []).flatMap(read)
  const totalPages = Math.ceil(matches.length / filters.pageSize)
  const versionCount = (snapshot.versions || []).filter((item) => artifactIds.has(item.artifactId)).length
  const installationCount = (snapshot.installations || []).filter((item) => artifactIds.has(item.artifactId)).length
  const budgets = relatedBudgets(versionCount, installationCount)
  const versions = boundedRelated(snapshot.versions || [], artifactIds, budgets.versions)
  const installations = boundedRelated(snapshot.installations || [], artifactIds, budgets.installations)
  const returnedVersionIds = new Map()
  for (const version of versions.values) {
    const ids = returnedVersionIds.get(version.artifactId) || []
    ids.push(version.id)
    returnedVersionIds.set(version.artifactId, ids)
  }
  const artifactVersionsTruncated = pageArtifacts.some((artifact) =>
    (artifact.versionIds || []).some((id) => !(returnedVersionIds.get(artifact.id) || []).includes(id)))
  const artifacts = pageArtifacts.map((artifact) => publicArtifact(artifact, returnedVersionIds.get(artifact.id) || []))
  const owners = boundedFacet(facetCounts(allArtifacts, (artifact) => [artifact.owner]), filters.owner)
  const warnings = publicWarnings(snapshot.warnings || [])
  return {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    sourceStatus: artifactVersionsTruncated || versions.truncated || installations.truncated || owners.truncated || warnings.truncated ? 'partial' : 'complete',
    artifacts,
    versions: versions.values.map(publicVersion),
    installations: installations.values.map(publicInstallation),
    compatibility: Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, publicCompatibility(snapshot.compatibility?.[kind], kind)])),
    warnings: warnings.values,
    page: filters.page,
    pageSize: filters.pageSize,
    totalItems: matches.length,
    totalPages,
    hasPrevious: matches.length > 0 && filters.page > 1,
    hasNext: filters.page < totalPages,
    stats: {
      totalArtifacts: allArtifacts.length,
      driftedInstallations: (snapshot.installations || [])
        .filter((installation) => installation.observedState === 'drifted' || installation.observedState === 'missing').length,
    },
    facets: {
      kinds: facetCounts(allArtifacts, (artifact) => [artifact.kind]),
      sources: facetCounts(allArtifacts, (artifact) => valuesForVersions(artifact, (version) => [version.source])),
      statuses: facetCounts(allArtifacts, (artifact) => [artifact.status]),
      runtimes: facetCounts(allArtifacts, (artifact) => valuesForVersions(artifact, (version) => version.runtimeTargets || [])),
      owners: owners.values,
    },
  }
}

let defaultRegistry
export function initializeArtifactRegistry(options = {}) {
  if (!defaultRegistry) defaultRegistry = createArtifactRegistry(options)
  return defaultRegistry
}

export async function handleArtifactRegistryApi(request, response, pathname, options = {}) {
  const collection = pathname === '/api/artifacts'
  const refresh = pathname === '/api/artifacts/refresh'
  const diff = pathname === '/api/artifacts/diff'
  const importPreview = pathname === '/api/artifacts/import-preview'
  const migrationPreview = pathname === '/api/artifacts/migration/preview'
  const migrationApply = pathname === '/api/artifacts/migration/apply'
  const rollback = pathname.match(/^\/api\/artifacts\/migration\/([^/]+)\/rollback$/)
  if (!collection && !refresh && !diff && !importPreview && !migrationPreview && !migrationApply && !rollback) return false
  setJsonApiHeaders(response)
  try {
    const post = request.method === 'POST'
    assertLocalApiRequest(request, { requireJson: post })
    const registry = options.artifactRegistry || initializeArtifactRegistry(options)
    if (collection) {
      method(request, 'GET')
      const filters = artifactQuery(new URL(request.url || pathname, 'http://127.0.0.1').searchParams)
      sendJson(response, 200, artifactPage(await cachedSnapshot(registry), filters))
    } else if (refresh) {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Artifact refresh request')
      const filters = artifactQuery(new URL(request.url || pathname, 'http://127.0.0.1').searchParams)
      const snapshot = await refreshedSnapshot(registry)
      sendJson(response, 200, artifactPage(snapshot, filters))
    } else if (diff) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['leftId', 'rightId']), 'Artifact Diff request')
      sendJson(response, 200, await registry.diff({ leftId: required(body.leftId, 'Left version ID', 1_000), rightId: required(body.rightId, 'Right version ID', 1_000) }))
    } else if (importPreview) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['sourceUrl', 'sourcePath']), 'Artifact import preview')
      sendJson(response, 200, await registry.previewImport({ sourceUrl: required(body.sourceUrl, 'Candidate URL', 2_000), sourcePath: body.sourcePath === undefined ? undefined : required(body.sourcePath, 'Candidate path', 4_000) }))
    } else if (migrationPreview) {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Artifact migration preview')
      sendJson(response, 200, await registry.previewMigration())
    } else if (migrationApply) {
      method(request, 'POST')
      const body = onlyKeys(await readEvaluationJsonBody(request), new Set(['previewToken']), 'Artifact migration apply')
      const result = await registry.applyMigration(required(body.previewToken, 'Migration preview token', 200))
      registrySnapshots.delete(registry)
      sendJson(response, 200, result)
    } else {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Artifact migration rollback')
      let migrationId
      try { migrationId = decodeURIComponent(rollback[1]) } catch { throw new EvaluationError('Migration ID is invalid.', 422) }
      const result = await registry.rollbackMigration(required(migrationId, 'Migration ID', 200))
      registrySnapshots.delete(registry)
      sendJson(response, 200, result)
    }
  } catch (error) {
    sendApiError(response, error, 'Artifact Registry request failed.')
  }
  return true
}
