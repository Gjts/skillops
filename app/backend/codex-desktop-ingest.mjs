import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { anonymizeEventSession, appendEvents, readEvents } from './event-store.mjs'
import { scanInstalledSkills } from './skill-scanner.mjs'

const desktopSources = new Set(['vscode', 'desktop', 'codex-desktop'])
const fileStates = new Map()
let syncQueue = Promise.resolve()
let skillCache

function canonicalPath(value) {
  const normalized = path.normalize(String(value || '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function stableId(event, sessionId, turnId, skillId = '') {
  return ['codex-desktop', sessionId || 'unknown', turnId || 'session', skillId || 'none', event].join(':')
}

function projectName(cwd) {
  return typeof cwd === 'string' && cwd ? path.basename(cwd) : undefined
}

function parserState(knownSkills = []) {
  return {
    active: new Map(),
    currentTurn: undefined,
    desktop: undefined,
    knownByPath: new Map(knownSkills.map((skill) => [canonicalPath(skill.sourcePath), skill])),
    session: undefined,
  }
}

function skillPaths(value) {
  if (typeof value !== 'string' || !value.includes('SKILL.md')) return []
  const text = value.replace(/\\{2,}/g, '\\')
  const found = new Set()
  const quoted = /(['"])([^'"\r\n]*?[\\/]skills[\\/][^'"\r\n]*?[\\/]SKILL\.md)\1/gi
  const unquoted = /((?:[a-zA-Z]:)?[^\s'"`;,()]*[\\/]skills[\\/][^\s'"`;,()]*[\\/]SKILL\.md)/gi
  for (const expression of [quoted, unquoted]) {
    for (const match of text.matchAll(expression)) {
      const candidate = match[2] || match[1]
      if (candidate) found.add(path.normalize(candidate))
    }
  }
  return [...found]
}

function readJavaScriptString(source, start) {
  const quote = source[start]
  if (!['"', "'", '`'].includes(quote)) return undefined
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === quote) return { value, end: index + 1 }
    if (character !== '\\') {
      value += character
      continue
    }
    index += 1
    if (index >= source.length) break
    const escaped = source[index]
    value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[escaped] ?? escaped
  }
  return undefined
}

function toolCallArguments(source, toolName) {
  const calls = []
  for (let index = 0; index < source.length;) {
    if (['"', "'", '`'].includes(source[index])) {
      const string = readJavaScriptString(source, index)
      index = string?.end || source.length
      continue
    }
    if (!source.startsWith(toolName, index)) {
      index += 1
      continue
    }
    let cursor = index + toolName.length
    while (/\s/.test(source[cursor] || '')) cursor += 1
    if (source[cursor] !== '(') {
      index = cursor
      continue
    }
    const argumentStart = cursor + 1
    let depth = 1
    cursor += 1
    while (cursor < source.length && depth) {
      if (['"', "'", '`'].includes(source[cursor])) {
        const string = readJavaScriptString(source, cursor)
        cursor = string?.end || source.length
        continue
      }
      if (source[cursor] === '(') depth += 1
      else if (source[cursor] === ')') depth -= 1
      cursor += 1
    }
    if (!depth) calls.push(source.slice(argumentStart, cursor - 1))
    index = cursor
  }
  return calls
}

function stringProperties(source, property) {
  const values = []
  for (let index = 0; index < source.length;) {
    if (['"', "'", '`'].includes(source[index])) {
      const string = readJavaScriptString(source, index)
      index = string?.end || source.length
      continue
    }
    if (!source.startsWith(property, index) || /[a-zA-Z0-9_$]/.test(source[index - 1] || '') ||
      /[a-zA-Z0-9_$]/.test(source[index + property.length] || '')) {
      index += 1
      continue
    }
    let cursor = index + property.length
    while (/\s/.test(source[cursor] || '')) cursor += 1
    if (source[cursor] !== ':') {
      index = cursor
      continue
    }
    cursor += 1
    while (/\s/.test(source[cursor] || '')) cursor += 1
    const string = readJavaScriptString(source, cursor)
    if (string) values.push(string.value)
    index = string?.end || cursor + 1
  }
  return values
}

function isFileReadCommand(command) {
  return /(?:^|[;&|()\s])(Get-Content|gc|cat|type|more|less|bat|sed|head|tail)(?:\s|$)/i.test(command)
}

function skillReadCommands(payload) {
  if (typeof payload?.input !== 'string') return []
  const commands = []
  if (payload.name === 'exec') {
    for (const args of toolCallArguments(payload.input, 'tools.exec_command')) {
      commands.push(...stringProperties(args, 'cmd'))
    }
  } else if (payload.name === 'exec_command') {
    try {
      const input = JSON.parse(payload.input)
      if (typeof input?.cmd === 'string') commands.push(input.cmd)
    } catch {
      // Ignore malformed direct tool input.
    }
  }
  return commands.filter((command) => command.includes('SKILL.md') && isFileReadCommand(command))
}

function inferredSkill(sourcePath, state) {
  const exact = state.knownByPath.get(canonicalPath(sourcePath))
  if (exact) return exact
  const lower = canonicalPath(sourcePath)
  const plugin = lower.includes(`${path.sep}plugins${path.sep}`)
  const projectScoped = Boolean(state.session?.cwd) && lower.startsWith(`${canonicalPath(state.session.cwd)}${path.sep}`)
  return {
    skillId: path.basename(path.dirname(sourcePath)),
    skillVersion: 'unversioned',
    sourcePath,
    source: plugin ? 'plugin' : projectScoped ? 'project' : 'global',
    provider: plugin ? 'Codex plugin' : projectScoped ? 'Project' : 'Codex',
  }
}

function eventTimestamp(record, fallback) {
  const candidate = record?.payload?.completed_at || record?.payload?.started_at || record?.timestamp || fallback
  const parsed = typeof candidate === 'number'
    ? candidate < 1_000_000_000_000 ? candidate * 1000 : candidate
    : Date.parse(candidate)
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString()
}

function commonFields(state) {
  const turn = state.currentTurn || {}
  const cwd = turn.cwd || state.session?.cwd
  return {
    runtime: 'codex',
    sessionId: state.session?.id || 'unknown',
    turnId: turn.id,
    project: projectName(cwd),
    model: turn.model,
    permissionMode: turn.permissionMode,
  }
}

function processRecord(record, state) {
  const created = []
  if (!record || typeof record !== 'object') return created

  if (record.type === 'session_meta') {
    state.session = {
      id: record.payload?.id || 'unknown',
      source: record.payload?.source,
      cwd: record.payload?.cwd,
    }
    state.desktop = desktopSources.has(state.session.source)
    if (state.desktop) {
      created.push({
        id: stableId('session.started', state.session.id),
        event: 'session.started',
        runtime: 'codex',
        sessionId: state.session.id,
        project: projectName(state.session.cwd),
        startSource: state.session.source,
        timestamp: eventTimestamp(record),
      })
    }
    return created
  }
  if (!state.desktop) return created

  const payload = record.payload || {}
  if (record.type === 'event_msg' && payload.type === 'task_started') {
    const id = payload.turn_id || 'unknown'
    state.currentTurn = {
      id,
      startedAt: eventTimestamp(record),
      cwd: state.session?.cwd,
    }
    state.active = new Map()
    return created
  }

  if (record.type === 'turn_context') {
    const id = payload.turn_id || state.currentTurn?.id || 'unknown'
    if (!state.currentTurn || state.currentTurn.id !== id) {
      state.currentTurn = { id, startedAt: eventTimestamp(record) }
      state.active = new Map()
    }
    state.currentTurn.cwd = payload.cwd || state.currentTurn.cwd || state.session?.cwd
    state.currentTurn.model = payload.model
    state.currentTurn.permissionMode = payload.approval_policy
    return created
  }

  if (record.type === 'response_item' && payload.type === 'custom_tool_call' && state.currentTurn) {
    const startedAt = eventTimestamp(record)
    const paths = new Set(skillReadCommands(payload).flatMap(skillPaths).map(canonicalPath))
    for (const canonical of paths) {
      const sourcePath = state.knownByPath.get(canonical)?.sourcePath || canonical
      const skill = inferredSkill(sourcePath, state)
      const activeKey = canonicalPath(skill.sourcePath || sourcePath)
      if (!skill.skillId || state.active.has(activeKey)) continue
      const common = commonFields(state)
      const fields = {
        ...common,
        skillId: skill.skillId,
        skillVersion: skill.skillVersion || 'unversioned',
        sourcePath: skill.sourcePath || sourcePath,
        source: skill.source || 'global',
        provider: skill.provider,
        detectionMethod: 'skill_path',
        confidence: 0.92,
      }
      created.push({
        id: stableId('skill.matched', common.sessionId, common.turnId, skill.skillId),
        event: 'skill.matched',
        ...fields,
        timestamp: startedAt,
      })
      created.push({
        id: stableId('skill.started', common.sessionId, common.turnId, skill.skillId),
        event: 'skill.started',
        ...fields,
        timestamp: startedAt,
      })
      state.active.set(activeKey, { ...fields, startedAt })
    }
    return created
  }

  if (record.type === 'event_msg' && payload.type === 'task_complete') {
    const turnId = payload.turn_id || state.currentTurn?.id || 'unknown'
    if (!state.currentTurn || state.currentTurn.id !== turnId) return created
    const completedAt = eventTimestamp(record)
    const completedMs = Date.parse(completedAt)
    for (const active of state.active.values()) {
      created.push({
        id: stableId('skill.completed', active.sessionId, active.turnId, active.skillId),
        event: 'skill.completed',
        ...active,
        timestamp: completedAt,
        outcome: 'unknown',
        durationMs: Math.max(0, completedMs - Date.parse(active.startedAt)),
      })
    }
    const common = commonFields(state)
    created.push({
      id: stableId('turn.completed', common.sessionId, common.turnId),
      event: 'turn.completed',
      ...common,
      timestamp: completedAt,
      outcome: 'unknown',
    })
    state.active = new Map()
    state.currentTurn = undefined
  }
  return created
}

export function parseCodexDesktopSession(contents, knownSkills = []) {
  const state = parserState(knownSkills)
  const created = []
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      created.push(...processRecord(JSON.parse(line), state))
    } catch {
      // Rollout logs are append-only; ignore a partially written or malformed record.
    }
  }
  return created
}

