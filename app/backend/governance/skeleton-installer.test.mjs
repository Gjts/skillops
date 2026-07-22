import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactContentHash } from '../evaluations/artifact-definition.mjs'
import { artifactPackageHash, readArtifactPackage } from '../evaluations/artifact-package.mjs'
import { createSkeletonInstaller } from './skeleton-installer.mjs'
import { withGovernanceFileLock } from './skeleton-lock.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup({ scanSucceeds = true, sameContents = false, missingObservation = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skillops-skeleton-')))
  temporaryDirectories.push(root)
  const targetFile = path.join(root, 'SKILL.md')
  const candidate = '# Candidate\nSafe instructions.\n'
  const current = sameContents ? candidate : '# Current\n'
  await writeFile(targetFile, current, 'utf8')
  const capability = {
    id: 'cap-1',
    artifact: { kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'github', sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md', contentHash: artifactContentHash(candidate) },
    baseline: { kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'local-scan', sourceRef: 'local-scan:review', contentHash: artifactContentHash(current) },
    targetSkeleton: 'codex:project-review',
  }
  const installerOptions = {
    dataDir: root,
    artifacts: { resolve: async (sourceRef) => {
      if (sourceRef !== capability.artifact.sourceRef) throw new Error('Unexpected source')
      return { artifact: capability.artifact, contents: candidate }
    } },
    resolveTarget: async (target) => {
      if (target !== capability.targetSkeleton) throw new Error('Target is not in the allowlist')
      return targetFile
    },
    scanInstalledSkills: async () => {
      if (!scanSucceeds) return []
      return await readFile(targetFile).then(
        () => [{ sourcePath: targetFile, kind: 'skill', runtime: 'codex' }],
        () => missingObservation ? [{ sourcePath: targetFile, kind: 'skill', runtime: 'codex', status: 'missing', enabled: false }] : [],
      )
    },
  }
  const installer = createSkeletonInstaller(installerOptions)
  return { root, targetFile, current, candidate, capability, installer, installerOptions }
}

function applyInput(preview) {
  return {
    confirm: true,
    capabilityId: preview.capabilityId,
    releaseCapabilityId: preview.releaseCapabilityId,
    purpose: preview.purpose,
    targetSkeleton: preview.target,
    candidateHash: preview.candidateHash,
  }
}

