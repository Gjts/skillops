import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeEvent } from '../shared/event-schema.mjs'
import { pruneEventsBefore } from './event-store.mjs'
import { createEvaluationStore } from './evaluations/evaluation-store.mjs'
import { canonicalJson } from './evaluations/suite-registry.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { gatePolicyHash, normalizeGatePolicy } from './governance/capability-policy.mjs'
import { withGovernanceFileLock } from './governance/skeleton-lock.mjs'
import { inspectProjectTemplateAdoption } from './project-template.mjs'

const ROLES = ['Owner', 'Maintainer', 'Reviewer', 'Developer', 'Viewer']
const ROLE_LEVEL = Object.freeze(Object.fromEntries(ROLES.map((role, index) => [role, ROLES.length - index])))
const ENTITY_RULES = Object.freeze({ workspace: 'Maintainer', project: 'Maintainer', environment: 'Maintainer', member: 'Owner', policyPack: 'Maintainer' })
const COLLECTOR_EVENT_FIELDS = new Set([
  'event', 'skillId', 'skillVersion', 'runtime', 'timestamp', 'durationMs', 'costUsd', 'tokens',
  'outcome', 'detectionMethod', 'confidence', 'provider', 'kind', 'enabled',
])
const EVIDENCE_FIELDS = new Set(['capabilityId', 'artifactId', 'version', 'contentHash', 'evidenceHash', 'gateResult', 'score', 'passRatePct'])

function text(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new EvaluationError(`${label} is invalid.`, 422)
  }
  return value.trim()
}

function id(value, label) {
  const normalized = text(value, label, 64).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) throw new EvaluationError(`${label} is invalid.`, 422)
  return normalized
}

function optionalText(value, label, maxLength = 500) {
  if (value === undefined || value === null || value === '') return null
  return text(value, label, maxLength)
}

function absoluteProjectRoot(value) {
  const root = text(value, 'Project root', 1_000)
  if (!path.isAbsolute(root)) throw new EvaluationError('Project root must be an absolute path.', 422)
  return path.resolve(root)
}

function role(value) {
  if (!ROLES.includes(value)) throw new EvaluationError('Team role is invalid.', 422)
  return value
}

