import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactContentHash } from '../evaluations/artifact-definition.mjs'
import { createSkeletonInstaller } from './skeleton-installer.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup({ scanSucceeds = true, sameContents = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillops-skeleton-'))
  temporaryDirectories.push(root)
  const targetFile = path.join(root, 'SKILL.md')
  const candidate = '# Candidate\nSafe instructions.\n'
  const current = sameContents ? candidate : '# Current\n'
  await writeFile(targetFile, current, 'utf8')
  const capability = {
    id: 'cap-1',
    artifact: { kind: 'skill', artifactId: 'review', version: '2.0.0', source: 'github', sourceRef: 'github:review', contentHash: artifactContentHash(candidate) },
    baseline: { kind: 'skill', artifactId: 'review', version: '1.0.0', source: 'local-scan', sourceRef: 'local-scan:review', contentHash: artifactContentHash(current) },
    targetSkeleton: 'codex:project-review',
  }
  const installer = createSkeletonInstaller({
    artifacts: { resolve: async (sourceRef) => {
      if (sourceRef !== capability.artifact.sourceRef) throw new Error('Unexpected source')
      return { artifact: capability.artifact, contents: candidate }
    } },
    resolveTarget: async (target) => {
      if (target !== capability.targetSkeleton) throw new Error('Target is not in the allowlist')
      return targetFile
    },
    scanInstalledSkills: async () => scanSucceeds ? [{ sourcePath: targetFile }] : [],
  })
  return { root, targetFile, current, candidate, capability, installer }
}

describe('project skeleton installer', () => {
  it('previews before writing, requires confirmation, backs up, writes atomically, and rescans', async () => {
    const { root, targetFile, candidate, capability, installer } = await setup()
    const preview = await installer.preview(capability)
    expect(preview).toEqual(expect.objectContaining({
      source: 'github:review', target: 'codex:project-review', conflict: false,
      diff: { beforeLines: 2, afterLines: 3, changedLines: 3 },
      rollbackPlan: expect.stringContaining('backup'),
    }))
    expect(await readFile(targetFile, 'utf8')).not.toBe(candidate)
    expect((await readdir(root)).filter((name) => name.includes('backup'))).toEqual([])
    await expect(installer.apply(preview.previewToken)).rejects.toThrow('confirmation')
    const applied = await installer.apply(preview.previewToken, { confirm: true })
    expect(applied).toEqual(expect.objectContaining({ applied: true, contentHash: capability.artifact.contentHash, rollback: { restored: false } }))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    expect((await readdir(root)).filter((name) => name.includes('backup'))).toHaveLength(1)
  })

  it('automatically restores the backup when post-write verification fails', async () => {
    const { targetFile, current, capability, installer } = await setup({ scanSucceeds: false })
    const preview = await installer.preview(capability)
    const applied = await installer.apply(preview.previewToken, { confirm: true })
    expect(applied).toEqual(expect.objectContaining({ applied: false, errorCode: 'PROMOTION_VERIFICATION_FAILED', rollback: { restored: true } }))
    expect(await readFile(targetFile, 'utf8')).toBe(current)
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
    const applied = await installer.apply(preview.previewToken, { confirm: true })
    expect(applied).toEqual(expect.objectContaining({ applied: true, unchanged: true, backup: null }))
    expect(await readFile(targetFile, 'utf8')).toBe(candidate)
    expect((await readdir(root)).sort()).toEqual(before)
  })

  it('rejects a target outside the explicit resolver allowlist', async () => {
    const { capability, installer } = await setup()
    await expect(installer.preview({ ...capability, targetSkeleton: '../../outside' })).rejects.toThrow('allowlist')
  })
})
