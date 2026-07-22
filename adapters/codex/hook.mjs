#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanInstalledSkills } from '../../app/backend/skill-scanner.mjs'

const adapterDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(adapterDir, '../..')
process.env.SKILLOPS_DATA_DIR ||= path.join(projectRoot, 'data')

const { anonymizeSessionId, appendEvent, appendUniqueDiscoveries, dataDir } = await import('../../app/backend/event-store.mjs')
const stateDir = path.join(dataDir, 'codex-state')

function safeId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160)
}

function definitionIdentity(skill) {
  return createHash('sha256').update(JSON.stringify([
    skill.kind || 'skill',
    skill.skillId,
    skill.sourcePath || '',
    skill.source || '',
    skill.provider || '',
  ])).digest('hex')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

async function readState(sessionId) {
  try {
    return JSON.parse(await readFile(path.join(stateDir, `${safeId(sessionId)}.json`), 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { knownSkills: [], active: {} }
  }
}

async function writeState(sessionId, state) {
  await mkdir(stateDir, { recursive: true })
  const file = path.join(stateDir, `${safeId(sessionId)}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

async function migrateLegacyState(rawSessionId, sessionId) {
  if (rawSessionId === sessionId) return
  const legacyFile = path.join(stateDir, `${safeId(rawSessionId)}.json`)
  let legacy
  try {
    legacy = JSON.parse(await readFile(legacyFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const current = await readState(sessionId)
  const active = { ...(legacy.active || {}), ...(current.active || {}) }
  for (const invocation of Object.values(active)) {
    if (invocation && typeof invocation === 'object') invocation.sessionId = sessionId
  }
  await writeState(sessionId, {
    knownSkills: current.knownSkills?.length ? current.knownSkills : (legacy.knownSkills || []),
    active,
  })
  await rm(legacyFile, { force: true })
}

function commonFields(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  return {
    runtime: 'codex',
    sessionId: input.session_id || 'unknown',
    turnId: input.turn_id,
    model: input.model,
    project: path.basename(cwd),
    permissionMode: input.permission_mode,
  }
}

function nestedString(input, names) {
  if (!input || typeof input !== 'object') return ''
  for (const [key, value] of Object.entries(input)) {
    if (names.has(key) && typeof value === 'string') return value
  }
  for (const value of Object.values(input)) {
    if (value && typeof value === 'object') {
      const found = nestedString(value, names)
      if (found) return found
    }
  }
  return ''
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output))
  return output
}

function findKnownSkill(name, knownSkills, kinds) {
  const normalized = name.toLowerCase()
  const available = knownSkills.filter((skill) => skill.enabled !== false && (!kinds || kinds.includes(skill.kind)))
  const exact = available.find((skill) => skill.skillId.toLowerCase() === normalized)
  if (exact || !normalized.includes(':')) return exact
  const [provider, ...parts] = normalized.split(':')
  const skillId = parts.join(':')
  return available.find((skill) => skill.skillId.toLowerCase() === skillId && skill.provider?.toLowerCase() === provider)
}

function explicitSkillNames(prompt, knownSkills) {
  const matches = [
    ...[...prompt.matchAll(/\$([a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9_-])?)/g)]
      .map((match) => findKnownSkill(match[1], knownSkills)),
    ...[...prompt.matchAll(/(?:^|\s)\/prompts:([a-zA-Z0-9][a-zA-Z0-9_.-]*)\b/g)]
      .map((match) => findKnownSkill(match[1], knownSkills, ['command'])),
  ]
  return [...new Map(matches.filter(Boolean).map((skill) => [`${skill.kind}:${skill.skillId}`, skill])).values()]
}

function skillsFromPaths(input, knownSkills) {
  const detected = new Map()
  for (const text of collectStrings(input)) {
    const matches = text.matchAll(/(?:^|[\\/])skills[\\/](?:[^\\/\s"']+[\\/])*([^\\/\s"']+)[\\/]SKILL\.md\b/gi)
    for (const match of matches) {
      const id = match[1]
      const skill = findKnownSkill(id, knownSkills)
      if (skill) detected.set(skill.skillId.toLowerCase(), skill)
    }
  }
  return [...detected.values()]
}

function toolFailed(input) {
  const result = input.tool_response ?? input.tool_result ?? input.result
  if (!result || typeof result !== 'object') return false
  return result.success === false || result.is_error === true || result.isError === true ||
    (typeof result.exit_code === 'number' && result.exit_code !== 0) || Boolean(result.error)
}

async function recordDiscoveries(input, state) {
  const skills = (await scanInstalledSkills({ project: input.cwd || process.cwd(), runtime: 'codex' }))
    .filter((skill) => ['skill', 'command', 'rules', 'agent'].includes(skill.kind))
  await appendUniqueDiscoveries(skills, commonFields(input))
  state.knownSkills = skills.filter((skill) => skill.enabled !== false)
  return state.knownSkills
}

async function activateSkill(skill, input, state, detectionMethod, confidence) {
  if (!skill || skill.enabled === false) return
  const common = commonFields(input)
  const activeKey = `${common.turnId || 'session'}:${definitionIdentity(skill)}`
  if (state.active[activeKey]) return
  const startedAt = new Date().toISOString()
  const fields = {
    ...common,
    skillId: skill.skillId,
    skillVersion: skill.skillVersion || 'unversioned',
    kind: skill.kind,
    sourcePath: skill.sourcePath,
    source: skill.source,
    provider: skill.provider,
    detectionMethod,
    confidence,
  }
  await appendEvent({ event: 'skill.matched', ...fields })
  await appendEvent({ event: 'skill.started', ...fields, timestamp: startedAt })
  state.active[activeKey] = { ...fields, startedAt }
}

async function handle(input) {
  const rawSessionId = String(input.session_id || 'unknown')
  input.session_id = await anonymizeSessionId(rawSessionId)
  await migrateLegacyState(rawSessionId, input.session_id)
  const eventName = input.hook_event_name
  const common = commonFields(input)
  const state = await readState(common.sessionId)

  if (eventName !== 'SessionStart' && !state.knownSkills.length &&
    (eventName === 'UserPromptSubmit' || eventName === 'PreToolUse')) {
    await recordDiscoveries(input, state)
  }

  if (eventName === 'SessionStart') {
    await appendEvent({ event: 'session.started', ...common, startSource: input.source })
    await recordDiscoveries(input, state)
  } else if (eventName === 'UserPromptSubmit') {
    const prompt = nestedString(input, new Set(['prompt', 'user_prompt', 'text']))
    await appendEvent({ event: 'prompt.submitted', ...common, promptLength: prompt.length })
    for (const skill of explicitSkillNames(prompt, state.knownSkills)) {
      await activateSkill(skill, input, state, 'explicit_prompt', 1)
    }
  } else if (eventName === 'PreToolUse') {
    const toolName = input.tool_name || input.tool?.name || 'unknown'
    await appendEvent({ event: 'tool.started', ...common, toolName })
    for (const skill of skillsFromPaths(input.tool_input ?? input, state.knownSkills)) {
      await activateSkill(skill, input, state, 'skill_path', .92)
    }
  } else if (eventName === 'PostToolUse') {
    const toolName = input.tool_name || input.tool?.name || 'unknown'
    await appendEvent({ event: 'tool.completed', ...common, toolName, outcome: toolFailed(input) ? 'failed' : 'success' })
  } else if (eventName === 'SubagentStart') {
    const subagentType = input.agent_type || input.subagent_type || input.agent_name || 'unknown'
    await appendEvent({ event: 'subagent.started', ...common, subagentType })
    await activateSkill(findKnownSkill(subagentType, state.knownSkills, ['agent']), input, state, 'hook', 1)
  } else if (eventName === 'SubagentStop') {
    await appendEvent({ event: 'subagent.completed', ...common, subagentType: input.agent_type || input.subagent_type || input.agent_name || 'unknown', outcome: 'unknown' })
  } else if (eventName === 'Stop') {
    const now = Date.now()
    for (const [key, active] of Object.entries(state.active)) {
      if (common.turnId && active.turnId && active.turnId !== common.turnId) continue
      await appendEvent({
        event: 'skill.completed',
        ...active,
        outcome: 'unknown',
        durationMs: Math.max(0, now - new Date(active.startedAt).getTime()),
      })
      delete state.active[key]
    }
    await appendEvent({ event: 'turn.completed', ...common, outcome: 'unknown' })
  }

  await writeState(common.sessionId, state)
}

async function reportAdapterError(error) {
  try {
    await mkdir(dataDir, { recursive: true })
    await appendFile(path.join(dataDir, 'codex-adapter-errors.log'), `${new Date().toISOString()} ${error?.stack || error}\n`, 'utf8')
  } catch {
    // Telemetry must never interrupt Codex.
  }
}

try {
  await handle(await readStdin())
} catch (error) {
  await reportAdapterError(error)
}
