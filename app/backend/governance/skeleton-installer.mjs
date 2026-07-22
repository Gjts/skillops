import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, cp, link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createArtifactResolver } from '../evaluations/artifact-resolver.mjs'
import { artifactContentHash, artifactKindForRuntimeDefinition, normalizeArtifactContent } from '../evaluations/artifact-definition.mjs'
import { artifactPackageHash, normalizeArtifactPackage, readArtifactPackage } from '../evaluations/artifact-package.mjs'
import { installedArtifactDefinitions } from '../evaluations/candidate-source.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { scanInstalledSkills } from '../skill-scanner.mjs'
import { withGovernanceFileLock } from './skeleton-lock.mjs'
import { ARTIFACT_REFERENCE_ONLY_KINDS, ARTIFACT_RUNTIME_COMPATIBILITY } from '../../shared/evaluation-schema.mjs'

function referenceOnlyArtifact(artifact) {
  return ARTIFACT_REFERENCE_ONLY_KINDS.includes(artifact.kind)
}

function diffSummary(current, candidate) {
  const before = normalizeArtifactContent(current).split('\n')
  const after = normalizeArtifactContent(candidate).split('\n')
  let changed = 0
  const length = Math.max(before.length, after.length)
  for (let index = 0; index < length; index += 1) if (before[index] !== after[index]) changed += 1
  return { beforeLines: before.length, afterLines: after.length, changedLines: changed }
}

function compatibleRuntimes(artifact) {
  const compatibility = { ...ARTIFACT_RUNTIME_COMPATIBILITY[artifact.kind], ...artifact.compatibility }
  const targets = artifact.runtimeTargets || Object.keys(compatibility).filter((runtime) => compatibility[runtime] !== 'unsupported')
  return targets.filter((runtime) => compatibility[runtime] === 'supported')
}

function assertDeployableArtifact(artifact) {
  if (!referenceOnlyArtifact(artifact) && !compatibleRuntimes(artifact).length) {
    throw new EvaluationError('Artifact kind has no supported Runtime release target.', 422)
  }
}

function matchesReleasedArtifact(record, artifact) {
  return artifactKindForRuntimeDefinition(record?.kind) === artifact.kind
    && compatibleRuntimes(artifact).includes(record?.runtime)
}

