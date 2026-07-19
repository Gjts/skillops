// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories = []

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('runtime connection inspection', () => {
  it('reports current hook installation instead of inferring from old events', async () => {
    const { readRuntimeConnections } = await import('./runtime-connections.mjs')
    const codexHome = await temporaryDirectory('skillops-connections-codex-')
    const claudeHome = await temporaryDirectory('skillops-connections-claude-')
    const codexHook = path.join(codexHome, 'codex-hook.mjs')
    const claudeHook = path.join(claudeHome, 'claude-hook.mjs')
    await writeFile(codexHook, '')
    await writeFile(claudeHook, '')
    await writeFile(path.join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: `SKILLOPS_ADAPTER=skillops-codex-hook node "${codexHook}"`, commandWindows: `node "${codexHook}"` }] }] },
    }))
    await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: `SKILLOPS_ADAPTER=skillops-claude-hook node "${claudeHook}"` }] }] },
    }))

    const connected = await readRuntimeConnections({ codexHome, claudeHome })
    expect(connected).toEqual([
      { runtime: 'codex', status: 'installed' },
      { runtime: 'claude-code', status: 'installed' },
      { runtime: 'cursor', status: 'preview' },
    ])

    await rm(claudeHook)
    expect(await readRuntimeConnections({ codexHome, claudeHome })).toContainEqual({
      runtime: 'claude-code',
      status: 'broken',
    })

    await rm(path.join(claudeHome, 'settings.json'))
    expect(await readRuntimeConnections({ codexHome, claudeHome })).toContainEqual({
      runtime: 'claude-code',
      status: 'not-installed',
    })
  })

  it('adds checked time and real runtime activity without counting discovery scans', async () => {
    const { enrichRuntimeConnections } = await import('./runtime-connections.mjs')
    const checkedAt = '2026-07-19T13:00:00.000Z'
    const result = enrichRuntimeConnections([
      { runtime: 'codex', status: 'installed' },
      { runtime: 'claude-code', status: 'installed' },
    ], [
      { id: 'discovery', event: 'skill.discovered', runtime: 'codex', timestamp: '2026-07-19T10:00:00.000Z' },
      { id: 'old', event: 'session.started', runtime: 'codex', timestamp: '2026-07-19T11:00:00.000Z' },
      { id: 'new', event: 'skill.completed', runtime: 'codex', timestamp: '2026-07-19T12:00:00.000Z' },
    ], checkedAt)

    expect(result).toEqual([
      { runtime: 'codex', status: 'installed', checkedAt, eventCount: 2, lastEventAt: '2026-07-19T12:00:00.000Z' },
      { runtime: 'claude-code', status: 'installed', checkedAt, eventCount: 0 },
    ])
  })

  it('inspects hooks in the Claude directory selected by CC Switch', async () => {
    const { readRuntimeConnections } = await import('./runtime-connections.mjs')
    const home = await temporaryDirectory('skillops-connections-cc-switch-')
    const ccSwitchHome = path.join(home, '.cc-switch')
    const claudeHome = path.join(home, 'claude-switched')
    const claudeHook = path.join(claudeHome, 'claude-hook.mjs')
    await mkdir(ccSwitchHome, { recursive: true })
    await mkdir(claudeHome, { recursive: true })
    await writeFile(path.join(ccSwitchHome, 'settings.json'), JSON.stringify({ claude_config_dir: claudeHome }))
    await writeFile(claudeHook, '')
    await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: `SKILLOPS_ADAPTER=skillops-claude-hook node "${claudeHook}"` }] }] },
    }))

    expect(await readRuntimeConnections({
      home,
      ccSwitchHome,
      environment: {},
      codexHome: path.join(home, '.codex'),
    })).toContainEqual({ runtime: 'claude-code', status: 'installed' })
  })
})
