import { createHash, createHmac, randomBytes } from 'node:crypto'
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeEvent, normalizeEvents } from '../shared/event-schema.mjs'

export const dataDir = path.resolve(process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
export const eventFile = path.join(dataDir, 'events.jsonl')
const discoveryIndexFile = path.join(dataDir, 'discovery-index.json')
const discoveryLockFile = path.join(dataDir, 'discovery-index.lock')
const sessionIdentityKeyFile = path.join(dataDir, 'session-identity.key')
const eventLockFile = path.join(dataDir, 'events.lock')
const pseudonymPattern = /^hmac-sha256:[a-f0-9]{64}$/
let sessionIdentityKeyPromise

export function discoveryKey(event) {
  return `${event.runtime}:${event.skillId}:${event.skillVersion || 'unversioned'}:${event.sourcePath || ''}`
}

function ensureStableLegacyEventId(event, line, occurrence) {
  if (typeof event.id === 'string' && event.id.trim()) return event
  event.id = `legacy-sha256:${createHash('sha256').update(line).update('\0').update(String(occurrence)).digest('hex')}`
  return event
}

function parseEventLines(contents) {
  const events = []
  const occurrences = new Map()
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      const occurrence = occurrences.get(line) ?? 0
      occurrences.set(line, occurrence + 1)
      if (event && typeof event === 'object') events.push(ensureStableLegacyEventId(event, line, occurrence))
    } catch {
      // A crashed writer can leave one partial JSONL record. Keep all other events readable.
    }
  }
  return events
}