describe('project skeleton installer', () => {
  it('previews before writing, requires confirmation, backs up, writes atomically, and rescans', async () => {
    const { root, targetFile, candidate, capability, installer } = await setup()
    const preview = await installer.preview(capability)
    expect(preview).toEqual(expect.objectContaining({
      source: capability.artifact.sourceRef, target: 'codex:project-review', conflict: false,
      diff: { beforeLines: 2, afterLines: 3, changedLines: 3 },
      rollbackPlan: expect.stringContaining('backup'),
    }))
    expect(await readFile(targetFile, 'utf8')).not.toBe(candidate)
    expect((await readdir(root)).filter((name) => name.includes('backup'))).toEqual([])
    await expect(installer.apply(preview.previewToken)).rejects.toThrow('confirmation')
    const applied = await installer.apply(preview.previewToken, applyInput(preview))
    expect(applied).toEqual(expect.objectContaining({ applied: true, contentHash: capability.artifact.contentHash, rollback: { restored: false } }))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    expect((await readdir(root)).filter((name) => name.includes('backup'))).toHaveLength(1)
  })

  it('does not apply a preview whose target conflicts with the evaluated Stable baseline', async () => {
    const { targetFile, capability, installer } = await setup()
    const drifted = '# External change\n'
    await writeFile(targetFile, drifted, 'utf8')
    const preview = await installer.preview(capability)
    expect(preview.conflict).toBe(true)

    await expect(installer.apply(preview.previewToken, applyInput(preview))).rejects.toThrow('conflicts')
    expect(await readFile(targetFile, 'utf8')).toBe(drifted)
  })

  it('discards backup bytes when a recovery point is explicitly committed', async () => {
    const { root, capability, installer } = await setup()
    const preview = await installer.preview(capability)
    const applied = await installer.apply(preview.previewToken, applyInput(preview))
    expect((await readdir(root)).some((name) => name.includes('backup'))).toBe(true)

    await installer.commitRecovery(applied.recoveryToken)

    expect((await readdir(root)).some((name) => name.includes('backup'))).toBe(false)
  })

  it('automatically restores the backup when post-write verification fails', async () => {
    const { targetFile, current, capability, installer } = await setup({ scanSucceeds: false })
    const preview = await installer.preview(capability)
    const applied = await installer.apply(preview.previewToken, applyInput(preview))
    expect(applied).toEqual(expect.objectContaining({ applied: false, errorCode: 'PROMOTION_VERIFICATION_FAILED', rollback: { restored: true } }))
    expect(await readFile(targetFile, 'utf8')).toBe(current)
  })

  it.each(['promotion', 'removal'])('does not overwrite an external write during %s compensation', async (operation) => {
    const { targetFile, current, capability, installerOptions } = await setup()
    const external = '# External write\n'
    const installer = createSkeletonInstaller({
      ...installerOptions,
      scanInstalledSkills: async () => {
        await writeFile(targetFile, external, 'utf8')
        return [{ sourcePath: targetFile, status: 'active', enabled: true }]
      },
    })
    const selected = operation === 'promotion'
      ? capability
      : { ...capability, artifact: { ...capability.artifact, contentHash: artifactContentHash(current) } }
    const preview = operation === 'promotion'
      ? await installer.preview(selected)
      : await installer.previewRemoval(selected)

    await expect(installer.apply(preview.previewToken, applyInput(preview))).rejects.toThrow('changed before automatic recovery')
    expect(await readFile(targetFile, 'utf8')).toBe(external)
  })

  it('does not rewrite or back up a target that already has the candidate content', async () => {
    const { root, targetFile, candidate, capability, installer } = await setup({ sameContents: true })
    const preview = await installer.preview(capability)
    expect(preview).toEqual(expect.objectContaining({
      diff: expect.objectContaining({ changedLines: 0 }),
      backup: 'not-required-current-content',
      rollbackPlan: expect.stringContaining('No file write'),
    }))
    const before = (await readdir(root)).sort()
    const applied = await installer.apply(preview.previewToken, applyInput(preview))
    expect(applied).toEqual(expect.objectContaining({ applied: true, unchanged: true, backup: null }))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    expect((await readdir(root)).sort()).toEqual(before)
  })

  it('installs and removes new files with compensating recovery', async () => {
    const { targetFile, candidate, capability, installer } = await setup({ missingObservation: true })
    await rm(targetFile)
    const installPreview = await installer.previewInstall(capability)
    const installed = await installer.apply(installPreview.previewToken, applyInput(installPreview))
    expect(installed).toEqual(expect.objectContaining({ applied: true, operation: 'install', contentHash: capability.artifact.contentHash }))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    await installer.revert(installed.recoveryToken)
    await expect(readFile(targetFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(targetFile, candidate, 'utf8')
    const removalPreview = await installer.previewRemoval(capability)
    const removed = await installer.apply(removalPreview.previewToken, applyInput(removalPreview))
    expect(removed).toEqual(expect.objectContaining({ applied: true, operation: 'remove', contentHash: null }))
    await expect(readFile(targetFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await installer.revert(removed.recoveryToken)
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
  })

  it('installs and reverts a complete immutable Skill directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-package-install-'))
    temporaryDirectories.push(root)
    const targetFile = path.join(root, 'skills', 'review', 'SKILL.md')
    const packageFiles = [
      { relativePath: 'SKILL.md', mode: 0o644, contents: '# Review\nUse the checker.\n' },
      { relativePath: 'scripts/check.mjs', mode: 0o755, contents: 'export const check = true\n' },
    ]
    const contentHash = artifactPackageHash(packageFiles)
    const capability = {
      id: 'cap-package',
      artifact: {
        kind: 'skill',
        artifactId: 'review',
        version: '2.0.0',
        source: 'git',
        sourceRef: `git:v1:${'a'.repeat(64)}:${'b'.repeat(40)}:skills%2Freview%2FSKILL.md:${contentHash}`,
        contentHash,
      },
      targetSkeleton: 'skills/review/SKILL.md',
    }
    const installerOptions = {
      dataDir: path.join(root, 'data'),
      artifacts: { resolve: async () => ({
        artifact: capability.artifact,
        contents: packageFiles[0].contents,
        packageFiles,
      }) },
      resolveTarget: async () => targetFile,
      scanInstalledSkills: async () => readFile(targetFile).then(
        async () => [{
          sourcePath: targetFile,
          kind: 'skill',
          runtime: 'codex',
          status: 'active',
          contentHash: (await readArtifactPackage(path.dirname(targetFile))).contentHash,
        }],
        () => [],
      ),
    }
    const installer = createSkeletonInstaller(installerOptions)

    const preview = await installer.previewInstall(capability)
    const installed = await installer.apply(preview.previewToken, applyInput(preview))
    expect(installed).toEqual(expect.objectContaining({ applied: true, contentHash, packageFileCount: 2 }))
    expect(await readFile(path.join(root, 'skills/review/scripts/check.mjs'), 'utf8')).toContain('check = true')

    await installer.revert(installed.recoveryToken)
    await expect(readFile(targetFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(root, 'skills/review/scripts/check.mjs'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const previousFiles = [
      { relativePath: 'SKILL.md', mode: 0o644, contents: '# Review\nUse the old checker.\n' },
      { relativePath: 'references/old.md', mode: 0o644, contents: '# Old reference\n' },
      { relativePath: 'scripts/check.mjs', mode: 0o644, contents: 'export const check = false\n' },
    ]
    await mkdir(path.join(root, 'skills/review/references'), { recursive: true })
    await mkdir(path.join(root, 'skills/review/scripts'), { recursive: true })
    for (const file of previousFiles) {
      await writeFile(path.join(root, 'skills/review', ...file.relativePath.split('/')), file.contents)
    }
    const previousHash = artifactPackageHash(previousFiles)
    const promotion = {
      ...capability,
      baseline: { ...capability.artifact, version: '1.0.0', contentHash: previousHash },
    }
    const promotionPreview = await installer.preview(promotion)
    const promoted = await installer.apply(promotionPreview.previewToken, applyInput(promotionPreview))
    expect(promoted).toEqual(expect.objectContaining({ applied: true, contentHash }))
    await expect(readFile(path.join(root, 'skills/review/references/old.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await installer.revert(promoted.recoveryToken)
    expect(await readFile(path.join(root, 'skills/review/scripts/check.mjs'), 'utf8')).toContain('check = false')
    expect(await readFile(path.join(root, 'skills/review/references/old.md'), 'utf8')).toContain('Old reference')

    const removal = {
      ...capability,
      artifact: { ...capability.artifact, version: '1.0.0', contentHash: previousHash },
    }
    const removalPreview = await installer.previewRemoval(removal)
    const removed = await installer.apply(removalPreview.previewToken, applyInput(removalPreview))
    expect(removed).toEqual(expect.objectContaining({ applied: true, operation: 'remove' }))
    await expect(readFile(targetFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = createSkeletonInstaller(installerOptions)
    const restorePreview = await restarted.previewRestore(removal, removed.recoveryToken, {
      purpose: 'restore',
      subjectCapabilityId: removal.id,
    })
    const restored = await restarted.apply(restorePreview.previewToken, applyInput(restorePreview))
    expect(restored).toEqual(expect.objectContaining({ applied: true, operation: 'restore', contentHash: previousHash }))
    expect(await readFile(path.join(root, 'skills/review/references/old.md'), 'utf8')).toContain('Old reference')
    await restarted.commitRecovery(restored.recoveryToken)
  })

  it('binds Canary writes and verification to one separate canonical project root', async () => {
    const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skillops-canary-roots-')))
    temporaryDirectories.push(dataDir)
    const stableRoot = path.join(dataDir, 'stable-project')
    const canaryRoot = path.join(dataDir, 'canary-project')
    await Promise.all([mkdir(stableRoot), mkdir(canaryRoot)])
    const contents = '# Canary candidate\n'
    const capability = {
      id: 'cap-canary',
      artifact: {
        kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'github',
        sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md',
        contentHash: artifactContentHash(contents),
      },
      targetSkeleton: 'skills/review/SKILL.md',
    }
    const scannedRoots = []
    const installer = createSkeletonInstaller({
      dataDir,
      skeletonRoot: stableRoot,
      artifacts: { resolve: async () => ({ artifact: capability.artifact, contents }) },
      scanInstalledSkills: async ({ projectRoot }) => {
        scannedRoots.push(projectRoot)
        const sourcePath = path.join(projectRoot, capability.targetSkeleton)
        return readFile(sourcePath).then(() => [{ sourcePath, kind: 'skill', runtime: 'codex' }], () => [])
      },
    })

    await expect(installer.previewInstall(capability, { projectRoot: 'relative-project' })).rejects.toThrow('absolute')
    const [stable, canary] = await Promise.all([
      installer.projectIdentity(capability.targetSkeleton),
      installer.projectIdentity(capability.targetSkeleton, canaryRoot),
    ])
    expect(stable.key).not.toBe(canary.key)
    const preview = await installer.previewInstall(capability, { purpose: 'canary', subjectCapabilityId: capability.id, projectRoot: canaryRoot })
    const applied = await installer.apply(preview.previewToken, { ...applyInput(preview), projectRoot: preview.projectRoot })
    const observed = await installer.verify(capability, capability.targetSkeleton, canaryRoot)

    expect(applied.applied).toBe(true)
    expect(observed).toEqual(expect.objectContaining({ projectRoot: canaryRoot, contentHash: capability.artifact.contentHash }))
    expect(scannedRoots).toEqual(expect.arrayContaining([canaryRoot]))
    await expect(readFile(path.join(stableRoot, capability.targetSkeleton), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(canaryRoot, capability.targetSkeleton), 'utf8')).toBe(contents)
  })

  it('restores a deprecated exact-byte backup after the installer restarts', async () => {
    const { targetFile, candidate, capability, installer, installerOptions } = await setup()
    await writeFile(targetFile, candidate, 'utf8')
    const removalPreview = await installer.previewRemoval(capability)
    const removed = await installer.apply(removalPreview.previewToken, applyInput(removalPreview))
    const restarted = createSkeletonInstaller(installerOptions)
    const restorePreview = await restarted.previewRestore(capability, removed.recoveryToken, { purpose: 'restore', subjectCapabilityId: capability.id })
    const restored = await restarted.apply(restorePreview.previewToken, applyInput(restorePreview))
    expect(restored).toEqual(expect.objectContaining({ applied: true, operation: 'restore', contentHash: capability.artifact.contentHash }))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    await restarted.commitRecovery(restored.recoveryToken)
  })
  it('rolls back over a new Stable after the previous version was removed', async () => {
    const { targetFile, candidate, capability, installer, installerOptions } = await setup()
    await writeFile(targetFile, candidate, 'utf8')
    const removalPreview = await installer.previewRemoval(capability)
    const removed = await installer.apply(removalPreview.previewToken, applyInput(removalPreview))
    const nextStable = '# Next Stable\n'
    await writeFile(targetFile, nextStable, 'utf8')
    const restarted = createSkeletonInstaller(installerOptions)

    const rollbackPreview = await restarted.previewRestore(capability, removed.recoveryToken, {
      purpose: 'rollback',
      subjectCapabilityId: 'cap-next',
      currentHash: artifactContentHash(nextStable),
    })
    const restored = await restarted.apply(rollbackPreview.previewToken, applyInput(rollbackPreview))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)

    await restarted.revert(restored.recoveryToken)
    expect(await readFile(targetFile, 'utf8')).toBe(nextStable)
  })

  it('does not overwrite an external write while reversing a failed restoration', async () => {
    const { targetFile, candidate, capability, installer, installerOptions } = await setup()
    await writeFile(targetFile, candidate, 'utf8')
    const removalPreview = await installer.previewRemoval(capability)
    const removed = await installer.apply(removalPreview.previewToken, applyInput(removalPreview))
    const nextStable = '# Next Stable\n'
    const external = '# External write\n'
    await writeFile(targetFile, nextStable, 'utf8')
    const restarted = createSkeletonInstaller({
      ...installerOptions,
      scanInstalledSkills: async () => {
        await writeFile(targetFile, external, 'utf8')
        return [{ sourcePath: targetFile, status: 'active', enabled: true }]
      },
    })
    const rollbackPreview = await restarted.previewRestore(capability, removed.recoveryToken, {
      purpose: 'rollback',
      subjectCapabilityId: 'cap-next',
      currentHash: artifactContentHash(nextStable),
    })

    await expect(restarted.apply(rollbackPreview.previewToken, applyInput(rollbackPreview)))
      .rejects.toThrow('changed before automatic recovery')
    expect(await readFile(targetFile, 'utf8')).toBe(external)
  })


  it('preserves recovery records written by another installer process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-recovery-concurrency-'))
    temporaryDirectories.push(root)
    const files = {
      'target-a': path.join(root, 'a', 'SKILL.md'),
      'target-b': path.join(root, 'b', 'SKILL.md'),
    }
    const contents = { 'target-a': '# Stable A\n', 'target-b': '# Stable B\n' }
    await Promise.all(Object.entries(files).map(async ([target, file]) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, contents[target], 'utf8')
    }))
    const capability = (target) => ({
      id: `cap-${target}`,
      artifact: {
        kind: 'skill',
        artifactId: target,
        version: '1.0.0',
        source: 'github',
        sourceRef: `github:https://github.com/acme/${target}/SKILL.md`,
        contentHash: artifactContentHash(contents[target]),
      },
      targetSkeleton: target,
    })
    const options = {
      dataDir: root,
      artifacts: { resolve: async () => { throw new Error('not used') } },
      resolveTarget: async (target) => files[target],
      scanInstalledSkills: async () => (await Promise.all(Object.values(files).map(async (file) => (
        await readFile(file).then(() => ({ sourcePath: file }), () => null)
      )))).filter(Boolean),
    }
    const first = createSkeletonInstaller(options)
    const second = createSkeletonInstaller(options)
    await expect(second.previewRestore(capability('target-a'), '00000000-0000-4000-8000-000000000099')).rejects.toThrow('unavailable')
    const previewA = await first.previewRemoval(capability('target-a'))
    const removedA = await first.apply(previewA.previewToken, applyInput(previewA))
    const previewB = await second.previewRemoval(capability('target-b'))
    const removedB = await second.apply(previewB.previewToken, applyInput(previewB))
    const restarted = createSkeletonInstaller(options)
    await expect(restarted.previewRestore(capability('target-a'), removedA.recoveryToken)).resolves.toEqual(expect.objectContaining({ candidateHash: capability('target-a').artifact.contentHash }))
    await expect(restarted.previewRestore(capability('target-b'), removedB.recoveryToken)).resolves.toEqual(expect.objectContaining({ candidateHash: capability('target-b').artifact.contentHash }))
  })

  it.each(['prepared', 'applied'])('reconciles an orphaned %s replacement on startup', async (state) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-recovery-startup-'))
    temporaryDirectories.push(root)
    const targetFile = path.join(root, 'SKILL.md')
    const backupFile = `${targetFile}.skillops-backup-crash`
    const current = '# Previous Stable\r\n'
    const candidate = '# Interrupted candidate\n'
    await writeFile(targetFile, candidate, 'utf8')
    await writeFile(backupFile, current, 'utf8')
    const token = state === 'prepared'
      ? '00000000-0000-4000-8000-000000000001'
      : '00000000-0000-4000-8000-000000000002'
    await writeFile(path.join(root, 'governance-release-recoveries.json'), `${JSON.stringify({
      schemaVersion: 1,
      recoveries: {
        [token]: {
          operation: 'replace',
          state,
          targetFile,
          backupFile,
          forwardBackupFile: null,
          currentHash: artifactContentHash(current),
          candidateHash: artifactContentHash(candidate),
          byteHash: createHash('sha256').update(current).digest('hex'),
          forwardHash: null,
          forwardByteHash: null,
          capabilityId: 'cap-crash',
          targetSkeleton: 'target-crash',
        },
      },
    }, null, 2)}\n`, 'utf8')
    const installer = createSkeletonInstaller({ dataDir: root })

    await installer.initialize()

    expect(await readFile(targetFile, 'utf8')).toBe(current)
    await expect(readFile(backupFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(root, 'governance-release-recoveries.json'), 'utf8')).recoveries).toEqual({})
  })

  it('garbage-collects recovery history evicted by a later Stable release', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-recovery-evicted-'))
    temporaryDirectories.push(root)
    const targetFile = path.join(root, 'SKILL.md')
    const backupFile = `${targetFile}.skillops-backup-old`
    const oldStable = '# Stable v1\n'
    const oldCandidate = '# Stable v2\n'
    const currentStable = '# Stable v22\n'
    const token = '00000000-0000-4000-8000-000000000022'
    await writeFile(targetFile, currentStable, 'utf8')
    await writeFile(backupFile, oldStable, 'utf8')
    await writeFile(path.join(root, 'governance-release-recoveries.json'), `${JSON.stringify({
      schemaVersion: 1,
      recoveries: {
        [token]: {
          operation: 'replace',
          state: 'applied',
          targetFile,
          backupFile,
          forwardBackupFile: null,
          currentHash: artifactContentHash(oldStable),
          candidateHash: artifactContentHash(oldCandidate),
          byteHash: createHash('sha256').update(oldStable).digest('hex'),
          forwardHash: null,
          forwardByteHash: null,
          capabilityId: 'cap-v2',
          targetSkeleton: 'target-history',
        },
      },
    }, null, 2)}\n`, 'utf8')
    await writeFile(path.join(root, 'project-skeleton.lock.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      targets: {
        'target-history': {
          stable: {
            capabilityId: 'cap-v22',
            artifact: { contentHash: artifactContentHash(currentStable) },
            evaluationRunId: 'quality-v22',
            evidenceHash: 'e'.repeat(64),
            approvedBy: ['Reviewer'],
            channel: 'stable',
            promotedAt: new Date().toISOString(),
          },
          canary: null,
          previous: [],
        },
      },
    }, null, 2)}\n`, 'utf8')

    await createSkeletonInstaller({ dataDir: root }).initialize()

    expect(await readFile(targetFile, 'utf8')).toBe(currentStable)
    await expect(readFile(backupFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(root, 'governance-release-recoveries.json'), 'utf8')).recoveries).toEqual({})
  })

  it('does not steal an old lock owned by a live process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-live-lock-'))
    temporaryDirectories.push(root)
    const lockFile = path.join(root, 'release.lock')
    await writeFile(lockFile, JSON.stringify({ pid: process.ppid, token: 'live-owner' }), 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockFile, old, old)

    await expect(withGovernanceFileLock(lockFile, async () => undefined, 2)).rejects.toThrow('Timed out')
    expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe('live-owner')
  })

  it('does not remove a replacement lock owned by another token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-replaced-lock-'))
    temporaryDirectories.push(root)
    const lockFile = path.join(root, 'release.lock')

    await withGovernanceFileLock(lockFile, async () => {
      await writeFile(lockFile, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }), 'utf8')
    })

    expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe('replacement-owner')
  })
  it('maps inventory aliases to one physical target key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-target-key-'))
    temporaryDirectories.push(root)
    const realDirectory = path.join(root, 'real')
    const aliasDirectory = path.join(root, 'alias')
    const realTarget = path.join(realDirectory, 'SKILL.md')
    const aliasTarget = path.join(aliasDirectory, 'SKILL.md')
    await mkdir(realDirectory)
    await writeFile(realTarget, '# Shared\n', 'utf8')
    await symlink(realDirectory, aliasDirectory, 'junction')
    const records = [
      { skillId: 'shared', skillVersion: '1.0.0', runtime: 'codex', kind: 'skill', sourcePath: realTarget, enabled: true, status: 'active' },
      { skillId: 'shared', skillVersion: '1.0.0', runtime: 'claude-code', kind: 'skill', sourcePath: aliasTarget, enabled: true, status: 'active' },
    ]
    const installer = createSkeletonInstaller({
      dataDir: root,
      scanInstalledSkills: async () => records,
    })

    expect(await installer.targetKey(`local-scan:codex:${realTarget}`))
      .toBe(await installer.targetKey(`local-scan:claude-code:${aliasTarget}`))
  })

  it('verifies a promotion scanned through an unchanged directory alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-scan-alias-'))
    temporaryDirectories.push(root)
    const realDirectory = path.join(root, 'real')
    const aliasDirectory = path.join(root, 'alias')
    const realTarget = path.join(realDirectory, 'SKILL.md')
    const aliasTarget = path.join(aliasDirectory, 'SKILL.md')
    const current = '# Current\n'
    const candidate = '# Candidate\n'
    await mkdir(realDirectory)
    await writeFile(realTarget, current, 'utf8')
    await symlink(realDirectory, aliasDirectory, 'junction')
    const capability = {
      id: 'cap-scan-alias',
      artifact: {
        kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'github',
        sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md',
        contentHash: artifactContentHash(candidate),
      },
      baseline: {
        kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'local-scan',
        sourceRef: `local-scan:codex:${aliasTarget}`, contentHash: artifactContentHash(current),
      },
      targetSkeleton: `local-scan:codex:${aliasTarget}`,
    }
    const installer = createSkeletonInstaller({
      dataDir: root,
      resolveTarget: async () => aliasTarget,
      artifacts: { resolve: async () => ({ artifact: capability.artifact, contents: candidate }) },
      scanInstalledSkills: async () => [{
        sourcePath: aliasTarget,
        contentHash: artifactContentHash(await readFile(aliasTarget, 'utf8')),
        enabled: true,
        status: 'active',
      }],
    })

    const preview = await installer.preview(capability)
    expect((await installer.apply(preview.previewToken, applyInput(preview))).applied).toBe(true)
    expect(await readFile(realTarget, 'utf8')).toBe(candidate)
  })

  it('rejects a post-write scan row that is no longer active', async () => {
    const { targetFile, current, candidate, capability, installerOptions } = await setup()
    const installer = createSkeletonInstaller({
      ...installerOptions,
      scanInstalledSkills: async () => [{
        sourcePath: targetFile,
        contentHash: artifactContentHash(candidate),
        enabled: false,
        status: 'shadowed',
      }],
    })

    const preview = await installer.preview(capability)
    expect(await installer.apply(preview.previewToken, applyInput(preview))).toEqual(expect.objectContaining({
      applied: false,
      errorCode: 'PROMOTION_VERIFICATION_FAILED',
      rollback: { restored: true },
    }))
    expect(await readFile(targetFile, 'utf8')).toBe(current)
  })


  it('confines new installations to the configured managed root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-managed-root-'))
    temporaryDirectories.push(root)
    const candidate = '# Managed candidate\n'
    const targetFile = path.join(root, 'skills', 'review', 'SKILL.md')
    const capability = {
      id: 'cap-managed',
      artifact: {
        kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'github',
        sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md',
        contentHash: artifactContentHash(candidate),
      },
      baseline: null,
      targetSkeleton: 'skills/review/SKILL.md',
    }
    const installer = createSkeletonInstaller({
      skeletonRoot: root,
      dataDir: root,
      artifacts: { resolve: async () => ({ artifact: capability.artifact, contents: candidate }) },
      scanInstalledSkills: async () => await readFile(targetFile).then(() => true, () => false) ? [{ sourcePath: targetFile }] : [],
    })
    const preview = await installer.previewInstall(capability)
    expect((await installer.apply(preview.previewToken, applyInput(preview))).applied).toBe(true)
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    const removal = await installer.previewRemoval(capability)
    expect((await installer.apply(removal.previewToken, applyInput(removal))).operation).toBe('remove')
    await expect(readFile(targetFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(installer.previewInstall({ ...capability, targetSkeleton: '../outside/SKILL.md' })).rejects.toThrow('escapes')
  })

  it.each(['promotion', 'removal'])('rejects an inventory parent redirect between %s preview and apply', async (operation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-parent-swap-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'skillops-parent-swap-outside-'))
    temporaryDirectories.push(root, outside)
    const approvedParent = path.join(root, 'approved')
    const displacedParent = path.join(root, 'approved-original')
    const targetFile = path.join(approvedParent, 'SKILL.md')
    const outsideTarget = path.join(outside, 'SKILL.md')
    const current = '# Stable\n'
    const candidate = operation === 'promotion' ? '# Candidate\n' : current
    await mkdir(approvedParent)
    await writeFile(targetFile, current, 'utf8')
    await writeFile(outsideTarget, current, 'utf8')
    const capability = {
      id: `cap-parent-${operation}`,
      artifact: {
        kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'github',
        sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md',
        contentHash: artifactContentHash(candidate),
      },
      baseline: { kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'local-scan', sourceRef: 'local-scan:review', contentHash: artifactContentHash(current) },
      targetSkeleton: 'approved-review',
    }
    const installer = createSkeletonInstaller({
      dataDir: root,
      resolveTarget: async () => targetFile,
      artifacts: { resolve: async () => ({ artifact: capability.artifact, contents: candidate }) },
      scanInstalledSkills: async () => [{ sourcePath: targetFile }],
    })
    const preview = operation === 'promotion' ? await installer.preview(capability) : await installer.previewRemoval(capability)
    await rename(approvedParent, displacedParent)
    await symlink(outside, approvedParent, 'junction')

    await expect(installer.apply(preview.previewToken, applyInput(preview))).rejects.toThrow('parent changed')
    expect(await readFile(outsideTarget, 'utf8')).toBe(current)
  })

  it('does not follow a new managed-parent junction created after preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-managed-parent-swap-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'skillops-managed-parent-swap-outside-'))
    temporaryDirectories.push(root, outside)
    const candidate = '# Candidate\n'
    const capability = {
      id: 'cap-managed-parent',
      artifact: {
        kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'github',
        sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md',
        contentHash: artifactContentHash(candidate),
      },
      baseline: null,
      targetSkeleton: 'skills/review/SKILL.md',
    }
    const installer = createSkeletonInstaller({
      skeletonRoot: root,
      dataDir: root,
      artifacts: { resolve: async () => ({ artifact: capability.artifact, contents: candidate }) },
      scanInstalledSkills: async () => [],
    })
    const preview = await installer.previewInstall(capability)
    await symlink(outside, path.join(root, 'skills'), 'junction')

    await expect(installer.apply(preview.previewToken, applyInput(preview))).rejects.toThrow('parent')
    await expect(readFile(path.join(outside, 'review', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a same-root recovery parent redirect after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-recovery-parent-swap-'))
    temporaryDirectories.push(root)
    const parent = path.join(root, 'skills', 'review')
    const displaced = path.join(root, 'skills', 'review-original')
    const redirect = path.join(root, 'skills', 'other')
    const targetFile = path.join(parent, 'SKILL.md')
    const current = '# Stable\n'
    await mkdir(parent, { recursive: true })
    await writeFile(targetFile, current, 'utf8')
    const capability = {
      id: 'cap-recovery-parent',
      artifact: {
        kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'github',
        sourceRef: 'github:https://github.com/acme/review/tree/main/SKILL.md',
        contentHash: artifactContentHash(current),
      },
      baseline: null,
      targetSkeleton: 'skills/review/SKILL.md',
    }
    const options = {
      skeletonRoot: root,
      dataDir: root,
      artifacts: { resolve: async () => ({ artifact: capability.artifact, contents: current }) },
      scanInstalledSkills: async () => [],
    }
    const installer = createSkeletonInstaller(options)
    const preview = await installer.previewRemoval(capability)
    expect((await installer.apply(preview.previewToken, applyInput(preview))).operation).toBe('remove')
    await rename(parent, displaced)
    await mkdir(redirect)
    await symlink(redirect, parent, 'junction')

    await expect(createSkeletonInstaller(options).initialize()).rejects.toThrow('parent changed')
  })

  it('keeps metadata Artifacts reference-only and rejects scan records with the wrong kind or Runtime', async () => {
    const { root, targetFile, capability, installerOptions } = await setup({ sameContents: true })
    for (const kind of ['evaluation-suite', 'policy-pack']) {
      const metadataCapability = { ...capability, artifact: { ...capability.artifact, kind }, targetSkeleton: `${kind}:quality` }
      const metadataInstaller = createSkeletonInstaller({
        ...installerOptions,
        skeletonRoot: root,
        artifacts: { resolve: async () => ({ artifact: metadataCapability.artifact, contents: '{}' }) },
      })
      const preview = await metadataInstaller.previewInstall(metadataCapability)
      expect(preview.backup).toBe('not-applicable-reference-lock')
      expect(await metadataInstaller.apply(preview.previewToken, applyInput(preview))).toEqual(expect.objectContaining({
        applied: true,
        referenceOnly: true,
      }))
      await expect(metadataInstaller.verify(metadataCapability, metadataCapability.targetSkeleton, root)).resolves.toEqual(expect.objectContaining({
        contentHash: metadataCapability.artifact.contentHash,
        referenceOnly: true,
      }))
    }

    const releaseCapability = { ...capability, targetSkeleton: 'SKILL.md' }
    const managedOptions = { ...installerOptions, resolveTarget: async () => targetFile }
    const wrongKind = createSkeletonInstaller({
      ...managedOptions,
      scanInstalledSkills: async () => [{ sourcePath: targetFile, kind: 'rules', runtime: 'codex', status: 'active' }],
    })
    await expect(wrongKind.verify(releaseCapability, releaseCapability.targetSkeleton, root)).rejects.toThrow('kind, Runtime')

    const wrongRuntime = createSkeletonInstaller({
      ...managedOptions,
      scanInstalledSkills: async () => [{ sourcePath: targetFile, kind: 'skill', runtime: 'cursor', status: 'active' }],
    })
    await expect(wrongRuntime.verify(releaseCapability, releaseCapability.targetSkeleton, root)).rejects.toThrow('kind, Runtime')
  })

  it('rejects a target outside the explicit resolver allowlist', async () => {
    const { capability, installer } = await setup()
    await expect(installer.preview({ ...capability, targetSkeleton: '../../outside' })).rejects.toThrow('allowlist')
  })
})