export function createSkeletonInstaller(options = {}) {
  const artifacts = options.artifacts || createArtifactResolver(options)
  const managedRoot = options.skeletonRoot || process.env.SKILLOPS_SKELETON_ROOT
  const scan = (projectRoot) => {
    const root = projectRoot || options.projectRoot || managedRoot
    return typeof options.scanInstalledSkills === 'function'
      ? options.scanInstalledSkills({ projectRoot: root })
      : scanInstalledSkills({ ...options, projectRoot: root })
  }
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const recoveryFile = path.join(dataDir, 'governance-release-recoveries.json')
  const recoveryLockFile = path.join(dataDir, 'governance-release-recoveries.lock')
  const projectLockFile = path.join(dataDir, 'project-skeleton.lock.json')
  const previews = new Map()
  const recoveries = new Map()
  let recoveryQueue = Promise.resolve()


  function assertInside(root, target) {
    const relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EvaluationError('Installation target escapes the managed skeleton root.', 422)
  }

  async function assertInstallParent(targetFile, root, expected) {
    const parentPath = await realpath(path.dirname(targetFile))
    const parentInfo = await stat(parentPath)
    if (!parentInfo.isDirectory()) throw new EvaluationError('Installation target parent is unavailable.', 409)
    let rootPath = null
    let rootInfo = null
    if (root) {
      rootPath = await realpath(root)
      assertInside(rootPath, parentPath)
      rootInfo = await stat(rootPath)
      if (!rootInfo.isDirectory()) throw new EvaluationError('Installation target parent is unavailable.', 409)
    }
    const identity = {
      rootPath,
      rootDev: rootInfo?.dev ?? null,
      rootIno: rootInfo?.ino ?? null,
      parentPath,
      parentDev: parentInfo.dev,
      parentIno: parentInfo.ino,
    }
    if (expected && JSON.stringify(identity) !== JSON.stringify(expected)) {
      throw new EvaluationError('Installation target parent changed during apply.', 409)
    }
    return identity
  }
  async function ensureInstallParent(targetFile, root, expected) {
    if (!root) {
      await mkdir(path.dirname(targetFile), { recursive: true })
      return assertInstallParent(targetFile, root, expected)
    }
    const rootPath = await realpath(root)
    const parent = path.dirname(targetFile)
    assertInside(rootPath, parent)
    let current = rootPath
    const relative = path.relative(rootPath, parent)
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const before = await lstat(current)
      if (!before.isDirectory() || before.isSymbolicLink()) throw new EvaluationError('Installation target parent is unavailable.', 409)
      const next = path.join(current, segment)
      let info = await lstat(next).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (!info) {
        await mkdir(next).catch((error) => {
          if (error?.code !== 'EEXIST') throw error
        })
        info = await lstat(next)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new EvaluationError('Installation target parent is unavailable.', 409)
      const [after, actual] = await Promise.all([lstat(current), realpath(next)])
      if (after.dev !== before.dev || after.ino !== before.ino) throw new EvaluationError('Installation target parent changed during apply.', 409)
      assertInside(rootPath, actual)
      current = actual
    }
    return assertInstallParent(targetFile, root, expected)
  }


  async function writeManagedTemporary(file, contents, root, parentIdentity) {
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0)
    const handle = await open(file, flags, 0o600)
    try {
      const actual = await realpath(file)
      if (root) assertInside(parentIdentity.rootPath, actual)
      else if (path.dirname(actual) !== parentIdentity.parentPath) throw new EvaluationError('Installation temporary file escaped its approved parent.', 409)
      const [opened, resolved] = await Promise.all([handle.stat(), stat(actual)])
      if (opened.dev !== resolved.dev || opened.ino !== resolved.ino) {
        throw new EvaluationError('Installation temporary file identity changed.', 409)
      }
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await assertInstallParent(file, root, parentIdentity)
      const verified = await realpath(file)
      if (root) assertInside(parentIdentity.rootPath, verified)
      else if (path.dirname(verified) !== parentIdentity.parentPath) throw new EvaluationError('Installation temporary file escaped its approved parent.', 409)
    } finally {
      await handle.close()
    }
  }

  async function canonicalProjectRoot(value, explicit = false) {
    if (typeof value !== 'string' || !value.trim() || (explicit && !path.isAbsolute(value))) {
      throw new EvaluationError('Canary project root must be an absolute directory.', 422)
    }
    const root = await realpath(path.resolve(value)).catch(() => {
      throw new EvaluationError('The target project root is unavailable.', 409)
    })
    const info = await stat(root)
    if (!info.isDirectory()) throw new EvaluationError('The target project root is unavailable.', 409)
    return root
  }

  async function resolveInstallTarget(targetSkeleton, projectRoot) {
    if (typeof options.resolveTarget === 'function' && !projectRoot && !managedRoot) {
      return { targetFile: path.resolve(await options.resolveTarget(targetSkeleton)), root: null }
    }
    const root = await canonicalProjectRoot(projectRoot || managedRoot, Boolean(projectRoot))
    if (typeof targetSkeleton !== 'string' || !targetSkeleton.trim() || path.isAbsolute(targetSkeleton) || /^[a-z][a-z0-9+.-]*:/i.test(targetSkeleton)) {
      throw new EvaluationError('Installation target must be relative to the target project root.', 422)
    }
    if (typeof options.resolveTarget === 'function') {
      const targetFile = path.resolve(await options.resolveTarget(targetSkeleton, root))
      assertInside(root, targetFile)
      return { targetFile, root }
    }
    const targetFile = path.resolve(root, targetSkeleton)
    assertInside(root, targetFile)
    let nearest = path.dirname(targetFile)
    while (true) {
      try {
        assertInside(root, await realpath(nearest))
        break
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        const parent = path.dirname(nearest)
        if (parent === nearest) throw new EvaluationError('Installation target parent is unavailable.', 409)
        nearest = parent
      }
    }
    return { targetFile, root }
  }
  async function resolveTargetDetails(targetSkeleton, projectRoot) {
    if (projectRoot || (managedRoot && typeof targetSkeleton === 'string' && !path.isAbsolute(targetSkeleton) && !/^[a-z][a-z0-9+.-]*:/i.test(targetSkeleton))) {
      return resolveInstallTarget(targetSkeleton, projectRoot)
    }
    if (typeof options.resolveTarget === 'function') {
      return { targetFile: path.resolve(await options.resolveTarget(targetSkeleton)), root: null }
    }
    const target = (await installedArtifactDefinitions(options)).find((item) => item.artifact?.sourceRef === targetSkeleton)
    if (!target) throw new EvaluationError('Target skeleton is not in the enabled scanned inventory.', 404)
    return { targetFile: path.resolve(target.sourcePath), root: target.projectRoot ? path.resolve(target.projectRoot) : null }
  }

  async function resolveTarget(targetSkeleton) {
    return (await resolveTargetDetails(targetSkeleton)).targetFile
  }

  async function projectIdentity(targetSkeleton, projectRoot) {
    let root = projectRoot || managedRoot
    if (!root) root = (await resolveTargetDetails(targetSkeleton)).root
    if (!root) throw new EvaluationError('A canonical project root is required for this release target.', 409)
    const canonical = await canonicalProjectRoot(root, Boolean(projectRoot))
    const info = await stat(canonical, { bigint: true })
    return { projectRoot: canonical, key: `directory:${info.dev}:${info.ino}` }
  }

  async function assertRegularTarget(targetFile) {
    const info = await lstat(targetFile).catch((error) => {
      if (error?.code === 'ENOENT') throw new EvaluationError('Target skeleton file was not found.', 404)
      throw error
    })
    if (!info.isFile() || info.isSymbolicLink()) throw new EvaluationError('Target skeleton must be a regular non-symlink file.', 422)
    return realpath(targetFile)
  }

  function activeScanRecord(item) {
    return item?.enabled !== false && (item?.status === undefined || item.status === 'active')
  }

  async function physicalTargetKey(targetFile) {
    const absolute = path.resolve(targetFile)
    const info = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) {
      const parent = await realpath(path.dirname(absolute)).catch((error) => (
        error?.code === 'ENOENT' ? path.resolve(path.dirname(absolute)) : Promise.reject(error)
      ))
      const location = path.join(parent, path.basename(absolute))
      return `pending:${process.platform === 'win32' ? location.toLocaleLowerCase('en-US') : location}`
    }
    const actual = await assertRegularTarget(absolute)
    const physical = await stat(actual, { bigint: true })
    return `file:${physical.dev}:${physical.ino}`
  }

  async function findScannedTarget(records, targetFile, predicate = () => true, keys = []) {
    const expected = new Set([...keys, await physicalTargetKey(targetFile)])
    for (const item of records) {
      if (!item?.sourcePath || !predicate(item)) continue
      try {
        if (expected.has(await physicalTargetKey(item.sourcePath))) return item
      } catch {}
    }
    return null
  }

  function hash(value, label, optional = false) {
    if ((value === undefined || value === null) && optional) return null
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new EvaluationError(`${label} is invalid.`, 500)
    return value
  }

  function recoveryRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationError('Release recovery metadata is invalid.', 500)
    if (!['install', 'remove', 'replace'].includes(value.operation)
      || !['prepared', 'applied', 'removed', 'restoring', 'restored'].includes(value.state)) {
      throw new EvaluationError('Release recovery metadata is invalid.', 500)
    }
    if (typeof value.targetFile !== 'string' || !path.isAbsolute(value.targetFile)) throw new EvaluationError('Release recovery metadata is invalid.', 500)
    const targetFile = path.resolve(value.targetFile)
    const backupFile = value.backupFile === null || value.backupFile === undefined ? null : path.resolve(value.backupFile)
    const forwardBackupFile = value.forwardBackupFile === null || value.forwardBackupFile === undefined ? null : path.resolve(value.forwardBackupFile)
    const packageRecord = value.package === true
    const definitionFile = value.definitionFile === null || value.definitionFile === undefined ? null : path.resolve(value.definitionFile)
    if (packageRecord) {
      if (!definitionFile || !path.isAbsolute(value.definitionFile)) throw new EvaluationError('Release recovery package metadata is invalid.', 500)
      assertInside(targetFile, definitionFile)
    } else if (definitionFile) {
      throw new EvaluationError('Release recovery package metadata is invalid.', 500)
    }
    const managedRoot = value.managedRoot === null || value.managedRoot === undefined ? null : path.resolve(value.managedRoot)
    if (managedRoot) {
      assertInside(managedRoot, targetFile)
      for (const candidate of [backupFile, forwardBackupFile].filter(Boolean)) assertInside(managedRoot, candidate)
    }
    const savedParent = value.parentIdentity
    const hasParentIdentity = savedParent !== null && savedParent !== undefined
    const savedRoot = savedParent?.rootPath
    if ((managedRoot || hasParentIdentity) && (!savedParent
      || ![null, 'string'].includes(savedRoot === null ? null : typeof savedRoot)
      || (typeof savedRoot === 'string' && !path.isAbsolute(savedRoot))
      || typeof savedParent.parentPath !== 'string'
      || !path.isAbsolute(savedParent.parentPath)
      || (savedRoot !== null && (!Number.isInteger(savedParent.rootDev) || !Number.isInteger(savedParent.rootIno)))
      || (savedRoot === null && (savedParent.rootDev !== null || savedParent.rootIno !== null))
      || !Number.isInteger(savedParent.parentDev)
      || !Number.isInteger(savedParent.parentIno))) {
      throw new EvaluationError('Release recovery parent metadata is invalid.', 500)
    }
    if (managedRoot && savedRoot === null) throw new EvaluationError('Release recovery parent metadata is invalid.', 500)
    const parentIdentity = hasParentIdentity ? {
      rootPath: savedRoot === null ? null : path.resolve(savedRoot),
      rootDev: savedParent.rootDev,
      rootIno: savedParent.rootIno,
      parentPath: path.resolve(savedParent.parentPath),
      parentDev: savedParent.parentDev,
      parentIno: savedParent.parentIno,
    } : null
    if (parentIdentity?.rootPath) assertInside(parentIdentity.rootPath, parentIdentity.parentPath)
    for (const candidate of [backupFile, forwardBackupFile].filter(Boolean)) {
      if (path.dirname(candidate) !== path.dirname(targetFile) || !path.basename(candidate).startsWith(`${path.basename(targetFile)}.skillops-`)) {
        throw new EvaluationError('Release recovery metadata is invalid.', 500)
      }
    }
    return {
      operation: value.operation,
      state: value.state,
      targetFile,
      backupFile,
      forwardBackupFile,
      definitionFile,
      managedRoot,
      parentIdentity,
      currentHash: hash(value.currentHash, 'Recovery current hash', true),
      candidateHash: hash(value.candidateHash, 'Recovery candidate hash', true),
      byteHash: hash(value.byteHash, 'Recovery byte hash', true),
      candidateByteHash: hash(value.candidateByteHash, 'Recovery candidate byte hash', true),
      forwardHash: hash(value.forwardHash, 'Recovery forward hash', true),
      forwardByteHash: hash(value.forwardByteHash, 'Recovery forward byte hash', true),
      capabilityId: typeof value.capabilityId === 'string' ? value.capabilityId : null,
      targetSkeleton: typeof value.targetSkeleton === 'string' ? value.targetSkeleton : null,
      package: packageRecord,
    }
  }

  async function loadRecoveries() {
    recoveries.clear()
    try {
      const parsed = JSON.parse(await readFile(recoveryFile, 'utf8'))
      if (parsed?.schemaVersion !== 1 || !parsed.recoveries || typeof parsed.recoveries !== 'object' || Array.isArray(parsed.recoveries)) throw new Error()
      for (const [token, value] of Object.entries(parsed.recoveries)) {
        if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error()
        recoveries.set(token, recoveryRecord(value))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new EvaluationError('Release recovery store is invalid.', 500)
    }
  }

  function withRecoveryStore(operation) {
    const pending = recoveryQueue.then(() => withGovernanceFileLock(recoveryLockFile, async () => {
      await loadRecoveries()
      return operation()
    }))
    recoveryQueue = pending.catch(() => undefined)
    return pending
  }

  async function persistRecoveries() {
    await mkdir(dataDir, { recursive: true })
    const temporary = `${recoveryFile}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, recoveries: Object.fromEntries(recoveries) }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, recoveryFile)
  }

  function createRecovery(value) {
    return withRecoveryStore(async () => {
      const token = randomUUID()
      recoveries.set(token, recoveryRecord(value))
      await persistRecoveries()
      return token
    })
  }

  function readRecovery(token) {
    return withRecoveryStore(() => {
      const value = recoveries.get(token)
      if (!value) throw new EvaluationError('Release recovery state is unavailable.', 409)
      return structuredClone(value)
    })
  }

  function updateRecovery(token, updater) {
    return withRecoveryStore(async () => {
      const current = recoveries.get(token)
      if (!current) throw new EvaluationError('Release recovery state is unavailable.', 409)
      const next = recoveryRecord(await updater(structuredClone(current)))
      recoveries.set(token, next)
      await persistRecoveries()
      return next
    })
  }

  function deleteRecovery(token, expected) {
    return withRecoveryStore(async () => {
      const current = recoveries.get(token) || null
      if (current && expected && JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new EvaluationError('Release recovery state changed before cleanup.', 409)
      }
      if (current) {
        recoveries.delete(token)
        await persistRecoveries()
      }
      return current
    })
  }

  async function fileByteHash(file) {
    return createHash('sha256').update(await readFile(file)).digest('hex')
  }
  async function fileSnapshot(file) {
    const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) return null
    if (!info.isFile() || info.isSymbolicLink()) throw new EvaluationError('Release recovery target is not a regular file.', 500)
    return { hash: artifactContentHash(await readFile(file, 'utf8')), byteHash: await fileByteHash(file) }
  }

  function exactSnapshot(snapshot, contentHash, byteHash) {
    return snapshot?.hash === contentHash && (!byteHash || snapshot.byteHash === byteHash)
  }
  async function packageSnapshot(directory) {
    const info = await lstat(directory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!info) return null
    if (!info.isDirectory() || info.isSymbolicLink()) throw new EvaluationError('Release recovery target is not a regular directory.', 500)
    const record = await readArtifactPackage(directory)
    return { hash: record.contentHash, byteHash: record.contentHash, fileCount: record.packageFiles.length }
  }
  function recoverySnapshot(record, target = record.targetFile) {
    return record.package ? packageSnapshot(target) : fileSnapshot(target)
  }

  async function writePackage(directory, files, managedRoot, parentIdentity) {
    const packageFiles = normalizeArtifactPackage(files)
    await assertInstallParent(directory, managedRoot, parentIdentity)
    await mkdir(directory)
    const directoryIdentity = await lstat(directory)
    try {
      for (const file of packageFiles) {
        const target = path.join(directory, ...file.relativePath.split('/'))
        assertInside(directory, target)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.contents, { flag: 'wx', mode: file.mode })
        await chmod(target, file.mode)
      }
      const snapshot = await packageSnapshot(directory)
      const contentHash = artifactPackageHash(packageFiles)
      if (!exactSnapshot(snapshot, contentHash, contentHash)) throw new EvaluationError('Candidate Skill package failed verification.', 500)
      return { directoryIdentity, contentHash, packageFileCount: packageFiles.length }
    } catch (error) {
      const current = await lstat(directory).catch((caught) => caught?.code === 'ENOENT' ? null : Promise.reject(caught))
      if (current && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino) await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async function quarantineExactPackage(record, target, quarantine, contentHash, message, parentIdentity, expectedIdentity) {
    const approvedParent = await assertRecoveryParent(record, parentIdentity)
    const targetDirectory = await realpath(target)
    assertApprovedParent(approvedParent, targetDirectory)
    const identity = await lstat(target)
    if (!identity.isDirectory() || identity.isSymbolicLink()
      || (expectedIdentity && (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino))
      || !exactSnapshot(await packageSnapshot(target), contentHash, contentHash)) {
      throw new EvaluationError(message, 409)
    }
    await assertInstallParent(quarantine, record.managedRoot, approvedParent)
    if (await lstat(quarantine).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
      throw new EvaluationError('Release quarantine path already exists.', 409)
    }
    await rename(target, quarantine)
    const moved = await lstat(quarantine)
    if (moved.dev !== identity.dev || moved.ino !== identity.ino
      || !exactSnapshot(await packageSnapshot(quarantine), contentHash, contentHash)) {
      if (!await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) await rename(quarantine, target)
      throw new EvaluationError(message, 409)
    }
    return moved
  }

  async function removeExactPackagePath(record, target, contentHash, message, parentIdentity, expectedIdentity) {
    const quarantine = `${target}.${process.pid}.${randomUUID()}.quarantine`
    await quarantineExactPackage(record, target, quarantine, contentHash, message, parentIdentity, expectedIdentity)
    await rm(quarantine, { recursive: true })
  }

  function removeExactPackage(record, contentHash, message, expectedIdentity) {
    return removeExactPackagePath(record, record.targetFile, contentHash, message, undefined, expectedIdentity)
  }
  function assertApprovedParent(identity, actual) {
    if (identity.rootPath) assertInside(identity.rootPath, actual)
    else if (path.dirname(actual) !== identity.parentPath) throw new EvaluationError('Release target escaped its approved parent.', 409)
  }

  async function assertRecoveryParent(record, expected = record.parentIdentity) {
    const identity = await assertInstallParent(record.targetFile, record.managedRoot, expected)
    for (const file of [record.backupFile, record.forwardBackupFile].filter(Boolean)) {
      const actual = await realpath(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (actual) assertApprovedParent(identity, actual)
    }
    return identity
  }
  async function quarantineExactTarget(record, target, quarantine, contentHash, byteHash, message, parentIdentity, expectedIdentity) {
    const approvedParent = await assertRecoveryParent(record, parentIdentity)
    const targetFile = await assertRegularTarget(target)
    assertApprovedParent(approvedParent, targetFile)
    const identity = await lstat(targetFile)
    if ((expectedIdentity && (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino))
      || !exactSnapshot(await fileSnapshot(targetFile), contentHash, byteHash)) {
      throw new EvaluationError(message, 409)
    }
    await assertInstallParent(quarantine, record.managedRoot, approvedParent)
    if (await lstat(quarantine).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
      throw new EvaluationError('Release quarantine path already exists.', 409)
    }
    await rename(targetFile, quarantine)
    const movedIdentity = await lstat(quarantine)
    const movedMatches = movedIdentity.dev === identity.dev
      && movedIdentity.ino === identity.ino
      && exactSnapshot(await fileSnapshot(quarantine), contentHash, byteHash)
    if (!movedMatches) {
      if (!await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
        await link(quarantine, target).catch((error) => {
          if (error?.code !== 'EEXIST') throw error
        })
      }
      throw new EvaluationError(message, 409)
    }
    return movedIdentity
  }

  async function removeExactPath(record, target, contentHash, byteHash, message, parentIdentity, expectedIdentity) {
    const quarantine = `${target}.${process.pid}.${randomUUID()}.quarantine`
    const identity = await quarantineExactTarget(
      record,
      target,
      quarantine,
      contentHash,
      byteHash,
      message,
      parentIdentity,
      expectedIdentity,
    )
    const current = await lstat(quarantine)
    if (current.dev !== identity.dev
      || current.ino !== identity.ino
      || !exactSnapshot(await fileSnapshot(quarantine), contentHash, byteHash)) {
      throw new EvaluationError(message, 409)
    }
    await rm(quarantine)
  }

  async function discardRecoveryFiles(record, expected) {
    const identity = await assertRecoveryParent(record, expected)
    const files = [
      [record.backupFile, record.currentHash, record.byteHash],
      [record.forwardBackupFile, record.forwardHash, record.forwardByteHash],
    ]
    for (const [file, contentHash, byteHash] of files) {
      if (!file || !await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) continue
      if (record.package) await removeExactPackagePath(record, file, contentHash, 'Release recovery directory changed before cleanup.', identity)
      else await removeExactPath(record, file, contentHash, byteHash, 'Release recovery file changed before cleanup.', identity)
    }
  }

  async function copyExact(source, target, contentHash, byteHash, record, parentIdentity, expectedTarget = { absent: true }) {
    await assertRecoveryParent(record, parentIdentity)
    const sourceFile = await assertRegularTarget(source)
    assertApprovedParent(parentIdentity, sourceFile)
    if (!exactSnapshot(await fileSnapshot(sourceFile), contentHash, byteHash)) {
      throw new EvaluationError('Release recovery backup verification failed.', 500)
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.reconcile.tmp`
    try {
      await copyFile(sourceFile, temporary, fsConstants.COPYFILE_EXCL)
      await assertInstallParent(temporary, record.managedRoot, parentIdentity)
      assertApprovedParent(parentIdentity, await realpath(temporary))
      const temporaryIdentity = await lstat(temporary)
      if (!expectedTarget.absent) {
        await removeExactPath(
          record,
          target,
          expectedTarget.contentHash,
          expectedTarget.byteHash,
          expectedTarget.message,
          parentIdentity,
          expectedTarget.identity,
        )
      }
      await assertRecoveryParent(record, parentIdentity)
      try {
        await link(temporary, target)
      } catch (error) {
        if (error?.code === 'EEXIST') throw new EvaluationError(expectedTarget.message || 'Release target changed before atomic recovery.', 409)
        throw error
      }
      const targetIdentity = await lstat(target)
      if (targetIdentity.dev !== temporaryIdentity.dev || targetIdentity.ino !== temporaryIdentity.ino) {
        throw new EvaluationError('Release recovery target changed during atomic replacement.', 500)
      }
      await assertInstallParent(target, record.managedRoot, parentIdentity)
      assertApprovedParent(parentIdentity, await realpath(target))
      if (!exactSnapshot(await fileSnapshot(target), contentHash, byteHash)) {
        throw new EvaluationError('Release recovery write verification failed.', 500)
      }
      return targetIdentity
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async function copyExactPackage(source, target, contentHash, record, parentIdentity, expectedTarget = { absent: true }) {
    await assertRecoveryParent(record, parentIdentity)
    const sourceDirectory = await realpath(source)
    assertApprovedParent(parentIdentity, sourceDirectory)
    if (!exactSnapshot(await packageSnapshot(source), contentHash, contentHash)) {
      throw new EvaluationError('Release recovery Skill package verification failed.', 500)
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.reconcile.tmp`
    try {
      await cp(source, temporary, { recursive: true, errorOnExist: true, force: false })
      await assertInstallParent(temporary, record.managedRoot, parentIdentity)
      assertApprovedParent(parentIdentity, await realpath(temporary))
      const temporaryIdentity = await lstat(temporary)
      if (!expectedTarget.absent) {
        await removeExactPackagePath(
          record,
          target,
          expectedTarget.contentHash,
          expectedTarget.message,
          parentIdentity,
          expectedTarget.identity,
        )
      } else if (await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
        throw new EvaluationError(expectedTarget.message || 'Release Skill package was recreated before recovery.', 409)
      }
      await rename(temporary, target)
      const targetIdentity = await lstat(target)
      if (targetIdentity.dev !== temporaryIdentity.dev || targetIdentity.ino !== temporaryIdentity.ino
        || !exactSnapshot(await packageSnapshot(target), contentHash, contentHash)) {
        throw new EvaluationError('Release recovery Skill package write verification failed.', 500)
      }
      return targetIdentity
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  async function removeExactTarget(record, contentHash, byteHash, message, expectedIdentity) {
    return removeExactPath(record, record.targetFile, contentHash, byteHash, message, undefined, expectedIdentity)
  }
  function copyRecovery(source, target, contentHash, byteHash, record, parentIdentity, expectedTarget) {
    return record.package
      ? copyExactPackage(source, target, contentHash, record, parentIdentity, expectedTarget)
      : copyExact(source, target, contentHash, byteHash, record, parentIdentity, expectedTarget)
  }
  function removeRecoveryPath(record, target, contentHash, byteHash, message, parentIdentity, expectedIdentity) {
    return record.package
      ? removeExactPackagePath(record, target, contentHash, message, parentIdentity, expectedIdentity)
      : removeExactPath(record, target, contentHash, byteHash, message, parentIdentity, expectedIdentity)
  }
  function removeRecoveryTarget(record, contentHash, byteHash, message, expectedIdentity) {
    return record.package
      ? removeExactPackage(record, contentHash, message, expectedIdentity)
      : removeExactTarget(record, contentHash, byteHash, message, expectedIdentity)
  }

  async function projectReleaseState() {
    try {
      const lock = JSON.parse(await readFile(projectLockFile, 'utf8'))
      if (lock?.schemaVersion !== 1 || !lock.targets || typeof lock.targets !== 'object' || Array.isArray(lock.targets)) throw new Error()
      const referenced = new Set()
      for (const target of Object.values(lock.targets)) {
        if (target?.canary?.restoreToken) referenced.add(target.canary.restoreToken)
        for (const deployment of target?.previous || []) if (deployment?.restoreToken) referenced.add(deployment.restoreToken)
      }
      return { referenced, targets: lock.targets }
    } catch (error) {
      if (error?.code === 'ENOENT') return { referenced: new Set(), targets: {} }
      throw new EvaluationError('Project skeleton lock is unavailable for release recovery.', 500)
    }
  }

  async function matchesCurrentRelease(record, targets) {
    if (!record.targetSkeleton) return false
    await assertRecoveryParent(record)
    const stable = targets[record.targetSkeleton]?.stable
    const current = await recoverySnapshot(record)
    if (!stable) return !current
    return current?.hash === stable.artifact?.contentHash
  }

  async function compensateToBefore(record) {
    const parentIdentity = await assertRecoveryParent(record)
    const target = await recoverySnapshot(record)
    if (record.operation === 'install') {
      if (!target) return
      if (record.package) await removeExactPackage(record, record.candidateHash, 'Prepared Skill package changed before recovery.')
      else await removeExactTarget(record, record.candidateHash, record.candidateByteHash, 'Prepared installation target changed before recovery.')
      return
    }
    if (exactSnapshot(target, record.currentHash, record.byteHash)) return
    if (record.operation === 'replace' && target && !exactSnapshot(target, record.candidateHash, record.candidateByteHash)) {
      throw new EvaluationError('Prepared replacement target changed before recovery.', 409)
    }
    if (record.operation === 'remove' && target) {
      throw new EvaluationError('Prepared removal target changed before recovery.', 409)
    }
    await copyRecovery(
      record.backupFile,
      record.targetFile,
      record.currentHash,
      record.byteHash,
      record,
      parentIdentity,
      target
        ? {
            contentHash: record.candidateHash,
            byteHash: record.candidateByteHash,
            message: 'Prepared replacement target changed before recovery.',
          }
        : { absent: true, message: 'Prepared release target was recreated before recovery.' },
    )
  }

  async function reverseRestoration(record) {
    const parentIdentity = await assertRecoveryParent(record)
    const target = await recoverySnapshot(record)
    if (record.forwardBackupFile) {
      const forward = await recoverySnapshot(record, record.forwardBackupFile)
      if (!forward) {
        if (!exactSnapshot(target, record.forwardHash, record.forwardByteHash)) {
          throw new EvaluationError('Restoration forward backup is unavailable.', 500)
        }
      } else if (!exactSnapshot(target, record.forwardHash, record.forwardByteHash)) {
        if (!exactSnapshot(target, record.currentHash, record.byteHash)) {
          throw new EvaluationError('Restored target changed before startup recovery.', 409)
        }
        await copyRecovery(
          record.forwardBackupFile,
          record.targetFile,
          record.forwardHash,
          record.forwardByteHash,
          record,
          parentIdentity,
          {
            contentHash: record.currentHash,
            byteHash: record.byteHash,
            message: 'Restored target changed before startup recovery.',
          },
        )
      }
      if (forward) {
        await removeRecoveryPath(
          record,
          record.forwardBackupFile,
          record.forwardHash,
          record.forwardByteHash,
          'Restoration forward backup changed before cleanup.',
          parentIdentity,
        )
      }
    } else {
      if (record.operation !== 'remove') throw new EvaluationError('Release restoration recovery metadata is invalid.', 500)
      if (target && !exactSnapshot(target, record.currentHash, record.byteHash)) {
        throw new EvaluationError('Restored target changed before startup recovery.', 409)
      }
      if (target) await removeRecoveryTarget(record, record.currentHash, record.byteHash, 'Restored target changed before startup recovery.')
    }
    return recoveryRecord({
      ...record,
      state: record.operation === 'remove' ? 'removed' : 'applied',
      forwardBackupFile: null,
      forwardHash: null,
      forwardByteHash: null,
    })
  }

  async function reconcileRecoveries() {
    const { referenced, targets } = await projectReleaseState()
    let changed = false
    for (const [token, record] of [...recoveries]) {
      if (record.state === 'prepared') {
        await compensateToBefore(record)
        await discardRecoveryFiles(record)
        recoveries.delete(token)
        changed = true
        continue
      }
      if (record.state === 'restoring' || record.state === 'restored') {
        if (referenced.has(token)) {
          recoveries.set(token, await reverseRestoration(record))
        } else {
          if (!exactSnapshot(await recoverySnapshot(record), record.currentHash, record.byteHash)) {
            throw new EvaluationError('Committed restoration target failed startup verification.', 500)
          }
          await discardRecoveryFiles(record)
          recoveries.delete(token)
        }
        changed = true
        continue
      }
      if (referenced.has(token)) continue
      const installed = record.operation === 'install'
        && record.targetSkeleton
        && targets[record.targetSkeleton]?.stable?.capabilityId === record.capabilityId
        && targets[record.targetSkeleton]?.stable?.artifact?.contentHash === record.candidateHash
      const superseded = !installed && await matchesCurrentRelease(record, targets)
      if (!installed && !superseded) await compensateToBefore(record)
      await discardRecoveryFiles(record)
      recoveries.delete(token)
      changed = true
    }
    if (changed) await persistRecoveries()
  }

  async function verify(capability, targetSkeleton, projectRoot) {
    const project = await projectIdentity(targetSkeleton, projectRoot)
    if (referenceOnlyArtifact(capability.artifact)) {
      const source = await artifacts.resolve(capability.artifact.sourceRef, { expectedContentHash: capability.artifact.contentHash })
      if (source.artifact.contentHash !== capability.artifact.contentHash) throw new EvaluationError('Canary Artifact reference failed verification.', 409)
      return { target: targetSkeleton, projectRoot: project.projectRoot, contentHash: source.artifact.contentHash, observedAt: new Date().toISOString(), referenceOnly: true }
    }
    assertDeployableArtifact(capability.artifact)
    const resolved = await resolveTargetDetails(targetSkeleton, project.projectRoot)
    const targetFile = await assertRegularTarget(resolved.targetFile)
    const parentIdentity = await assertInstallParent(targetFile, resolved.root)
    const rescanned = await scan(project.projectRoot)
    await assertInstallParent(targetFile, resolved.root, parentIdentity)
    assertApprovedParent(parentIdentity, await realpath(targetFile))
    const fileHash = artifactContentHash(await readFile(targetFile, 'utf8'))
    const packageRecord = capability.artifact.kind === 'skill' && fileHash !== capability.artifact.contentHash
      ? await packageSnapshot(path.dirname(targetFile))
      : null
    const contentHash = packageRecord?.hash || fileHash
    const record = await findScannedTarget(rescanned, targetFile, activeScanRecord)
    if (!record
      || contentHash !== capability.artifact.contentHash
      || record.contentHash && record.contentHash !== contentHash
      || !matchesReleasedArtifact(record, capability.artifact)) {
      throw new EvaluationError('Canary deployment failed kind, Runtime, or content verification.', 409)
    }
    return { target: targetSkeleton, projectRoot: project.projectRoot, contentHash, observedAt: new Date().toISOString(), referenceOnly: false }
  }

  async function targetKey(targetSkeleton, projectRoot) {
    if (typeof targetSkeleton !== 'string') return targetSkeleton
    let targetFile
    try {
      targetFile = (await resolveTargetDetails(targetSkeleton, projectRoot)).targetFile
    } catch (error) {
      const localPath = /^local-scan:[^:]+:(.+)$/.exec(targetSkeleton)?.[1]
      if (!(error instanceof EvaluationError) || error.status !== 404) throw error
      if (!localPath) return targetSkeleton
      targetFile = path.resolve(localPath)
    }
    return physicalTargetKey(targetFile)
  }


  return {
    targetKey,
    projectIdentity,
    verify,
    async initialize() {
      await withGovernanceFileLock(path.join(dataDir, 'governance-release.lock'), () => withRecoveryStore(reconcileRecoveries), 3_000)
    },
    async previewInstall(capability, context = {}) {
      const token = randomUUID()
      const expiresAt = Date.now() + 10 * 60_000
      assertDeployableArtifact(capability.artifact)
      if (referenceOnlyArtifact(capability.artifact)) {
        const source = await artifacts.resolve(capability.artifact.sourceRef, { ...context, expectedContentHash: capability.artifact.contentHash })
        if (source.artifact.contentHash !== capability.artifact.contentHash) throw new EvaluationError('Candidate content changed before installation.', 409)
        const project = context.projectRoot ? await projectIdentity(capability.targetSkeleton, context.projectRoot) : null
        const plan = {
          previewToken: token,
          purpose: context.purpose || 'install',
          capabilityId: context.subjectCapabilityId || capability.id,
          releaseCapabilityId: capability.id,
          source: capability.artifact.sourceRef,
          target: capability.targetSkeleton,
          ...(project ? { projectRoot: project.projectRoot } : {}),
          currentHash: null,
          candidateHash: capability.artifact.contentHash,
          diff: { beforeLines: 0, afterLines: 0, changedLines: 1 },
          conflict: false,
          backup: 'not-applicable-reference-lock',
          rollbackPlan: 'Remove the installed immutable Artifact reference from project-skeleton.lock.json.',
          expiresAt: new Date(expiresAt).toISOString(),
        }
        previews.set(token, { plan, referenceOnly: true, install: true, expiresAt })
        return plan
      }
      const source = await artifacts.resolve(capability.artifact.sourceRef, { ...context, expectedContentHash: capability.artifact.contentHash })
      const candidateContents = normalizeArtifactContent(source.contents)
      const packageFiles = capability.artifact.kind === 'skill' && source.packageFiles
        ? normalizeArtifactPackage(source.packageFiles)
        : null
      const resolvedHash = packageFiles ? artifactPackageHash(packageFiles) : artifactContentHash(candidateContents)
      if (source.artifact.contentHash !== capability.artifact.contentHash || resolvedHash !== capability.artifact.contentHash) {
        throw new EvaluationError('Candidate content changed before installation.', 409)
      }
      const { targetFile, root } = await resolveInstallTarget(capability.targetSkeleton, context.projectRoot)
      const installationTarget = packageFiles ? path.dirname(targetFile) : targetFile
      const existing = await lstat(installationTarget).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (existing) throw new EvaluationError('Installation target already exists.', 409)
      const parentIdentity = await assertInstallParent(installationTarget, root).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      const plan = {
        previewToken: token,
        purpose: context.purpose || 'install',
        capabilityId: context.subjectCapabilityId || capability.id,
        releaseCapabilityId: capability.id,
        source: capability.artifact.sourceRef,
        target: capability.targetSkeleton,
        ...(context.projectRoot ? { projectRoot: root } : {}),
        currentHash: null,
        candidateHash: capability.artifact.contentHash,
        diff: diffSummary('', candidateContents),
        conflict: false,
        backup: packageFiles ? 'not-required-new-directory' : 'not-required-new-file',
        rollbackPlan: packageFiles
          ? 'Remove the complete newly installed Skill directory if any downstream release step fails.'
          : 'Remove the newly installed file if any downstream release step fails.',
        expiresAt: new Date(expiresAt).toISOString(),
      }
      previews.set(token, {
        plan,
        install: true,
        targetFile,
        installationTarget,
        root,
        parentIdentity,
        candidateContents,
        ...(packageFiles ? { package: true, packageFiles } : {}),
        expiresAt,
      })
      return plan
    },
    async previewRemoval(capability, context = {}) {
      const token = randomUUID()
      const expiresAt = Date.now() + 10 * 60_000
      if (referenceOnlyArtifact(capability.artifact)) {
        const plan = {
          previewToken: token,
          purpose: context.purpose || 'deprecate',
          capabilityId: context.subjectCapabilityId || capability.id,
          releaseCapabilityId: capability.id,
          source: capability.artifact.sourceRef,
          target: capability.targetSkeleton,
          currentHash: capability.artifact.contentHash,
          candidateHash: capability.artifact.contentHash,
          diff: { beforeLines: 0, afterLines: 0, changedLines: 1 },
          conflict: false,
          backup: 'not-applicable-reference-lock',
          rollbackPlan: 'Restore the immutable Artifact reference from project-skeleton.lock.json.',
          expiresAt: new Date(expiresAt).toISOString(),
        }
        previews.set(token, { plan, referenceOnly: true, removal: true, expiresAt })
        return plan
      }
      const resolved = await resolveTargetDetails(capability.targetSkeleton)
      const targetFile = await assertRegularTarget(resolved.targetFile)
      const currentContents = await readFile(targetFile, 'utf8')
      const fileHash = artifactContentHash(currentContents)
      const packageRoot = path.dirname(targetFile)
      const packageRecord = capability.artifact.kind === 'skill' && fileHash !== capability.artifact.contentHash
        ? await packageSnapshot(packageRoot)
        : null
      const removalTarget = packageRecord ? packageRoot : targetFile
      const parentIdentity = await assertInstallParent(removalTarget, resolved.root)
      const currentHash = packageRecord?.hash || fileHash
      if (currentHash !== capability.artifact.contentHash) throw new EvaluationError('Stable target drift must be resolved before removal.', 409)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const plan = {
        previewToken: token,
        purpose: context.purpose || 'deprecate',
        capabilityId: context.subjectCapabilityId || capability.id,
        releaseCapabilityId: capability.id,
        source: capability.artifact.sourceRef,
        target: capability.targetSkeleton,
        currentHash,
        candidateHash: capability.artifact.contentHash,
        diff: { beforeLines: normalizeArtifactContent(currentContents).split('\n').length, afterLines: 0, changedLines: normalizeArtifactContent(currentContents).split('\n').length },
        conflict: false,
        backup: `${path.basename(removalTarget)}.skillops-backup-${timestamp}`,
        rollbackPlan: packageRecord
          ? 'Restore the complete immutable Skill directory backup, then rescan the target.'
          : 'Restore the exact-byte backup atomically, then rescan the target.',
        expiresAt: new Date(expiresAt).toISOString(),
      }
      previews.set(token, {
        plan,
        removal: true,
        targetFile,
        removalTarget,
        root: resolved.root,
        parentIdentity,
        currentHash,
        ...(packageRecord ? { package: true } : {}),
        expiresAt,
      })
      return plan
    },
    async previewRestore(capability, recoveryToken, context = {}) {
      const token = randomUUID()
      const expiresAt = Date.now() + 10 * 60_000
      if (referenceOnlyArtifact(capability.artifact)) {
        const plan = {
          previewToken: token,
          purpose: context.purpose || 'restore',
          capabilityId: context.subjectCapabilityId || capability.id,
          releaseCapabilityId: capability.id,
          source: capability.artifact.sourceRef,
          target: capability.targetSkeleton,
          currentHash: null,
          candidateHash: capability.artifact.contentHash,
          diff: { beforeLines: 0, afterLines: 0, changedLines: 1 },
          conflict: false,
          backup: 'not-applicable-reference-lock',
          rollbackPlan: 'Restore the immutable Artifact reference from project-skeleton.lock.json.',
          expiresAt: new Date(expiresAt).toISOString(),
        }
        previews.set(token, { plan, referenceOnly: true, restore: true, expiresAt })
        return plan
      }
      const recovery = await readRecovery(recoveryToken)
      const expectedState = recovery.operation === 'remove' ? 'removed' : recovery.operation === 'replace' ? 'applied' : null
      if (!expectedState || recovery.state !== expectedState || recovery.currentHash !== capability.artifact.contentHash || !recovery.backupFile) {
        throw new EvaluationError('Release recovery state does not match the requested Stable version.', 409)
      }
      const parentIdentity = await assertRecoveryParent(recovery)
      const backupFile = recovery.package ? await realpath(recovery.backupFile) : await assertRegularTarget(recovery.backupFile)
      const backupSnapshot = await recoverySnapshot(recovery, recovery.backupFile)
      if (!exactSnapshot(backupSnapshot, recovery.currentHash, recovery.byteHash)) {
        throw new EvaluationError('Release backup verification failed.', 409)
      }
      const backupContents = recovery.package ? '' : await readFile(backupFile, 'utf8')
      let currentContents = ''
      let currentTargetHash = null
      const replaceExisting = recovery.operation === 'replace'
        || (recovery.operation === 'remove' && context.purpose === 'rollback' && context.currentHash)
      if (replaceExisting) {
        const currentSnapshot = await recoverySnapshot(recovery)
        currentTargetHash = recovery.operation === 'replace' ? recovery.candidateHash : hash(context.currentHash, 'Current Stable hash')
        if (!exactSnapshot(currentSnapshot, currentTargetHash, recovery.package ? currentTargetHash : currentSnapshot?.byteHash)) {
          throw new EvaluationError('Release target changed before rollback.', 409)
        }
        if (!recovery.package) currentContents = await readFile(recovery.targetFile, 'utf8')
      } else if (recovery.operation === 'remove') {
        if (await lstat(recovery.targetFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
          throw new EvaluationError('Removed target was recreated before restoration.', 409)
        }
      }
      const plan = {
        previewToken: token,
        purpose: context.purpose || 'restore',
        capabilityId: context.subjectCapabilityId || capability.id,
        releaseCapabilityId: capability.id,
        source: capability.artifact.sourceRef,
        target: capability.targetSkeleton,
        currentHash: currentTargetHash,
        candidateHash: capability.artifact.contentHash,
        diff: recovery.package ? { beforeLines: replaceExisting ? 1 : 0, afterLines: 1, changedLines: 1 } : diffSummary(currentContents, backupContents),
        conflict: false,
        backup: path.basename(backupFile),
        rollbackPlan: recovery.package
          ? 'Restore the complete immutable Skill directory backup and retain the displaced version for compensation.'
          : replaceExisting ? 'Restore the previous exact-byte Stable backup atomically.' : 'Restore the exact-byte backup atomically, then rescan the target.',
        expiresAt: new Date(expiresAt).toISOString(),
      }
      previews.set(token, { plan, restore: true, replaceExisting, currentTargetHash, recoveryToken, recovery, parentIdentity, expiresAt })
      return plan
    },
    async preview(capability, context = {}) {
      assertDeployableArtifact(capability.artifact)
      if (referenceOnlyArtifact(capability.artifact)) {
        if (!context.skipReferenceVerification) {
          const source = await artifacts.resolve(capability.artifact.sourceRef, { ...context, expectedContentHash: capability.artifact.contentHash })
          if (source.artifact.contentHash !== capability.artifact.contentHash) throw new EvaluationError('Candidate content changed before promotion.', 409)
        }
        const project = context.projectRoot ? await projectIdentity(capability.targetSkeleton, context.projectRoot) : null
        const token = randomUUID()
        const expiresAt = Date.now() + 10 * 60_000
        const plan = {
          previewToken: token,
          purpose: context.purpose || 'promote',
          capabilityId: context.subjectCapabilityId || capability.id,
          releaseCapabilityId: capability.id,
          source: capability.artifact.sourceRef,
          target: capability.targetSkeleton,
          ...(project ? { projectRoot: project.projectRoot } : {}),
          currentHash: capability.baseline?.contentHash || null,
          candidateHash: capability.artifact.contentHash,
          diff: { beforeLines: 0, afterLines: 0, changedLines: capability.baseline?.contentHash === capability.artifact.contentHash ? 0 : 1 },
          conflict: false,
          backup: 'not-applicable-reference-lock',
          rollbackPlan: 'Restore the previous immutable local Artifact reference from project-skeleton.lock.json.',
          expiresAt: new Date(expiresAt).toISOString(),
        }
        previews.set(token, { plan, referenceOnly: true, expiresAt })
        return plan
      }
      const source = await artifacts.resolve(capability.artifact.sourceRef, { ...context, expectedContentHash: capability.artifact.contentHash })
      if (source.artifact.contentHash !== capability.artifact.contentHash) throw new EvaluationError('Candidate content changed before promotion.', 409)
      const resolved = await resolveTargetDetails(capability.targetSkeleton, context.projectRoot)
      const targetFile = await assertRegularTarget(resolved.targetFile)
      const currentContents = await readFile(targetFile, 'utf8')
      const candidateContents = normalizeArtifactContent(source.contents)
      const packageFiles = capability.artifact.kind === 'skill' && source.packageFiles
        ? normalizeArtifactPackage(source.packageFiles)
        : null
      const promotionTarget = packageFiles ? path.dirname(targetFile) : targetFile
      const parentIdentity = await assertInstallParent(promotionTarget, resolved.root)
      const candidateContentHash = packageFiles ? artifactPackageHash(packageFiles) : artifactContentHash(candidateContents)
      if (candidateContentHash !== capability.artifact.contentHash) throw new EvaluationError('Candidate content hash verification failed.', 409)
      const currentHash = packageFiles
        ? (await packageSnapshot(promotionTarget))?.hash
        : artifactContentHash(currentContents)
      if (!currentHash) throw new EvaluationError('Current Skill package is unavailable.', 409)
      const token = randomUUID()
      const expiresAt = Date.now() + 10 * 60_000
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const alreadyCurrent = currentHash === capability.artifact.contentHash
      const plan = {
        previewToken: token,
        purpose: context.purpose || 'promote',
        capabilityId: context.subjectCapabilityId || capability.id,
        releaseCapabilityId: capability.id,
        source: capability.artifact.sourceRef,
        target: capability.targetSkeleton,
        ...(context.projectRoot ? { projectRoot: resolved.root } : {}),
        currentHash,
        candidateHash: capability.artifact.contentHash,
        diff: diffSummary(currentContents, candidateContents),
        conflict: Boolean(capability.baseline && capability.baseline.contentHash !== currentHash),
        backup: alreadyCurrent ? 'not-required-current-content' : `${path.basename(promotionTarget)}.skillops-backup-${timestamp}`,
        rollbackPlan: alreadyCurrent
          ? 'No file write is required because the target already has the candidate content.'
          : packageFiles
            ? 'Restore the complete timestamped Skill directory backup if verification fails.'
            : 'Restore the timestamped backup atomically if verification fails.',
        expiresAt: new Date(expiresAt).toISOString(),
      }
      previews.set(token, {
        plan,
        targetFile,
        promotionTarget,
        root: resolved.root,
        parentIdentity,
        currentHash,
        candidateContents,
        ...(packageFiles ? { package: true, packageFiles } : {}),
        expiresAt,
      })
      return plan
    },
    async apply(previewToken, { confirm = false, capabilityId, releaseCapabilityId, purpose = 'promote', targetSkeleton, projectRoot, candidateHash } = {}) {
      if (!confirm) throw new EvaluationError('Explicit release confirmation is required.', 422)
      const preview = previews.get(previewToken)
      if (!preview || preview.expiresAt < Date.now()) throw new EvaluationError('Release preview is missing or expired.', 409)
      if (preview.plan.capabilityId !== capabilityId
        || preview.plan.releaseCapabilityId !== releaseCapabilityId
        || preview.plan.purpose !== purpose
        || preview.plan.target !== targetSkeleton
        || preview.plan.projectRoot !== projectRoot
        || preview.plan.candidateHash !== candidateHash) {
        throw new EvaluationError('Release preview does not match this capability and operation.', 409)
      }
      previews.delete(previewToken)
      if (preview.plan.conflict) {
        throw new EvaluationError('Release target conflicts with the evaluated Stable baseline; resolve the drift and preview again.', 409)
      }
      if (preview.restore && preview.recovery?.package) {
        const recovery = await readRecovery(preview.recoveryToken)
        if (JSON.stringify(recovery) !== JSON.stringify(preview.recovery)) throw new EvaluationError('Release recovery state changed after preview.', 409)
        const parentIdentity = await assertRecoveryParent(recovery, preview.parentIdentity)
        if (!exactSnapshot(await packageSnapshot(recovery.backupFile), recovery.currentHash, recovery.currentHash)) {
          throw new EvaluationError('Release Skill package backup changed after preview.', 409)
        }
        let forwardBackupFile = null
        let forwardIdentity = null
        let restoredTarget = false
        let restoredIdentity = null
        let restoring
        try {
          if (preview.replaceExisting) {
            const targetSnapshot = await packageSnapshot(recovery.targetFile)
            if (!exactSnapshot(targetSnapshot, preview.currentTargetHash, preview.currentTargetHash)) {
              throw new EvaluationError('Release Skill package changed after preview.', 409)
            }
            forwardBackupFile = `${recovery.targetFile}.skillops-forward-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
            forwardIdentity = await lstat(recovery.targetFile)
          } else if (recovery.operation === 'remove'
            && await lstat(recovery.targetFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            throw new EvaluationError('Removed Skill package was recreated after preview.', 409)
          }
          restoring = await updateRecovery(preview.recoveryToken, (current) => {
            if (JSON.stringify(current) !== JSON.stringify(recovery)) throw new EvaluationError('Release recovery state changed during restoration.', 409)
            return {
              ...current,
              state: 'restoring',
              forwardBackupFile,
              forwardHash: preview.currentTargetHash,
              forwardByteHash: preview.currentTargetHash,
            }
          })
          if (forwardBackupFile) {
            await quarantineExactPackage(
              restoring,
              recovery.targetFile,
              forwardBackupFile,
              preview.currentTargetHash,
              'Release Skill package changed after preview.',
              parentIdentity,
              forwardIdentity,
            )
          }
          restoredIdentity = await copyExactPackage(
            recovery.backupFile,
            recovery.targetFile,
            recovery.currentHash,
            restoring,
            parentIdentity,
            { absent: true, message: 'Release Skill package changed before restoration.' },
          )
          restoredTarget = true
          const rescanned = await scan(recovery.managedRoot)
          const record = await findScannedTarget(rescanned, recovery.definitionFile, activeScanRecord)
          if (!record
            || !exactSnapshot(await packageSnapshot(recovery.targetFile), recovery.currentHash, recovery.currentHash)
            || record.contentHash !== recovery.currentHash) {
            throw new EvaluationError('Restored Skill package failed post-write verification.', 500)
          }
          await updateRecovery(preview.recoveryToken, (current) => {
            if (JSON.stringify(current) !== JSON.stringify(restoring)) throw new EvaluationError('Release recovery state changed during restoration.', 409)
            return { ...current, state: 'restored' }
          })
          return {
            applied: true,
            operation: 'restore',
            target: preview.plan.target,
            contentHash: recovery.currentHash,
            packageFileCount: (await packageSnapshot(recovery.targetFile)).fileCount,
            backup: path.basename(recovery.backupFile),
            rollback: { restored: false },
            recoveryToken: preview.recoveryToken,
          }
        } catch (error) {
          if (restoring) {
            const targetSnapshot = await packageSnapshot(recovery.targetFile)
            const forwardSnapshot = forwardBackupFile ? await packageSnapshot(forwardBackupFile) : null
            if (forwardBackupFile && forwardSnapshot) {
              if (!exactSnapshot(forwardSnapshot, preview.currentTargetHash, preview.currentTargetHash)) {
                throw new EvaluationError('Release Skill package changed before automatic recovery.', 409)
              }
              if (!exactSnapshot(targetSnapshot, preview.currentTargetHash, preview.currentTargetHash)) {
                if (targetSnapshot && !exactSnapshot(targetSnapshot, recovery.currentHash, recovery.currentHash)) {
                  throw new EvaluationError('Restored Skill package changed before automatic recovery.', 409)
                }
                await copyExactPackage(
                  forwardBackupFile,
                  recovery.targetFile,
                  preview.currentTargetHash,
                  restoring,
                  parentIdentity,
                  targetSnapshot
                    ? {
                        identity: restoredIdentity,
                        contentHash: recovery.currentHash,
                        message: 'Restored Skill package changed before automatic recovery.',
                      }
                    : { absent: true, message: 'Release Skill package changed before automatic recovery.' },
                )
              }
              await removeExactPackagePath(
                restoring,
                forwardBackupFile,
                preview.currentTargetHash,
                'Restoration forward Skill package changed before cleanup.',
                parentIdentity,
              )
            } else if (forwardBackupFile && !exactSnapshot(targetSnapshot, preview.currentTargetHash, preview.currentTargetHash)) {
              throw new EvaluationError('Release Skill package changed before automatic recovery.', 409)
            } else if (!forwardBackupFile && targetSnapshot) {
              if (!restoredTarget) throw new EvaluationError('Release Skill package changed before automatic recovery.', 409)
              await removeExactPackage(restoring, recovery.currentHash, 'Restored Skill package changed before automatic recovery.', restoredIdentity)
            }
            await updateRecovery(preview.recoveryToken, (current) => {
              if (current.state !== 'restoring') throw new EvaluationError('Release recovery state changed during restoration recovery.', 409)
              return recovery
            })
          }
          if (error instanceof EvaluationError && error.status === 409) throw error
          return {
            applied: false,
            operation: 'restore',
            target: preview.plan.target,
            contentHash: preview.plan.currentHash,
            backup: path.basename(recovery.backupFile),
            rollback: { restored: restoredTarget },
            errorCode: 'RESTORATION_VERIFICATION_FAILED',
          }
        }
      }
      if (preview.restore && !preview.referenceOnly) {
        const recovery = await readRecovery(preview.recoveryToken)
        if (JSON.stringify(recovery) !== JSON.stringify(preview.recovery)) throw new EvaluationError('Release recovery state changed after preview.', 409)
        const parentIdentity = await assertRecoveryParent(recovery, preview.parentIdentity)
        const backupFile = await assertRegularTarget(recovery.backupFile)
        if (artifactContentHash(await readFile(backupFile, 'utf8')) !== recovery.currentHash || await fileByteHash(backupFile) !== recovery.byteHash) {
          throw new EvaluationError('Release backup changed after preview.', 409)
        }
        let forwardBackupFile = null
        let forwardByteHash = null
        let forwardIdentity = null
        let restoredTarget = false
        let restoredIdentity = null
        let restoring
        try {
          if (preview.replaceExisting) {
            const targetFile = await assertRegularTarget(recovery.targetFile)
            assertApprovedParent(parentIdentity, targetFile)
            const targetSnapshot = await fileSnapshot(targetFile)
            if (targetSnapshot.hash !== preview.currentTargetHash) throw new EvaluationError('Release target changed after preview.', 409)
            forwardBackupFile = `${recovery.targetFile}.skillops-forward-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
            forwardByteHash = targetSnapshot.byteHash
            forwardIdentity = await lstat(targetFile)
          } else if (recovery.operation === 'remove'
            && await lstat(recovery.targetFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            throw new EvaluationError('Removed target was recreated after preview.', 409)
          }
          restoring = await updateRecovery(preview.recoveryToken, (current) => {
            if (JSON.stringify(current) !== JSON.stringify(recovery)) throw new EvaluationError('Release recovery state changed during restoration.', 409)
            return {
              ...current,
              state: 'restoring',
              forwardBackupFile,
              forwardHash: preview.currentTargetHash,
              forwardByteHash,
            }
          })
          if (forwardBackupFile) {
            await quarantineExactTarget(
              restoring,
              recovery.targetFile,
              forwardBackupFile,
              preview.currentTargetHash,
              forwardByteHash,
              'Release target changed after preview.',
              parentIdentity,
              forwardIdentity,
            )
          }
          restoredIdentity = await copyExact(
            backupFile,
            recovery.targetFile,
            recovery.currentHash,
            recovery.byteHash,
            restoring,
            parentIdentity,
            { absent: true, message: 'Release target changed before restoration.' },
          )
          restoredTarget = true
          const rescanned = await scan(recovery.managedRoot)
          const record = await findScannedTarget(rescanned, recovery.targetFile, activeScanRecord)
          if (!record
            || !exactSnapshot(await fileSnapshot(recovery.targetFile), recovery.currentHash, recovery.byteHash)
            || (record.contentHash && record.contentHash !== recovery.currentHash)) {
            throw new EvaluationError('Restored artifact failed post-write verification.', 500)
          }
          await updateRecovery(preview.recoveryToken, (current) => {
            if (JSON.stringify(current) !== JSON.stringify(restoring)) throw new EvaluationError('Release recovery state changed during restoration.', 409)
            return { ...current, state: 'restored' }
          })
          return {
            applied: true,
            operation: 'restore',
            target: preview.plan.target,
            contentHash: recovery.currentHash,
            backup: path.basename(backupFile),
            rollback: { restored: false },
            recoveryToken: preview.recoveryToken,
          }
        } catch (error) {
          if (restoring) {
            const targetSnapshot = await fileSnapshot(recovery.targetFile)
            const forwardSnapshot = forwardBackupFile ? await fileSnapshot(forwardBackupFile) : null
            if (forwardBackupFile && forwardSnapshot) {
              if (!exactSnapshot(forwardSnapshot, preview.currentTargetHash, forwardByteHash)) {
                throw new EvaluationError('Release target changed before automatic recovery.', 409)
              }
              if (!exactSnapshot(targetSnapshot, preview.currentTargetHash, forwardByteHash)) {
                if (targetSnapshot && !exactSnapshot(targetSnapshot, recovery.currentHash, recovery.byteHash)) {
                  throw new EvaluationError('Release target changed before automatic recovery.', 409)
                }
                await copyExact(
                  forwardBackupFile,
                  recovery.targetFile,
                  preview.currentTargetHash,
                  forwardByteHash,
                  restoring,
                  parentIdentity,
                  targetSnapshot
                    ? {
                        identity: restoredIdentity,
                        contentHash: recovery.currentHash,
                        byteHash: recovery.byteHash,
                        message: 'Restored target changed before automatic recovery.',
                      }
                    : { absent: true, message: 'Release target changed before automatic recovery.' },
                )
              }
              await removeExactPath(
                restoring,
                forwardBackupFile,
                preview.currentTargetHash,
                forwardByteHash,
                'Restoration forward backup changed before cleanup.',
                parentIdentity,
              )
            } else if (forwardBackupFile && !exactSnapshot(targetSnapshot, preview.currentTargetHash, forwardByteHash)) {
              throw new EvaluationError('Release target changed before automatic recovery.', 409)
            } else if (!forwardBackupFile && targetSnapshot) {
              if (!restoredTarget) throw new EvaluationError('Release target changed before automatic recovery.', 409)
              await removeExactTarget(
                restoring,
                recovery.currentHash,
                recovery.byteHash,
                'Restored target changed before automatic recovery.',
                restoredIdentity,
              )
            }
            await updateRecovery(preview.recoveryToken, (current) => {
              if (current.state !== 'restoring') throw new EvaluationError('Release recovery state changed during restoration recovery.', 409)
              return recovery
            })
          }
          if (error instanceof EvaluationError && error.status === 409) throw error
          return { applied: false, operation: 'restore', target: preview.plan.target, contentHash: preview.plan.currentHash, backup: path.basename(backupFile), rollback: { restored: restoredTarget }, errorCode: 'RESTORATION_VERIFICATION_FAILED' }
        }
      }
      if (preview.install && preview.package) {
        const targetDirectory = preview.installationTarget
        if (await lstat(targetDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
          throw new EvaluationError('Installation target changed after preview.', 409)
        }
        const parentIdentity = await ensureInstallParent(targetDirectory, preview.root, preview.parentIdentity)
        const temporary = `${targetDirectory}.${process.pid}.${randomUUID()}.tmp`
        let installedIdentity = null
        let recoveryToken
        try {
          recoveryToken = await createRecovery({
            operation: 'install',
            state: 'prepared',
            targetFile: targetDirectory,
            managedRoot: preview.root,
            parentIdentity,
            backupFile: null,
            forwardBackupFile: null,
            currentHash: null,
            candidateHash: preview.plan.candidateHash,
            byteHash: null,
            candidateByteHash: preview.plan.candidateHash,
            capabilityId: releaseCapabilityId,
            targetSkeleton,
            definitionFile: preview.targetFile,
            package: true,
          })
          const staged = await writePackage(temporary, preview.packageFiles, preview.root, parentIdentity)
          if (await lstat(targetDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            throw new EvaluationError('Installation target changed after preview.', 409)
          }
          await rename(temporary, targetDirectory)
          installedIdentity = await lstat(targetDirectory)
          if (installedIdentity.dev !== staged.directoryIdentity.dev || installedIdentity.ino !== staged.directoryIdentity.ino) {
            throw new EvaluationError('Installed Skill package changed during atomic creation.', 500)
          }
          const written = await packageSnapshot(targetDirectory)
          const rescanned = await scan(preview.root)
          const record = await findScannedTarget(rescanned, preview.targetFile, activeScanRecord)
          if (!record || !exactSnapshot(written, preview.plan.candidateHash, preview.plan.candidateHash)
            || record.contentHash !== preview.plan.candidateHash) {
            throw new EvaluationError('Installed Skill package failed post-write verification.', 500)
          }
          await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'applied' }))
          return {
            applied: true,
            operation: 'install',
            target: preview.plan.target,
            contentHash: preview.plan.candidateHash,
            packageFileCount: written.fileCount,
            backup: null,
            rollback: { restored: false },
            recoveryToken,
          }
        } catch (error) {
          let restored = !installedIdentity
          if (installedIdentity) {
            const recovery = await readRecovery(recoveryToken)
            await removeExactPackage(recovery, preview.plan.candidateHash, 'Installed Skill package changed before recovery.', installedIdentity)
            restored = true
          }
          if (recoveryToken && restored) await deleteRecovery(recoveryToken)
          if (error instanceof EvaluationError && error.status === 409) throw error
          return {
            applied: false,
            operation: 'install',
            target: preview.plan.target,
            contentHash: null,
            backup: null,
            rollback: { restored },
            errorCode: 'INSTALLATION_VERIFICATION_FAILED',
          }
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      if (preview.install && !preview.referenceOnly) {
        const targetFile = preview.targetFile
        if (await lstat(targetFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
          throw new EvaluationError('Installation target changed after preview.', 409)
        }
        const parentIdentity = await ensureInstallParent(targetFile, preview.root, preview.parentIdentity)
        const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`
        const candidateByteHash = createHash('sha256').update(Buffer.from(preview.candidateContents, 'utf8')).digest('hex')
        let installed = false
        let recoveryToken
        try {
          recoveryToken = await createRecovery({
            operation: 'install',
            state: 'prepared',
            targetFile,
            managedRoot: preview.root,
            parentIdentity,
            backupFile: null,
            forwardBackupFile: null,
            currentHash: null,
            candidateHash: preview.plan.candidateHash,
            byteHash: null,
            candidateByteHash,
            capabilityId: releaseCapabilityId,
            targetSkeleton,
          })
          await writeManagedTemporary(temporary, preview.candidateContents, preview.root, parentIdentity)
          await assertInstallParent(targetFile, preview.root, parentIdentity)
          const temporaryIdentity = await lstat(temporary)
          await link(temporary, targetFile)
          installed = true
          const installedIdentity = await lstat(targetFile)
          if (installedIdentity.dev !== temporaryIdentity.dev || installedIdentity.ino !== temporaryIdentity.ino) {
            throw new EvaluationError('Installed target changed during atomic creation.', 500)
          }
          await assertInstallParent(targetFile, preview.root, parentIdentity)
          assertApprovedParent(parentIdentity, await realpath(targetFile))
          const rescanned = await scan(preview.root)
          await assertInstallParent(targetFile, preview.root, parentIdentity)
          assertApprovedParent(parentIdentity, await realpath(targetFile))
          const record = await findScannedTarget(rescanned, targetFile, activeScanRecord)
          const writtenHash = artifactContentHash(await readFile(targetFile, 'utf8'))
          if (!record || writtenHash !== preview.plan.candidateHash || (record.contentHash && record.contentHash !== writtenHash)) {
            throw new EvaluationError('Installed artifact failed post-write verification.', 500)
          }
          await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'applied', candidateHash: writtenHash }))
          return { applied: true, operation: 'install', target: preview.plan.target, contentHash: writtenHash, backup: null, rollback: { restored: false }, recoveryToken }
        } catch (error) {
          let restored = !installed
          if (installed) {
            await assertInstallParent(targetFile, preview.root, parentIdentity)
            const targetInfo = await lstat(targetFile).catch((caught) => caught?.code === 'ENOENT' ? null : Promise.reject(caught))
            if (!targetInfo) {
              restored = true
            } else {
              const recovery = await readRecovery(recoveryToken)
              await removeExactTarget(
                recovery,
                preview.plan.candidateHash,
                candidateByteHash,
                'Installed target changed before recovery.',
                await lstat(temporary),
              )
              restored = true
            }
          }
          if (recoveryToken && restored) await deleteRecovery(recoveryToken)
          if (error?.code === 'EEXIST') throw new EvaluationError('Installation target changed after preview.', 409)
          return { applied: false, operation: 'install', target: preview.plan.target, contentHash: null, backup: null, rollback: { restored }, errorCode: 'INSTALLATION_VERIFICATION_FAILED' }
        } finally { await rm(temporary, { force: true }) }
      }
      if (preview.removal && preview.package) {
        const targetDirectory = preview.removalTarget
        const parentIdentity = await assertInstallParent(targetDirectory, preview.root, preview.parentIdentity)
        const targetSnapshot = await packageSnapshot(targetDirectory)
        if (!exactSnapshot(targetSnapshot, preview.currentHash, preview.currentHash)) {
          throw new EvaluationError('Removal Skill package changed after preview.', 409)
        }
        const targetIdentity = await lstat(targetDirectory)
        const removedTargetKey = await physicalTargetKey(preview.targetFile)
        const backupDirectory = path.join(path.dirname(targetDirectory), preview.plan.backup)
        const recoveryToken = await createRecovery({
          operation: 'remove',
          state: 'prepared',
          targetFile: targetDirectory,
          managedRoot: preview.root,
          parentIdentity,
          backupFile: backupDirectory,
          forwardBackupFile: null,
          currentHash: preview.currentHash,
          candidateHash: null,
          byteHash: preview.currentHash,
          capabilityId: releaseCapabilityId,
          targetSkeleton,
          definitionFile: preview.targetFile,
          package: true,
        })
        try {
          const recovery = await readRecovery(recoveryToken)
          await quarantineExactPackage(
            recovery,
            targetDirectory,
            backupDirectory,
            preview.currentHash,
            'Removal Skill package changed after preview.',
            parentIdentity,
            targetIdentity,
          )
          const rescanned = await scan(preview.root)
          const visible = await findScannedTarget(rescanned, preview.targetFile, (item) => item.status !== 'missing', [removedTargetKey])
          if (visible || await lstat(targetDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            throw new EvaluationError('Removed Skill package remains visible after rescan.', 500)
          }
          await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'removed' }))
          return {
            applied: true,
            operation: 'remove',
            target: preview.plan.target,
            contentHash: null,
            backup: path.basename(backupDirectory),
            rollback: { restored: false },
            recoveryToken,
          }
        } catch (error) {
          if (error instanceof EvaluationError && error.status === 409) throw error
          const recovery = await readRecovery(recoveryToken)
          const current = await packageSnapshot(targetDirectory)
          const backup = await packageSnapshot(backupDirectory)
          if (exactSnapshot(backup, preview.currentHash, preview.currentHash)) {
            if (current && !exactSnapshot(current, preview.currentHash, preview.currentHash)) {
              throw new EvaluationError('Removal Skill package changed before automatic recovery.', 409)
            }
            if (!current) {
              await copyExactPackage(backupDirectory, targetDirectory, preview.currentHash, recovery, parentIdentity, {
                absent: true,
                message: 'Removal Skill package changed before automatic recovery.',
              })
            }
          } else if (!exactSnapshot(current, preview.currentHash, preview.currentHash)) {
            throw new EvaluationError('Removal Skill package changed before automatic recovery.', 409)
          }
          const deleted = await deleteRecovery(recoveryToken, recovery)
          if (deleted) await discardRecoveryFiles(deleted, parentIdentity)
          return {
            applied: false,
            operation: 'remove',
            target: preview.plan.target,
            contentHash: preview.currentHash,
            backup: path.basename(backupDirectory),
            rollback: { restored: true },
            errorCode: 'REMOVAL_VERIFICATION_FAILED',
          }
        }
      }
      if (preview.removal && !preview.referenceOnly) {
        const parentIdentity = await assertInstallParent(preview.targetFile, preview.root, preview.parentIdentity)
        const targetFile = await assertRegularTarget(preview.targetFile)
        assertApprovedParent(parentIdentity, targetFile)
        const currentContents = await readFile(targetFile, 'utf8')
        if (artifactContentHash(currentContents) !== preview.currentHash) throw new EvaluationError('Removal target changed after preview.', 409)
        const currentByteHash = await fileByteHash(targetFile)
        const targetIdentity = await lstat(targetFile)
        const removedTargetKey = await physicalTargetKey(targetFile)
        const backupFile = path.join(path.dirname(targetFile), preview.plan.backup)
        const recoveryToken = await createRecovery({
          operation: 'remove',
          state: 'prepared',
          targetFile,
          managedRoot: preview.root,
          parentIdentity,
          backupFile,
          forwardBackupFile: null,
          currentHash: preview.currentHash,
          candidateHash: null,
          byteHash: currentByteHash,
          capabilityId: releaseCapabilityId,
          targetSkeleton,
        })
        try {
          const recovery = await readRecovery(recoveryToken)
          await quarantineExactTarget(
            recovery,
            targetFile,
            backupFile,
            preview.currentHash,
            currentByteHash,
            'Removal target changed after preview.',
            parentIdentity,
            targetIdentity,
          )
          const rescanned = await scan(preview.root)
          const visible = await findScannedTarget(rescanned, targetFile, (item) => item.status !== 'missing', [removedTargetKey])
          if (visible || await lstat(targetFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            throw new EvaluationError('Removed artifact remains visible after rescan.', 500)
          }
          await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'removed' }))
          return { applied: true, operation: 'remove', target: preview.plan.target, contentHash: null, backup: path.basename(backupFile), rollback: { restored: false }, recoveryToken }
        } catch (error) {
          if (error instanceof EvaluationError && error.status === 409) throw error
          const recovery = await readRecovery(recoveryToken)
          const targetSnapshot = await fileSnapshot(targetFile)
          const backupSnapshot = await fileSnapshot(backupFile)
          if (exactSnapshot(backupSnapshot, preview.currentHash, currentByteHash)) {
            if (targetSnapshot && !exactSnapshot(targetSnapshot, preview.currentHash, currentByteHash)) {
              throw new EvaluationError('Removal target changed before automatic recovery.', 409)
            }
            if (!targetSnapshot) {
              await copyExact(backupFile, targetFile, preview.currentHash, currentByteHash, recovery, parentIdentity, {
                absent: true,
                message: 'Removal target changed before automatic recovery.',
              })
            }
          } else if (!exactSnapshot(targetSnapshot, preview.currentHash, currentByteHash)) {
            throw new EvaluationError('Removal target changed before automatic recovery.', 409)
          }
          const deleted = await deleteRecovery(recoveryToken, recovery)
          if (deleted) await discardRecoveryFiles(deleted, parentIdentity)
          return { applied: false, operation: 'remove', target: preview.plan.target, contentHash: preview.currentHash, backup: path.basename(backupFile), rollback: { restored: true }, errorCode: 'REMOVAL_VERIFICATION_FAILED' }
        }
      }
      if (preview.package) {
        const targetDirectory = preview.promotionTarget
        const parentIdentity = await assertInstallParent(targetDirectory, preview.root, preview.parentIdentity)
        const before = await packageSnapshot(targetDirectory)
        if (!exactSnapshot(before, preview.currentHash, preview.currentHash)) {
          throw new EvaluationError('Skill package changed after preview.', 409)
        }
        if (preview.currentHash === preview.plan.candidateHash) {
          const rescanned = await scan(preview.root)
          const record = await findScannedTarget(rescanned, preview.targetFile, activeScanRecord)
          if (!record || record.contentHash !== preview.currentHash) throw new EvaluationError('Current Skill package failed verification scan.', 500)
          return {
            applied: true,
            unchanged: true,
            target: preview.plan.target,
            contentHash: preview.currentHash,
            packageFileCount: before.fileCount,
            backup: null,
            rollback: { restored: false },
          }
        }
        const targetIdentity = await lstat(targetDirectory)
        const backupDirectory = path.join(path.dirname(targetDirectory), preview.plan.backup)
        const temporary = `${targetDirectory}.${process.pid}.${randomUUID()}.tmp`
        let recoveryToken
        let promotedIdentity = null
        try {
          recoveryToken = await createRecovery({
            operation: 'replace',
            state: 'prepared',
            targetFile: targetDirectory,
            managedRoot: preview.root,
            parentIdentity,
            backupFile: backupDirectory,
            forwardBackupFile: null,
            currentHash: preview.currentHash,
            candidateHash: preview.plan.candidateHash,
            byteHash: preview.currentHash,
            candidateByteHash: preview.plan.candidateHash,
            capabilityId: releaseCapabilityId,
            targetSkeleton,
            definitionFile: preview.targetFile,
            package: true,
          })
          const staged = await writePackage(temporary, preview.packageFiles, preview.root, parentIdentity)
          const recovery = await readRecovery(recoveryToken)
          await quarantineExactPackage(
            recovery,
            targetDirectory,
            backupDirectory,
            preview.currentHash,
            'Promotion Skill package changed after preview.',
            parentIdentity,
            targetIdentity,
          )
          if (await lstat(targetDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            throw new EvaluationError('Promotion Skill package target changed during replacement.', 409)
          }
          await rename(temporary, targetDirectory)
          promotedIdentity = await lstat(targetDirectory)
          if (promotedIdentity.dev !== staged.directoryIdentity.dev || promotedIdentity.ino !== staged.directoryIdentity.ino) {
            throw new EvaluationError('Promoted Skill package changed during replacement.', 500)
          }
          const written = await packageSnapshot(targetDirectory)
          const rescanned = await scan(preview.root)
          const record = await findScannedTarget(rescanned, preview.targetFile, activeScanRecord)
          if (!record || !exactSnapshot(written, preview.plan.candidateHash, preview.plan.candidateHash)
            || record.contentHash !== preview.plan.candidateHash) {
            throw new EvaluationError('Promoted Skill package failed post-write verification.', 500)
          }
          await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'applied' }))
          return {
            applied: true,
            target: preview.plan.target,
            contentHash: preview.plan.candidateHash,
            packageFileCount: written.fileCount,
            backup: path.basename(backupDirectory),
            rollback: { restored: false },
            recoveryToken,
          }
        } catch (error) {
          if (error instanceof EvaluationError && error.status === 409) throw error
          if (recoveryToken) {
            const recovery = await readRecovery(recoveryToken)
            const current = await packageSnapshot(targetDirectory)
            const backup = await packageSnapshot(backupDirectory)
            if (exactSnapshot(backup, preview.currentHash, preview.currentHash)) {
              if (current && !exactSnapshot(current, preview.plan.candidateHash, preview.plan.candidateHash)
                && !exactSnapshot(current, preview.currentHash, preview.currentHash)) {
                throw new EvaluationError('Promotion Skill package changed before automatic recovery.', 409)
              }
              if (!exactSnapshot(current, preview.currentHash, preview.currentHash)) {
                await copyExactPackage(
                  backupDirectory,
                  targetDirectory,
                  preview.currentHash,
                  recovery,
                  parentIdentity,
                  current
                    ? {
                        identity: promotedIdentity,
                        contentHash: preview.plan.candidateHash,
                        message: 'Promotion Skill package changed before automatic recovery.',
                      }
                    : { absent: true, message: 'Promotion Skill package changed before automatic recovery.' },
                )
              }
            } else if (!exactSnapshot(current, preview.currentHash, preview.currentHash)) {
              throw new EvaluationError('Promotion Skill package changed before automatic recovery.', 409)
            }
            const deleted = await deleteRecovery(recoveryToken, recovery)
            if (deleted) await discardRecoveryFiles(deleted, parentIdentity)
          }
          return {
            applied: false,
            target: preview.plan.target,
            contentHash: preview.currentHash,
            backup: path.basename(backupDirectory),
            rollback: { restored: true },
            errorCode: 'PROMOTION_VERIFICATION_FAILED',
          }
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      if (preview.referenceOnly) return { applied: true, target: preview.plan.target, contentHash: preview.plan.candidateHash, backup: null, rollback: { restored: false }, referenceOnly: true }
      const parentIdentity = await assertInstallParent(preview.targetFile, preview.root, preview.parentIdentity)
      const targetFile = await assertRegularTarget(preview.targetFile)
      assertApprovedParent(parentIdentity, targetFile)
      const currentContents = await readFile(targetFile, 'utf8')
      if (artifactContentHash(currentContents) !== preview.currentHash) throw new EvaluationError('Target skeleton changed after preview.', 409)
      if (preview.currentHash === preview.plan.candidateHash) {
        const rescanned = await scan(preview.root)
        await assertInstallParent(targetFile, preview.root, parentIdentity)
        assertApprovedParent(parentIdentity, await realpath(targetFile))
        const record = await findScannedTarget(rescanned, targetFile, activeScanRecord)
        if (!record
          || artifactContentHash(await readFile(targetFile, 'utf8')) !== preview.currentHash
          || (record.contentHash && record.contentHash !== preview.currentHash)) {
          throw new EvaluationError('Current artifact failed verification scan.', 500)
        }
        return { applied: true, unchanged: true, target: preview.plan.target, contentHash: preview.currentHash, backup: null, rollback: { restored: false } }
      }
      const currentByteHash = await fileByteHash(targetFile)
      const targetIdentity = await lstat(targetFile)
      const backupFile = path.join(path.dirname(targetFile), preview.plan.backup)
      const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`
      const candidateByteHash = createHash('sha256').update(Buffer.from(preview.candidateContents, 'utf8')).digest('hex')
      let recoveryToken
      let promotedIdentity = null
      try {
        recoveryToken = await createRecovery({
          operation: 'replace',
          state: 'prepared',
          targetFile,
          managedRoot: preview.root,
          parentIdentity,
          backupFile,
          forwardBackupFile: null,
          currentHash: preview.currentHash,
          candidateHash: preview.plan.candidateHash,
          byteHash: currentByteHash,
          candidateByteHash,
          capabilityId: releaseCapabilityId,
          targetSkeleton,
        })
        await writeManagedTemporary(temporary, preview.candidateContents, preview.root, parentIdentity)
        const temporaryIdentity = await lstat(temporary)
        if (!exactSnapshot(await fileSnapshot(temporary), preview.plan.candidateHash, candidateByteHash)) {
          throw new EvaluationError('Candidate temporary file failed verification.', 500)
        }
        const recovery = await readRecovery(recoveryToken)
        await quarantineExactTarget(
          recovery,
          targetFile,
          backupFile,
          preview.currentHash,
          currentByteHash,
          'Promotion target changed after preview.',
          parentIdentity,
          targetIdentity,
        )
        await assertInstallParent(targetFile, preview.root, parentIdentity)
        try {
          await link(temporary, targetFile)
        } catch (error) {
          if (error?.code === 'EEXIST') throw new EvaluationError('Promotion target changed during atomic replacement.', 409)
          throw error
        }
        promotedIdentity = await lstat(targetFile)
        if (promotedIdentity.dev !== temporaryIdentity.dev || promotedIdentity.ino !== temporaryIdentity.ino) {
          throw new EvaluationError('Promotion target changed during atomic replacement.', 500)
        }
        await assertInstallParent(targetFile, preview.root, parentIdentity)
        assertApprovedParent(parentIdentity, await realpath(targetFile))
        const rescanned = await scan(preview.root)
        await assertInstallParent(targetFile, preview.root, parentIdentity)
        assertApprovedParent(parentIdentity, await realpath(targetFile))
        const record = await findScannedTarget(rescanned, targetFile, activeScanRecord)
        const writtenHash = artifactContentHash(await readFile(targetFile, 'utf8'))
        if (!record) throw new EvaluationError('Promoted artifact was not found by the post-write scan.', 500)
        if (writtenHash !== preview.plan.candidateHash || (record.contentHash && record.contentHash !== writtenHash)) {
          throw new EvaluationError('Promoted artifact hash verification failed.', 500)
        }
        await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'applied', candidateHash: writtenHash, candidateByteHash }))
        return { applied: true, target: preview.plan.target, contentHash: writtenHash, backup: path.basename(backupFile), rollback: { restored: false }, recoveryToken }
      } catch (error) {
        if (error instanceof EvaluationError && error.status === 409) throw error
        if (recoveryToken) {
          const recovery = await readRecovery(recoveryToken)
          const targetSnapshot = await fileSnapshot(targetFile)
          const backupSnapshot = await fileSnapshot(backupFile)
          if (exactSnapshot(backupSnapshot, preview.currentHash, currentByteHash)) {
            if (targetSnapshot && !exactSnapshot(targetSnapshot, preview.plan.candidateHash, candidateByteHash)
              && !exactSnapshot(targetSnapshot, preview.currentHash, currentByteHash)) {
              throw new EvaluationError('Promotion target changed before automatic recovery.', 409)
            }
            if (!exactSnapshot(targetSnapshot, preview.currentHash, currentByteHash)) {
              await copyExact(
                backupFile,
                targetFile,
                preview.currentHash,
                currentByteHash,
                recovery,
                parentIdentity,
                targetSnapshot
                  ? {
                      identity: promotedIdentity,
                      contentHash: preview.plan.candidateHash,
                      byteHash: candidateByteHash,
                      message: 'Promotion target changed before automatic recovery.',
                    }
                  : { absent: true, message: 'Promotion target changed before automatic recovery.' },
              )
            }
          } else if (!exactSnapshot(targetSnapshot, preview.currentHash, currentByteHash)) {
            throw new EvaluationError('Promotion target changed before automatic recovery.', 409)
          }
          const deleted = await deleteRecovery(recoveryToken, recovery)
          if (deleted) await discardRecoveryFiles(deleted, parentIdentity)
        }
        return { applied: false, target: preview.plan.target, contentHash: preview.currentHash, backup: path.basename(backupFile), rollback: { restored: true }, errorCode: 'PROMOTION_VERIFICATION_FAILED' }
      } finally {
        await rm(temporary, { force: true })
      }
    },
    async commitRecovery(recoveryToken) {
      if (!recoveryToken) return
      const recovery = await withRecoveryStore(() => {
        const current = recoveries.get(recoveryToken)
        return current ? structuredClone(current) : null
      })
      if (!recovery) return
      const parentIdentity = await assertRecoveryParent(recovery)
      const deleted = await deleteRecovery(recoveryToken, recovery)
      if (deleted) await discardRecoveryFiles(deleted, parentIdentity)
    },
    async revert(recoveryToken) {
      if (!recoveryToken) return { restored: false }
      const recovery = await readRecovery(recoveryToken)
      const parentIdentity = await assertRecoveryParent(recovery)
      if (recovery.state === 'restored') {
        const targetFile = recovery.package ? await realpath(recovery.targetFile) : await assertRegularTarget(recovery.targetFile)
        assertApprovedParent(parentIdentity, targetFile)
        const targetIdentity = await lstat(targetFile)
        if (!exactSnapshot(await recoverySnapshot(recovery), recovery.currentHash, recovery.byteHash)) {
          throw new EvaluationError('Restored target changed before recovery.', 409)
        }
        if (!recovery.forwardBackupFile) {
          if (recovery.operation !== 'remove') throw new EvaluationError('Release recovery state is invalid.', 500)
          await removeRecoveryTarget(recovery, recovery.currentHash, recovery.byteHash, 'Restored target changed before recovery.')
          await updateRecovery(recoveryToken, (current) => ({ ...current, state: 'removed', forwardBackupFile: null, forwardHash: null, forwardByteHash: null }))
          return { restored: true }
        }
        await copyRecovery(
          recovery.forwardBackupFile,
          recovery.targetFile,
          recovery.forwardHash,
          recovery.forwardByteHash,
          recovery,
          parentIdentity,
          {
            identity: targetIdentity,
            contentHash: recovery.currentHash,
            byteHash: recovery.byteHash,
            message: 'Restored target changed before recovery.',
          },
        )
        await removeRecoveryPath(
          recovery,
          recovery.forwardBackupFile,
          recovery.forwardHash,
          recovery.forwardByteHash,
          'Restoration forward backup changed before cleanup.',
          parentIdentity,
        )
        await updateRecovery(recoveryToken, (current) => ({
          ...current,
          state: recovery.operation === 'remove' ? 'removed' : 'applied',
          forwardBackupFile: null,
          forwardHash: null,
          forwardByteHash: null,
        }))
        return { restored: true }
      }
      if (recovery.operation === 'install') {
        if (recovery.package) await removeExactPackage(recovery, recovery.candidateHash, 'Installed Skill package changed before recovery.')
        else await removeExactTarget(recovery, recovery.candidateHash, recovery.candidateByteHash, 'Installed target changed before recovery.')
        await deleteRecovery(recoveryToken, recovery)
        return { restored: true }
      }
      let expectedTarget = { absent: true, message: 'Removed target was recreated before recovery.' }
      if (recovery.operation === 'remove') {
        if (recovery.state !== 'removed') throw new EvaluationError('Release recovery state is invalid.', 500)
        if (await lstat(recovery.targetFile).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
          throw new EvaluationError('Removed target was recreated before recovery.', 409)
        }
      } else {
        if (recovery.state !== 'applied') throw new EvaluationError('Release recovery state is invalid.', 500)
        const targetFile = recovery.package ? await realpath(recovery.targetFile) : await assertRegularTarget(recovery.targetFile)
        assertApprovedParent(parentIdentity, targetFile)
        const targetSnapshot = await recoverySnapshot(recovery)
        if (!exactSnapshot(targetSnapshot, recovery.candidateHash, recovery.candidateByteHash)) {
          throw new EvaluationError('Release target changed before recovery.', 409)
        }
        expectedTarget = {
          identity: await lstat(targetFile),
          contentHash: recovery.candidateHash,
          byteHash: recovery.candidateByteHash,
          message: 'Release target changed before recovery.',
        }
      }
      if (recovery.package) {
        await copyExactPackage(recovery.backupFile, recovery.targetFile, recovery.currentHash, recovery, parentIdentity, expectedTarget)
      } else {
        await copyExact(recovery.backupFile, recovery.targetFile, recovery.currentHash, recovery.byteHash, recovery, parentIdentity, expectedTarget)
      }
      const deleted = await deleteRecovery(recoveryToken, recovery)
      if (deleted) await discardRecoveryFiles(deleted, parentIdentity)
      return { restored: true }
    },
  }
}
