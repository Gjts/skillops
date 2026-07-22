// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveProjectRoot } from './project-root.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('project root resolution', () => {
  it('prefers the repository root when launched from a nested project directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillops-project-root-'))
    temporaryDirectories.push(root)
    const nested = path.join(root, 'packages', 'dashboard', 'src')
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(root, 'packages', 'dashboard', 'package.json'), '{}\n', 'utf8')

    await expect(resolveProjectRoot(nested)).resolves.toBe(root)
  })

  it('falls back to the nearest project marker outside a Git repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillops-project-marker-'))
    temporaryDirectories.push(root)
    const project = path.join(root, 'service')
    const nested = path.join(project, 'src', 'feature')
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "service"\n', 'utf8')

    await expect(resolveProjectRoot(nested)).resolves.toBe(project)
  })
})