function projectTemplate(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Project Template status is invalid.', 422)
  const status = ['current', 'drifted', 'upgrade-available'].includes(value.status) ? value.status : null
  if (!status) throw new EvaluationError('Project Template status is invalid.', 422)
  const candidateVersion = optionalText(value.candidateVersion, 'Project Template candidate version', 100)
  if (status === 'upgrade-available' && !candidateVersion) throw new EvaluationError('Pending Project Template version is required.', 422)
  return {
    id: id(value.id, 'Project Template ID'),
    version: text(value.version, 'Project Template version', 100),
    status,
    candidateVersion,
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashToken(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

function defaultState() {
  return {
    schemaVersion: 1,
    revision: 0,
    team: null,
    workspaces: [],
    projects: [],
    environments: [],
    members: [],
    devices: [],
    policyPacks: [],
    exceptions: [],
    retentionDays: 90,
    updatedAt: null,
  }
}

function normalizeState(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new EvaluationError('Team control-plane state is invalid.', 500)
  }
  for (const field of ['workspaces', 'projects', 'environments', 'members', 'devices', 'policyPacks', 'exceptions']) {
    if (!Array.isArray(value[field]) || value[field].length > 10_000) throw new EvaluationError('Team control-plane state is invalid.', 500)
  }
  return value
}

function templateAdoption(projects) {
  const adopted = projects.filter((project) => project.template)
  return {
    totalProjects: projects.length,
    adoptedProjects: adopted.length,
    currentProjects: adopted.filter((project) => project.template.status === 'current').length,
    driftedProjects: adopted.filter((project) => project.template.status === 'drifted').length,
    pendingUpgradeProjects: adopted.filter((project) => project.template.status === 'upgrade-available').length,
    adoptionRatePct: projects.length ? Math.round(adopted.length / projects.length * 100) : 0,
  }
}

function publicState(state) {
  const value = structuredClone(state)
  return {
    ...value,
    devices: value.devices.map(({ tokenHash: _tokenHash, ...device }) => device),
    templateAdoption: templateAdoption(value.projects),
    capabilities: { deployment: 'local-git', networkApi: false, sso: false, scim: false },
  }
}

function memberFor(state, principal) {
  return state.members.find((member) => member.id === principal.id && member.status === 'active') || null
}

function requireRole(state, principal, minimum) {
  const member = memberFor(state, principal)
  if (!member || ROLE_LEVEL[member.role] < ROLE_LEVEL[minimum]) throw new EvaluationError(`Team role ${minimum} is required.`, 403)
  return member
}

function upsert(items, item) {
  const index = items.findIndex((current) => current.id === item.id)
  if (index < 0) items.push(item)
  else items[index] = { ...items[index], ...item, createdAt: items[index].createdAt || item.createdAt }
}

function sanitizeEvent(value) {
  let normalized
  try { normalized = normalizeEvent(value) } catch (error) { throw new EvaluationError(error.message, 422) }
  return Object.fromEntries(Object.entries(normalized).filter(([key]) => COLLECTOR_EVENT_FIELDS.has(key)))
}

function sanitizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Collector evidence summary is invalid.', 422)
  const unknown = Object.keys(value).filter((key) => !EVIDENCE_FIELDS.has(key))
  if (unknown.length) throw new EvaluationError(`Collector evidence summary contains unsupported field: ${unknown[0]}.`, 422)
  const result = {
    capabilityId: id(value.capabilityId, 'Collector capability ID'),
    artifactId: text(value.artifactId, 'Collector Artifact ID'),
    version: text(value.version, 'Collector Artifact version'),
    contentHash: text(value.contentHash, 'Collector content hash', 64),
    evidenceHash: text(value.evidenceHash, 'Collector evidence hash', 64),
    gateResult: text(value.gateResult, 'Collector gate result', 40),
  }
  for (const field of ['contentHash', 'evidenceHash']) if (!/^[a-f0-9]{64}$/i.test(result[field])) throw new EvaluationError(`Collector ${field} is invalid.`, 422)
  for (const field of ['score', 'passRatePct']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) throw new EvaluationError(`Collector ${field} is invalid.`, 422)
      result[field] = value[field]
    }
  }
  return result
}