async function nestedSessionFiles(directory, depth = 0) {
  if (depth > 4) return []
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = await Promise.all(entries.map(async (entry) => {
      const location = path.join(directory, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return [location]
      return entry.isDirectory() ? nestedSessionFiles(location, depth + 1) : []
    }))
    return files.flat()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return []
    throw error
  }
}

async function readRange(file, start, end) {
  const length = Math.max(0, end - start)
  if (!length) return ''
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, start + read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function cachedSkills(project, ttlMs) {
  if (!skillCache || Date.now() - skillCache.createdAt > ttlMs || skillCache.project !== project) {
    skillCache = {
      project,
      createdAt: Date.now(),
      skills: (await scanInstalledSkills({ project, runtime: 'codex' })).filter((skill) => skill.kind === 'skill'),
    }
  }
  return skillCache.skills
}

function semanticKey(event) {
  return [event.runtime, event.sessionId, event.turnId || '', event.skillId || '', event.event].join(':')
}

async function performSync(options) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const project = options.project || process.cwd()
  const lookbackMs = options.lookbackMs ?? 7 * 24 * 60 * 60 * 1000
  const maxFiles = options.maxFiles ?? 50
  const now = options.now ?? Date.now()
  const candidates = []
  for (const file of await nestedSessionFiles(path.join(codexHome, 'sessions'))) {
    try {
      const details = await stat(file)
      if (now - details.mtimeMs <= lookbackMs) candidates.push({ file, details })
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') throw error
    }
  }
  candidates.sort((left, right) => right.details.mtimeMs - left.details.mtimeMs)

  const knownSkills = options.knownSkills || await cachedSkills(project, options.skillCacheTtlMs ?? 30_000)
  const generated = []
  let scannedFiles = 0
  for (const { file, details } of candidates.slice(0, maxFiles)) {
    let fileState = fileStates.get(file)
    if (!fileState || details.size < fileState.offset) {
      fileState = { offset: 0, remainder: '', parser: parserState(knownSkills) }
      fileStates.set(file, fileState)
    }
    if (details.size === fileState.offset) continue
    const chunk = `${fileState.remainder}${await readRange(file, fileState.offset, details.size)}`
    fileState.offset = details.size
    const lines = chunk.split(/\r?\n/)
    fileState.remainder = chunk.endsWith('\n') ? '' : lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        generated.push(...processRecord(JSON.parse(line), fileState.parser))
      } catch {
        // Never let one malformed rollout record interrupt event collection.
      }
    }
    scannedFiles += 1
  }

  if (!generated.length) return { created: [], scannedFiles }
  const anonymized = await Promise.all(generated.map(anonymizeEventSession))
  const existingKeys = new Set((await readEvents()).map(semanticKey))
  const unique = anonymized.filter((event) => {
    const key = semanticKey(event)
    if (existingKeys.has(key)) return false
    existingKeys.add(key)
    return true
  })
  return { created: await appendEvents(unique), scannedFiles }
}

export function syncCodexDesktopEvents(options = {}) {
  const operation = syncQueue.then(() => performSync(options))
  syncQueue = operation.catch(() => undefined)
  return operation
}
