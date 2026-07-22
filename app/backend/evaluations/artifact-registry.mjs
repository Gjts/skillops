import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_RUNTIME_COMPATIBILITY,
  ARTIFACT_REFERENCE_ONLY_KINDS,
  normalizeArtifactRecord,
  normalizeArtifactVersionRecord,
  normalizeInstallationRecord,
} from '../../shared/evaluation-schema.mjs'
import { createCapabilityRegistry } from '../governance/capability-registry.mjs'
import { createSkeletonLock } from '../governance/skeleton-lock.mjs'
import { promptRegistry } from '../prompts/prompt-registry.mjs'
import { scanInstalledSkills } from '../skill-scanner.mjs'
import { discoverCandidateArtifact } from './candidate-source.mjs'
import { gitArtifactSource } from './git-artifact-source.mjs'
import { EvaluationError } from './errors.mjs'

const STATUS_PRIORITY = Object.freeze({ deprecated: 0, blocked: 1, draft: 2, ready: 3, candidate: 4, canary: 5, stable: 6 })
const DIFF_FIELDS = Object.freeze(['version', 'source', 'sourceRef', 'contentHash', 'gitCommit', 'repository', 'description', 'componentHashes', 'dependencies', 'runtimeTargets', 'compatibility', 'status'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

function observedArtifact(skill) {
  const kind = skill.kind === 'command' ? 'workflow' : skill.kind || 'skill'
  return {
    kind,
    artifactId: skill.skillId,
    version: skill.skillVersion || 'unversioned',
    description: skill.description,
    source: 'local-scan',
    sourceRef: `local-scan:${skill.runtime}:${skill.sourcePath}`,
    contentHash: skill.contentHash || sha256(JSON.stringify([skill.runtime, skill.sourcePath, skill.skillId, skill.skillVersion])),
    runtimeTargets: [skill.runtime],
  }
}

function artifactCommit(artifact) {
  if (artifact?.gitCommit) return artifact.gitCommit.toLowerCase()
  const sourceRef = String(artifact?.sourceRef || '')
  const match = artifact?.source === 'prompt-registry'
    ? /^prompt-registry:([a-f0-9]{40,64}):/i.exec(sourceRef)
    : artifact?.source === 'github'
      ? /^github:.*:([a-f0-9]{40,64}):[^:]+$/i.exec(sourceRef) || /\/blob\/([a-f0-9]{40,64})(?:\/|#)/i.exec(sourceRef)
      : null
  return match?.[1].toLowerCase()
}

function versionStatus(capabilities, artifact) {
  const commit = artifactCommit(artifact)
  const stage = capabilities.find((capability) => {
    const candidate = capability.artifact
    const candidateCommit = artifactCommit(candidate)
    return candidate?.kind === artifact.kind
      && candidate?.artifactId === artifact.artifactId
      && candidate?.contentHash === artifact.contentHash
      && (commit ? candidateCommit === commit : candidate?.source === artifact.source && candidate?.sourceRef === artifact.sourceRef)
  })?.stage
  if (stage === 'ready' || stage === 'approved') return 'ready'
  if ((stage === 'stable' || stage === 'canary') && !commit) return 'ready'
  if (stage === 'stable' || stage === 'canary' || stage === 'blocked') return stage
  if (stage === 'deprecated' || stage === 'superseded' || stage === 'rolled-back') return 'deprecated'
  if (stage === 'candidate' || stage === 'evaluating') return 'candidate'
  return 'draft'
}

function addVersion(versions, artifact, status, extra = {}) {
  const commit = artifactCommit(artifact)
  const versionArtifact = !artifact.gitCommit && commit ? { ...artifact, gitCommit: commit } : artifact
  const record = normalizeArtifactVersionRecord({ artifact: versionArtifact, status, ...extra })
  const existing = versions.get(record.id)
  if (!existing) {
    versions.set(record.id, record)
    return record
  }
  const merged = {
    ...existing,
    description: existing.description || record.description,
    repository: existing.repository || record.repository,
    runtimeTargets: [...new Set([...existing.runtimeTargets, ...record.runtimeTargets])].sort(),
    dependencies: [...new Set([...existing.dependencies, ...record.dependencies])].sort(),
    compatibility: { ...existing.compatibility, ...record.compatibility },
    componentHashes: { ...existing.componentHashes, ...record.componentHashes },
    status: STATUS_PRIORITY[existing.status] < STATUS_PRIORITY[record.status] ? record.status : existing.status,
    createdAt: [existing.createdAt, record.createdAt].filter(Boolean).sort()[0] || null,
  }
  versions.set(record.id, merged)
  return merged
}

function publicDiffValue(value) {
  return value === undefined ? null : value
}

function versionDiff(left, right) {
  if (left.artifactId !== right.artifactId) throw new EvaluationError('Artifact versions must share the same kind and Artifact ID.', 422)
  const changedFields = DIFF_FIELDS.filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))
  return {
    artifactId: left.artifactId,
    leftId: left.id,
    rightId: right.id,
    changed: changedFields.length > 0,
    changedFields,
    fields: Object.fromEntries(changedFields.map((field) => [field, {
      left: publicDiffValue(left[field]),
      right: publicDiffValue(right[field]),
    }])),
  }
}

async function existingBytes(file) {
  let info
  try { info = await lstat(file) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new EvaluationError('Artifact Registry storage must be a regular non-symlink file.', 422)
  return readFile(file)
}

async function replaceFileAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

const LEGACY_SCAN_FIELDS = new Set([
  'skillId', 'skillVersion', 'runtime', 'source', 'sourcePath', 'provider', 'kind', 'enabled',
  'disabledReason', 'status', 'shadowedBy', 'configurationSource', 'scope', 'originConfigs',
  'projectRoot', 'contentHash', 'description', 'tags', 'discoveredAt',
])

function legacyScanVersions(value) {
  const definitions = Array.isArray(value)
    ? value
    : value?.schemaVersion === 0
      && Array.isArray(value.definitions)
      && Object.keys(value).every((key) => ['schemaVersion', 'definitions'].includes(key))
      ? value.definitions
      : null
  if (!definitions || definitions.length > 10_000) throw new EvaluationError('Artifact Registry legacy metadata format is not recognized.', 422)
  const versions = []
  for (const item of definitions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !LEGACY_SCAN_FIELDS.has(key))) {
      throw new EvaluationError('Artifact Registry legacy metadata format is not recognized.', 422)
    }
    for (const field of ['skillId', 'skillVersion', 'runtime', 'sourcePath', 'contentHash']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) throw new EvaluationError('Artifact Registry legacy metadata format is not recognized.', 422)
    }
    if (!['codex', 'claude-code', 'cursor'].includes(item.runtime)
      || !['skill', 'command'].includes(item.kind || 'skill')
      || !/^[a-f0-9]{64}$/.test(item.contentHash)
      || item.skillId.length > 300 || item.skillVersion.length > 100 || item.sourcePath.length > 4_000
      || item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 2_000)
      || item.discoveredAt !== undefined && (typeof item.discoveredAt !== 'string' || Number.isNaN(Date.parse(item.discoveredAt)))
      || ['tags', 'originConfigs'].some((field) => item[field] !== undefined
        && (!Array.isArray(item[field]) || item[field].some((entry) => typeof entry !== 'string')))) {
      throw new EvaluationError('Artifact Registry legacy metadata format is not recognized.', 422)
    }
    if (item.status === 'missing') continue
    versions.push(normalizeArtifactVersionRecord({
      artifact: observedArtifact(item),
      status: 'deprecated',
      createdAt: item.discoveredAt,
    }))
  }
  return versions
}

