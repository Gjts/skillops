import { sendApiError, sendJson, setJsonApiHeaders } from '../api-response.mjs'
import { createArtifactRegistry } from './artifact-registry.mjs'
import { EvaluationError } from './errors.mjs'
import { assertLocalApiRequest, readEvaluationJsonBody } from './request-guard.mjs'

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
      sendJson(response, 200, await registry.list())
    } else if (refresh) {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Artifact refresh request')
      sendJson(response, 200, await registry.refresh())
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
      sendJson(response, 200, await registry.applyMigration(required(body.previewToken, 'Migration preview token', 200)))
    } else {
      method(request, 'POST')
      onlyKeys(await readEvaluationJsonBody(request), new Set(), 'Artifact migration rollback')
      let migrationId
      try { migrationId = decodeURIComponent(rollback[1]) } catch { throw new EvaluationError('Migration ID is invalid.', 422) }
      sendJson(response, 200, await registry.rollbackMigration(required(migrationId, 'Migration ID', 200)))
    }
  } catch (error) {
    sendApiError(response, error, 'Artifact Registry request failed.')
  }
  return true
}
