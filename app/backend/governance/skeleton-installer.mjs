import { randomUUID } from 'node:crypto'
import { copyFile, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createArtifactResolver } from '../evaluations/artifact-resolver.mjs'
import { artifactContentHash, normalizeArtifactContent } from '../evaluations/artifact-definition.mjs'
import { installedDefinitions } from '../evaluations/candidate-source.mjs'
import { EvaluationError } from '../evaluations/errors.mjs'
import { scanInstalledSkills } from '../skill-scanner.mjs'

function diffSummary(current, candidate) {
  const before = normalizeArtifactContent(current).split('\n')
  const after = normalizeArtifactContent(candidate).split('\n')
  let changed = 0
  const length = Math.max(before.length, after.length)
  for (let index = 0; index < length; index += 1) if (before[index] !== after[index]) changed += 1
  return { beforeLines: before.length, afterLines: after.length, changedLines: changed }
}

export function createSkeletonInstaller(options = {}) {
  const artifacts = options.artifacts || createArtifactResolver(options)
  const scan = options.scanInstalledSkills || (() => scanInstalledSkills(options))
  const previews = new Map()

  async function resolveTarget(targetSkeleton) {
    if (typeof options.resolveTarget === 'function') return path.resolve(await options.resolveTarget(targetSkeleton))
    const target = (await installedDefinitions(options)).find((item) => item.artifact?.sourceRef === targetSkeleton)
    if (!target) throw new EvaluationError('Target skeleton is not in the enabled scanned inventory.', 404)
    return path.resolve(target.sourcePath)
  }

  async function assertRegularTarget(targetFile) {
    const info = await lstat(targetFile).catch((error) => {
      if (error?.code === 'ENOENT') throw new EvaluationError('Target skeleton file was not found.', 404)
      throw error
    })
    if (!info.isFile() || info.isSymbolicLink()) throw new EvaluationError('Target skeleton must be a regular non-symlink file.', 422)
    return realpath(targetFile)
  }

  return {
    async preview(capability, context = {}) {
      if (capability.artifact.kind === 'prompt' && capability.artifact.source === 'prompt-registry') {
        if (!context.skipReferenceVerification) {
          const source = await artifacts.resolve(capability.artifact.sourceRef, context)
          if (source.artifact.contentHash !== capability.artifact.contentHash) throw new EvaluationError('Candidate content changed before promotion.', 409)
        }
        const token = randomUUID()
        const expiresAt = Date.now() + 10 * 60_000
        const plan = {
          previewToken: token,
          capabilityId: capability.id,
          source: capability.artifact.sourceRef,
          target: capability.targetSkeleton,
          currentHash: capability.baseline?.contentHash || null,
          candidateHash: capability.artifact.contentHash,
          diff: { beforeLines: 0, afterLines: 0, changedLines: capability.baseline?.contentHash === capability.artifact.contentHash ? 0 : 1 },
          conflict: false,
          backup: 'not-applicable-reference-lock',
          rollbackPlan: 'Restore the previous immutable local Prompt reference from project-skeleton.lock.json.',
          expiresAt: new Date(expiresAt).toISOString(),
        }
        previews.set(token, { plan, referenceOnly: true, expiresAt })
        return plan
      }
      const source = await artifacts.resolve(capability.artifact.sourceRef, context)
      if (source.artifact.contentHash !== capability.artifact.contentHash) throw new EvaluationError('Candidate content changed before promotion.', 409)
      const targetFile = await assertRegularTarget(await resolveTarget(capability.targetSkeleton))
      const currentContents = await readFile(targetFile, 'utf8')
      const candidateContents = normalizeArtifactContent(source.contents)
      if (artifactContentHash(candidateContents) !== capability.artifact.contentHash) throw new EvaluationError('Candidate content hash verification failed.', 409)
      const currentHash = artifactContentHash(currentContents)
      const token = randomUUID()
      const expiresAt = Date.now() + 10 * 60_000
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const alreadyCurrent = currentHash === capability.artifact.contentHash
      const plan = {
        previewToken: token,
        capabilityId: capability.id,
        source: capability.artifact.sourceRef,
        target: capability.targetSkeleton,
        currentHash,
        candidateHash: capability.artifact.contentHash,
        diff: diffSummary(currentContents, candidateContents),
        conflict: Boolean(capability.baseline && capability.baseline.contentHash !== currentHash),
        backup: alreadyCurrent ? 'not-required-current-content' : `${path.basename(targetFile)}.skillops-backup-${timestamp}`,
        rollbackPlan: alreadyCurrent ? 'No file write is required because the target already has the candidate content.' : 'Restore the timestamped backup atomically if verification fails.',
        expiresAt: new Date(expiresAt).toISOString(),
      }
      previews.set(token, { plan, targetFile, currentHash, candidateContents, expiresAt })
      return plan
    },
    async apply(previewToken, { confirm = false } = {}) {
      if (!confirm) throw new EvaluationError('Explicit promotion confirmation is required.', 422)
      const preview = previews.get(previewToken)
      if (!preview || preview.expiresAt < Date.now()) throw new EvaluationError('Promotion preview is missing or expired.', 409)
      previews.delete(previewToken)
      if (preview.referenceOnly) return { applied: true, target: preview.plan.target, contentHash: preview.plan.candidateHash, backup: null, rollback: { restored: false }, referenceOnly: true }
      const targetFile = await assertRegularTarget(preview.targetFile)
      const currentContents = await readFile(targetFile, 'utf8')
      if (artifactContentHash(currentContents) !== preview.currentHash) throw new EvaluationError('Target skeleton changed after preview.', 409)
      if (preview.currentHash === preview.plan.candidateHash) {
        const rescanned = await scan()
        const record = rescanned.find((item) => path.resolve(item.sourcePath) === targetFile)
        if (!record) throw new EvaluationError('Current artifact was not found by the verification scan.', 500)
        return { applied: true, unchanged: true, target: preview.plan.target, contentHash: preview.currentHash, backup: null, rollback: { restored: false } }
      }
      const backupFile = path.join(path.dirname(targetFile), preview.plan.backup)
      const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`
      await copyFile(targetFile, backupFile)
      try {
        await writeFile(temporary, preview.candidateContents, 'utf8')
        await rename(temporary, targetFile)
        const writtenHash = artifactContentHash(await readFile(targetFile, 'utf8'))
        const rescanned = await scan()
        const record = rescanned.find((item) => path.resolve(item.sourcePath) === targetFile)
        if (!record) throw new EvaluationError('Promoted artifact was not found by the post-write scan.', 500)
        if (writtenHash !== preview.plan.candidateHash) throw new EvaluationError('Promoted artifact hash verification failed.', 500)
        return { applied: true, target: preview.plan.target, contentHash: writtenHash, backup: path.basename(backupFile), rollback: { restored: false } }
      } catch {
        const restore = `${targetFile}.${process.pid}.${randomUUID()}.restore.tmp`
        try {
          await copyFile(backupFile, restore)
          await rename(restore, targetFile)
          return { applied: false, target: preview.plan.target, contentHash: preview.currentHash, backup: path.basename(backupFile), rollback: { restored: true }, errorCode: 'PROMOTION_VERIFICATION_FAILED' }
        } finally {
          await rm(restore, { force: true })
        }
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}
