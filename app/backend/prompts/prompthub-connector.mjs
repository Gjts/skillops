import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeArtifactDefinition } from '../../shared/evaluation-schema.mjs'
import { artifactContentHash } from '../evaluations/artifact-definition.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { boundedResponseText } from '../evaluations/response-limit.mjs'
import { normalizePromptVariableName, promptVariableNames } from '../evaluations/prompt-variables.mjs'
import { canonicalJson } from '../evaluations/suite-registry.mjs'
import { createSecureCredentialStore } from '../secure-credential-store.mjs'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PROJECTS = 500
const CONFIGURATION_FIELDS = new Set([
  'max_tokens', 'max_tokens_to_sample', 'temperature', 'top_p', 'top_k',
  'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'stop_sequences',
])

export const PROMPTHUB_V1 = Object.freeze({
  id: 'prompthub',
  apiVersion: 'v1',
  authorization: 'bearer',
  baseUrl: 'https://app.prompthub.us',
  capabilities: Object.freeze({ pull: true, push: false, historicalVersions: false }),
})

function requiredText(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError(`${label} is invalid.`, 422)
  }
  return value.trim()
}

function projectId(value) {
  const normalized = String(value ?? '')
  if (!/^[1-9]\d{0,19}$/.test(normalized)) throw new EvaluationError('PromptHub project ID is invalid.', 422)
  return normalized
}

function revision(value) {
  const normalized = requiredText(String(value ?? ''), 'PromptHub revision', 100)
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new EvaluationError('PromptHub revision is invalid.', 422)
  return normalized
}

function branch(value) {
  if (value === undefined || value === null || value === '') return null
  const normalized = requiredText(value, 'PromptHub branch', 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) || normalized.includes('..') || normalized.includes('//')) {
    throw new EvaluationError('PromptHub branch is invalid.', 422)
  }
  return normalized
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError(`${label} is invalid.`, 502)
  return value
}

function optionalText(value, label, maxLength = 100_000) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\u0000')) throw new EvaluationError(`${label} is invalid.`, 502)
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function safeValue(value, label, depth = 0) {
  if (depth > 5) throw new EvaluationError(`${label} is too deeply nested.`, 502)
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.length <= 100) return value.map((item) => safeValue(item, label, depth + 1))
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 100) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, safeValue(item, label, depth + 1)]))
  }
  throw new EvaluationError(`${label} is invalid.`, 502)
}

function promptContent(data) {
  const formatted = object(data.formatted_request, 'PromptHub formatted request')
  const messages = formatted.messages === undefined ? [] : formatted.messages
  if (!Array.isArray(messages) || messages.length > 100) throw new EvaluationError('PromptHub messages are invalid.', 502)
  const normalizedMessages = messages.map((entry, index) => {
    const message = object(entry, `PromptHub message ${index + 1}`)
    if (!['system', 'user', 'assistant'].includes(message.role)) throw new EvaluationError(`PromptHub message ${index + 1} role is invalid.`, 502)
    return { role: message.role, content: optionalText(message.content, `PromptHub message ${index + 1} content`) }
  })
  const configuration = {}
  for (const source of [data.configuration, formatted]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (CONFIGURATION_FIELDS.has(key) && value !== undefined) configuration[key] = safeValue(value, `PromptHub configuration ${key}`)
    }
  }
  return {
    system: optionalText(formatted.system, 'PromptHub system message'),
    messages: normalizedMessages,
    model: {
      provider: optionalText(data.provider, 'PromptHub provider', 100).trim(),
      name: optionalText(data.model ?? formatted.model, 'PromptHub model', 200).trim(),
      configuration: Object.fromEntries(Object.entries(configuration).sort(([left], [right]) => left.localeCompare(right))),
    },
    variables: data.variables === undefined ? {} : safeValue(object(data.variables, 'PromptHub variables'), 'PromptHub variables'),
  }
}

function componentHashes(prompt, variableNames) {
  return {
    system: artifactContentHash(canonicalJson(prompt.system)),
    prompt: artifactContentHash(canonicalJson(prompt.messages)),
    model: artifactContentHash(canonicalJson({ provider: prompt.model.provider, name: prompt.model.name })),
    configuration: artifactContentHash(canonicalJson(prompt.model.configuration)),
    variables: artifactContentHash(canonicalJson(Object.keys(prompt.variables).length ? { names: variableNames, defaults: prompt.variables } : variableNames)),
  }
}

