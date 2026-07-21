import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EvaluationError } from '../evaluations/errors.mjs'

function deployment(capability, channel) {
  const approvedBy = capability.approvals.filter((item) => item.decision === 'approved' && item.evidenceHash === capability.evidence?.evidenceHash).map((item) => item.reviewer)
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

export function createSkeletonLock(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const file = path.join(dataDir, 'project-skeleton.lock.json')
  const lockFile = path.join(dataDir, 'project-skeleton.lock')
  let queue = Promise.resolve()

  async function read() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed?.schemaVersion !== 1 || !parsed.targets || typeof parsed.targets !== 'object' || Array.isArray(parsed.targets)) throw new Error('schema')
      return parsed
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, updatedAt: null, targets: {} }
      throw new EvaluationError('Project skeleton lock is invalid.', 500)
    }
  }

  async function withLock(operation) {
    await mkdir(dataDir, { recursive: true })
    let handle
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lockFile, 'wx'); break } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const info = await stat(lockFile).catch(() => null)
        if (info && Date.now() - info.mtimeMs > 30_000) await rm(lockFile, { force: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!handle) throw new EvaluationError('Timed out waiting for the project skeleton lock.', 503)
    try { return await operation() } finally { await handle.close(); await rm(lockFile, { force: true }) }
  }

  function mutate(operation) {
    const pending = queue.then(() => withLock(async () => {
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
    setCanary(targetSkeleton, capability) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton] || { stable: null, canary: null, previous: [] }
        target.canary = deployment(capability, 'canary')
        state.targets[targetSkeleton] = target
        return target
      })
    },
    promoteStable(targetSkeleton, capability) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton] || { stable: null, canary: null, previous: [] }
        if (!target.canary || target.canary.capabilityId !== capability.id || target.canary.evidenceHash !== capability.evidence?.evidenceHash) {
          throw new EvaluationError('The current Canary lock does not match this capability evidence.', 409)
        }
        if (target.stable) target.previous = [target.stable, ...(target.previous || [])].slice(0, 20)
        target.stable = deployment(capability, 'stable')
        target.canary = null
        state.targets[targetSkeleton] = target
        return target
      })
    },
    rollback(targetSkeleton) {
      return mutate((state) => {
        const target = state.targets[targetSkeleton]
        if (!target?.stable || !Array.isArray(target.previous) || !target.previous.length) throw new EvaluationError('No previous immutable Stable version is available for rollback.', 409)
        const rolledBack = target.stable
        target.stable = { ...target.previous.shift(), channel: 'stable', promotedAt: new Date().toISOString() }
        target.canary = null
        return { target, rolledBack, restored: target.stable }
      })
    },
  }
}
