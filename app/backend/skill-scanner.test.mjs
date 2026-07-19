// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanInstalledSkills } from './skill-scanner.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('installed Skill scanner', () => {
  it('classifies plugin Skills and respects explicit plugin enablement', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-scanner-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginSkill = path.join(codexHome, 'plugins/cache/openai-curated-remote/example/1.0.0/skills/plugin-skill/SKILL.md')
    const globalSkill = path.join(codexHome, 'skills/global-skill/SKILL.md')
    await mkdir(path.dirname(pluginSkill), { recursive: true })
    await mkdir(path.dirname(globalSkill), { recursive: true })
    await writeFile(pluginSkill, '---\nname: plugin-skill\nversion: 1.2.0\n---\n', 'utf8')
    await writeFile(globalSkill, '---\nname: global-skill\n---\n', 'utf8')
    await writeFile(path.join(codexHome, 'config.toml'), '[plugins."example@openai-curated"]\nenabled = false\n', 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(skills).toContainEqual(expect.objectContaining({
      skillId: 'plugin-skill',
      skillVersion: '1.2.0',
      source: 'plugin',
      provider: 'example',
      kind: 'skill',
      enabled: false,
    }))
    expect(skills).toContainEqual(expect.objectContaining({
      skillId: 'global-skill',
      source: 'global',
      provider: 'Codex',
      enabled: true,
    }))
  })

  it('scans active Claude Code plugin Skills from the installation registry', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-claude-plugin-scanner-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginRoot = path.join(claudeHome, 'plugins/cache/official/superpowers/6.1.1')
    const pluginSkill = path.join(pluginRoot, 'skills/brainstorming/SKILL.md')
    const mirrorSkill = path.join(pluginRoot, '.openclaw/skills/brainstorming/SKILL.md')
    const unrelatedRoot = path.join(claudeHome, 'plugins/cache/official/project-only/1.0.0')
    await mkdir(path.dirname(pluginSkill), { recursive: true })
    await mkdir(path.dirname(mirrorSkill), { recursive: true })
    await mkdir(path.join(unrelatedRoot, 'skills/project-only'), { recursive: true })
    await mkdir(path.join(claudeHome, 'plugins'), { recursive: true })
    await writeFile(pluginSkill, '---\nname: brainstorming\n---\n', 'utf8')
    await writeFile(mirrorSkill, '---\nname: brainstorming\n---\n', 'utf8')
    await writeFile(path.join(unrelatedRoot, 'skills/project-only/SKILL.md'), '---\nname: project-only\n---\n', 'utf8')
    await writeFile(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@official': [{ scope: 'user', installPath: pluginRoot, version: '6.1.1' }],
        'project-only@official': [{ scope: 'project', projectPath: path.join(home, 'somewhere-else'), installPath: unrelatedRoot, version: '1.0.0' }],
      },
    }), 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'claude-code' })
    expect(skills.filter((skill) => skill.skillId === 'brainstorming')).toHaveLength(1)
    expect(skills).toContainEqual(expect.objectContaining({
      skillId: 'brainstorming',
      skillVersion: '6.1.1',
      source: 'plugin',
      provider: 'superpowers',
      enabled: true,
      sourcePath: pluginSkill,
    }))
    expect(skills.some((skill) => skill.skillId === 'project-only')).toBe(false)
  })

  it('only scans canonical Codex plugin skill directories', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-canonical-plugin-scanner-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginRoot = path.join(codexHome, 'plugins/cache/ponytail/ponytail/4.8.4')
    const canonical = path.join(pluginRoot, 'skills/ponytail-review/SKILL.md')
    const mirror = path.join(pluginRoot, '.openclaw/skills/ponytail-review/SKILL.md')
    await mkdir(path.dirname(canonical), { recursive: true })
    await mkdir(path.dirname(mirror), { recursive: true })
    await writeFile(canonical, '---\nname: ponytail-review\n---\n', 'utf8')
    await writeFile(mirror, '---\nname: ponytail-review\n---\n', 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(skills.filter((skill) => skill.skillId === 'ponytail-review')).toHaveLength(1)
    expect(skills.find((skill) => skill.skillId === 'ponytail-review')?.sourcePath).toBe(canonical)
  })

  it('discovers CC Switch symlinked Skills from its custom Claude directory', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-cc-switch-scanner-'))
    temporaryDirectories.push(home)
    const ccSwitchHome = path.join(home, '.cc-switch')
    const claudeHome = path.join(home, 'claude-switched')
    const sourceSkill = path.join(ccSwitchHome, 'skills', 'linked-skill')
    const linkedSkill = path.join(claudeHome, 'skills', 'linked-skill')
    await mkdir(sourceSkill, { recursive: true })
    await mkdir(path.dirname(linkedSkill), { recursive: true })
    await writeFile(path.join(sourceSkill, 'SKILL.md'), '---\nname: linked-skill\nversion: 3.2.1\n---\n', 'utf8')
    await writeFile(path.join(ccSwitchHome, 'settings.json'), JSON.stringify({ claude_config_dir: claudeHome }), 'utf8')
    await symlink(sourceSkill, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir')

    const skills = await scanInstalledSkills({
      home,
      ccSwitchHome,
      environment: {},
      project: path.join(home, 'project'),
      codexHome: path.join(home, '.codex'),
      runtime: 'claude-code',
    })
    expect(skills).toContainEqual(expect.objectContaining({
      skillId: 'linked-skill',
      skillVersion: '3.2.1',
      runtime: 'claude-code',
      provider: 'Claude Code',
      sourcePath: path.join(linkedSkill, 'SKILL.md'),
    }))
  })
})