function remoteVersion(payload, requestedBranch = null) {
  const data = object(payload?.data, 'PromptHub revision response')
  const project = object(data.project, 'PromptHub project')
  const id = projectId(data.project_id ?? project.id)
  const remoteRevision = revision(data.hash ?? data.id)
  const prompt = promptContent(data)
  const contentHash = artifactContentHash(canonicalJson(prompt))
  const variableNames = [...new Set([
    ...Object.keys(prompt.variables).map(normalizePromptVariableName),
    ...promptVariableNames(prompt.system, ...prompt.messages.map((message) => message.content)),
  ])].sort()
  const artifact = normalizeArtifactDefinition({
    kind: 'prompt',
    artifactId: `prompthub-${id}`,
    version: remoteRevision,
    description: optionalText(project.description, 'PromptHub project description', 2_000) || undefined,
    source: 'prompthub',
    sourceRef: requestedBranch
      ? `prompthub:v1:${id}:branch:${encodeURIComponent(requestedBranch)}:${remoteRevision}:${contentHash}`
      : `prompthub:v1:${id}:${remoteRevision}:${contentHash}`,
    contentHash,
    providerHint: prompt.model.provider || undefined,
    modelHint: prompt.model.name || undefined,
    variables: variableNames,
    componentHashes: componentHashes(prompt, variableNames),
    createdAt: data.created_at,
  })
  return {
    ref: { projectId: id, revision: remoteRevision, ...(requestedBranch ? { branch: requestedBranch } : {}) },
    remoteId: id,
    remoteVersionId: String(data.id ?? remoteRevision),
    remoteHash: remoteRevision,
    name: optionalText(project.name, 'PromptHub project name', 200) || `PromptHub ${id}`,
    description: artifact.description,
    type: optionalText(project.type, 'PromptHub project type', 40) || 'prompt',
    createdAt: artifact.createdAt || null,
    artifact,
    prompt,
  }
}

function versionMetadata(version) {
  const { prompt: _prompt, ...metadata } = version
  return metadata
}

const CANDIDATE_STAGES = new Set(['candidate', 'evaluating', 'blocked', 'ready', 'approved', 'canary'])

function chooseLocal(records, link) {
  if (!records.length) return { artifact: null, ambiguousHashes: null }
  const linked = link?.localContentHash
    ? records.filter((item) => item.artifact.contentHash === link.localContentHash)
    : []
  if (linked.length) return { artifact: linked.at(-1).artifact, ambiguousHashes: null }
  const hashes = [...new Set(records.map((item) => item.artifact.contentHash))].sort()
  return hashes.length === 1
    ? { artifact: records.at(-1).artifact, ambiguousHashes: null }
    : { artifact: null, ambiguousHashes: hashes }
}

function selectLocal(items, artifactId, link) {
  const records = items
    .map((item) => ({ artifact: item?.artifact || item, stage: item?.stage || item?.status || null }))
    .filter((item) => item.artifact?.artifactId === artifactId)
  const candidates = records.filter((item) => CANDIDATE_STAGES.has(item.stage))
  if (candidates.length) return chooseLocal(candidates, link)
  const stable = records.filter((item) => item.stage === 'stable')
  if (stable.length) return chooseLocal(stable, link)
  return chooseLocal(records.filter((item) => !item.stage), link)
}


function remoteProject(value) {
  const item = object(value, 'PromptHub project')
  const project = item.project && typeof item.project === 'object' ? item.project : item
  const head = item.head && typeof item.head === 'object' ? item.head : item.revision && typeof item.revision === 'object' ? item.revision : null
  const id = projectId(project.id ?? item.project_id)
  return {
    remoteId: id,
    name: optionalText(project.name, 'PromptHub project name', 200) || `PromptHub ${id}`,
    description: optionalText(project.description, 'PromptHub project description', 2_000) || undefined,
    type: optionalText(project.type, 'PromptHub project type', 40) || 'prompt',
    head: head ? { revision: String(head.hash ?? head.id ?? ''), createdAt: head.created_at || null } : null,
    source: `prompthub:v1:${id}`,
  }
}

