// @vitest-environment node
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanInstalledSkills } from '../../app/backend/skill-scanner.mjs'
import { resolveEffectiveSettingsFile } from './config.mjs'
import { resolveSettingsFile, updateInstallation } from './install.mjs'

const temporaryDirectories = []

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runHook(input, environment, hookMode = 'default') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve('adapters/claude/hook.mjs'),
      '--adapter=skillops-claude-hook',
      `--hook-mode=${hookMode}`,
    ], {
      cwd: input.cwd,
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Hook exited ${code}: ${stderr}`)))
    child.stdin.end(JSON.stringify(input))
  })
}

function runInstaller(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('adapters/claude/install.mjs'), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`Installer exited ${code}: ${stderr}`)))
  })
}

describe('Claude Code hook installer', () => {
  it('redacts existing environment credentials from dry-run output', async () => {
    const claudeHome = await temporaryDirectory('skillops-claude-dry-run-')
    const secret = 'do-not-print-this-auth-token'
    await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: secret },
    }))

    const { stdout } = await runInstaller(['--dry-run', '--claude-home', claudeHome])
    expect(stdout).not.toContain(secret)
    expect(stdout).toContain('[REDACTED]')
  })

  it('merges idempotently and removes only SkillOps handlers', async () => {
    const claudeHome = await temporaryDirectory('skillops-claude-home-')
    const settingsFile = path.join(claudeHome, 'settings.json')
    await writeFile(settingsFile, JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] }] },
    }))

    await updateInstallation({ claudeHome })
    await updateInstallation({ claudeHome })
    const installed = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(installed.permissions.allow).toEqual(['Read'])
    expect(installed.hooks.PreToolUse.flatMap((group) => group.hooks).filter((hook) => hook.command.includes('skillops-claude-hook'))).toHaveLength(2)
    const skillOpsCommands = Object.values(installed.hooks)
      .flatMap((groups) => groups)
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command)
      .filter((command) => command.includes('skillops-claude-hook'))
    expect(skillOpsCommands.every((command) => !command.includes('SKILLOPS_HOOK_MODE='))).toBe(true)
    expect(skillOpsCommands.some((command) => command.includes('--hook-mode=generic'))).toBe(true)
    expect(installed.hooks.PreToolUse.flatMap((group) => group.hooks).some((hook) => hook.command === 'echo existing')).toBe(true)
    expect(Object.keys(installed.hooks)).toEqual(expect.arrayContaining([
      'SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse',
      'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd',
    ]))
    expect(installed.hooks.UserPromptSubmit[0].hooks[0].async).toBe(true)
    expect(installed.hooks.PreToolUse.some((group) => group.matcher === '^Skill$')).toBe(true)

    await updateInstallation({ claudeHome, uninstall: true })
    const uninstalled = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(JSON.stringify(uninstalled)).not.toContain('skillops-claude-hook')
    expect(uninstalled.hooks.PreToolUse[0].hooks[0].command).toBe('echo existing')
    expect(uninstalled.permissions.allow).toEqual(['Read'])
  })

  it('respects CLAUDE_CONFIG_DIR for settings and global Skill discovery', async () => {
    const configDirectory = await temporaryDirectory('skillops-claude-config-')
    const skillFile = path.join(configDirectory, 'skills', 'config-dir-skill', 'SKILL.md')
    await mkdir(path.dirname(skillFile), { recursive: true })
    await writeFile(skillFile, '---\nname: config-dir-skill\nversion: 1.0.0\n---\nConfigured Skill.\n')
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDirectory
    try {
      expect(resolveSettingsFile()).toBe(path.join(configDirectory, 'settings.json'))
      const skills = await scanInstalledSkills({ runtime: 'claude-code' })
      expect(skills.some((skill) => skill.skillId === 'config-dir-skill' && skill.sourcePath === skillFile)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it('uses the Claude directory configured by CC Switch when no explicit override exists', async () => {
    const home = await temporaryDirectory('skillops-cc-switch-home-')
    const claudeHome = path.join(home, 'custom-claude')
    const ccSwitchHome = path.join(home, '.cc-switch')
    await mkdir(ccSwitchHome, { recursive: true })
    await writeFile(path.join(ccSwitchHome, 'settings.json'), JSON.stringify({
      claude_config_dir: claudeHome,
    }))

    const options = { home, ccSwitchHome, environment: {} }
    expect(await resolveEffectiveSettingsFile(options)).toBe(path.join(claudeHome, 'settings.json'))
    const installed = await updateInstallation(options)
    expect(installed.file).toBe(path.join(claudeHome, 'settings.json'))
    expect(JSON.parse(await readFile(installed.file, 'utf8')).hooks.PreToolUse).toBeDefined()
  })
})

describe('Claude Code lifecycle adapter', () => {
  it('resolves namespaced plugin invocations to the installed canonical Skill', async () => {
    const root = await temporaryDirectory('skillops-claude-plugin-alias-')
    const claudeHome = path.join(root, 'claude-home')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const pluginRoot = path.join(claudeHome, 'plugins/cache/official/superpowers/6.1.1')
    const skillFile = path.join(pluginRoot, 'skills/brainstorming/SKILL.md')
    await mkdir(path.dirname(skillFile), { recursive: true })
    await mkdir(path.join(claudeHome, 'plugins'), { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(skillFile, '---\nname: brainstorming\n---\nBrainstorm.\n')
    await writeFile(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'superpowers@official': [{ scope: 'user', installPath: pluginRoot, version: '6.1.1' }] },
    }))
    const environment = { CLAUDE_CONFIG_DIR: claudeHome, SKILLOPS_DATA_DIR: dataDir }
    const common = { session_id: 'plugin-session', cwd: project, permission_mode: 'default' }

    await runHook({ ...common, hook_event_name: 'SessionStart', source: 'startup' }, environment)
    await runHook({
      ...common,
      prompt_id: 'plugin-prompt',
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_use_id: 'plugin-tool',
      tool_input: { skill: 'superpowers:brainstorming' },
    }, environment, 'exact')

    const raw = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    expect(events).toContainEqual(expect.objectContaining({
      event: 'skill.started',
      skillId: 'brainstorming',
      skillVersion: '6.1.1',
      detectionMethod: 'skill_tool',
    }))
    expect(events.some((event) => event.skillId === 'superpowers:brainstorming')).toBe(false)
  })

  it('migrates legacy raw-session state before completing active Skills', async () => {
    const root = await temporaryDirectory('skillops-claude-state-migration-')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const rawSessionId = 'legacy-claude-session'
    const invocation = path.join(dataDir, 'claude-state', rawSessionId, 'prompt-1_skill_tool_review')
    await mkdir(invocation, { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(path.join(invocation, 'started.json'), JSON.stringify({
      runtime: 'claude-code',
      sessionId: rawSessionId,
      promptId: 'prompt-1',
      turnId: 'prompt-1',
      skillId: 'review',
      skillVersion: '1.0.0',
      startedAt: '2026-07-22T00:00:00.000Z',
    }))

    await runHook({
      session_id: rawSessionId,
      prompt_id: 'prompt-1',
      cwd: project,
      hook_event_name: 'Stop',
    }, { SKILLOPS_DATA_DIR: dataDir })

    const events = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')
    expect(events).not.toContain(rawSessionId)
    expect(events).toContain('"event":"skill.completed"')
    await expect(access(path.join(dataDir, 'claude-state', rawSessionId))).rejects.toMatchObject({ code: 'ENOENT' })
    const [stateDirectory] = await readdir(path.join(dataDir, 'claude-state'))
    expect(stateDirectory).toMatch(/^hmac-sha256_[a-f0-9]{64}$/)
    expect(await readFile(path.join(dataDir, 'claude-state', stateDirectory, 'prompt-1_skill_tool_review', 'started.json'), 'utf8')).not.toContain(rawSessionId)
  })

  it('observes direct and model-invoked Skills without storing sensitive payloads', async () => {
    const root = await temporaryDirectory('skillops-claude-adapter-')
    const claudeHome = path.join(root, 'claude-home')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const reviewSkill = path.join(claudeHome, 'skills', 'code-review', 'SKILL.md')
    const migrationSkill = path.join(project, '.claude', 'skills', 'database-migration', 'SKILL.md')
    const legacyCommand = path.join(claudeHome, 'commands', 'deploy-preview.md')
    await mkdir(path.dirname(reviewSkill), { recursive: true })
    await mkdir(path.dirname(migrationSkill), { recursive: true })
    await mkdir(path.dirname(legacyCommand), { recursive: true })
    await writeFile(reviewSkill, '---\nname: code-review\nversion: 2.0.0\n---\nReview code.\n')
    await writeFile(migrationSkill, '---\nname: database-migration\nversion: 1.3.0\n---\nSafe migrations.\n')
    await writeFile(legacyCommand, '---\nversion: 0.8.0\n---\nDeploy a preview.\n')
    const environment = { CLAUDE_CONFIG_DIR: claudeHome, SKILLOPS_DATA_DIR: dataDir }
    const common = { session_id: 'session-claude-1', cwd: project, permission_mode: 'default' }

    await runHook({ ...common, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-test' }, environment)
    await rm(reviewSkill)
    await runHook({ ...common, prompt_id: 'prompt-1', hook_event_name: 'UserPromptSubmit', prompt: 'private customer request' }, environment)
    await runHook({
      ...common,
      prompt_id: 'prompt-1',
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'code-review',
      command_args: 'do not persist these private arguments',
      command_source: 'user',
      prompt: '/code-review do not persist these private arguments',
    }, environment, 'exact')
    await runHook({
      ...common,
      prompt_id: 'prompt-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_use_id: 'tool-skill-1',
      tool_input: { skill: 'database-migration', args: 'private database details' },
    }, environment, 'exact')
    await runHook({
      ...common,
      prompt_id: 'prompt-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_use_id: 'tool-skill-generic',
      tool_input: { skill: 'database-migration' },
    }, environment, 'generic')
    await runHook({ ...common, prompt_id: 'prompt-1', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_use_id: 'tool-skill-1', tool_output: 'private output' }, environment)
    await runHook({ ...common, prompt_id: 'prompt-1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'tool-failed-1', error: 'private error details' }, environment)
    await runHook({ ...common, prompt_id: 'prompt-1', hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'Explore' }, environment)
    await runHook({ ...common, prompt_id: 'prompt-1', hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'Explore', last_assistant_message: 'private agent result' }, environment)
    await runHook({ ...common, prompt_id: 'prompt-1', hook_event_name: 'Stop' }, environment)
    await runHook({ ...common, prompt_id: 'prompt-paths', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'path-tool-1', tool_input: { file_path: migrationSkill } }, environment, 'generic')
    await runHook({ ...common, prompt_id: 'prompt-paths', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'path-tool-2', tool_input: { path: migrationSkill } }, environment, 'generic')
    await runHook({ ...common, prompt_id: 'prompt-paths', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'path-tool-3', tool_input: { command: `inspect ${migrationSkill} and ${reviewSkill}` } }, environment, 'generic')
    await runHook({ ...common, prompt_id: 'prompt-paths', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'business-failure', tool_response: { exit_code: 1 } }, environment)
    await runHook({ ...common, prompt_id: 'prompt-paths', hook_event_name: 'Stop' }, environment)
    await runHook({
      ...common,
      prompt_id: 'prompt-2',
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'deploy-preview',
      command_args: 'private failed invocation',
      command_source: 'user',
    }, environment, 'exact')
    await runHook({ ...common, prompt_id: 'prompt-2', hook_event_name: 'StopFailure', error: 'private API error' }, environment)
    await runHook({ ...common, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, environment)

    const raw = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    expect(raw).not.toContain('private customer request')
    expect(raw).not.toContain(common.session_id)
    expect(events.filter((event) => event.sessionId).every((event) => /^hmac-sha256:[a-f0-9]{64}$/.test(event.sessionId))).toBe(true)
    expect(raw).not.toContain('private arguments')
    expect(raw).not.toContain('private database details')
    expect(raw).not.toContain('private output')
    expect(raw).not.toContain('private error details')
    expect(raw).not.toContain('private agent result')
    expect(raw).not.toContain('private failed invocation')
    expect(raw).not.toContain('private API error')
    expect(events.filter((event) => event.event === 'skill.discovered')).toHaveLength(3)
    expect(events.some((event) => event.event === 'skill.discovered' && event.skillId === 'deploy-preview')).toBe(true)
    expect(events.some((event) => event.event === 'skill.started' && event.skillId === 'code-review' && event.skillVersion === '2.0.0' && event.detectionMethod === 'slash_command' && event.confidence === 1)).toBe(true)
    expect(events.some((event) => event.event === 'skill.started' && event.skillId === 'database-migration' && event.detectionMethod === 'skill_tool' && event.toolUseId === 'tool-skill-1')).toBe(true)
    expect(events.some((event) => event.toolUseId === 'tool-skill-generic')).toBe(false)
    expect(events.filter((event) => event.event === 'skill.started' && event.skillId === 'database-migration' && event.detectionMethod === 'skill_path')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'skill.started' && event.skillId === 'code-review' && event.detectionMethod === 'skill_path')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'skill.completed')).toHaveLength(4)
    expect(events.filter((event) => event.event === 'skill.completed').every((event) => event.outcome === 'unknown')).toBe(true)
    expect(events.some((event) => event.event === 'skill.failed' && event.skillId === 'deploy-preview' && event.outcome === 'failed')).toBe(true)
    expect(events.some((event) => event.event === 'tool.completed' && event.toolUseId === 'tool-failed-1' && event.outcome === 'failed')).toBe(true)
    expect(events.some((event) => event.event === 'tool.completed' && event.toolUseId === 'business-failure' && event.outcome === 'failed')).toBe(true)
    expect(events.some((event) => event.event === 'subagent.started' && event.subagentId === 'agent-1')).toBe(true)
    expect(events.some((event) => event.event === 'session.completed' && event.reason === 'prompt_input_exit')).toBe(true)
    await expect(access(path.join(dataDir, 'claude-state', 'session-claude-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('records Workflow and Agent lifecycles while keeping Rules discovery-only', async () => {
    const root = await temporaryDirectory('skillops-claude-artifacts-')
    const claudeHome = path.join(root, 'claude-home')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const workflow = path.join(claudeHome, 'commands/review.md')
    const agent = path.join(project, '.claude/agents/Explore.md')
    const scopedRules = path.join(project, '.claude/CLAUDE.md')
    await mkdir(path.dirname(workflow), { recursive: true })
    await mkdir(path.dirname(agent), { recursive: true })
    await mkdir(path.dirname(scopedRules), { recursive: true })
    await writeFile(workflow, '---\ndescription: Review changes\n---\nReview carefully.\n')
    await writeFile(agent, '---\nname: Explore\ndescription: Explore the codebase\n---\nExplore carefully.\n')
    await writeFile(path.join(project, 'CLAUDE.md'), '# Project rules\n')
    await writeFile(scopedRules, '# Scoped project rules\n')
    const environment = { CLAUDE_CONFIG_DIR: claudeHome, SKILLOPS_DATA_DIR: dataDir }
    const common = { session_id: 'artifact-session', prompt_id: 'artifact-prompt', cwd: project }

    await runHook({ ...common, hook_event_name: 'SessionStart', source: 'startup' }, environment)
    await runHook({ ...common, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'review' }, environment, 'exact')
    await runHook({ ...common, hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'Explore' }, environment)
    await runHook({ ...common, hook_event_name: 'Stop' }, environment)

    const events = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'skill.started', skillId: 'review', kind: 'command', detectionMethod: 'slash_command' }),
      expect.objectContaining({ event: 'skill.started', skillId: 'Explore', kind: 'agent', detectionMethod: 'hook' }),
    ]))
    expect(events.filter((event) => event.event === 'skill.discovered' && event.skillId === 'CLAUDE' && event.kind === 'rules')).toHaveLength(2)
    expect(events.some((event) => ['skill.matched', 'skill.started', 'skill.completed', 'skill.failed'].includes(event.event) && event.kind === 'rules')).toBe(false)
  })
})
