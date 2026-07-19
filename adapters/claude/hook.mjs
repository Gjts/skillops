#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanInstalledSkills } from '../../app/backend/skill-scanner.mjs'

const adapterDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(adapterDir, '../..')
process.env.SKILLOPS_DATA_DIR ||= path.join(projectRoot, 'data')

const { appendEvent, appendUniqueDiscoveries, dataDir } = await import('../../app/backend/event-store.mjs')
const stateDir = path.join(dataDir, 'claude-state')

function safePathId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180)
}

function normalizeSkillName(value) {
  const first = typeof value === 'string' ? value.trim().split(/\s+/)[0] : ''
  return first.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 180) || 'unknown'
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

function commonFields(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  const promptId = input.prompt_id || input.turn_id
  return {
    runtime: 'claude-code',
    sessionId: input.session_id || 'unknown',
    turnId: promptId,
    promptId,
    model: input.model,
    project: path.basename(cwd),
    permissionMode: input.permission_mode,
  }
}

function sessionStateDirectory(sessionId) {
  return path.join(stateDir, safePathId(sessionId))
}

function knownSkillsFile(sessionId) {
  return path.join(sessionStateDirectory(sessionId), 'known-skills.json')
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output))
  return output
}

function skillNamesFromPaths(input) {
  const names = new Set()
  for (const text of collectStrings(input)) {
    for (const match of text.matchAll(/(?:^|[\\/])skills[\\/](?:[^\\/\s"']+[\\/])*([^\\/\s"']+)[\\/]SKILL\.md\b/gi)) {
      names.add(normalizeSkillName(match[1]))
    }
    for (const match of text.matchAll(/(?:^|[\\/])\.claude[\\/]commands[\\/]([^\\/\s"']+)\.md\b/gi)) {
      names.add(normalizeSkillName(match[1]))
    }
  }
  return [...names].filter((name) => name !== 'unknown')
}

function skillNameFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  for (const key of ['skill', 'skill_name', 'name', 'command']) {
    if (typeof toolInput[key] === 'string') return normalizeSkillName(toolInput[key])
  }
  return ''
}

async function readKnownSkills(sessionId) {
  try {
    return JSON.parse(await readFile(knownSkillsFile(sessionId), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeKnownSkills(sessionId, skills) {
  const file = knownSkillsFile(sessionId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(skills, null, 2)}\n`, 'utf8')
}

async function refreshKnownSkills(input) {
  const skills = await scanInstalledSkills({ project: input.cwd || process.cwd(), runtime: 'claude-code' })
  const available = skills.filter((skill) => skill.enabled !== false)
  await writeKnownSkills(commonFields(input).sessionId, available)
  return available
}

function findKnownSkill(skillId, skills = []) {
  const normalized = skillId.toLowerCase()
  const available = skills.filter((skill) => skill.enabled !== false)
  const exact = available.find((skill) => skill.skillId.toLowerCase() === normalized)
  if (exact || !normalized.includes(':')) return exact
  const [provider, ...parts] = normalized.split(':')
  const canonicalId = parts.join(':')
  return available.find((skill) => skill.skillId.toLowerCase() === canonicalId && skill.provider?.toLowerCase() === provider)
}

async function resolveSkill(name, input) {
  const skillId = normalizeSkillName(name)
  const sessionId = commonFields(input).sessionId
  let skills = await readKnownSkills(sessionId)
  let match = findKnownSkill(skillId, skills)
  if (!match) {
    skills = await refreshKnownSkills(input)
    match = findKnownSkill(skillId, skills)
  }
  return match || {
    skillId,
    skillVersion: 'unversioned',
    runtime: 'claude-code',
  }
}

async function claim(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  try {
    await writeFile(file, `${JSON.stringify(contents, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

function invocationDirectory(input, skill, detectionMethod) {
  const common = commonFields(input)
  const stableInvocation = detectionMethod === 'skill_tool' && input.tool_use_id
    ? input.tool_use_id
    : `${common.promptId || 'session'}:${detectionMethod}:${skill.skillId}`
  return path.join(sessionStateDirectory(common.sessionId), safePathId(stableInvocation))
}

async function activateSkill(skill, input, detectionMethod, confidence, extra = {}) {
  if (!skill.skillId || skill.skillId === 'unknown' || skill.enabled === false) return
  const common = commonFields(input)
  const startedAt = new Date().toISOString()
  const fields = {
    ...common,
    skillId: skill.skillId,
    skillVersion: skill.skillVersion || 'unversioned',
    sourcePath: skill.sourcePath,
    source: skill.source,
    provider: skill.provider,
    detectionMethod,
    confidence,
    toolUseId: input.tool_use_id,
    ...extra,
  }
  const directory = invocationDirectory(input, skill, detectionMethod)
  if (!await claim(path.join(directory, 'started.json'), { ...fields, startedAt })) return
  await appendEvent({ event: 'skill.matched', ...fields })
  await appendEvent({ event: 'skill.started', ...fields, timestamp: startedAt })
}

async function activeInvocations(sessionId) {
  const sessionDirectory = sessionStateDirectory(sessionId)
  try {
    const entries = await readdir(sessionDirectory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionDirectory, entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function completeActiveSkills(input, outcome, onlyCurrentPrompt = true) {
  const common = commonFields(input)
  for (const directory of await activeInvocations(common.sessionId)) {
    try {
      await stat(path.join(directory, 'completed.json'))
      continue
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    let active
    try {
      active = JSON.parse(await readFile(path.join(directory, 'started.json'), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (onlyCurrentPrompt && common.promptId && active.promptId && active.promptId !== common.promptId) continue
    const completedAt = new Date().toISOString()
    if (!await claim(path.join(directory, 'completed.json'), { completedAt, outcome })) continue
    const { startedAt, ...fields } = active
    await appendEvent({
      event: outcome === 'failed' ? 'skill.failed' : 'skill.completed',
      ...fields,
      timestamp: completedAt,
      outcome,
      durationMs: Math.max(0, Date.now() - new Date(startedAt).getTime()),
    })
  }
}

async function recordDiscoveries(input) {
  const skills = await scanInstalledSkills({ project: input.cwd || process.cwd(), runtime: 'claude-code' })
  await writeKnownSkills(commonFields(input).sessionId, skills.filter((skill) => skill.enabled !== false))
  await appendUniqueDiscoveries(skills, commonFields(input))
}

function toolFailed(input) {
  const result = input.tool_response ?? input.tool_result ?? input.tool_output ?? input.result
  if (!result || typeof result !== 'object') return false
  return result.success === false || result.is_error === true || result.isError === true ||
    (typeof result.exit_code === 'number' && result.exit_code !== 0) || Boolean(result.error)
}

async function handle(input) {
  const eventName = input.hook_event_name
  const common = commonFields(input)
  const hookMode = process.env.SKILLOPS_HOOK_MODE || 'default'

  if (eventName === 'SessionStart') {
    await appendEvent({ event: 'session.started', ...common, startSource: input.source })
    await recordDiscoveries(input)
  } else if (eventName === 'UserPromptSubmit') {
    await appendEvent({ event: 'prompt.submitted', ...common, promptLength: typeof input.prompt === 'string' ? input.prompt.length : 0 })
  } else if (eventName === 'UserPromptExpansion' && input.expansion_type === 'slash_command') {
    const skill = await resolveSkill(input.command_name, input)
    await activateSkill(skill, input, 'slash_command', 1, {
      commandSource: input.command_source,
      skillArgsLength: typeof input.command_args === 'string' ? input.command_args.length : 0,
    })
  } else if (eventName === 'PreToolUse') {
    const toolName = input.tool_name || 'unknown'
    if (!(toolName === 'Skill' && hookMode === 'generic')) {
      await appendEvent({ event: 'tool.started', ...common, toolName, toolUseId: input.tool_use_id })
    }
    if (toolName === 'Skill' && hookMode !== 'generic') {
      const name = skillNameFromToolInput(input.tool_input)
      if (name) await activateSkill(await resolveSkill(name, input), input, 'skill_tool', 1)
    } else if (toolName !== 'Skill') {
      for (const name of skillNamesFromPaths(input.tool_input)) {
        await activateSkill(await resolveSkill(name, input), input, 'skill_path', .92)
      }
    }
  } else if (eventName === 'PostToolUse') {
    await appendEvent({ event: 'tool.completed', ...common, toolName: input.tool_name || 'unknown', toolUseId: input.tool_use_id, outcome: toolFailed(input) ? 'failed' : 'success' })
  } else if (eventName === 'PostToolUseFailure') {
    await appendEvent({ event: 'tool.completed', ...common, toolName: input.tool_name || 'unknown', toolUseId: input.tool_use_id, outcome: 'failed' })
  } else if (eventName === 'SubagentStart') {
    await appendEvent({ event: 'subagent.started', ...common, subagentId: input.agent_id, subagentType: input.agent_type || 'unknown' })
  } else if (eventName === 'SubagentStop') {
    await appendEvent({ event: 'subagent.completed', ...common, subagentId: input.agent_id, subagentType: input.agent_type || 'unknown', outcome: 'unknown' })
  } else if (eventName === 'Stop') {
    await completeActiveSkills(input, 'unknown')
    await appendEvent({ event: 'turn.completed', ...common, outcome: 'unknown' })
  } else if (eventName === 'StopFailure') {
    await completeActiveSkills(input, 'failed')
    await appendEvent({ event: 'turn.completed', ...common, outcome: 'failed' })
  } else if (eventName === 'SessionEnd') {
    await completeActiveSkills(input, 'unknown', false)
    await appendEvent({ event: 'session.completed', ...common, outcome: 'unknown', reason: input.reason })
    await rm(sessionStateDirectory(common.sessionId), { recursive: true, force: true })
  }
}

async function reportAdapterError(error) {
  try {
    await mkdir(dataDir, { recursive: true })
    await appendFile(path.join(dataDir, 'claude-adapter-errors.log'), `${new Date().toISOString()} ${error?.stack || error}\n`, 'utf8')
  } catch {
    // Observability must never interrupt Claude Code.
  }
}

try {
  await handle(await readStdin())
} catch (error) {
  await reportAdapterError(error)
}