function parseRef(value) {
  if (typeof value === 'string') {
    const direct = /^prompthub:v1:([1-9]\d{0,19}):([A-Za-z0-9._-]{1,100}):([a-f0-9]{64})$/i.exec(value)
    if (direct) return { projectId: direct[1], revision: direct[2], contentHash: direct[3].toLowerCase(), branch: null }
    const branched = /^prompthub:v1:([1-9]\d{0,19}):branch:([^:]{1,600}):([A-Za-z0-9._-]{1,100}):([a-f0-9]{64})$/i.exec(value)
    if (!branched) throw new EvaluationError('PromptHub version reference is invalid.', 422)
    let requestedBranch
    try { requestedBranch = decodeURIComponent(branched[2]) } catch {
      throw new EvaluationError('PromptHub version reference is invalid.', 422)
    }
    return {
      projectId: branched[1],
      revision: branched[3],
      contentHash: branched[4].toLowerCase(),
      branch: branch(requestedBranch),
    }
  }
  const input = object(value, 'PromptHub version reference')
  return {
    projectId: projectId(input.projectId),
    revision: input.revision === undefined ? null : revision(input.revision),
    contentHash: input.contentHash === undefined ? null : requiredText(input.contentHash, 'PromptHub content hash', 64).toLowerCase(),
    branch: branch(input.branch),
  }
}


function stateFile(value) {
  if (!value || value.schemaVersion !== 1 || value.connector !== 'prompthub' || !value.links || typeof value.links !== 'object' || Array.isArray(value.links)) {
    throw new EvaluationError('PromptHub sync state is invalid.', 500)
  }
  return value
}