async function readOptional(file, fallback) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function replaceFile(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export function createTeamControlPlane(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const stateFile = path.join(dataDir, 'team-control-plane.json')
  const lockFile = path.join(dataDir, 'team-control-plane.lock')
  const transactionFile = path.join(dataDir, 'team-control-plane.transaction.json')
  const auditFile = path.join(dataDir, 'team-audit.jsonl')
  const collectorFile = path.join(dataDir, 'team-collector.jsonl')
  const artifactRegistry = options.artifactRegistry
  const governance = options.governance
  const now = options.now || (() => new Date())
  const inspectTemplateAdoption = options.inspectProjectTemplateAdoption || inspectProjectTemplateAdoption
  const evaluations = options.evaluations || createEvaluationStore({ ...options, dataDir })
  const pruneEvents = options.pruneEvents || ((cutoff) => pruneEventsBefore(cutoff, { directory: dataDir }))

  async function observedPublicState(state) {
    const value = publicState(state)
    value.projects = await Promise.all(value.projects.map(async (project) => {
      if (!project.projectRoot) return { ...project, template: null }
      const selected = project.template
        ? { id: project.template.id, version: project.template.candidateVersion || project.template.version }
        : null
      let adoption
      try {
        adoption = await inspectTemplateAdoption(project.projectRoot, selected)
      } catch {
        return { ...project, template: null }
      }
      if (adoption.state === 'unmanaged') return { ...project, template: null }
      return {
        ...project,
        template: {
          id: adoption.templateId,
          version: adoption.currentVersion,
          status: adoption.state,
          candidateVersion: adoption.pendingUpgrade ? adoption.candidateVersion : null,
        },
      }
    }))
    value.templateAdoption = templateAdoption(value.projects)
    return value
  }

  function parseState(contents) {
    try { return normalizeState(JSON.parse(contents)) } catch (error) {
      if (error instanceof EvaluationError) throw error
      throw new EvaluationError('Team control-plane state is invalid.', 500)
    }
  }

  async function readStateFile() {
    const contents = await readOptional(stateFile, null)
    return contents === null ? defaultState() : parseState(contents)
  }

  function parseAudit(contents) {
    const records = contents.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { throw new EvaluationError('Team audit log is invalid.', 500) }
    })
    let previousHash = null
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      const { hash: recordedHash, ...unsigned } = record
      if (record.sequence !== index + 1 || record.previousHash !== previousHash || recordedHash !== hash(canonicalJson(unsigned))) {
        throw new EvaluationError('Team audit hash chain verification failed.', 500)
      }
      previousHash = recordedHash
    }
    return records
  }

  async function readAuditFile() {
    return parseAudit(await readOptional(auditFile, ''))
  }

  async function recoverTransaction() {
    const contents = await readOptional(transactionFile, null)
    if (contents === null) return
    let transaction
    try { transaction = JSON.parse(contents) } catch { throw new EvaluationError('Team transaction journal is invalid.', 500) }
    if (transaction?.schemaVersion !== 1 || typeof transaction.state !== 'string' || typeof transaction.audit !== 'string'
      || transaction.collector !== undefined && typeof transaction.collector !== 'string') {
      throw new EvaluationError('Team transaction journal is invalid.', 500)
    }
    parseState(transaction.state)
    parseAudit(transaction.audit)
    await replaceFile(stateFile, transaction.state)
    if (transaction.collector !== undefined) await replaceFile(collectorFile, transaction.collector)
    await replaceFile(auditFile, transaction.audit)
    await rm(transactionFile, { force: true })
  }

  function readConsistent(reader) {
    return withGovernanceFileLock(lockFile, async () => {
      await recoverTransaction()
      return reader()
    })
  }

  function readState() {
    return readConsistent(readStateFile)
  }

  function readAudit() {
    return readConsistent(readAuditFile)
  }

  function createAuditRecord(records, action, principal, roleName, subjectType, subjectId, revision) {
    // ponytail: replaying the local audit is O(n); move to SQLite when audit volume makes writes measurable.
    const unsigned = {
      schemaVersion: 1,
      id: randomUUID(),
      sequence: records.length + 1,
      previousHash: records.at(-1)?.hash || null,
      action,
      actorId: principal.id,
      actorRole: roleName,
      subjectType,
      subjectId,
      stateRevision: revision,
      at: now().toISOString(),
    }
    return { ...unsigned, hash: hash(canonicalJson(unsigned)) }
  }

  async function commitTransaction(state, records, collector) {
    const transaction = {
      schemaVersion: 1,
      state: `${JSON.stringify(state, null, 2)}\n`,
      audit: records.length ? `${records.map(JSON.stringify).join('\n')}\n` : '',
      ...(collector === undefined ? {} : { collector }),
    }
    await replaceFile(transactionFile, `${JSON.stringify(transaction)}\n`)
    try {
      await recoverTransaction()
    } catch (error) {
      throw new EvaluationError('Team transaction could not be committed; recovery will retry on the next access.', 500, { cause: error })
    }
  }

  function mutate(action, principal, minimumRole, subjectType, subjectId, operation) {
    return withGovernanceFileLock(lockFile, async () => {
      await recoverTransaction()
      const current = await readStateFile()
      const member = minimumRole ? requireRole(current, principal, minimumRole) : null
      const next = normalizeState(await operation(structuredClone(current), member))
      next.revision = current.revision + 1
      next.updatedAt = now().toISOString()
      const records = await readAuditFile()
      records.push(createAuditRecord(records, action, principal, member?.role || 'Owner', subjectType, subjectId, next.revision))
      await commitTransaction(next, records)
      return next
    })
  }

  async function initialize(input, principal) {
    const teamId = id(input?.id, 'Team ID')
    const name = text(input?.name, 'Team name')
    const next = await mutate('team.created', principal, null, 'team', teamId, (state) => {
      if (state.team) throw new EvaluationError('A Team is already configured.', 409)
      state.team = { id: teamId, name, createdAt: now().toISOString() }
      state.members.push({ id: principal.id, displayName: principal.displayName, role: 'Owner', status: 'active', createdAt: now().toISOString() })
      return state
    })
    return publicState(next)
  }

  async function snapshot(principal) {
    const state = await readState()
    if (state.team) requireRole(state, principal, 'Viewer')
    return observedPublicState(state)
  }

  async function authorize(principal, minimumRole) {
    const state = await readState()
    return state.team ? requireRole(state, principal, minimumRole) : null
  }

  async function resolveProjectRoot(projectId) {
    const state = await readState()
    if (!state.team) return null
    const normalizedId = id(projectId, 'Project ID')
    const project = state.projects.find((item) => item.id === normalizedId)
    if (!project) throw new EvaluationError('Project was not found.', 404)
    if (!project.projectRoot) throw new EvaluationError('Project root is not configured.', 409)
    return absoluteProjectRoot(project.projectRoot)
  }

  async function saveEntity(kind, input, principal) {
    if (!Object.hasOwn(ENTITY_RULES, kind)) throw new EvaluationError('Team entity kind is invalid.', 422)
    const entityId = kind === 'member' ? text(input?.id, 'Member ID') : id(input?.id, `${kind} ID`)
    const next = await mutate(`${kind}.saved`, principal, ENTITY_RULES[kind], kind, entityId, (state) => {
      const createdAt = now().toISOString()
      if (kind === 'workspace') {
        upsert(state.workspaces, { id: entityId, teamId: state.team.id, name: text(input.name, 'Workspace name'), createdAt })
      } else if (kind === 'project') {
        const workspaceId = id(input.workspaceId, 'Workspace ID')
        if (!state.workspaces.some((item) => item.id === workspaceId)) throw new EvaluationError('Workspace was not found.', 404)
        const artifactIds = input.artifactIds === undefined ? [] : input.artifactIds
        if (!Array.isArray(artifactIds) || artifactIds.length > 500) throw new EvaluationError('Project Artifact IDs are invalid.', 422)
        const existing = state.projects.find((item) => item.id === entityId)
        const template = input.template === undefined ? existing?.template || null : projectTemplate(input.template)
        const projectRoot = input.projectRoot === undefined ? existing?.projectRoot || null : absoluteProjectRoot(input.projectRoot)
        upsert(state.projects, { id: entityId, workspaceId, name: text(input.name, 'Project name'), projectRoot, repository: optionalText(input.repository, 'Project repository', 1_000), artifactIds: artifactIds.map((item) => text(item, 'Project Artifact ID')), template, createdAt })
      } else if (kind === 'environment') {
        const projectId = id(input.projectId, 'Project ID')
        if (!state.projects.some((item) => item.id === projectId)) throw new EvaluationError('Project was not found.', 404)
        upsert(state.environments, { id: entityId, projectId, name: text(input.name, 'Environment name'), channel: ['canary', 'stable'].includes(input.channel) ? input.channel : 'stable', createdAt })
      } else if (kind === 'member') {
        upsert(state.members, { id: entityId, displayName: text(input.displayName || entityId, 'Member display name'), role: role(input.role), status: input.status === 'revoked' ? 'revoked' : 'active', createdAt })
        if (!state.members.some((member) => member.role === 'Owner' && member.status === 'active')) throw new EvaluationError('A Team must retain at least one active Owner.', 409)
      } else {
        const gatePolicy = normalizeGatePolicy(input.gatePolicy)
        const contentHash = text(input.contentHash, 'Policy Pack content hash', 64)
        if (gatePolicy.id !== entityId || contentHash !== gatePolicyHash(gatePolicy)) {
          throw new EvaluationError('Policy Pack ID or content hash does not match its Gate Policy.', 422)
        }
        upsert(state.policyPacks, {
          id: entityId,
          version: text(input.version, 'Policy Pack version'),
          sourceRef: text(input.sourceRef, 'Policy Pack source', 2_000),
          contentHash,
          gatePolicy,
          createdAt,
        })
      }
      return state
    })
    return publicState(next)
  }

  async function removeEntity(kind, entityId, principal) {
    const fields = { workspace: 'workspaces', project: 'projects', environment: 'environments', member: 'members', policyPack: 'policyPacks' }
    const field = fields[kind]
    if (!field) throw new EvaluationError('Team entity kind is invalid.', 422)
    const required = kind === 'member' ? 'Owner' : 'Maintainer'
    const normalizedId = kind === 'member' ? text(entityId, 'Member ID') : id(entityId, `${kind} ID`)
    const next = await mutate(`${kind}.removed`, principal, required, kind, normalizedId, (state, actor) => {
      if (kind === 'member' && normalizedId === actor.id) throw new EvaluationError('The acting Owner cannot remove themselves.', 409)
      if (kind === 'workspace' && state.projects.some((item) => item.workspaceId === normalizedId)) throw new EvaluationError('Workspace still has Projects.', 409)
      if (kind === 'project' && (state.environments.some((item) => item.projectId === normalizedId) || state.exceptions.some((item) => item.projectId === normalizedId))) throw new EvaluationError('Project still has Environments or Policy exceptions.', 409)
      if (kind === 'member' && state.devices.some((item) => item.memberId === normalizedId)) throw new EvaluationError('Member still has registered Devices.', 409)
      if (kind === 'policyPack' && state.exceptions.some((item) => item.policyId === normalizedId)) throw new EvaluationError('Policy Pack still has exceptions.', 409)
      const before = state[field].length
      state[field] = state[field].filter((item) => item.id !== normalizedId)
      if (state[field].length === before) throw new EvaluationError('Team entity was not found.', 404)
      return state
    })
    return publicState(next)
  }

  async function registerDevice(input, principal) {
    const deviceId = id(input?.id || `device-${randomUUID()}`, 'Device ID')
    const token = randomBytes(32).toString('base64url')
    const next = await mutate('device.registered', principal, 'Developer', 'device', deviceId, (state, actor) => {
      const memberId = input?.memberId ? text(input.memberId, 'Device member ID') : principal.id
      if (memberId !== principal.id && ROLE_LEVEL[actor.role] < ROLE_LEVEL.Maintainer) throw new EvaluationError('Maintainer role is required to register another member device.', 403)
      if (!state.members.some((item) => item.id === memberId && item.status === 'active')) throw new EvaluationError('Device member was not found.', 404)
      if (state.devices.some((item) => item.id === deviceId)) throw new EvaluationError('Device already exists.', 409)
      state.devices.push({ id: deviceId, memberId, name: text(input?.name, 'Device name'), scopes: ['collector:write'], tokenHash: hashToken(token).toString('hex'), status: 'active', registeredAt: now().toISOString(), revokedAt: null, lastSeenAt: null })
      return state
    })
    return { device: publicState(next).devices.find((item) => item.id === deviceId), token }
  }

  async function revokeDevice(deviceId, principal) {
    const normalizedId = id(deviceId, 'Device ID')
    const next = await mutate('device.revoked', principal, 'Developer', 'device', normalizedId, (state, actor) => {
      const device = state.devices.find((item) => item.id === normalizedId)
      if (!device) throw new EvaluationError('Device was not found.', 404)
      if (device.memberId !== principal.id && ROLE_LEVEL[actor.role] < ROLE_LEVEL.Maintainer) throw new EvaluationError('Maintainer role is required to revoke another member device.', 403)
      device.status = 'revoked'
      device.revokedAt = now().toISOString()
      return state
    })
    return publicState(next).devices.find((item) => item.id === normalizedId)
  }

  async function collect(token, input) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) throw new EvaluationError('Collector token is invalid.', 403)
    const supplied = hashToken(token)
    return withGovernanceFileLock(lockFile, async () => {
      await recoverTransaction()
      const state = await readStateFile()
      const previousCollector = await readOptional(collectorFile, '')
      const device = state.devices.find((item) => {
        const stored = Buffer.from(item.tokenHash || '', 'hex')
        return item.status === 'active' && stored.length === supplied.length && timingSafeEqual(stored, supplied)
      })
      if (!device || !device.scopes.includes('collector:write')) throw new EvaluationError('Collector token is invalid or revoked.', 403)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EvaluationError('Collector payload is invalid.', 422)
      const unknown = Object.keys(input).filter((key) => !['events', 'evidence'].includes(key))
      if (unknown.length) throw new EvaluationError(`Collector payload contains unsupported field: ${unknown[0]}.`, 422)
      if (!Array.isArray(input.events || []) || input.events?.length > 100 || !Array.isArray(input.evidence || []) || input.evidence?.length > 100) throw new EvaluationError('Collector payload is too large.', 422)
      const record = {
        schemaVersion: 1,
        id: randomUUID(),
        deviceId: device.id,
        memberId: device.memberId,
        receivedAt: now().toISOString(),
        events: (input.events || []).map(sanitizeEvent),
        evidence: (input.evidence || []).map(sanitizeEvidence),
      }
      // ponytail: local collector rewrites are O(n); move to SQLite when retention-bounded files make uploads measurable.
      const collector = `${previousCollector}${JSON.stringify(record)}\n`
      device.lastSeenAt = record.receivedAt
      state.revision += 1
      state.updatedAt = record.receivedAt
      const records = await readAuditFile()
      records.push(createAuditRecord(records, 'collector.received', { id: `device:${device.id}` }, 'Device', 'device', device.id, state.revision))
      await commitTransaction(state, records, collector)
      return { accepted: true, eventCount: record.events.length, evidenceCount: record.evidence.length }
    })
  }

  async function catalog(principal) {
    const state = await readState()
    requireRole(state, principal, 'Viewer')
    if (!artifactRegistry?.list || !governance?.list) throw new EvaluationError('Team Artifact catalog is unavailable.', 503)
    const [registrySnapshot, capabilities] = await Promise.all([artifactRegistry.list(), governance.list()])
    return registrySnapshot.versions.map((version) => {
      const governed = capabilities.find((item) => item.artifact.kind === version.kind && item.artifact.artifactId === version.sourceArtifactId && item.artifact.contentHash === version.contentHash)
      return {
        artifactVersionId: version.id,
        artifactId: `${version.kind}:${version.sourceArtifactId}`,
        version: version.version,
        contentHash: version.contentHash,
        source: version.source,
        lifecycleStatus: governed?.stage || version.status,
        owner: governed?.owner || null,
        usedByProjectIds: state.projects.filter((project) => project.artifactIds.includes(`${version.kind}:${version.sourceArtifactId}`)).map((project) => project.id),
        evidenceHash: governed?.evidence?.evidenceHash || null,
      }
    })
  }

  async function queues(principal) {
    const state = await readState()
    requireRole(state, principal, 'Viewer')
    if (!governance?.list) throw new EvaluationError('Team governance queue is unavailable.', 503)
    const capabilities = await governance.list()
    return {
      approvalInbox: capabilities.filter((item) => item.stage === 'ready').map((item) => ({ capabilityId: item.id, artifactId: item.artifact.artifactId, owner: item.owner, evidenceHash: item.evidence?.evidenceHash || null })),
      releaseQueue: capabilities.filter((item) => ['approved', 'canary'].includes(item.stage)).map((item) => ({ capabilityId: item.id, artifactId: item.artifact.artifactId, stage: item.stage, targetSkeleton: item.targetSkeleton })),
    }
  }

  async function requestException(input, principal) {
    const exceptionId = id(input?.id || `exception-${randomUUID()}`, 'Policy exception ID')
    const next = await mutate('exception.requested', principal, 'Developer', 'exception', exceptionId, (state) => {
      const projectId = id(input.projectId, 'Project ID')
      const policyId = id(input.policyId, 'Policy Pack ID')
      if (!state.projects.some((item) => item.id === projectId)) throw new EvaluationError('Project was not found.', 404)
      if (!state.policyPacks.some((item) => item.id === policyId)) throw new EvaluationError('Policy Pack was not found.', 404)
      state.exceptions.push({ id: exceptionId, projectId, policyId, reason: text(input.reason, 'Policy exception reason', 1_000), requestedBy: principal.id, status: 'pending', reviewedBy: null, reviewedAt: null, createdAt: now().toISOString() })
      return state
    })
    return publicState(next).exceptions.find((item) => item.id === exceptionId)
  }

  async function reviewException(exceptionId, decision, principal) {
    const normalizedId = id(exceptionId, 'Policy exception ID')
    if (!['approved', 'rejected'].includes(decision)) throw new EvaluationError('Policy exception decision is invalid.', 422)
    const next = await mutate('exception.reviewed', principal, 'Reviewer', 'exception', normalizedId, (state) => {
      const item = state.exceptions.find((entry) => entry.id === normalizedId)
      if (!item) throw new EvaluationError('Policy exception was not found.', 404)
      if (item.status !== 'pending') throw new EvaluationError('Policy exception was already reviewed.', 409)
      if (item.requestedBy === principal.id) throw new EvaluationError('Policy exception requester and reviewer must differ.', 409)
      item.status = decision
      item.reviewedBy = principal.id
      item.reviewedAt = now().toISOString()
      return state
    })
    return publicState(next).exceptions.find((item) => item.id === normalizedId)
  }

  async function resolveGatePolicy(selection = {}) {
    const policyId = id(selection.policyId, 'Policy Pack ID')
    const projectId = selection.projectId == null ? null : id(selection.projectId, 'Project ID')
    const state = await readState()
    const policyPack = state.policyPacks.find((item) => item.id === policyId)
    if (!policyPack) throw new EvaluationError(`Gate policy ${policyId} is not available.`, 422)
    if (projectId && !state.projects.some((item) => item.id === projectId)) {
      throw new EvaluationError('Project was not found.', 404)
    }
    const gatePolicy = normalizeGatePolicy(policyPack.gatePolicy)
    if (gatePolicy.id !== policyPack.id || gatePolicyHash(gatePolicy) !== policyPack.contentHash) {
      throw new EvaluationError('Policy Pack content integrity verification failed.', 500)
    }
    const exception = projectId
      ? state.exceptions.find((item) => item.projectId === projectId
        && item.policyId === policyId
        && item.status === 'approved')
      : null
    return {
      policy: exception ? null : gatePolicy,
      policyId,
      projectId,
      waived: Boolean(exception),
      exceptionId: exception?.id || null,
    }
  }

  async function audit(principal) {
    requireRole(await readState(), principal, 'Viewer')
    return readAudit()
  }

  async function recordConnectorCredentialChange(connectorId, configured, principal) {
    const normalizedId = id(connectorId, 'Connector ID')
    return withGovernanceFileLock(lockFile, async () => {
      await recoverTransaction()
      const current = await readStateFile()
      if (!current.team) return null
      const member = requireRole(current, principal, 'Owner')
      const next = structuredClone(current)
      next.revision += 1
      next.updatedAt = now().toISOString()
      const records = await readAuditFile()
      records.push(createAuditRecord(records, configured ? 'connector.credential.saved' : 'connector.credential.removed', principal, member.role, 'connector', normalizedId, next.revision))
      await commitTransaction(next, records)
      return { connectorId: normalizedId, configured, stateRevision: next.revision }
    })
  }

  async function exportTeam(principal) {
    const state = await readState()
    requireRole(state, principal, 'Owner')
    return {
      schemaVersion: 1,
      exportedAt: now().toISOString(),
      state: await observedPublicState(state),
      catalog: artifactRegistry && governance ? await catalog(principal) : [],
      queues: governance ? await queues(principal) : { approvalInbox: [], releaseQueue: [] },
      audit: await readAudit(),
    }
  }

  async function backup(principal) {
    const exported = await exportTeam(principal)
    const payload = { ...exported, backupHash: hash(canonicalJson(exported)) }
    const name = `team-backup-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
    await replaceFile(path.join(dataDir, 'backups', name), `${JSON.stringify(payload, null, 2)}\n`)
    return { created: true, file: name, stateRevision: payload.state.revision }
  }

  async function restoreBackup(file, principal) {
    const name = text(file, 'Team backup file', 300)
    if (path.basename(name) !== name || !/^team-backup-[a-zA-Z0-9-]+\.json$/.test(name)) {
      throw new EvaluationError('Team backup file is invalid.', 422)
    }
    return withGovernanceFileLock(lockFile, async () => {
      await recoverTransaction()
      const current = await readStateFile()
      const member = requireRole(current, principal, 'Owner')
      let payload
      try { payload = JSON.parse(await readFile(path.join(dataDir, 'backups', name), 'utf8')) } catch (error) {
        if (error?.code === 'ENOENT') throw new EvaluationError('Team backup was not found.', 404)
        throw new EvaluationError('Team backup is invalid.', 500)
      }
      const { backupHash, ...exported } = payload || {}
      if (!/^[a-f0-9]{64}$/.test(backupHash || '') || hash(canonicalJson(exported)) !== backupHash || exported.schemaVersion !== 1) {
        throw new EvaluationError('Team backup integrity verification failed.', 409)
      }
      const source = exported.state
      if (!source || source.team?.id !== current.team?.id || !Number.isInteger(source.retentionDays)) {
        throw new EvaluationError('Team backup does not match the configured Team.', 409)
      }
      const restored = normalizeState({
        schemaVersion: 1,
        revision: current.revision + 1,
        team: structuredClone(source.team),
        workspaces: structuredClone(source.workspaces),
        projects: structuredClone(source.projects),
        environments: structuredClone(source.environments),
        members: structuredClone(source.members),
        devices: [],
        policyPacks: structuredClone(source.policyPacks),
        exceptions: structuredClone(source.exceptions),
        retentionDays: source.retentionDays,
        updatedAt: now().toISOString(),
      })
      requireRole(restored, principal, 'Owner')
      const records = await readAuditFile()
      records.push(createAuditRecord(records, 'backup.restored', principal, member.role, 'team', current.team.id, restored.revision))
      await commitTransaction(restored, records)
      return { restored: true, file: name, state: publicState(restored) }
    })
  }

  async function applyRetention(days, principal) {
    if (!Number.isInteger(days) || days < 1 || days > 3_650) throw new EvaluationError('Team retention days are invalid.', 422)
    return withGovernanceFileLock(lockFile, async () => {
      await recoverTransaction()
      const state = await readStateFile()
      const member = requireRole(state, principal, 'Owner')
      if (!governance?.list || !evaluations?.pruneBefore) throw new EvaluationError('Team retention dependencies are unavailable.', 503)
      const cutoff = new Date(now().getTime() - days * 86_400_000)
      const collectorRecords = (await readOptional(collectorFile, '')).split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { throw new EvaluationError('Team collector store is invalid.', 500) }
      })
      const retainedCollector = collectorRecords.filter((record) => Date.parse(record.receivedAt) >= cutoff.getTime())
      const capabilities = await governance.list()
      const preserveRunIds = [...new Set(capabilities.flatMap((capability) => [
        capability.latestEvidenceRunId,
        capability.evidence?.qualityRunId,
        capability.evidence?.redteamRunId,
      ]).filter(Boolean))]
      const events = await pruneEvents(cutoff)
      const evaluationEvidence = await evaluations.pruneBefore(cutoff, { preserveRunIds })
      let removedTeamBackups = 0
      const backupDirectory = path.join(dataDir, 'backups')
      for (const entry of await readdir(backupDirectory, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
        if (!entry.isFile() || !/^team-backup-[a-zA-Z0-9-]+\.json$/.test(entry.name)) continue
        try {
          const payload = JSON.parse(await readFile(path.join(backupDirectory, entry.name), 'utf8'))
          if (Date.parse(payload.exportedAt) >= cutoff.getTime()) continue
        } catch {
          continue
        }
        await rm(path.join(backupDirectory, entry.name))
        removedTeamBackups += 1
      }
      state.retentionDays = days
      state.revision += 1
      state.updatedAt = now().toISOString()
      const auditRecords = await readAuditFile()
      auditRecords.push(createAuditRecord(auditRecords, 'retention.updated', principal, member.role, 'team', 'retention', state.revision))
      const collector = retainedCollector.length ? `${retainedCollector.map(JSON.stringify).join('\n')}\n` : ''
      await commitTransaction(state, auditRecords, collector)
      return {
        retentionDays: state.retentionDays,
        retainedCollectorRecords: retainedCollector.length,
        removedCollectorRecords: collectorRecords.length - retainedCollector.length,
        events: {
          removed: events.removed,
          retained: events.retained,
          removedBackups: events.removedBackups,
        },
        evaluationEvidence: {
          removedRuns: evaluationEvidence.removedRuns,
          retainedRuns: evaluationEvidence.retainedRuns,
          removedBackups: evaluationEvidence.removedBackups,
          preservedRuns: preserveRunIds.length,
        },
        removedTeamBackups,
      }
    })
  }

  return {
    metadata: { deployment: 'local-git', networkApi: false, sso: false, scim: false },
    initialize,
    snapshot,
    authorize,
    resolveProjectRoot,
    saveEntity,
    removeEntity,
    registerDevice,
    revokeDevice,
    collect,
    catalog,
    queues,
    requestException,
    reviewException,
    resolveGatePolicy,
    audit,
    recordConnectorCredentialChange,
    exportTeam,
    backup,
    restoreBackup,
    applyRetention,
  }
}
