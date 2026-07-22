// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConflictService } from './conflict-service.mjs'
import { handleConflictApi } from './conflict-api.mjs'
import { scanSkillInventory } from '../skill-scanner.mjs'

const filesystemRace = vi.hoisted(() => ({ afterBackup: null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal()
  async function mutateAfterBackup(operation, source, target) {
    await actual[operation](source, target)
    await filesystemRace.afterBackup?.(source, target)
  }
  return {
    ...actual,
    copyFile: (source, target) => mutateAfterBackup('copyFile', source, target),
    rename: (source, target) => mutateAfterBackup('rename', source, target),
  }
})

const temporaryDirectories = []

afterEach(async () => {
  filesystemRace.afterBackup = null
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'skillops-conflicts-'))
  temporaryDirectories.push(root)
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const project = path.join(root, 'project')
  const globalFile = path.join(codexHome, 'skills', 'review', 'SKILL.md')
  const projectFile = path.join(project, '.agents', 'skills', 'review', 'SKILL.md')
  const configFile = path.join(codexHome, 'config.toml')
  const globalContents = '---\nname: review\nversion: 1.0.0\ntools: read\n---\nGlobal instructions.\n'
  const projectContents = '---\nname: review\nversion: 2.0.0\ntools: read, write\n---\nProject instructions.\n'
  await Promise.all([
    mkdir(path.dirname(globalFile), { recursive: true }),
    mkdir(path.dirname(projectFile), { recursive: true }),
    mkdir(project, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(project, 'package.json'), '{}\n'),
    writeFile(globalFile, globalContents),
    writeFile(projectFile, projectContents),
    writeFile(configFile, '[model]\nname = "local"\n', 'utf8'),
  ])
  const scan = () => scanSkillInventory({ home, codexHome, project, projectRoot: project, runtime: 'codex', codexAdminSkillsDirectories: [] })
  const dataDir = path.join(root, 'data')
  const serviceOptions = {
    dataDir,
    codexHome,
    scanSkillInventory: scan,
    readRuntimeConnections: async () => [{ runtime: 'codex', status: 'installed' }],
  }
  const service = createConflictService(serviceOptions)
  return { service, serviceOptions, scan, globalFile, projectFile, configFile, globalContents, projectContents }
}

async function planAndApply(service, request) {
  const plan = await service.preview(request)
  const result = await service.apply(plan.previewToken, { confirm: true, confirmedDefinitionKey: plan.definitionKey })
  return { plan, result }
}

async function guardedCall(headers, remoteAddress = '127.0.0.1') {
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:4173', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {},
  }
  const response = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(value = '') { this.body += value },
  }
  await handleConflictApi(request, response, '/api/conflicts/inspect')
  return response
}