async function replaceFileAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export function createPromptHubConnector(options = {}) {
  const environment = options.environment || process.env
  const strategy = options.strategy || environment.SKILLOPS_PROMPTHUB_SYNC_STRATEGY || 'pull-only'
  if (strategy !== 'pull-only') throw new EvaluationError('PromptHub public API v1 supports only pull-only synchronization.', 422)
  const baseUrl = new URL(options.baseUrl || PROMPTHUB_V1.baseUrl)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)
  if ((baseUrl.protocol !== 'https:' && !(loopback && baseUrl.protocol === 'http:')) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new EvaluationError('PromptHub base URL is invalid.', 500)
  }
  const configuredTeamId = options.teamId || environment.SKILLOPS_PROMPTHUB_TEAM_ID
  const teamId = configuredTeamId ? projectId(configuredTeamId) : null
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20_000
  const localArtifacts = options.listLocalArtifacts || (async () => [])
  const dataDir = path.resolve(options.dataDir || environment.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const credentialStore = options.credentialStore || createSecureCredentialStore({ dataDir })
  const syncFile = path.join(dataDir, 'prompthub-sync.json')
  const auditFile = path.join(dataDir, 'prompthub-sync-audit.jsonl')
  const previews = new Map()
  let writes = Promise.resolve()

  async function credential() {
    const value = options.getCredential
      ? await options.getCredential('prompthub')
      : environment.SKILLOPS_PROMPTHUB_API_KEY || await credentialStore.get('prompthub')
    if (typeof value !== 'string' || !value.trim()) throw new EvaluationError('PromptHub credential is unavailable.', 503)
    return value.trim()
  }

  async function request(pathname) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(new URL(pathname, baseUrl), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${await credential()}` },
        signal: controller.signal,
      })
      if (!response.ok) throw new EvaluationError(`PromptHub request failed (HTTP ${response.status}).`, response.status === 401 || response.status === 403 ? 401 : response.status === 404 ? 404 : 502)
      const text = await boundedResponseText(response, MAX_RESPONSE_BYTES, 'PromptHub response exceeds the 2 MiB limit.')
      try { return JSON.parse(text) } catch { throw new EvaluationError('PromptHub returned invalid JSON.', 502) }
    } catch (error) {
      if (error instanceof EvaluationError) throw error
      if (controller.signal.aborted) throw new EvaluationError('PromptHub request timed out.', 504)
      throw new EvaluationError('PromptHub is unavailable.', 502)
    } finally { clearTimeout(timer) }
  }

  async function readState() {
    try { return stateFile(JSON.parse(await readFile(syncFile, 'utf8'))) } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, connector: 'prompthub', links: {} }
      throw error
    }
  }

  function serialize(operation) {
    const pending = writes.then(operation)
    writes = pending.catch(() => undefined)
    return pending
  }

  async function record(action, details) {
    return serialize(async () => {
      await mkdir(dataDir, { recursive: true })
      const entry = {
        schemaVersion: 1,
        id: randomUUID(),
        connector: 'prompthub',
        action,
        remoteId: details.remoteId || null,
        remoteVersion: details.remoteVersion || null,
        remoteHash: details.remoteHash || null,
        localContentHash: details.localContentHash || null,
        result: details.result || 'ok',
        at: new Date().toISOString(),
      }
      await appendFile(auditFile, `${JSON.stringify(entry)}\n`, 'utf8')
      return entry
    })
  }

  async function listArtifacts() {
    if (!teamId) throw new EvaluationError('PromptHub team ID is not configured.', 503)
    const payload = await request(`/api/v1/teams/${encodeURIComponent(teamId)}/projects`)
    const data = payload?.data
    const items = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : Array.isArray(data?.items) ? data.items : null
    if (!items || items.length > MAX_PROJECTS) throw new EvaluationError('PromptHub project list is invalid.', 502)
    return items.map(remoteProject).sort((left, right) => left.name.localeCompare(right.name) || left.remoteId.localeCompare(right.remoteId))
  }

  async function getVersion(value) {
    const ref = parseRef(value)
    const search = ref.branch ? `?branch=${encodeURIComponent(ref.branch)}` : ''
    const version = remoteVersion(await request(`/api/v1/projects/${encodeURIComponent(ref.projectId)}/head${search}`), ref.branch)
    if (version.remoteId !== ref.projectId) throw new EvaluationError('PromptHub returned a different project.', 502)
    if (ref.revision && version.remoteHash !== ref.revision) throw new EvaluationError('PromptHub public API v1 exposes only the current branch head; the requested revision is unavailable.', 409)
    if (ref.contentHash && version.artifact.contentHash !== ref.contentHash) throw new EvaluationError('PromptHub content no longer matches the immutable reference.', 409)
    return version
  }

  async function previewImport(value) {
    const version = await getVersion(value)
    const [locals, state] = await Promise.all([localArtifacts(), readState()])
    const selected = selectLocal(locals, version.artifact.artifactId, state.links[version.remoteId])
    if (selected.ambiguousHashes) throw new EvaluationError('PromptHub import has multiple active local versions.', 409)
    const currentArtifact = selected.artifact
    const previewToken = randomUUID()
    const expiresAt = Date.now() + 10 * 60_000
    previews.clear()
    previews.set(previewToken, { version, currentHash: currentArtifact?.contentHash || null, expiresAt })
    await record('import.previewed', { remoteId: version.remoteId, remoteVersion: version.remoteVersionId, remoteHash: version.remoteHash })
    return {
      mode: 'preview',
      persisted: false,
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      targetStatus: 'candidate',
      replacesStable: false,
      version: versionMetadata(version),
      currentArtifact: currentArtifact || null,
      diff: {
        changed: currentArtifact?.contentHash !== version.artifact.contentHash,
        changedComponents: Object.keys(version.artifact.componentHashes || {}).filter((key) => currentArtifact?.componentHashes?.[key] !== version.artifact.componentHashes[key]),
      },
    }
  }

  async function applyImport(previewToken, importer, compensate) {
    const plan = previews.get(previewToken)
    previews.delete(previewToken)
    if (!plan || plan.expiresAt < Date.now()) throw new EvaluationError('PromptHub import preview is missing or expired.', 409)
    if (typeof importer !== 'function') throw new EvaluationError('PromptHub Candidate importer is unavailable.', 500)
    const current = await getVersion(plan.version.artifact.sourceRef)
    const [locals, stateBefore] = await Promise.all([localArtifacts(), readState()])
    const selected = selectLocal(locals, current.artifact.artifactId, stateBefore.links[current.remoteId])
    if (selected.ambiguousHashes || (selected.artifact?.contentHash ?? null) !== plan.currentHash) {
      throw new EvaluationError('Local Artifact changed after PromptHub import preview.', 409)
    }
    const imported = await importer(current)
    const importedArtifact = imported?.artifact || imported?.capability?.artifact
    if (!importedArtifact || typeof importedArtifact.contentHash !== 'string') {
      throw new EvaluationError('PromptHub Candidate importer did not return an Artifact.', 500)
    }
    let previousState
    try {
      await serialize(async () => {
        await mkdir(dataDir, { recursive: true })
        const state = await readState()
        previousState = structuredClone(state)
        state.links[current.remoteId] = {
          branch: current.ref.branch || null,
          remoteId: current.remoteId,
          remoteVersion: current.remoteVersionId,
          remoteHash: current.remoteHash,
          remoteContentHash: current.artifact.contentHash,
          localContentHash: importedArtifact.contentHash,
          syncedAt: new Date().toISOString(),
          direction: 'pull',
        }
        await replaceFileAtomic(syncFile, `${JSON.stringify(state, null, 2)}\n`)
      })
      await record('import.applied', {
        remoteId: current.remoteId,
        remoteVersion: current.remoteVersionId,
        remoteHash: current.remoteHash,
        localContentHash: importedArtifact.contentHash,
      })
      return imported
    } catch (error) {
      const failures = []
      if (previousState) {
        try {
          await serialize(() => replaceFileAtomic(syncFile, `${JSON.stringify(previousState, null, 2)}\n`))
        } catch (caught) { failures.push(caught) }
      }
      if (typeof compensate === 'function') {
        try { await compensate(imported) } catch (caught) { failures.push(caught) }
      }
      if (failures.length) throw new EvaluationError('PromptHub import failed and automatic recovery was incomplete.', 500)
      throw error
    }
  }

  async function compareState() {
    const [state, locals] = await Promise.all([readState(), localArtifacts()])
    let projects
    try { projects = await listArtifacts() } catch {
      return Object.values(state.links).map((link) => ({
        remoteId: link.remoteId,
        type: 'remote-unavailable',
        blocking: false,
        localStablePreserved: true,
        localContentHash: link.localContentHash,
        lastSyncedAt: link.syncedAt,
      }))
    }
    const versions = []
    for (const project of projects) versions.push(await getVersion({ projectId: project.remoteId, branch: state.links[project.remoteId]?.branch }))
    const remote = new Map(versions.map((item) => [item.remoteId, item]))
    const local = new Map()
    for (const item of locals) {
      const artifact = item?.artifact || item
      const id = item?.remoteId
        || /^prompthub:v1:([1-9]\d{0,19}):/.exec(artifact?.sourceRef || '')?.[1]
        || /^prompthub-([1-9]\d{0,19})$/.exec(artifact?.artifactId || '')?.[1]
      if (!id) continue
      if (local.has(id)) local.get(id).push(item)
      else local.set(id, [item])
    }
    const ids = new Set([...Object.keys(state.links), ...remote.keys(), ...local.keys()])
    return [...ids].sort().map((id) => {
      const link = state.links[id]
      const remoteVersion = remote.get(id)
      const localRecords = local.get(id) || []
      const selected = selectLocal(localRecords, `prompthub-${id}`, link)
      const localArtifact = selected.artifact
      if (!remoteVersion) return { remoteId: id, type: 'remote-deleted', blocking: false, action: 'keep-local', localStablePreserved: true }
      if (selected.ambiguousHashes) return {
        remoteId: id,
        type: 'local-ambiguous',
        blocking: true,
        remoteHash: remoteVersion.remoteHash,
        localContentHashes: selected.ambiguousHashes,
      }
      if (!localArtifact) return { remoteId: id, type: link ? 'local-missing' : 'remote-only', blocking: false, remoteHash: remoteVersion.remoteHash }
      if (!link) return { remoteId: id, type: 'untracked', blocking: true, remoteHash: remoteVersion.remoteHash, localContentHash: localArtifact.contentHash }
      const remoteChanged = link.remoteContentHash !== remoteVersion.artifact.contentHash
      const localChanged = link.localContentHash !== localArtifact.contentHash
      if (remoteChanged && localChanged) return { remoteId: id, type: 'conflict', blocking: true, autoResolve: false, remoteHash: remoteVersion.remoteHash, localContentHash: localArtifact.contentHash }
      if (remoteChanged) return { remoteId: id, type: 'remote-changed', blocking: false, remoteHash: remoteVersion.remoteHash, localContentHash: localArtifact.contentHash }
      if (localChanged) return { remoteId: id, type: 'local-changed', blocking: true, remoteHash: remoteVersion.remoteHash, localContentHash: localArtifact.contentHash }
      return { remoteId: id, type: 'synchronized', blocking: false, remoteHash: remoteVersion.remoteHash, localContentHash: localArtifact.contentHash, lastSyncedAt: link.syncedAt }
    })
  }

  async function publishVersion() {
    throw new EvaluationError('PromptHub pull-only strategy does not allow publishing.', 409)
  }

  return {
    metadata: { ...PROMPTHUB_V1, strategy, teamId },
    syncFile,
    auditFile,
    listArtifacts,
    getVersion,
    previewImport,
    applyImport,
    publishVersion,
    compareState,
  }
}

let defaultConnector
export function initializePromptHubConnector(options = {}) {
  if (!defaultConnector) defaultConnector = createPromptHubConnector(options)
  return defaultConnector
}
