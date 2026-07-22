// @vitest-environment node
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactPackageHash, normalizeArtifactPackage, readArtifactPackage } from './artifact-package.mjs'

const temporaryDirectories = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('immutable Artifact packages', () => {
  it('binds every path and byte independently of enumeration order', () => {
    const files = [
      { relativePath: 'SKILL.md', contents: '# Review\n' },
      { relativePath: 'scripts/check.mjs', contents: 'export const check = true\n' },
    ]
    expect(artifactPackageHash(files)).toBe(artifactPackageHash([...files].reverse()))
    expect(artifactPackageHash(files)).not.toBe(artifactPackageHash([
      files[0],
      { ...files[1], contents: 'export const check = false\n' },
    ]))
  })

  it('rejects unsafe and filesystem-colliding paths', () => {
    expect(() => normalizeArtifactPackage([{ relativePath: '../SKILL.md', contents: '' }])).toThrow('path is invalid')
    expect(() => normalizeArtifactPackage([
      { relativePath: 'SKILL.md', contents: '' },
      { relativePath: 'skill.md', contents: '' },
    ])).toThrow('unique across supported filesystems')
  })

  it('reads nested regular files and rejects package symlinks', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skillops-package-')))
    temporaryDirectories.push(root)
    await mkdir(path.join(root, 'scripts'))
    await writeFile(path.join(root, 'SKILL.md'), '# Review\n')
    await writeFile(path.join(root, 'scripts/check.mjs'), 'export const check = true\n')
    expect(await readArtifactPackage(root)).toEqual(expect.objectContaining({
      packageFiles: expect.arrayContaining([
        expect.objectContaining({ relativePath: 'SKILL.md' }),
        expect.objectContaining({ relativePath: 'scripts/check.mjs' }),
      ]),
    }))
    const linked = path.join(root, 'scripts/linked.md')
    await writeFile(linked, 'not followed\n')
    await expect(readArtifactPackage(root, {
      lstat: async (file) => file === linked ? { isSymbolicLink: () => true } : lstat(file),
    })).rejects.toThrow('cannot contain symbolic links')
  })
})