describe('conflict resolution service', () => {
  it('reports every conflict facet, possible Runtime definitions, impact, and structured content diffs', async () => {
    const { service } = await fixture()
    const detail = await service.inspect({ runtime: 'codex', skillId: 'review' })

    expect(detail.classifications).toEqual(expect.arrayContaining(['content-conflict', 'version-conflict']))
    expect(detail.definitions).toHaveLength(2)
    expect(detail.possibleLoadedDefinitions).toHaveLength(2)
    expect(detail.possibleLoadedDefinitions.every((item) => item.possible === true)).toBe(true)
    expect(detail.impact).toMatchObject({ runtimes: ['codex'], installationSources: expect.arrayContaining(['global', 'project']) })
    expect(detail.comparisons[0].sections).toMatchObject({
      frontmatter: { changed: true },
      instructions: { changed: true },
      tools: { changed: true },
      references: { changed: false },
      scripts: { changed: false },
    })
    expect(JSON.stringify(detail)).not.toContain('Global instructions.')
    expect(JSON.stringify(detail)).not.toContain('Project instructions.')
    expect(detail.comparisons[0].sections.instructions).toEqual(expect.objectContaining({
      beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      beforeBytes: expect.any(Number),
      afterBytes: expect.any(Number),
    }))
  })

  it('does not classify different artifact kinds as duplicate definitions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillops-conflict-kinds-'))
    temporaryDirectories.push(root)
    const skillFile = path.join(root, 'skill', 'SKILL.md')
    const commandFile = path.join(root, 'command.md')
    const contents = '---\nname: review\nversion: 1.0.0\n---\nShared instructions.\n'
    await mkdir(path.dirname(skillFile), { recursive: true })
    await Promise.all([writeFile(skillFile, contents), writeFile(commandFile, contents)])
    const definitions = [
      { skillId: 'review', skillVersion: '1.0.0', runtime: 'claude-code', kind: 'skill', source: 'global', sourcePath: skillFile, contentHash: 'a'.repeat(64), enabled: true, status: 'active' },
      { skillId: 'review', skillVersion: '1.0.0', runtime: 'claude-code', kind: 'command', source: 'global', sourcePath: commandFile, contentHash: 'a'.repeat(64), enabled: true, status: 'active' },
    ]
    const service = createConflictService({
      dataDir: path.join(root, 'data'),
      scanSkillInventory: async () => ({ definitions }),
      readRuntimeConnections: async () => [],
    })

    const detail = await service.inspect({ runtime: 'claude-code', skillId: 'review' })
    expect(detail.classifications).not.toContain('exact-duplicate')
  })

  it.each(['keep', 'defer'])('previews and records the %s action without modifying files', async (action) => {
    const { service, globalFile, globalContents } = await fixture()
    const { plan, result } = await planAndApply(service, { action, runtime: 'codex', sourcePath: globalFile })

    expect(plan.changes).toEqual([])
    expect(result).toMatchObject({ status: 'applied', changed: false, action })
    expect(await readFile(globalFile, 'utf8')).toBe(globalContents)
  })

  it('disables through one managed Codex section, backs it up, verifies, and undoes byte-for-byte', async () => {
    const { service, scan, globalFile, configFile } = await fixture()
    const originalConfig = await readFile(configFile, 'utf8')
    const { plan, result } = await planAndApply(service, { action: 'disable', runtime: 'codex', sourcePath: globalFile })

    expect(plan.changes[0]).toMatchObject({ target: configFile, operation: 'write-managed-section', diff: { before: '', after: expect.stringContaining('enabled = false') } })
    expect(result.backup).toMatchObject({ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect((await readFile(configFile, 'utf8')).startsWith(originalConfig)).toBe(true)
    expect((await scan()).definitions.find((item) => item.sourcePath === globalFile)?.status).toBe('disabled')

    const undone = await service.undo(result.recordId)
    expect(undone).toMatchObject({ status: 'undone', restored: true })
    expect(await readFile(configFile, 'utf8')).toBe(originalConfig)
    expect((await scan()).definitions.find((item) => item.sourcePath === globalFile)?.status).toBe('active')
  })

  it('re-enables a disabled Codex definition through a reviewed action and supports undo', async () => {
    const { service, scan, globalFile, configFile } = await fixture()
    await planAndApply(service, { action: 'disable', runtime: 'codex', sourcePath: globalFile })

    const { plan, result } = await planAndApply(service, { action: 'enable', runtime: 'codex', sourcePath: globalFile })
    expect(plan.changes[0].diff.after).toContain('enabled = true')
    expect((await scan()).definitions.find((item) => item.sourcePath === globalFile)?.status).toBe('active')

    await service.undo(result.recordId)
    expect(await readFile(configFile, 'utf8')).toContain('enabled = false')
    expect((await scan()).definitions.find((item) => item.sourcePath === globalFile)?.status).toBe('disabled')
  })

  it('serializes competing mutations of the same target across service instances', async () => {
    const { service, serviceOptions, globalFile } = await fixture()
    const competing = createConflictService(serviceOptions)
    const [first, second] = await Promise.all([
      service.preview({ action: 'rename', runtime: 'codex', sourcePath: globalFile, newName: 'review-one' }),
      competing.preview({ action: 'rename', runtime: 'codex', sourcePath: globalFile, newName: 'review-two' }),
    ])
    const results = await Promise.allSettled([
      service.apply(first.previewToken, { confirm: true, confirmedDefinitionKey: first.definitionKey }),
      competing.apply(second.previewToken, { confirm: true, confirmedDefinitionKey: second.definitionKey }),
    ])

    expect(results.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('rejects a config action when the reviewed definition changes after preview', async () => {
    const { service, globalFile, globalContents, configFile } = await fixture()
    const originalConfig = await readFile(configFile, 'utf8')
    const plan = await service.preview({ action: 'disable', runtime: 'codex', sourcePath: globalFile })
    await writeFile(globalFile, globalContents.replace('Global instructions.', 'Changed instructions.'))

    await expect(service.apply(plan.previewToken, {
      confirm: true,
      confirmedDefinitionKey: plan.definitionKey,
    })).rejects.toMatchObject({ statusCode: 409 })
    expect(await readFile(configFile, 'utf8')).toBe(originalConfig)
  })

  it('preserves bytes written while the reviewed target is being backed up', async () => {
    const { service, globalFile, configFile } = await fixture()
    const original = await readFile(configFile, 'utf8')
    const editorContents = '[model]\nname = "editor"\n'
    const plan = await service.preview({ action: 'disable', runtime: 'codex', sourcePath: globalFile })
    filesystemRace.afterBackup = async (source, target) => {
      if (source !== configFile || target !== plan.changes[0].backupTarget) return
      filesystemRace.afterBackup = null
      await writeFile(configFile, editorContents)
    }

    const result = await service.apply(plan.previewToken, {
      confirm: true,
      confirmedDefinitionKey: plan.definitionKey,
    })

    expect(result).toMatchObject({ status: 'failed', rollback: { restored: false } })
    expect(await readFile(configFile, 'utf8')).toBe(editorContents)
    expect(await readFile(result.backup.path, 'utf8')).toBe(original)
  })

  it('disables Claude plugins through enabledPlugins without mutating the plugin cache', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillops-conflict-claude-plugin-'))
    temporaryDirectories.push(root)
    const home = path.join(root, 'home')
    const claudeHome = path.join(home, '.claude')
    const codexHome = path.join(home, '.codex')
    const project = path.join(root, 'project')
    const pluginRoot = path.join(claudeHome, 'plugins', 'cache', 'official', 'review-tools', '1.0.0')
    const pluginSkill = path.join(pluginRoot, 'skills', 'review', 'SKILL.md')
    const registryFile = path.join(claudeHome, 'plugins', 'installed_plugins.json')
    const settingsFile = path.join(claudeHome, 'settings.json')
    const settings = '{\r\n  "theme": "dark",\r\n  "enabledPlugins": {\r\n    "review-tools@official": true\r\n  }\r\n}\r\n'
    await Promise.all([mkdir(path.dirname(pluginSkill), { recursive: true }), mkdir(project, { recursive: true })])
    await Promise.all([
      writeFile(path.join(project, 'package.json'), '{}\n'),
      writeFile(pluginSkill, '---\nname: review\nversion: 1.0.0\n---\nPlugin instructions.\n'),
      writeFile(registryFile, JSON.stringify({ plugins: { 'review-tools@official': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] } })),
      writeFile(settingsFile, settings),
    ])
    const scan = () => scanSkillInventory({
      home,
      codexHome,
      claudeHome,
      project,
      projectRoot: project,
      runtime: 'claude-code',
      claudeManagedSettingsDirectory: path.join(root, 'managed'),
    })
    const service = createConflictService({
      dataDir: path.join(root, 'data'),
      home,
      claudeHome,
      project,
      scanSkillInventory: scan,
      readRuntimeConnections: async () => [{ runtime: 'claude-code', status: 'installed' }],
    })
    expect((await scan()).definitions[0].pluginId).toBe('review-tools@official')

    const { plan, result } = await planAndApply(service, { action: 'disable', runtime: 'claude-code', sourcePath: pluginSkill })

    expect(plan.changes[0]).toMatchObject({ operation: 'write-json-property', target: settingsFile })
    expect(await readFile(settingsFile, 'utf8')).toBe(settings.replace('true', 'false'))
    expect(await readFile(pluginSkill, 'utf8')).toContain('Plugin instructions.')
    expect((await scan()).definitions[0].status).toBe('disabled')
    await expect(service.preview({ action: 'remove', runtime: 'claude-code', sourcePath: pluginSkill })).rejects.toThrow(/plugin cache/i)
    await service.undo(result.recordId)
    expect(await readFile(settingsFile, 'utf8')).toBe(settings)
  })

  it('rejects disable when the Runtime has no disablement setting and keeps Remove explicit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillops-conflict-unsupported-disable-'))
    temporaryDirectories.push(root)
    const skillFile = path.join(root, 'skills', 'review', 'SKILL.md')
    const contents = '---\nname: review\nversion: 1.0.0\n---\nReview instructions.\n'
    await mkdir(path.dirname(skillFile), { recursive: true })
    await writeFile(skillFile, contents)
    const service = createConflictService({
      dataDir: path.join(root, 'data'),
      scanSkillInventory: async () => ({ definitions: [{
        skillId: 'review',
        skillVersion: '1.0.0',
        runtime: 'claude-code',
        kind: 'skill',
        source: 'global',
        sourcePath: skillFile,
        enabled: true,
        status: 'active',
      }] }),
      readRuntimeConnections: async () => [],
    })

    await expect(service.preview({ action: 'disable', runtime: 'claude-code', sourcePath: skillFile })).rejects.toMatchObject({ statusCode: 409 })
    expect(await readFile(skillFile, 'utf8')).toBe(contents)
    expect((await service.preview({ action: 'remove', runtime: 'claude-code', sourcePath: skillFile })).changes[0].operation).toBe('move-directory')
  })

  it('removes only after preview and restores the exact definition after a service restart', async () => {
    const { service, serviceOptions, scan, globalFile, globalContents } = await fixture()
    const { result } = await planAndApply(service, { action: 'remove', runtime: 'codex', sourcePath: globalFile })

    await expect(stat(globalFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.backup.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await scan()).definitions.some((item) => item.sourcePath.includes('skillops-backup'))).toBe(false)
    await createConflictService(serviceOptions).undo(result.recordId)
    expect(await readFile(globalFile, 'utf8')).toBe(globalContents)
  })

  it('persists a successful undo even when post-restore Runtime verification is temporarily unavailable', async () => {
    const { service, serviceOptions, globalFile, globalContents } = await fixture()
    const { result } = await planAndApply(service, { action: 'remove', runtime: 'codex', sourcePath: globalFile })
    const degraded = createConflictService({
      ...serviceOptions,
      scanSkillInventory: async () => { throw new Error('temporary scanner outage') },
    })

    await expect(degraded.undo(result.recordId)).resolves.toMatchObject({
      status: 'undone',
      restored: true,
      verification: { status: 'failed' },
    })
    expect(await readFile(globalFile, 'utf8')).toBe(globalContents)
    await expect(createConflictService(serviceOptions).undo(result.recordId)).rejects.toThrow('cannot be undone')
  })

  it('renames a Skill frontmatter name and restores it on undo', async () => {
    const { service, globalFile, globalContents } = await fixture()
    const { plan, result } = await planAndApply(service, { action: 'rename', runtime: 'codex', sourcePath: globalFile, newName: 'review-global' })

    expect(plan.changes[0].diff).toEqual(expect.objectContaining({ changed: true, afterHash: expect.stringMatching(/^[a-f0-9]{64}$/) }))
    expect(JSON.stringify(plan)).not.toContain('Global instructions.')
    expect(await readFile(globalFile, 'utf8')).toContain('name: review-global')
    await service.undo(result.recordId)
    expect(await readFile(globalFile, 'utf8')).toBe(globalContents)
  })

  it('does not let undo overwrite bytes written while quarantining its target', async () => {
    const { service, globalFile, globalContents } = await fixture()
    const { result } = await planAndApply(service, {
      action: 'rename',
      runtime: 'codex',
      sourcePath: globalFile,
      newName: 'review-global',
    })
    const editorContents = globalContents.replace('Global instructions.', 'Concurrent editor instructions.')
    filesystemRace.afterBackup = async (source, target) => {
      const undoCopy = source === result.backup.path && target === globalFile
      const undoQuarantine = source === globalFile && target.includes('.failed-')
      if (!undoCopy && !undoQuarantine) return
      filesystemRace.afterBackup = null
      await writeFile(globalFile, editorContents)
    }

    await expect(service.undo(result.recordId)).rejects.toMatchObject({ statusCode: 409 })
    expect(await readFile(globalFile, 'utf8')).toBe(editorContents)
    expect(await readFile(result.backup.path, 'utf8')).toBe(globalContents)
  })

  it('uses the scanner canonical hash for CRLF Skill actions', async () => {
    const { service, globalFile, globalContents } = await fixture()
    await writeFile(globalFile, globalContents.replace(/\n/g, '\r\n'))

    const { result } = await planAndApply(service, {
      action: 'rename',
      runtime: 'codex',
      sourcePath: globalFile,
      newName: 'review-crlf',
    })

    expect(result.status).toBe('applied')
    expect(await readFile(globalFile, 'utf8')).toContain('name: review-crlf')
  })

  it('replaces the complete Skill directory and restores every auxiliary file on undo', async () => {
    const { service, globalFile, projectFile, globalContents, projectContents } = await fixture()
    const oldReference = path.join(path.dirname(globalFile), 'references', 'old.md')
    const newScript = path.join(path.dirname(projectFile), 'scripts', 'new.mjs')
    await Promise.all([mkdir(path.dirname(oldReference), { recursive: true }), mkdir(path.dirname(newScript), { recursive: true })])
    await Promise.all([writeFile(oldReference, 'old reference\n'), writeFile(newScript, 'export default true\n')])
    const { result } = await planAndApply(service, { action: 'replace', runtime: 'codex', sourcePath: globalFile, replacementSourcePath: projectFile })

    expect(await readFile(globalFile, 'utf8')).toBe(projectContents)
    await expect(readFile(oldReference, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(path.dirname(globalFile), 'scripts', 'new.mjs'), 'utf8')).toBe('export default true\n')
    await service.undo(result.recordId)
    expect(await readFile(globalFile, 'utf8')).toBe(globalContents)
    expect(await readFile(oldReference, 'utf8')).toBe('old reference\n')
    await expect(readFile(path.join(path.dirname(globalFile), 'scripts', 'new.mjs'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { action: 'disable', failAt: 3, request: (base) => ({ action: 'disable', runtime: 'codex', sourcePath: base.globalFile }) },
    { action: 'remove', failAt: 3, request: (base) => ({ action: 'remove', runtime: 'codex', sourcePath: base.globalFile }) },
    { action: 'rename', failAt: 3, request: (base) => ({ action: 'rename', runtime: 'codex', sourcePath: base.globalFile, newName: 'changed' }) },
    { action: 'replace', failAt: 4, request: (base) => ({ action: 'replace', runtime: 'codex', sourcePath: base.globalFile, replacementSourcePath: base.projectFile }) },
  ])('rolls back $action when post-action verification fails', async ({ failAt, request }) => {
    const base = await fixture()
    const originalConfig = await readFile(base.configFile, 'utf8')
    let scans = 0
    const service = createConflictService({
      dataDir: path.join(path.dirname(base.configFile), 'records'),
      codexHome: path.dirname(base.configFile),
      scanSkillInventory: async () => {
        scans += 1
        if (scans === failAt) throw new Error('verification unavailable')
        return base.scan()
      },
      readRuntimeConnections: async () => [{ runtime: 'codex', status: 'installed' }],
    })
    const plan = await service.preview(request(base))
    const result = await service.apply(plan.previewToken, { confirm: true, confirmedDefinitionKey: plan.definitionKey })

    expect(result).toMatchObject({ status: 'failed', rollback: { restored: true } })
    expect(await readFile(base.globalFile, 'utf8')).toBe(base.globalContents)
    expect(await readFile(base.configFile, 'utf8')).toBe(originalConfig)
  })

  it('rejects unpreviewed actions and batch items without individual confirmation', async () => {
    const { service, globalFile, projectFile, globalContents, projectContents } = await fixture()
    await expect(service.apply('missing', { confirm: true })).rejects.toMatchObject({ statusCode: 409 })
    const first = await service.preview({ action: 'remove', runtime: 'codex', sourcePath: globalFile })
    const second = await service.preview({ action: 'remove', runtime: 'codex', sourcePath: projectFile })

    await expect(service.applyBatch([
      { previewToken: first.previewToken, confirmedDefinitionKey: first.definitionKey, confirmed: true },
      { previewToken: second.previewToken, confirmedDefinitionKey: second.definitionKey, confirmed: false },
    ])).rejects.toMatchObject({ statusCode: 422 })
    expect(await readFile(globalFile, 'utf8')).toBe(globalContents)
    expect(await readFile(projectFile, 'utf8')).toBe(projectContents)
  })

  it('applies a batch only after every definition is individually confirmed', async () => {
    const { service, globalFile, projectFile } = await fixture()
    const first = await service.preview({ action: 'defer', runtime: 'codex', sourcePath: globalFile })
    const second = await service.preview({ action: 'keep', runtime: 'codex', sourcePath: projectFile })
    const batch = await service.applyBatch([
      { previewToken: first.previewToken, confirmedDefinitionKey: first.definitionKey, confirmed: true },
      { previewToken: second.previewToken, confirmedDefinitionKey: second.definitionKey, confirmed: true },
    ])

    expect(batch.results).toEqual([
      expect.objectContaining({ action: 'defer', status: 'applied', changed: false }),
      expect.objectContaining({ action: 'keep', status: 'applied', changed: false }),
    ])
  })
  it('rejects non-local, non-JSON, and oversized requests before conflict routing', async () => {
    expect((await guardedCall({ 'content-type': 'application/json' }, '10.0.0.8')).statusCode).toBe(403)
    expect((await guardedCall({ 'content-type': 'text/plain' })).statusCode).toBe(415)
    expect((await guardedCall({ 'content-type': 'application/json', 'content-length': '512001' })).statusCode).toBe(413)
  })

})