export function createArtifactRegistry(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const file = path.join(dataDir, 'artifact-registry.json')
  const lockFile = path.join(dataDir, 'artifact-registry.lock')
  const capabilities = options.capabilityRegistry || createCapabilityRegistry({ dataDir })
  const skeletonLock = options.skeletonLock || createSkeletonLock({ dataDir })
  const prompts = options.promptRegistry || promptRegistry()
  const gitArtifacts = options.gitArtifactSource || gitArtifactSource(options)
  const scan = options.scanInstalledSkills || scanInstalledSkills
  const scanRoot = path.resolve(options.scanOptions?.projectRoot || options.skeletonRoot || process.env.SKILLOPS_SKELETON_ROOT || process.cwd())
  const scanOptions = { ...options.scanOptions, projectRoot: scanRoot }
  const physicalScanPath = (value, projectRoot = scanRoot) => path.isAbsolute(value) ? value : path.resolve(projectRoot, value)
  const discover = options.discoverCandidateArtifact || discoverCandidateArtifact
  const now = options.now || (() => new Date())
  const previews = new Map()
  let mutation = Promise.resolve()

  const unavailablePromptSource = Object.freeze({
    source: 'prompt-registry',
    code: 'PROMPT_SOURCE_UNAVAILABLE',
  })
  const unavailableGitSource = Object.freeze({
    source: 'git',
    code: 'GIT_ARTIFACT_SOURCE_UNAVAILABLE',
  })
  async function list() {
    let promptSourceWarning = null
    let gitSourceWarning = null
    const promptSource = Promise.resolve()
      .then(() => prompts.list())
      .catch(() => {
        promptSourceWarning = unavailablePromptSource
        return { items: [] }
      })
    const gitSource = Promise.resolve()
      .then(() => gitArtifacts.list())
      .catch(() => {
        gitSourceWarning = unavailableGitSource
        return { items: [] }
      })
    const [capabilityItems, lock, promptItems, gitItems, migratedBytes] = await Promise.all([
      capabilities.list(),
      skeletonLock.read(),
      promptSource,
      gitSource,
      existingBytes(file),
    ])
    const projectRoots = new Map([[pathKey(scanRoot), scanRoot]])
    for (const target of Object.values(lock.targets || {})) {
      for (const deployment of [target.stable, target.canary]) {
        if (typeof deployment?.projectRoot === 'string' && path.isAbsolute(deployment.projectRoot)) {
          projectRoots.set(pathKey(deployment.projectRoot), path.resolve(deployment.projectRoot))
        }
      }
    }
    const installedByRoot = new Map(await Promise.all([...projectRoots].map(async ([key, projectRoot]) => [
      key,
      await scan({ ...scanOptions, projectRoot }),
    ])))
    const installedByPath = new Map()
    for (const definitions of installedByRoot.values()) {
      for (const definition of definitions) {
        const key = `${definition.runtime}:${definition.kind}:${pathKey(definition.sourcePath)}`
        const current = installedByPath.get(key)
        if (!current || current.status === 'missing' && definition.status !== 'missing') installedByPath.set(key, definition)
      }
    }
    const installed = [...installedByPath.values()]
    const versions = new Map()

    for (const skill of installed) {
      if (skill.status === 'missing') continue
      const artifact = observedArtifact(skill)
      addVersion(versions, artifact, versionStatus(capabilityItems, artifact), { createdAt: skill.discoveredAt })
    }
    for (const item of gitItems.items || []) addVersion(versions, item.artifact, versionStatus(capabilityItems, item.artifact), { createdAt: item.discoveredAt })
    for (const item of promptItems.items || []) addVersion(versions, item.artifact, versionStatus(capabilityItems, item.artifact), { createdAt: item.discoveredAt })
    for (const capability of capabilityItems) {
      if (!capability.artifact) continue
      addVersion(versions, capability.artifact, versionStatus(capabilityItems, capability.artifact), { createdAt: capability.createdAt })
    }
    for (const target of Object.values(lock.targets || {})) {
      for (const [channel, deployment] of [['stable', target.stable], ['canary', target.canary]]) {
        if (!deployment?.artifact) continue
        addVersion(versions, deployment.artifact, channel, { createdAt: deployment.promotedAt })
      }
    }
    if (migratedBytes) {
      let migrated
      try { migrated = JSON.parse(migratedBytes.toString('utf8')) } catch {
        // Invalid legacy data is ignored until an explicit migration replaces it.
      }
      if (migrated?.schemaVersion === 1 && migrated?.migration?.id && Array.isArray(migrated.versions)) {
        assertMigrationSnapshot(migrated)
        const historicalVersions = new Map()
        for (const version of migrated.versions) {
          addVersion(historicalVersions, {
            kind: version.kind,
            artifactId: version.sourceArtifactId,
            version: version.version,
            description: version.description,
            source: version.source,
            sourceRef: version.sourceRef,
            contentHash: version.contentHash,
            gitCommit: version.gitCommit,
            repository: version.repository,
            dependencies: version.dependencies,
            runtimeTargets: version.runtimeTargets,
            compatibility: version.compatibility,
            componentHashes: version.componentHashes,
          }, 'deprecated', { createdAt: version.createdAt })
        }
        for (const [id, version] of historicalVersions) if (!versions.has(id)) versions.set(id, version)
      } else if (migrated !== undefined) {
        try {
          for (const version of legacyScanVersions(migrated)) if (!versions.has(version.id)) versions.set(version.id, version)
        } catch {
          // Invalid legacy data is ignored until an explicit migration replaces it.
        }
      }
    }

    const versionItems = [...versions.values()].sort((left, right) => left.id.localeCompare(right.id))
    const artifacts = new Map()
    for (const version of versionItems) {
      const owner = capabilityItems.find((item) => {
        const candidate = item.artifact
        return candidate?.kind === version.kind
          && candidate?.artifactId === version.sourceArtifactId
          && candidate?.contentHash === version.contentHash
          && (!version.gitCommit || artifactCommit(candidate) === version.gitCommit)
      })?.owner || 'local'
      const artifact = artifacts.get(version.artifactId) || normalizeArtifactRecord({
        kind: version.kind,
        artifactId: version.sourceArtifactId,
        name: version.sourceArtifactId,
        description: version.description,
        owner,
        repository: version.repository,
        status: version.status,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
      })
      if (!artifact.repository && version.repository) artifact.repository = version.repository
      if (!artifact.description && version.description) artifact.description = version.description
      if (version.createdAt && (!artifact.createdAt || version.createdAt < artifact.createdAt)) artifact.createdAt = version.createdAt
      if (version.createdAt && (!artifact.updatedAt || version.createdAt > artifact.updatedAt)) artifact.updatedAt = version.createdAt
      artifact.versionIds = [...(artifact.versionIds || []), version.id]
      if (STATUS_PRIORITY[artifact.status] < STATUS_PRIORITY[version.status]) {
        artifact.status = version.status
        artifact.owner = owner
      }
      artifacts.set(artifact.id, artifact)
    }

    const installations = []
    const managedPaths = new Set()
    for (const [targetRef, target] of Object.entries(lock.targets || {})) {
      for (const [channel, deployment] of [['stable', target.stable], ['canary', target.canary]]) {
        if (!deployment?.artifact) continue
        const commit = artifactCommit(deployment.artifact)
        const desired = normalizeArtifactVersionRecord({
          artifact: !deployment.artifact.gitCommit && commit ? { ...deployment.artifact, gitCommit: commit } : deployment.artifact,
          status: channel,
        })
        const referenceOnly = ARTIFACT_REFERENCE_ONLY_KINDS.includes(desired.kind)
        const deploymentRoot = typeof deployment.projectRoot === 'string' && path.isAbsolute(deployment.projectRoot)
          ? path.resolve(deployment.projectRoot)
          : scanRoot
        const deploymentRef = deployment.targetSkeleton || targetRef
        const targetRuntime = /^local-scan:([^:]+):/.exec(deploymentRef)?.[1]
          || /^local-scan:([^:]+):/.exec(targetRef)?.[1]
        const targetPath = /^local-scan:[^:]+:(.+)$/.exec(deploymentRef)?.[1] || deploymentRef
        const physicalTargetPath = referenceOnly ? targetRef : physicalScanPath(targetPath, deploymentRoot)
        const projectScan = installedByRoot.get(pathKey(deploymentRoot)) || []
        const observed = referenceOnly ? null : projectScan.find((skill) =>
          skill.status !== 'missing'
          && (`local-scan:${skill.runtime}:${skill.sourcePath}` === deploymentRef
          || (!targetRuntime || skill.runtime === targetRuntime) && samePath(physicalScanPath(skill.sourcePath, deploymentRoot), physicalTargetPath)))
        const observedHash = referenceOnly ? desired.contentHash : observed?.contentHash
        if (observed) managedPaths.add(pathKey(physicalScanPath(observed.sourcePath, deploymentRoot)))
        installations.push(normalizeInstallationRecord({
          id: `${desired.id}:${channel}:${targetRef}`,
          artifactId: desired.artifactId,
          artifactVersionId: desired.id,
          runtime: targetRuntime || observed?.runtime || desired.runtimeTargets[0] || 'codex',
          scope: observed?.scope || 'project',
          targetPath: physicalTargetPath,
          desiredState: 'present',
          observedState: referenceOnly || observedHash === desired.contentHash ? 'present' : observed ? 'drifted' : 'missing',
          observedHash,
        }))
      }
    }
    for (const skill of installed) {
      const targetPath = physicalScanPath(skill.sourcePath)
      if (skill.status === 'missing' || managedPaths.has(pathKey(targetPath))) continue
      const observed = observedArtifact(skill)
      const version = normalizeArtifactVersionRecord({ artifact: observed, status: versionStatus(capabilityItems, observed) })
      installations.push(normalizeInstallationRecord({
        id: `${version.id}:${targetPath}`,
        artifactId: version.artifactId,
        artifactVersionId: version.id,
        runtime: skill.runtime,
        scope: skill.scope || 'unknown',
        targetPath,
        desiredState: 'unmanaged',
        observedState: 'unmanaged',
        observedHash: skill.contentHash,
      }))
    }

    return {
      schemaVersion: 1,
      generatedAt: now().toISOString(),
      artifacts: [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id)),
      versions: versionItems,
      installations: installations.sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
      compatibility: ARTIFACT_RUNTIME_COMPATIBILITY,
      warnings: [gitSourceWarning, promptSourceWarning].filter(Boolean),
    }
  }

  async function diff(input) {
    const snapshot = await list()
    const left = snapshot.versions.find((item) => item.id === input?.leftId)
    const right = snapshot.versions.find((item) => item.id === input?.rightId)
    if (!left || !right) throw new EvaluationError('Both Artifact version IDs must exist.', 404)
    return versionDiff(left, right)
  }

  async function previewImport(input) {
    const remote = await discover({ sourceUrl: input?.sourceUrl, candidatePath: input?.sourcePath }, options)
    const version = normalizeArtifactVersionRecord({ artifact: remote.definition.artifact, status: 'candidate' })
    const snapshot = await list()
    const current = snapshot.versions.filter((item) => item.artifactId === version.artifactId)
    return {
      mode: 'preview',
      persisted: false,
      version,
      sourcePath: remote.definition.sourcePath,
      candidates: remote.candidates,
      currentVersionIds: current.map((item) => item.id),
      diff: current.length ? versionDiff(current.at(-1), version) : null,
    }
  }

  async function previewMigration() {
    previews.clear()
    const before = await existingBytes(file)
    if (before !== null) {
      let current
      try { current = JSON.parse(before.toString('utf8')) } catch {
        throw new EvaluationError('Artifact Registry legacy metadata format is not recognized.', 422)
      }
      if (current?.schemaVersion === 1 && current?.migration?.id) {
        assertMigrationSnapshot(current)
        return {
          action: 'noop',
          backupHash: current.migration.backupHash,
          migrationId: current.migration.id,
          appliedAt: current.migration.appliedAt,
          previewToken: null,
        }
      }
      legacyScanVersions(current)
    }
    const previewToken = randomUUID()
    const snapshot = await list()
    const expiresAt = now().getTime() + 10 * 60_000
    const plan = { action: before !== null ? 'replace' : 'create', beforeExisted: before !== null, backupHash: sha256(before || Buffer.alloc(0)), snapshot, expiresAt }
    previews.set(previewToken, plan)
    return { action: plan.action, backupHash: plan.backupHash, previewToken, expiresAt: new Date(expiresAt).toISOString(), counts: { artifacts: snapshot.artifacts.length, versions: snapshot.versions.length, installations: snapshot.installations.length } }
  }

  function serializeMigration(snapshot, migration) {
    return Buffer.from(`${JSON.stringify({ ...snapshot, migration }, null, 2)}\n`, 'utf8')
  }

  function migrationSnapshotHash(value) {
    const migration = { ...(value.migration || {}) }
    delete migration.snapshotHash
    return sha256(Buffer.from(JSON.stringify({ ...value, migration }), 'utf8'))
  }

  function assertMigrationSnapshot(value) {
    if (!/^[a-f0-9]{64}$/.test(value?.migration?.snapshotHash || '')
      || migrationSnapshotHash(value) !== value.migration.snapshotHash) {
      throw new EvaluationError('Artifact Registry changed after migration apply.', 409)
    }
    return value
  }

  async function withMigrationLock(operation) {
    await mkdir(dataDir, { recursive: true })
    let handle
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await open(lockFile, 'wx')
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const info = await stat(lockFile).catch(() => null)
        if (info && Date.now() - info.mtimeMs > 30_000) await rm(lockFile, { force: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!handle) throw new EvaluationError('Timed out waiting for the Artifact Registry lock.', 503)
    try {
      return await operation()
    } finally {
      await handle.close()
      await rm(lockFile, { force: true })
    }
  }

  function mutate(operation) {
    const pending = mutation.then(() => withMigrationLock(operation))
    mutation = pending.catch(() => undefined)
    return pending
  }

  async function applyMigration(previewToken) {
    const plan = previews.get(previewToken)
    if (!plan || plan.expiresAt < now().getTime()) {
      previews.delete(previewToken)
      throw new EvaluationError('Migration preview is missing or expired.', 409)
    }
    previews.delete(previewToken)
    return mutate(async () => {
      const current = await existingBytes(file)
      const currentExisted = current !== null
      if (currentExisted !== plan.beforeExisted || sha256(current || Buffer.alloc(0)) !== plan.backupHash) {
        throw new EvaluationError('Artifact Registry changed after migration preview.', 409)
      }
      const migrationId = randomUUID()
      const appliedAt = now().toISOString()
      const backupFile = currentExisted ? `${file}.backup-${migrationId}` : null
      const migration = {
        id: migrationId,
        appliedAt,
        previousExisted: currentExisted,
        backupFile: backupFile ? path.basename(backupFile) : null,
        backupHash: plan.backupHash,
      }
      migration.snapshotHash = migrationSnapshotHash({ ...plan.snapshot, migration })
      const contents = serializeMigration(plan.snapshot, migration)
      try {
        if (backupFile) await writeFile(backupFile, current)
        await replaceFileAtomic(file, contents)
      } catch (error) {
        if (backupFile) await rm(backupFile, { force: true })
        throw error
      }
      return { applied: true, migrationId, appliedAt, backupHash: plan.backupHash }
    })
  }

  async function rollbackMigration(migrationId) {
    if (typeof migrationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(migrationId)) {
      throw new EvaluationError('Migration ID is invalid.', 422)
    }
    return mutate(async () => {
      const current = await existingBytes(file)
      if (!current) throw new EvaluationError('Artifact Registry migration was not found.', 404)
      let state
      try { state = JSON.parse(current.toString('utf8')) } catch { throw new EvaluationError('Artifact Registry migration state is invalid.', 500) }
      const migration = state.migration
      if (migration?.id !== migrationId) throw new EvaluationError('Artifact Registry migration ID does not match.', 409)
      const backupFile = `${file}.backup-${migrationId}`
      if (migration.previousExisted && migration.backupFile !== path.basename(backupFile)) {
        throw new EvaluationError('Artifact Registry migration backup reference is invalid.', 409)
      }
      assertMigrationSnapshot(state)
      if (!migration.previousExisted) {
        await rm(file)
        return { rolledBack: true, restored: false }
      }
      const backup = await existingBytes(backupFile)
      if (!backup || sha256(backup) !== migration.backupHash) throw new EvaluationError('Artifact Registry migration backup is missing or changed.', 409)
      await replaceFileAtomic(file, backup)
      await rm(backupFile)
      return { rolledBack: true, restored: true }
    })
  }

  return { file, list, refresh: list, diff, previewImport, previewMigration, applyMigration, rollbackMigration }
}