async function loadSessionIdentityKey() {
  await mkdir(dataDir, { recursive: true })
  try {
    const key = await readFile(sessionIdentityKeyFile)
    if (key.length !== 32) throw new Error('SkillOps session identity key is invalid.')
    return key
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const key = randomBytes(32)
  try {
    await writeFile(sessionIdentityKeyFile, key, { flag: 'wx', mode: 0o600 })
    return key
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readFile(sessionIdentityKeyFile)
    if (existing.length !== 32) throw new Error('SkillOps session identity key is invalid.')
    return existing
  }
}

function sessionIdentityKey() {
  sessionIdentityKeyPromise ||= loadSessionIdentityKey()
  return sessionIdentityKeyPromise
}

export async function anonymizeSessionId(sessionId) {
  if (!sessionId || pseudonymPattern.test(sessionId)) return sessionId
  return `hmac-sha256:${createHmac('sha256', await sessionIdentityKey()).update(sessionId).digest('hex')}`
}

export async function anonymizeEventSession(event) {
  if (!event.sessionId) return event
  const sessionId = await anonymizeSessionId(event.sessionId)
  const id = typeof event.id === 'string' && event.id.includes(event.sessionId)
    ? event.id.replaceAll(event.sessionId, sessionId)
    : event.id
  return { ...event, id, sessionId }
}

async function withEventLock(operation, directory = dataDir) {
  await mkdir(directory, { recursive: true })
  const lockFile = directory === dataDir ? eventLockFile : path.join(directory, 'events.lock')
  let handle
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockFile, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lockStats = await stat(lockFile)
        if (Date.now() - lockStats.mtimeMs > 30_000) await rm(lockFile, { force: true })
      } catch (lockError) {
        if (lockError?.code !== 'ENOENT') throw lockError
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (!handle) throw new Error('Timed out waiting for the event store lock.')
  try {
    return await operation()
  } finally {
    await handle.close()
    await rm(lockFile, { force: true })
  }
}

async function replaceEventFile(contents) {
  const temporary = `${eventFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, eventFile)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readEventsUnlocked() {
  let contents
  try {
    contents = await readFile(eventFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return Promise.all(parseEventLines(contents).map(async (event) => {
    try {
      return await anonymizeEventSession(normalizeEvent(event))
    } catch {
      return undefined
    }
  })).then((events) => events.filter(Boolean))
}

export function readEvents() {
  return withEventLock(readEventsUnlocked)
}

export function migrateLegacyEvents({ backup = true } = {}) {
  return withEventLock(async () => {
    let contents
    try {
      contents = await readFile(eventFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { migrated: 0, removed: 0, backupFile: undefined }
      throw error
    }
    const events = []
    const lines = []
    let migrated = 0
    let removed = 0
    const occurrences = new Map()
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event row')
        const occurrence = occurrences.get(line) ?? 0
        occurrences.set(line, occurrence + 1)
        const normalized = await anonymizeEventSession(normalizeEvent(ensureStableLegacyEventId(event, line, occurrence)))
        const serialized = JSON.stringify(normalized)
        if (serialized !== line.trim()) migrated += 1
        events.push(normalized)
        lines.push(serialized)
      } catch {
        removed += 1
      }
    }
    if (!migrated && !removed) return { migrated: 0, removed: 0, backupFile: undefined }
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
    if (backupFile) await copyFile(eventFile, backupFile)
    await replaceEventFile(lines.length ? `${lines.join('\n')}\n` : '')
    await writeDiscoveryIndex(new Set(events
      .filter((event) => event.event === 'skill.discovered')
      .map(discoveryKey)))
    return { migrated, removed, backupFile }
  })
}

export async function eventVersion() {
  try {
    const stats = await stat(eventFile)
    return `"${stats.size}-${Math.trunc(stats.mtimeMs)}"`
  } catch (error) {
    if (error?.code === 'ENOENT') return '"empty"'
    throw error
  }
}

export async function appendEvent(event) {
  const normalized = await anonymizeEventSession(normalizeEvent(event))
  return withEventLock(async () => {
    await readEventsUnlocked()
    await repairTrailingNewline()
    await appendFile(eventFile, `${JSON.stringify(normalized)}\n`, 'utf8')
    return normalized
  })
}

export async function appendEvents(events) {
  const normalized = await Promise.all(normalizeEvents(events).map(anonymizeEventSession))
  return withEventLock(async () => {
    const existingIds = new Set((await readEventsUnlocked()).map((event) => event.id).filter(Boolean))
    const batchIds = new Set()
    const created = normalized.filter((event) => {
      if (existingIds.has(event.id) || batchIds.has(event.id)) return false
      batchIds.add(event.id)
      return true
    })
    if (!created.length) return []
    await repairTrailingNewline()
    await appendFile(eventFile, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
    return created
  })
}

export function clearEvents({ backup = true } = {}) {
  return withEventLock(async () => {
    const events = await readEventsUnlocked()
    let existing = false
    try {
      await stat(eventFile)
      existing = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (!existing) return { removed: 0, backupFile: undefined }
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
    if (backupFile) await copyFile(eventFile, backupFile)
    await replaceEventFile('')
    await writeDiscoveryIndex(new Set())
    return { removed: events.length, backupFile }
  })
}

export function removeEventsByIdPrefix(prefix, { backup = true } = {}) {
  if (typeof prefix !== 'string' || !prefix) throw new Error('A non-empty event id prefix is required.')
  return withEventLock(async () => {
    await readEventsUnlocked()
    let contents
    try {
      contents = await readFile(eventFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0, backupFile: undefined }
      throw error
    }
    const kept = []
    let removed = 0
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (typeof event?.id === 'string' && event.id.startsWith(prefix)) {
          removed += 1
          continue
        }
      } catch {
        // Preserve malformed source lines for later diagnosis.
      }
      kept.push(line)
    }
    if (!removed) return { removed: 0, backupFile: undefined }
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
    if (backupFile) await copyFile(eventFile, backupFile)
    await replaceEventFile(kept.length ? `${kept.join('\n')}\n` : '')
    const discoveryKeys = new Set(parseEventLines(kept.join('\n'))
      .filter((event) => event.event === 'skill.discovered')
      .map(discoveryKey))
    await writeDiscoveryIndex(discoveryKeys)
    return { removed, backupFile }
  })
}

async function repairTrailingNewline() {
  let handle
  try {
    handle = await open(eventFile, 'r')
    const stats = await handle.stat()
    if (!stats.size) return
    const lastByte = Buffer.alloc(1)
    await handle.read(lastByte, 0, 1, stats.size - 1)
    if (lastByte[0] !== 10) await appendFile(eventFile, '\n', 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  } finally {
    await handle?.close()
  }
}

let discoveryQueue = Promise.resolve()

async function writeDiscoveryIndex(keys) {
  const temporary = `${discoveryIndexFile}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify([...keys].sort())}\n`, 'utf8')
  await rename(temporary, discoveryIndexFile)
}

async function readDiscoveryIndex() {
  try {
    const values = JSON.parse(await readFile(discoveryIndexFile, 'utf8'))
    if (Array.isArray(values) && values.every((value) => typeof value === 'string')) return new Set(values)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Rebuild malformed or stale index files from the append-only source of truth.
    }
  }
  const keys = new Set((await readEvents())
    .filter((event) => event.event === 'skill.discovered')
    .map(discoveryKey))
  await writeDiscoveryIndex(keys)
  return keys
}

async function withDiscoveryLock(operation) {
  await mkdir(dataDir, { recursive: true })
  let handle
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(discoveryLockFile, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lockStats = await stat(discoveryLockFile)
        if (Date.now() - lockStats.mtimeMs > 30_000) await rm(discoveryLockFile, { force: true })
      } catch (lockError) {
        if (lockError?.code !== 'ENOENT') throw lockError
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (!handle) throw new Error('Timed out waiting for the discovery index lock.')
  try {
    return await operation()
  } finally {
    await handle.close()
    await rm(discoveryLockFile, { force: true })
  }
}

export function appendUniqueDiscoveries(skills, context = {}) {
  const operation = discoveryQueue.then(() => withDiscoveryLock(async () => {
    const existing = await readDiscoveryIndex()
    const created = []
    for (const skill of skills) {
      const key = discoveryKey(skill)
      if (existing.has(key)) continue
      created.push(await appendEvent({ event: 'skill.discovered', ...skill, ...context }))
      existing.add(key)
    }
    if (created.length) await writeDiscoveryIndex(existing)
    return created
  }))
  discoveryQueue = operation.catch(() => undefined)
  return operation
}

export function compactDiscoveryEvents({ backup = true } = {}) {
  return withEventLock(async () => {
    await readEventsUnlocked()
    let contents
    try {
      contents = await readFile(eventFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0, backupFile: undefined }
      throw error
    }
    const seen = new Set()
    const kept = []
    let removed = 0
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event?.event === 'skill.discovered') {
          const key = discoveryKey(event)
          if (seen.has(key)) {
            removed += 1
            continue
          }
          seen.add(key)
        }
      } catch {
        // Preserve corrupt source lines for diagnosis; readEvents safely ignores them.
      }
      kept.push(line)
    }
    if (!removed) return { removed: 0, backupFile: undefined }
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
    if (backupFile) await copyFile(eventFile, backupFile)
    await replaceEventFile(kept.length ? `${kept.join('\n')}\n` : '')
    await writeDiscoveryIndex(seen)
    return { removed, backupFile }
  })
}

export function pruneEventsBefore(cutoff, { backup = true, directory = dataDir } = {}) {
  const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff)
  if (!Number.isFinite(cutoffMs)) throw new Error('Event retention cutoff is invalid.')
  return withEventLock(async () => {
    const file = path.join(directory, 'events.jsonl')
    const contents = await readFile(file, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    const kept = []
    let removed = 0
    if (contents !== null) {
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          const timestamp = Date.parse(event?.timestamp)
          if (Number.isFinite(timestamp) && timestamp < cutoffMs) {
            removed += 1
            continue
          }
        } catch {
          // Retention cannot establish the age of malformed rows; events:migrate owns their removal.
        }
        kept.push(line)
      }
    }
    let backupFile
    if (removed) {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-')
      backupFile = backup ? `${file}.backup-${suffix}` : undefined
      if (backupFile) await copyFile(file, backupFile)
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(temporary, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
      const keys = new Set(parseEventLines(kept.join('\n'))
        .filter((event) => event.event === 'skill.discovered')
        .map(discoveryKey))
      const indexFile = path.join(directory, 'discovery-index.json')
      const temporaryIndex = `${indexFile}.${process.pid}.tmp`
      await writeFile(temporaryIndex, `${JSON.stringify([...keys].sort())}\n`, 'utf8')
      await rename(temporaryIndex, indexFile)
    }
    let removedBackups = 0
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('events.jsonl.backup-')) continue
      const candidate = path.join(directory, entry.name)
      if (candidate === backupFile) continue
      if ((await stat(candidate)).mtimeMs >= cutoffMs) continue
      await rm(candidate)
      removedBackups += 1
    }
    return { removed, retained: kept.length, removedBackups, backupFile }
  }, directory)
}

export async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
