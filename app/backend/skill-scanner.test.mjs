// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanInstalledSkills, scanSkillInventory } from './skill-scanner.mjs'

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

  it('changes a Skill identity when any regular file in its package changes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-package-hash-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const skillFile = path.join(codexHome, 'skills/review/SKILL.md')
    const scriptFile = path.join(codexHome, 'skills/review/scripts/check.mjs')
    await mkdir(path.dirname(scriptFile), { recursive: true })
    await writeFile(skillFile, '---\nname: review\nversion: 1.0.0\n---\n', 'utf8')
    await writeFile(scriptFile, 'export const verdict = \"safe\"\n', 'utf8')

    const before = (await scanInstalledSkills({
      home,
      codexHome,
      claudeHome: path.join(home, '.claude'),
      project: path.join(home, 'project'),
      runtime: 'codex',
    })).find((skill) => skill.skillId === 'review')
    await writeFile(scriptFile, 'export const verdict = \"unsafe\"\n', 'utf8')
    const after = (await scanInstalledSkills({
      home,
      codexHome,
      claudeHome: path.join(home, '.claude'),
      project: path.join(home, 'project'),
      runtime: 'codex',
    })).find((skill) => skill.skillId === 'review')

    expect(before.packageFileCount).toBe(2)
    expect(after.contentHash).not.toBe(before.contentHash)
  })

  it('respects Codex per-Skill configuration and reports why a definition is disabled', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-codex-skill-config-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const disabledSkill = path.join(home, '.agents/skills/disabled-review/SKILL.md')
    const enabledSkill = path.join(home, '.agents/skills/enabled-review/SKILL.md')
    await mkdir(path.dirname(disabledSkill), { recursive: true })
    await mkdir(path.dirname(enabledSkill), { recursive: true })
    await mkdir(codexHome, { recursive: true })
    await writeFile(disabledSkill, '---\nname: disabled-review\n---\n', 'utf8')
    await writeFile(enabledSkill, '---\nname: enabled-review\n---\n', 'utf8')
    await writeFile(path.join(codexHome, 'config.toml'), [
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(disabledSkill))}`,
      'enabled = false',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(enabledSkill))}`,
      'enabled = false',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(enabledSkill))}`,
      'enabled = true',
      '',
    ].join('\n'), 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(skills).toContainEqual(expect.objectContaining({
      skillId: 'disabled-review',
      enabled: false,
      disabledReason: 'skill-config',
    }))
    expect(skills).toContainEqual(expect.objectContaining({
      skillId: 'enabled-review',
      enabled: true,
      disabledReason: undefined,
    }))
  })

  it('combines plugin and per-Skill disabled reasons without allowing Skill config to enable a disabled plugin', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-codex-plugin-skill-config-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginAndSkillConfig = path.join(codexHome, 'plugins/cache/openai-curated-remote/example/1.0.0/skills/review/SKILL.md')
    const pluginOnlySkill = path.join(codexHome, 'plugins/cache/openai-curated-remote/example/1.0.0/skills/plugin-only-review/SKILL.md')
    await mkdir(path.dirname(pluginAndSkillConfig), { recursive: true })
    await mkdir(path.dirname(pluginOnlySkill), { recursive: true })
    await writeFile(pluginAndSkillConfig, '---\nname: review\n---\n', 'utf8')
    await writeFile(pluginOnlySkill, '---\nname: plugin-only-review\n---\n', 'utf8')
    await writeFile(path.join(codexHome, 'config.toml'), [
      '[plugins."example@openai-curated"]',
      'enabled = false',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(pluginAndSkillConfig))}`,
      'enabled = false',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(pluginOnlySkill))}`,
      'enabled = true',
      '',
    ].join('\n'), 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'review', enabled: false, disabledReason: 'plugin-and-skill-config' }))
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'plugin-only-review', enabled: false, disabledReason: 'plugin' }))
  })


  it('lets trusted Codex project config override user plugin and per-Skill enablement', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-codex-project-config-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginSkill = path.join(codexHome, 'plugins/cache/openai-curated-remote/review-tools/1.0.0/skills/plugin-review/SKILL.md')
    const directSkill = path.join(codexHome, 'skills/direct-review/SKILL.md')
    await mkdir(path.dirname(pluginSkill), { recursive: true })
    await mkdir(path.dirname(directSkill), { recursive: true })
    await mkdir(path.join(project, '.codex'), { recursive: true })
    await writeFile(pluginSkill, '---\nname: plugin-review\n---\n', 'utf8')
    await writeFile(directSkill, '---\nname: direct-review\n---\n', 'utf8')
    await writeFile(path.join(codexHome, 'config.toml'), [
      '[plugins."review-tools@openai-curated"]',
      'enabled = true',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(directSkill))}`,
      'enabled = true',
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(project, '.codex/config.toml'), [
      '[plugins."review-tools@openai-curated"] # trusted project override',
      'enabled = false # disable for this project',
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path.dirname(directSkill))}`,
      'enabled = false',
      '',
    ].join('\n'), 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'plugin-review', enabled: false, disabledReason: 'plugin' }))
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'direct-review', enabled: false, disabledReason: 'skill-config' }))
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

  it('discovers runtime Rules and Agent definitions without treating arbitrary Markdown as assets', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-runtime-artifacts-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const projectAgent = path.join(project, '.claude/agents/reviewer.md')
    const projectRule = path.join(project, 'CLAUDE.md')
    const codexRule = path.join(project, 'AGENTS.md')
    const codexPrompt = path.join(codexHome, 'prompts/review.md')
    const codexAgent = path.join(project, '.codex/agents/reviewer.toml')
    const codexGlobalRule = path.join(codexHome, 'AGENTS.md')
    const unrelated = path.join(project, 'README.md')
    await mkdir(path.dirname(projectAgent), { recursive: true })
    await mkdir(path.dirname(codexPrompt), { recursive: true })
    await mkdir(path.dirname(codexAgent), { recursive: true })
    await writeFile(projectAgent, '---\nname: reviewer\nversion: 2.0.0\n---\nReview changes.', 'utf8')
    await writeFile(projectRule, '# Claude instructions\n', 'utf8')
    await writeFile(codexRule, '# Codex instructions\n', 'utf8')
    await writeFile(unrelated, '# Not a runtime rule\n', 'utf8')
    await writeFile(codexPrompt, '---\ndescription: Review changes\n---\nReview carefully.\n', 'utf8')
    await writeFile(codexAgent, 'name = "reviewer"\ndescription = "Review changes."\ndeveloper_instructions = """Review carefully."""\n', 'utf8')
    await writeFile(codexGlobalRule, '# Global Codex instructions\n', 'utf8')

    const definitions = await scanInstalledSkills({ home, codexHome, claudeHome, project })
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: 'reviewer', kind: 'agent', runtime: 'claude-code', sourcePath: projectAgent }),
      expect.objectContaining({ skillId: 'CLAUDE', kind: 'rules', runtime: 'claude-code', sourcePath: projectRule }),
      expect.objectContaining({ skillId: 'AGENTS', kind: 'rules', runtime: 'codex', sourcePath: codexRule }),
      expect.objectContaining({ skillId: 'review', kind: 'command', runtime: 'codex', sourcePath: codexPrompt }),
      expect.objectContaining({ skillId: 'reviewer', kind: 'agent', runtime: 'codex', description: 'Review changes.', sourcePath: codexAgent }),
      expect.objectContaining({ skillId: 'AGENTS', kind: 'rules', runtime: 'codex', sourcePath: codexGlobalRule }),
    ]))
    expect(definitions.some((item) => item.sourcePath === unrelated)).toBe(false)
  })

  it('lets Claude project-local settings override shared and user plugin enablement', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-claude-local-settings-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginRoot = path.join(claudeHome, 'plugins/cache/official/review-tools/1.0.0')
    const pluginSkill = path.join(pluginRoot, 'skills/review/SKILL.md')
    await mkdir(path.dirname(pluginSkill), { recursive: true })
    await mkdir(path.join(project, '.claude'), { recursive: true })
    await mkdir(path.join(claudeHome, 'plugins'), { recursive: true })
    await writeFile(pluginSkill, '---\nname: review\n---\n', 'utf8')
    await writeFile(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({
      plugins: { 'review-tools@official': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] },
    }), 'utf8')
    await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'review-tools@official': true } }), 'utf8')
    await writeFile(path.join(project, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'review-tools@official': true } }), 'utf8')
    await writeFile(path.join(project, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'review-tools@official': false } }), 'utf8')

    const [skill] = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'claude-code' })
    expect(skill).toEqual(expect.objectContaining({
      enabled: false,
      disabledReason: 'plugin',
      configurationSource: 'local',
      originConfigs: expect.arrayContaining([path.join(project, '.claude/settings.local.json')]),
    }))
  })

  it('applies Claude file-managed plugin policy after local settings and ordered drop-ins', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-claude-managed-settings-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const managed = path.join(home, 'managed-claude')
    const pluginRoot = path.join(claudeHome, 'plugins/cache/official/review-tools/1.0.0')
    const pluginSkill = path.join(pluginRoot, 'skills/review/SKILL.md')
    await mkdir(path.dirname(pluginSkill), { recursive: true })
    await mkdir(path.join(project, '.claude'), { recursive: true })
    await mkdir(path.join(claudeHome, 'plugins'), { recursive: true })
    await mkdir(path.join(managed, 'managed-settings.d'), { recursive: true })
    await writeFile(pluginSkill, '---\nname: review\n---\n', 'utf8')
    await writeFile(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({
      plugins: { 'review-tools@official': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] },
    }), 'utf8')
    await writeFile(path.join(project, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'review-tools@official': false } }), 'utf8')
    await writeFile(path.join(managed, 'managed-settings.json'), JSON.stringify({ enabledPlugins: { 'review-tools@official': false } }), 'utf8')
    await writeFile(path.join(managed, 'managed-settings.d/20-plugin-policy.json'), JSON.stringify({ enabledPlugins: { 'review-tools@official': true } }), 'utf8')

    const [skill] = await scanInstalledSkills({
      home, codexHome, claudeHome, project, runtime: 'claude-code', claudeManagedSettingsDirectory: managed,
    })
    expect(skill).toEqual(expect.objectContaining({
      enabled: true,
      configurationSource: 'managed',
      originConfigs: expect.arrayContaining([path.join(managed, 'managed-settings.d/20-plugin-policy.json')]),
    }))
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

  it('scans the default Windows Codex administrator Skill directory', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-windows-admin-scanner-'))
    temporaryDirectories.push(home)
    const programData = path.join(home, 'ProgramData')
    const adminSkill = path.join(programData, 'OpenAI', 'Codex', 'skills', 'admin-review', 'SKILL.md')
    await mkdir(path.dirname(adminSkill), { recursive: true })
    await writeFile(adminSkill, '---\nname: admin-review\n---\nReview system policy.\n', 'utf8')

    const definitions = await scanInstalledSkills({
      home,
      codexHome: path.join(home, '.codex'),
      claudeHome: path.join(home, '.claude'),
      project: path.join(home, 'project'),
      runtime: 'codex',
      platform: 'win32',
      environment: { ProgramData: programData },
    })

    expect(definitions).toContainEqual(expect.objectContaining({
      skillId: 'admin-review',
      sourcePath: adminSkill,
      configurationSource: 'admin',
      scope: 'admin',
    }))
  })

  it('emits one definition when scan roots alias the same physical Skill', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-physical-dedup-'))
    temporaryDirectories.push(home)
    const realDirectory = path.join(home, 'admin-skills')
    const aliasDirectory = path.join(home, 'admin-skills-alias')
    const skill = path.join(realDirectory, 'review/SKILL.md')
    await mkdir(path.dirname(skill), { recursive: true })
    await writeFile(skill, '---\nname: physical-review\n---\nReview once.\n', 'utf8')
    await symlink(realDirectory, aliasDirectory, 'junction')

    const definitions = await scanInstalledSkills({
      home,
      codexHome: path.join(home, '.codex'),
      claudeHome: path.join(home, '.claude'),
      project: path.join(home, 'project'),
      runtime: 'codex',
      codexAdminSkillsDirectories: [realDirectory, aliasDirectory],
    })

    expect(definitions.filter((item) => item.skillId === 'physical-review')).toEqual([
      expect.objectContaining({ sourcePath: skill }),
    ])
  })

  it('scans only the active Codex plugin version, preferring local over the highest version', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-active-plugin-version-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginBase = path.join(codexHome, 'plugins/cache/openai-curated-remote/review-tools')
    const oldSkill = path.join(pluginBase, '1.9.0/skills/old-review/SKILL.md')
    const prereleaseSkill = path.join(pluginBase, '1.10.0-beta.1/skills/prerelease-review/SKILL.md')
    const currentSkill = path.join(pluginBase, '1.10.0/skills/current-review/SKILL.md')
    await mkdir(path.dirname(oldSkill), { recursive: true })
    await mkdir(path.dirname(prereleaseSkill), { recursive: true })
    await mkdir(path.dirname(currentSkill), { recursive: true })
    await writeFile(oldSkill, '---\nname: old-review\n---\n', 'utf8')
    await writeFile(prereleaseSkill, '---\nname: prerelease-review\n---\n', 'utf8')
    await writeFile(currentSkill, '---\nname: current-review\n---\n', 'utf8')

    const versioned = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(versioned.map((skill) => skill.skillId)).toEqual(['current-review'])
    expect(versioned[0].skillVersion).toBe('1.10.0')

    const localSkill = path.join(pluginBase, 'local/skills/local-review/SKILL.md')
    await mkdir(path.dirname(localSkill), { recursive: true })
    await writeFile(localSkill, '---\nname: local-review\n---\n', 'utf8')
    const local = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(local.map((skill) => skill.skillId)).toEqual(['local-review'])
    expect(local[0].skillVersion).toBe('local')
  })

  it('chooses valid SemVer Codex plugin versions before invalid directory names', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-mixed-plugin-version-'))
    temporaryDirectories.push(home)
    const codexHome = path.join(home, '.codex')
    const claudeHome = path.join(home, '.claude')
    const project = path.join(home, 'project')
    const pluginCache = path.join(codexHome, 'plugins/cache/openai-curated-remote')
    const invalidFirstInvalid = path.join(pluginCache, 'invalid-first', '11x/skills/invalid-first-bad/SKILL.md')
    const invalidFirstValid = path.join(pluginCache, 'invalid-first', '10.0.0/skills/invalid-first-good/SKILL.md')
    const validFirstValid = path.join(pluginCache, 'valid-first', '10.0.0/skills/valid-first-good/SKILL.md')
    const validFirstInvalid = path.join(pluginCache, 'valid-first', '11x/skills/valid-first-bad/SKILL.md')
    const lexicalOld = path.join(pluginCache, 'lexical-only', 'alpha/skills/lexical-alpha/SKILL.md')
    const lexicalNew = path.join(pluginCache, 'lexical-only', 'zulu/skills/lexical-zulu/SKILL.md')
    const semverShapedValid = path.join(pluginCache, 'semver-shaped-invalid', '10.0.0/skills/semver-shaped-good/SKILL.md')
    const leadingZeroPrerelease = path.join(pluginCache, 'semver-shaped-invalid', '11.0.0-01/skills/leading-zero-bad/SKILL.md')
    const emptyPrereleaseIdentifier = path.join(pluginCache, 'semver-shaped-invalid', '12.0.0-alpha..1/skills/empty-identifier-bad/SKILL.md')
    await mkdir(path.dirname(invalidFirstInvalid), { recursive: true })
    await mkdir(path.dirname(invalidFirstValid), { recursive: true })
    await mkdir(path.dirname(validFirstValid), { recursive: true })
    await mkdir(path.dirname(validFirstInvalid), { recursive: true })
    await mkdir(path.dirname(lexicalOld), { recursive: true })
    await mkdir(path.dirname(lexicalNew), { recursive: true })
    await mkdir(path.dirname(semverShapedValid), { recursive: true })
    await mkdir(path.dirname(leadingZeroPrerelease), { recursive: true })
    await mkdir(path.dirname(emptyPrereleaseIdentifier), { recursive: true })
    await writeFile(invalidFirstInvalid, '---\nname: invalid-first-bad\n---\n', 'utf8')
    await writeFile(invalidFirstValid, '---\nname: invalid-first-good\n---\n', 'utf8')
    await writeFile(validFirstValid, '---\nname: valid-first-good\n---\n', 'utf8')
    await writeFile(validFirstInvalid, '---\nname: valid-first-bad\n---\n', 'utf8')
    await writeFile(lexicalOld, '---\nname: lexical-alpha\n---\n', 'utf8')
    await writeFile(lexicalNew, '---\nname: lexical-zulu\n---\n', 'utf8')
    await writeFile(semverShapedValid, '---\nname: semver-shaped-good\n---\n', 'utf8')
    await writeFile(leadingZeroPrerelease, '---\nname: leading-zero-bad\n---\n', 'utf8')
    await writeFile(emptyPrereleaseIdentifier, '---\nname: empty-identifier-bad\n---\n', 'utf8')

    const skills = await scanInstalledSkills({ home, codexHome, claudeHome, project, runtime: 'codex' })
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'invalid-first-good', skillVersion: '10.0.0' }))
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'valid-first-good', skillVersion: '10.0.0' }))
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'lexical-zulu', skillVersion: 'zulu' }))
    expect(skills).toContainEqual(expect.objectContaining({ skillId: 'semver-shaped-good', skillVersion: '10.0.0' }))
    expect(skills.some((skill) => skill.skillId.endsWith('-bad'))).toBe(false)
    expect(skills.some((skill) => skill.skillId === 'lexical-alpha')).toBe(false)
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

  it('resolves repository roots and scans parent plus administrator Skill locations', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-root-scan-'))
    temporaryDirectories.push(home)
    const repository = path.join(home, 'repository')
    const project = path.join(repository, 'packages', 'dashboard', 'src')
    const rootSkill = path.join(repository, '.agents/skills/root-review/SKILL.md')
    const packageSkill = path.join(repository, 'packages/dashboard/.agents/skills/package-review/SKILL.md')
    const adminDirectory = path.join(home, 'admin-skills')
    const adminSkill = path.join(adminDirectory, 'admin-review/SKILL.md')
    await mkdir(path.join(repository, '.git'), { recursive: true })
    await mkdir(project, { recursive: true })
    await mkdir(path.dirname(rootSkill), { recursive: true })
    await mkdir(path.dirname(packageSkill), { recursive: true })
    await mkdir(path.dirname(adminSkill), { recursive: true })
    await writeFile(rootSkill, '---\nname: root-review\n---\n', 'utf8')
    await writeFile(packageSkill, '---\nname: package-review\n---\n', 'utf8')
    await writeFile(adminSkill, '---\nname: admin-review\n---\n', 'utf8')

    const skills = await scanInstalledSkills({
      home,
      codexHome: path.join(home, '.codex'),
      claudeHome: path.join(home, '.claude'),
      project,
      runtime: 'codex',
      codexAdminSkillsDirectories: [adminDirectory],
    })

    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: 'root-review', configurationSource: 'project', projectRoot: repository }),
      expect.objectContaining({ skillId: 'package-review', configurationSource: 'project', projectRoot: repository }),
      expect.objectContaining({ skillId: 'admin-review', configurationSource: 'admin', projectRoot: repository }),
    ]))
  })

  it('classifies known Claude precedence without guessing external policy', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-claude-status-'))
    temporaryDirectories.push(home)
    const project = path.join(home, 'project')
    const personal = path.join(home, '.claude/skills/review/SKILL.md')
    const projectSkill = path.join(project, '.claude/skills/review/SKILL.md')
    const legacyCommand = path.join(project, '.claude/commands/review.md')
    const projectRules = path.join(project, 'CLAUDE.md')
    await mkdir(path.dirname(personal), { recursive: true })
    await mkdir(path.dirname(projectSkill), { recursive: true })
    await mkdir(path.dirname(legacyCommand), { recursive: true })
    await writeFile(projectRules, 'description: Private project instructions\nNever persist this body.\n', 'utf8')
    await writeFile(personal, '---\nname: review\n---\nPersonal review.\n', 'utf8')
    await writeFile(projectSkill, '---\nname: review\n---\nProject review.\n', 'utf8')
    await writeFile(legacyCommand, '---\nname: review\n---\nLegacy review.\n', 'utf8')

    const skills = await scanInstalledSkills({
      home,
      codexHome: path.join(home, '.codex'),
      claudeHome: path.join(home, '.claude'),
      project,
      runtime: 'claude-code',
    })
    const byPath = new Map(skills.map((skill) => [skill.sourcePath, skill]))

    expect(byPath.get(personal)).toEqual(expect.objectContaining({ status: 'active', configurationSource: 'user' }))
    expect(byPath.get(projectSkill)).toEqual(expect.objectContaining({ status: 'shadowed', shadowedBy: personal }))
    expect(byPath.get(legacyCommand)).toEqual(expect.objectContaining({ status: 'shadowed', shadowedBy: personal }))
    expect(byPath.get(projectRules)).toEqual(expect.objectContaining({ kind: 'rules', description: undefined }))
  })

  it('returns scan identity, coverage, permission errors, and partial Claude observability', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-scan-report-'))
    temporaryDirectories.push(home)
    const blocked = path.join(home, 'blocked-admin-skills')
    const project = path.join(home, 'project')
    await mkdir(project, { recursive: true })

    const report = await scanSkillInventory({
      home,
      codexHome: path.join(home, '.codex'),
      claudeHome: path.join(home, '.claude'),
      project,
      codexAdminSkillsDirectories: [blocked],
      inspectPath: async (location) => {
        if (location === blocked) throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
        return stat(location)
      },
    })

    expect(report.definitions).toBeInstanceOf(Array)
    expect(report.scan).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^scan_/),
      projectRoot: project,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      durationMs: expect.any(Number),
    }))
    expect(report.scan.coverage).toContainEqual(expect.objectContaining({
      directory: blocked,
      state: 'inaccessible',
    }))
    expect(report.scan.errors).toContainEqual(expect.objectContaining({ code: 'EACCES', path: blocked }))
    expect(report.scan.observability).toContainEqual(expect.objectContaining({
      runtime: 'claude-code',
      state: 'partial',
    }))
  })

  it('reports inaccessible nested directories as partial scan coverage', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'skillops-nested-scan-error-'))
    temporaryDirectories.push(home)
    const adminRoot = path.join(home, 'admin-skills')
    const blocked = path.join(adminRoot, 'blocked')
    const visibleSkill = path.join(adminRoot, 'visible', 'SKILL.md')
    const project = path.join(home, 'project')
    await Promise.all([
      mkdir(blocked, { recursive: true }),
      mkdir(path.dirname(visibleSkill), { recursive: true }),
      mkdir(project, { recursive: true }),
    ])
    await writeFile(visibleSkill, '---\nname: visible\n---\n')

    const report = await scanSkillInventory({
      home,
      codexHome: path.join(home, '.codex'),
      claudeHome: path.join(home, '.claude'),
      project,
      runtime: 'codex',
      codexAdminSkillsDirectories: [adminRoot],
      readDirectory: async (directory, options) => {
        if (directory === blocked) throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
        return readdir(directory, options)
      },
    })

    expect(report.definitions).toContainEqual(expect.objectContaining({ skillId: 'visible' }))
    expect(report.scan.coverage).toContainEqual(expect.objectContaining({ directory: adminRoot, state: 'partial' }))
    expect(report.scan.errors).toContainEqual(expect.objectContaining({
      code: 'EACCES',
      path: blocked,
      runtime: 'codex',
      source: 'global',
      configurationSource: 'admin',
    }))
  })
})
