import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { EvaluationError } from '../evaluations/errors.mjs'

function deployment(capability, channel, allowLegacyApproval = false) {
  const approvedBy = capability.approvals.filter((item) => item.decision === 'approved'
    && item.evidenceHash === capability.evidence?.evidenceHash
    && (allowLegacyApproval || (typeof item.identityAssurance === 'string'
      && item.identityAssurance !== 'unverified-legacy'))).map((item) => item.reviewer)
  return {
    capabilityId: capability.id,
    artifact: capability.artifact,
    evaluationRunId: capability.evidence.qualityRunId,
    evidenceHash: capability.evidence.evidenceHash,
    approvedBy,
    channel,
    promotedAt: new Date().toISOString(),
  }
}
function retainedRecovery(deployment, recoveryToken) {
  if (!recoveryToken) return deployment
  if (typeof recoveryToken !== 'string' || !/^[a-f0-9-]{36}$/.test(recoveryToken)) throw new EvaluationError('Release recovery token is invalid.', 500)
  return { ...deployment, restoreToken: recoveryToken }
}
function observedCanary(capability, observation) {
  if (!observation || typeof observation !== 'object'
    || typeof observation.targetSkeleton !== 'string' || !observation.targetSkeleton.trim()
    || typeof observation.projectRoot !== 'string' || !path.isAbsolute(observation.projectRoot)
    || observation.observedContentHash !== capability.artifact.contentHash
    || Number.isNaN(Date.parse(observation.observedAt))) {
    throw new EvaluationError('Canary deployment observation is invalid.', 500)
  }
  return retainedRecovery({
    ...deployment(capability, 'canary'),
    targetSkeleton: observation.targetSkeleton,
    projectRoot: observation.projectRoot,
    observedContentHash: observation.observedContentHash,
    observedAt: observation.observedAt,
  }, observation.recoveryToken)
}


function restoredDeployment(value, capability) {
  if (capability) return deployment(capability, 'stable')
  const { restoreToken, ...restored } = value
  return { ...restored, channel: 'stable', promotedAt: new Date().toISOString() }
}
function persistedEqual(left, right) {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(left ?? null)),
    JSON.parse(JSON.stringify(right ?? null)),
  )
}
function targetMap(value = {}) {
  return Object.assign(Object.create(null), value)
}
function validDeployment(value, channel) {
  return value
    && typeof value === 'object'
    && value.channel === channel
    && typeof value.capabilityId === 'string'
    && value.artifact
    && typeof value.artifact === 'object'
    && /^[a-f0-9]{64}$/.test(value.artifact.contentHash)
    && typeof value.evaluationRunId === 'string'
    && /^[a-f0-9]{64}$/.test(value.evidenceHash)
    && Array.isArray(value.approvedBy)
    && value.approvedBy.every((reviewer) => typeof reviewer === 'string')
    && !Number.isNaN(Date.parse(value.promotedAt))
    && (value.restoreToken === undefined || /^[a-f0-9-]{36}$/.test(value.restoreToken))
    && (channel !== 'canary'
      || value.targetSkeleton === undefined && value.observedContentHash === undefined && value.observedAt === undefined
      || typeof value.targetSkeleton === 'string' && Boolean(value.targetSkeleton.trim())
        && (value.projectRoot === undefined || typeof value.projectRoot === 'string' && path.isAbsolute(value.projectRoot))
        && /^[a-f0-9]{64}$/.test(value.observedContentHash)
        && !Number.isNaN(Date.parse(value.observedAt)))
}

function validTargets(targets) {
  return Object.values(targets).every((target) => target
    && typeof target === 'object'
    && !Array.isArray(target)
    && (target.stable === null || validDeployment(target.stable, 'stable'))
    && (target.canary === null || validDeployment(target.canary, 'canary'))
    && Array.isArray(target.previous)
    && target.previous.length <= 20
    && target.previous.every((item) => validDeployment(item, 'stable')))
}
async function lockIsAbandoned(filePath) {
  try {
    const owner = JSON.parse(await readFile(filePath, 'utf8'))
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('owner')
    if (owner.pid === process.pid) return false
    try {
      process.kill(owner.pid, 0)
      return false
    } catch (error) {
      if (error?.code === 'ESRCH') return true
      if (error?.code === 'EPERM') return false
      throw error
    }
  } catch {
    const info = await stat(filePath).catch(() => null)
    return Boolean(info && Date.now() - info.mtimeMs > 30_000)
  }
}

