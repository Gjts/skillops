import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createPromptRegistry } from './prompt-registry.mjs'

const execute = promisify(execFile)
const temporaryDirectories = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

function prompt(template, model = 'gpt-5.6-sol') {
  return `${JSON.stringify({
    schemaVersion: 1,
    id: 'release-summary',
    name: 'Release summary',
    description: 'Synthetic test Prompt.',
    system: 'Answer for {{audience}}.',
    template,
    model: { provider: 'openai', name: model, configuration: { temperature: 0.1 } },
  }, null, 2)}\n`
}

async function git(repository, ...args) {
  const result = await execute('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}

async function fixture() {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'skillops-prompt-registry-'))
  temporaryDirectories.push(repository)
  await git(repository, 'init', '-b', 'main')
  await mkdir(path.join(repository, 'prompts'))
  const promptFile = path.join(repository, 'prompts', 'release.prompt.json')
  await writeFile(promptFile, prompt('Summarize {{release}}.'), 'utf8')
  await git(repository, 'add', 'prompts/release.prompt.json')
  await git(repository, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'prompt v1')
  const mainCommit = await git(repository, 'rev-parse', 'HEAD')
  await git(repository, 'switch', '-c', 'experiment')
  await writeFile(promptFile, prompt('Summarize the verified status of {{release}}.', 'gpt-5.6-sol'), 'utf8')
  await git(repository, 'add', 'prompts/release.prompt.json')
  await git(repository, '-c', 'user.name=SkillOps Test', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', 'prompt v2')
  const experimentCommit = await git(repository, 'rev-parse', 'HEAD')
  await git(repository, 'switch', 'main')
  return { repository, promptFile, mainCommit, experimentCommit }
}

describe('Git-backed Prompt Registry', () => {
  it('lists branch heads without returning Prompt bodies and compares immutable versions', async () => {
    const { repository, mainCommit, experimentCommit } = await fixture()
    const registry = createPromptRegistry({ promptWorkspace: repository })
    const status = await registry.status()
    expect(status).toEqual(expect.objectContaining({ available: true, currentBranch: 'main', commit: mainCommit, branches: ['experiment', 'main'], persistence: 'git-source-only' }))
    const main = await registry.list({ revision: 'main' })
    const experiment = await registry.list({ revision: 'experiment', provider: 'OPENAI', search: 'release' })
    expect(main.items).toHaveLength(1)
    expect(experiment.items).toHaveLength(1)
    expect(main.items[0]).not.toHaveProperty('prompt')
    expect(JSON.stringify(main)).not.toContain('Summarize {{release}}')
    expect(experiment.commit).toBe(experimentCommit)
    const comparison = await registry.compare(main.items[0].artifact.sourceRef, experiment.items[0].artifact.sourceRef)
    expect(comparison).toEqual(expect.objectContaining({ artifactId: 'release-summary', changed: true, changedFields: ['prompt'] }))
  })

  it('resolves pinned Git content even when the working tree changes and rejects a forged hash', async () => {
    const { repository, promptFile } = await fixture()
    const registry = createPromptRegistry({ promptWorkspace: repository })
    const listed = await registry.list({ revision: 'main' })
    const sourceRef = listed.items[0].artifact.sourceRef
    await writeFile(promptFile, prompt('Uncommitted replacement.'), 'utf8')
    const resolved = await registry.resolveArtifact(sourceRef)
    expect(resolved.prompt.template).toBe('Summarize {{release}}.')
    await expect(registry.resolveArtifact(sourceRef.replace(/[a-f0-9]{64}$/, 'f'.repeat(64)))).rejects.toThrow('does not match')
  })

  it('rejects option-shaped revisions and never reads outside prompts/', async () => {
    const { repository } = await fixture()
    const registry = createPromptRegistry({ promptWorkspace: repository })
    await expect(registry.list({ revision: '--help' })).rejects.toThrow('revision is invalid')
    const listed = await registry.list({ revision: 'main' })
    const forged = listed.items[0].artifact.sourceRef.replace(encodeURIComponent('prompts/release.prompt.json'), encodeURIComponent('README.md'))
    await expect(registry.resolveArtifact(forged)).rejects.toThrow('outside the configured prompt directory')
  })
})
