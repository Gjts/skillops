// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { updateInstallation } from './install.mjs'

const temporaryDirectories = []

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runHook(input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('adapters/codex/hook.mjs')], {
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

describe('Codex hook installer', () => {
  it('emits a cross-shell Windows command', async () => {
    const codexHome = await temporaryDirectory('skillops-codex-home-')
    const hooksFile = path.join(codexHome, 'hooks.json')

    await updateInstallation({ codexHome })

    const installed = JSON.parse(await readFile(hooksFile, 'utf8'))
    const handler = installed.hooks.UserPromptSubmit[0].hooks[0]
    expect(handler.commandWindows).toMatch(/^node\s+"/)
    expect(handler.commandWindows).not.toMatch(/\bset\s+"SKILLOPS_ADAPTER=/i)
  })

  it('merges idempotently and removes only SkillOps handlers', async () => {
    const codexHome = await temporaryDirectory('skillops-codex-home-')
    const hooksFile = path.join(codexHome, 'hooks.json')
    await writeFile(hooksFile, JSON.stringify({
      description: 'Existing user hooks',
      hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'echo existing' }] }] },
    }))

    await updateInstallation({ codexHome })
    await updateInstallation({ codexHome })
    const installed = JSON.parse(await readFile(hooksFile, 'utf8'))
    expect(installed.description).toBe('Existing user hooks')
    expect(installed.hooks.PreToolUse.flatMap((group) => group.hooks).filter((hook) => hook.command.includes('skillops-codex-hook'))).toHaveLength(1)
    expect(installed.hooks.PreToolUse.flatMap((group) => group.hooks).some((hook) => hook.command === 'echo existing')).toBe(true)
    expect(Object.keys(installed.hooks)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']))

    await updateInstallation({ codexHome, uninstall: true })
    const uninstalled = JSON.parse(await readFile(hooksFile, 'utf8'))
    expect(JSON.stringify(uninstalled)).not.toContain('skillops-codex-hook')
    expect(uninstalled.hooks.PreToolUse[0].hooks[0].command).toBe('echo existing')
  })
})

describe('Codex lifecycle adapter', () => {
  it('does not activate explicitly disabled plugin Skills', async () => {
    const root = await temporaryDirectory('skillops-codex-disabled-plugin-')
    const codexHome = path.join(root, 'codex-home')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const skillFile = path.join(codexHome, 'plugins/cache/openai-curated-remote/cloudflare/1.0.0/skills/wrangler/SKILL.md')
    await mkdir(path.dirname(skillFile), { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(skillFile, '---\nname: wrangler\nversion: 1.0.0\n---\nWrangler.\n')
    await writeFile(path.join(codexHome, 'config.toml'), '[plugins."cloudflare@openai-curated"]\nenabled = false\n')

    await runHook({
      session_id: 'disabled-session',
      turn_id: 'disabled-turn',
      cwd: project,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Use $wrangler for this deployment.',
    }, { CODEX_HOME: codexHome, SKILLOPS_DATA_DIR: dataDir })

    const raw = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    expect(events).toContainEqual(expect.objectContaining({ event: 'skill.discovered', skillId: 'wrangler', enabled: false }))
    expect(events.some((event) => event.skillId === 'wrangler' && event.event === 'skill.started')).toBe(false)
  })

  it('matches an explicit Skill reference before sentence punctuation', async () => {
    const root = await temporaryDirectory('skillops-codex-punctuation-')
    const codexHome = path.join(root, 'codex-home')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const skillFile = path.join(codexHome, 'skills', 'diagnosing-bugs', 'SKILL.md')
    await mkdir(path.dirname(skillFile), { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(skillFile, '---\nname: diagnosing-bugs\nversion: 1.0.0\n---\nDiagnose bugs.\n')

    await runHook({
      session_id: 'punctuation-session',
      turn_id: 'punctuation-turn',
      cwd: project,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Use $diagnosing-bugs. Reply when done.',
    }, { CODEX_HOME: codexHome, SKILLOPS_DATA_DIR: dataDir })

    const raw = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    expect(events.some((event) => event.event === 'skill.started' && event.skillId === 'diagnosing-bugs')).toBe(true)
  })

  it('observes explicit and path-based Skill invocation without storing prompt content', async () => {
    const root = await temporaryDirectory('skillops-codex-adapter-')
    const codexHome = path.join(root, 'codex-home')
    const dataDir = path.join(root, 'data')
    const project = path.join(root, 'project')
    const databaseSkill = path.join(codexHome, 'skills', 'database-migration', 'SKILL.md')
    const testingSkill = path.join(codexHome, 'skills', 'test-generator', 'SKILL.md')
    await mkdir(path.dirname(databaseSkill), { recursive: true })
    await mkdir(path.dirname(testingSkill), { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(databaseSkill, '---\nname: database-migration\nversion: 1.3.0\n---\nSafe migrations.\n')
    await writeFile(testingSkill, '---\nname: test-generator\nversion: 1.0.4\n---\nGenerate tests.\n')
    const environment = { CODEX_HOME: codexHome, SKILLOPS_DATA_DIR: dataDir }
    const common = { session_id: 'session-1', cwd: project, model: 'gpt-test', permission_mode: 'default' }

    await runHook({ ...common, hook_event_name: 'SessionStart', source: 'startup' }, environment)
    await runHook({ ...common, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'Use $database-migration for this change' }, environment)
    await runHook({ ...common, turn_id: 'turn-1', hook_event_name: 'Stop' }, environment)
    await runHook({ ...common, turn_id: 'turn-2', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `sed -n 1,80p ${testingSkill}` } }, environment)
    await runHook({ ...common, turn_id: 'turn-2', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 0 } }, environment)
    await runHook({ ...common, turn_id: 'turn-2', hook_event_name: 'SubagentStart', agent_type: 'reviewer' }, environment)
    await runHook({ ...common, turn_id: 'turn-2', hook_event_name: 'SubagentStop', agent_type: 'reviewer' }, environment)
    await runHook({ ...common, turn_id: 'turn-2', hook_event_name: 'Stop' }, environment)

    const raw = await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')
    const events = raw.trim().split('\n').map((line) => JSON.parse(line))
    expect(raw).not.toContain('Use $database-migration for this change')
    expect(events.filter((event) => event.event === 'skill.discovered' && event.sourcePath.startsWith(root))).toHaveLength(2)
    expect(events.some((event) => event.event === 'skill.started' && event.skillId === 'database-migration' && event.detectionMethod === 'explicit_prompt' && event.confidence === 1)).toBe(true)
    expect(events.some((event) => event.event === 'skill.started' && event.skillId === 'test-generator' && event.detectionMethod === 'skill_path')).toBe(true)
    expect(events.filter((event) => event.event === 'skill.completed').every((event) => event.outcome === 'unknown')).toBe(true)
    expect(events.some((event) => event.event === 'tool.completed' && event.outcome === 'success')).toBe(true)
    expect(events.some((event) => event.event === 'subagent.started' && event.subagentType === 'reviewer')).toBe(true)
    expect(events.some((event) => event.event === 'subagent.completed' && event.subagentType === 'reviewer')).toBe(true)
  })
})