async function removeAbandonedLock(filePath) {
  const reaperFile = `${filePath}.reap`
  let reaper
  try {
    reaper = await open(reaperFile, 'wx')
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const info = await stat(reaperFile).catch(() => null)
    if (info && Date.now() - info.mtimeMs > 30_000) await rm(reaperFile, { force: true })
    return
  }
  try {
    const snapshot = await readFile(filePath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (snapshot !== null && await lockIsAbandoned(filePath)) {
      const current = await readFile(filePath, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (current === snapshot) await rm(filePath, { force: true })
    }
  } finally {
    await reaper.close()
    await rm(reaperFile, { force: true })
  }
}

async function removeOwnedLock(filePath, owner, heldInfo) {
  let contents
  try { contents = await readFile(filePath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  try {
    if (JSON.parse(contents)?.token === owner.token) await rm(filePath, { force: true })
    return
  } catch {
    const current = await stat(filePath, { bigint: true }).catch(() => null)
    if (heldInfo && current && heldInfo.dev === current.dev && heldInfo.ino === current.ino) {
      await rm(filePath, { force: true })
    }
  }
}

export async function withGovernanceFileLock(filePath, operation, attempts = 100, label = 'governance file') {
  await mkdir(path.dirname(filePath), { recursive: true })
  const owner = { pid: process.pid, token: randomUUID() }
  let handle
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      handle = await open(filePath, 'wx')
      await handle.writeFile(JSON.stringify(owner), 'utf8')
      await handle.sync()
      break
    } catch (error) {
      if (handle) {
        const heldInfo = await handle.stat({ bigint: true }).catch(() => null)
        await handle.close().catch(() => undefined)
        handle = undefined
        await removeOwnedLock(filePath, owner, heldInfo)
      }
      const lockContention = error?.code === 'EEXIST' || (
        process.platform === 'win32' && error?.code === 'EPERM' &&
        await stat(filePath).then((info) => info.isFile(), () => false)
      )
      if (!lockContention) throw error
      await removeAbandonedLock(filePath)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (!handle) throw new EvaluationError(`Timed out waiting for the ${label} lock.`, 503)
  const heartbeat = setInterval(() => handle.utimes(new Date(), new Date()).catch(() => undefined), 5_000)
  heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    const heldInfo = await handle.stat({ bigint: true }).catch(() => null)
    await handle.close()
    await removeOwnedLock(filePath, owner, heldInfo)
  }
}






export function createSkeletonLock(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const file = path.join(dataDir, 'project-skeleton.lock.json')
  const lockFile = path.join(dataDir, 'project-skeleton.lock')
  const releaseLockFile = path.join(dataDir, 'governance-release.lock')
  let queue = Promise.resolve()
  let releaseQueue = Promise.resolve()

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed?.schemaVersion !== 1
        || !parsed.targets
        || typeof parsed.targets !== 'object'
        || Array.isArray(parsed.targets)
        || !validTargets(parsed.targets)) throw new Error('schema')
      return { ...parsed, targets: targetMap(parsed.targets) }
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, updatedAt: null, targets: targetMap() }
      throw new EvaluationError('Project skeleton lock is invalid.', 500)
    }
  }


  function mutate(operation) {
    const pending = queue.then(() => withGovernanceFileLock(lockFile, async () => {
      const state = await read()
      const result = await operation(state)
      state.updatedAt = new Date().toISOString()
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
      return result
    }))
    queue = pending.catch(() => undefined)
    return pending
  }

  return {
    file,
    read,
    transaction(operation) {
      const pending = releaseQueue.then(() => withGovernanceFileLock(releaseLockFile, operation, 3_000))
      releaseQueue = pending.catch(() => undefined)
      return pending
    },
    restoreTarget(targetSkeleton, expected, replacement) {
      return mutate((state) => {
        const current = state.targets[targetSkeleton] || null
        if (persistedEqual(current, replacement)) return current
        if (!persistedEqual(current, expected)) throw new EvaluationError('The project skeleton lock changed during release recovery.', 409)
        if (replacement) state.targets[targetSkeleton] = structuredClone(replacement)
        else delete state.targets[targetSkeleton]
        return state.targets[targetSkeleton] || null
      })
    },
    replace(snapshot) {
      if (snapshot?.schemaVersion !== 1
        || !snapshot.targets
        || typeof snapshot.targets !== 'object'
        || Array.isArray(snapshot.targets)
        || !validTargets(snapshot.targets)) {
        throw new EvaluationError('Project skeleton lock snapshot is invalid.', 500)
      }
      return mutate((state) => {
        state.schemaVersion = 1
        state.targets = targetMap(structuredClone(snapshot.targets))
        return state
      })
    },
    setCanary(targetSkeleton, capability, observation) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton] || { stable: null, canary: null, previous: [] }
        if (target.canary && target.canary.capabilityId !== capability.id) {
          throw new EvaluationError('Another capability already owns the Canary target.', 409)
        }
        target.canary = observedCanary(capability, observation)
        state.targets[targetSkeleton] = target
        return target
      })
    },
    clearCanary(targetSkeleton, capability) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton]
        if (!target?.canary
          || target.canary.capabilityId !== capability.id
          || target.canary.evidenceHash !== capability.evidence?.evidenceHash) {
          throw new EvaluationError('The current Canary lock does not match this capability evidence.', 409)
        }
        target.canary = null
        state.targets[targetSkeleton] = target
        return target
      })
    },
    restoreCanary(targetSkeleton, capability) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton] || { stable: null, canary: null, previous: [] }
        if (target.canary && target.canary.capabilityId !== capability.id) {
          throw new EvaluationError('Another capability already owns the Canary target.', 409)
        }
        target.canary = deployment(capability, 'canary', true)
        state.targets[targetSkeleton] = target
        return target
      })
    },
    promoteStable(targetSkeleton, capability, recoveryToken) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton] || { stable: null, canary: null, previous: [] }
        if (!target.canary || target.canary.capabilityId !== capability.id || target.canary.evidenceHash !== capability.evidence?.evidenceHash) {
          throw new EvaluationError('The current Canary lock does not match this capability evidence.', 409)
        }
        if (target.stable) target.previous = [retainedRecovery(target.stable, recoveryToken), ...(target.previous || [])].slice(0, 20)
        target.stable = deployment(capability, 'stable')
        target.canary = null
        state.targets[targetSkeleton] = target
        return target
      })
    },
    deprecateStable(targetSkeleton, capability, recoveryToken) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton]
        if (!target?.stable || target.stable.capabilityId !== capability.id || target.stable.evidenceHash !== capability.evidence?.evidenceHash) {
          throw new EvaluationError('The Stable lock does not match this capability evidence.', 409)
        }
        const deprecated = retainedRecovery(target.stable, recoveryToken)
        target.previous = [deprecated, ...(target.previous || [])].slice(0, 20)
        target.stable = null
        target.canary = null
        return { target, deprecated }
      })
    },
    restoreDeprecated(targetSkeleton, capability) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton]
        const previous = target?.previous?.[0]
        if (target?.stable || !previous || previous.capabilityId !== capability.id
          || previous.artifact?.contentHash !== capability.artifact?.contentHash) {
          throw new EvaluationError('The Deprecated lock does not match this capability.', 409)
        }
        target.previous.shift()
        target.stable = restoredDeployment(previous, capability)
        target.canary = null
        return target
      })
    },
    rollback(targetSkeleton, capability) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton]
        if (!target?.stable || !Array.isArray(target.previous) || !target.previous.length) throw new EvaluationError('No previous immutable Stable version is available for rollback.', 409)
        const previous = target.previous[0]
        if (capability && (previous.capabilityId !== capability.id || previous.artifact?.contentHash !== capability.artifact?.contentHash)) {
          throw new EvaluationError('Previous Stable lock does not match the requalified capability.', 409)
        }
        const rolledBack = target.stable
        target.previous.shift()
        target.stable = restoredDeployment(previous, capability)
        target.canary = null
        return { target, rolledBack, restored: target.stable }
      })
    },
  }
}
