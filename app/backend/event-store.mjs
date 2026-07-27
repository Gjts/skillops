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
const eventReasons = new Set(['clear', 'resume', 'logout', 'prompt_input_exit', 'bypass_permissions_disabled', 'other', 'unknown'])
let sessionIdentityKeyPromise
let eventCache

function sanitizeEventReason(event) {
  return event.reason === undefined || eventReasons.has(event.reason)
    ? event
    : { ...event, reason: 'unknown' }
}

function invalidateEventCache() {
  eventCache = undefined
}

async function eventFingerprint() {
  try {
    const stats = await stat(eventFile, { bigint: true })
    return `${stats.size}:${stats.mtimeNs}`
  } catch (error) {
    if (error?.code === 'ENOENT') return 'empty'
    throw error
  }
}

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
  const lines = contents.split('\n')
  let sourceStatus = 'ok'
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      const position = Number(error?.message?.match(/position (\d+)/)?.[1])
      const incomplete = line.trimStart().startsWith('{')
        && (error?.message === 'Unexpected end of JSON input'
          || error?.message?.startsWith('Unterminated string')
          || Number.isInteger(position) && position >= line.length)
      if (!contents.endsWith('\n') && lines.slice(index + 1).every((candidate) => !candidate.trim()) && incomplete) {
        sourceStatus = 'partial'
        break
      }
      throw new Error('Event store contains a malformed record.')
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('Event store contains a malformed record.')
    }
    const occurrence = occurrences.get(line) ?? 0
    occurrences.set(line, occurrence + 1)
    events.push(ensureStableLegacyEventId(event, line, occurrence))
  }
  return { events, sourceStatus }
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
    invalidateEventCache()
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readEventStoreUnlocked() {
  const fingerprint = await eventFingerprint()
  if (eventCache?.fingerprint === fingerprint) return eventCache
  let contents
  try {
    contents = await readFile(eventFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      eventCache = { fingerprint, events: [], sourceStatus: 'ok' }
      return eventCache
    }
    throw error
  }
  const parsed = parseEventLines(contents)
  const events = await Promise.all(parsed.events.map(async (event) => anonymizeEventSession(normalizeEvent(event))))
  eventCache = { fingerprint, events, sourceStatus: parsed.sourceStatus }
  return eventCache
}

async function readEventsUnlocked() {
  return (await readEventStoreUnlocked()).events
}

export function readEvents() {
  return withEventLock(readEventsUnlocked)
}

export function readEventsWithStatus() {
  return withEventLock(async () => {
    const snapshot = await readEventStoreUnlocked()
    return { events: snapshot.events, sourceStatus: snapshot.sourceStatus }
  })
}

export function migrateLegacyEvents({ backup = true } = {}) {
  return withEventMutationLock(async () => {
    let contents
    try {
      contents = await readFile(eventFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { migrated: 0, removed: 0, backupFile: undefined }
      throw error
    }
    const sourceLines = contents.split('\n')
    const finalRecord = sourceLines.findLastIndex((line) => line.trim())
    let recoverableTail = -1
    try {
      if (parseEventLines(contents).sourceStatus === 'partial') recoverableTail = finalRecord
    } catch (error) {
      try { parseEventLines(`${sourceLines.slice(0, finalRecord).join('\n')}\n`) } catch { throw error }
      recoverableTail = finalRecord
    }
    if (recoverableTail >= 0 && !backup) {
      throw new Error('Event store contains a malformed record; recovery requires a backup and no data was changed.')
    }
    const events = []
    const lines = []
    let migrated = 0
    let removed = 0
    const occurrences = new Map()
    for (const [index, line] of sourceLines.entries()) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event row')
        const occurrence = occurrences.get(line) ?? 0
        occurrences.set(line, occurrence + 1)
        const normalized = await anonymizeEventSession(sanitizeEventReason(normalizeEvent(ensureStableLegacyEventId(event, line, occurrence))))
        const serialized = JSON.stringify(normalized)
        if (serialized !== line.trim()) migrated += 1
        events.push(normalized)
        lines.push(serialized)
      } catch {
        if (index !== finalRecord) throw new Error('Event store contains a malformed record; no data was changed.')
        if (!backup) throw new Error('Event store contains a malformed record; recovery requires a backup and no data was changed.')
        removed += 1
      }
    }
    if (!migrated && !removed) return { migrated: 0, removed: 0, backupFile: undefined }
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
    if (backupFile) await copyFile(eventFile, backupFile)
    await mutateEventFileAndIndex(contents, lines.length ? `${lines.join('\n')}\n` : '', new Set(events
      .filter((event) => event.event === 'skill.discovered')
      .map(discoveryKey)), backupFile, 'Event migration')
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
  const normalized = await anonymizeEventSession(sanitizeEventReason(normalizeEvent(event)))
  return withEventLock(async () => {
    const snapshot = await readEventStoreUnlocked()
    if (snapshot.sourceStatus === 'partial') throw new Error('Event store has a partial trailing record; no data was changed.')
    await repairTrailingNewline()
    await appendFile(eventFile, `${JSON.stringify(normalized)}\n`, 'utf8')
    invalidateEventCache()
    return normalized
  })
}

export async function appendEvents(events) {
  const normalized = await Promise.all(normalizeEvents(events).map(sanitizeEventReason).map(anonymizeEventSession))
  return withEventLock(async () => {
    const snapshot = await readEventStoreUnlocked()
    if (snapshot.sourceStatus === 'partial') throw new Error('Event store has a partial trailing record; no data was changed.')
    const existingIds = new Set(snapshot.events.map((event) => event.id).filter(Boolean))
    const batchIds = new Set()
    const created = normalized.filter((event) => {
      if (existingIds.has(event.id) || batchIds.has(event.id)) return false
      batchIds.add(event.id)
      return true
    })
    if (!created.length) return []
    await repairTrailingNewline()
    await appendFile(eventFile, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
    invalidateEventCache()
    return created
  })
}

export function clearEvents({ backup = true } = {}) {
  return withEventMutationLock(async () => {
    let contents
    try {
      contents = await readFile(eventFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0, backupFile: undefined }
      throw error
    }
    const snapshot = await readEventStoreUnlocked()
    if (snapshot.sourceStatus === 'partial') throw new Error('Event store has a partial trailing record; no data was changed.')
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
    if (backupFile) await copyFile(eventFile, backupFile)
    await mutateEventFileAndIndex(contents, '', new Set(), backupFile, 'Event clear')
    return { removed: snapshot.events.length, backupFile }
  })
}

export function removeEventsByIdPrefix(prefix, { backup = true } = {}) {
  if (typeof prefix !== 'string' || !prefix) throw new Error('A non-empty event id prefix is required.')
  return withEventMutationLock(async () => {
    const snapshot = await readEventStoreUnlocked()
    if (snapshot.sourceStatus === 'partial') {
      throw new Error('Event store has a partial trailing record; no data was changed.')
    }
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
    const postimage = kept.length ? `${kept.join('\n')}\n` : ''
    const discoveryKeys = new Set(parseEventLines(kept.join('\n')).events
      .filter((event) => event.event === 'skill.discovered')
      .map(discoveryKey))
    await mutateEventFileAndIndex(contents, postimage, discoveryKeys, backupFile, 'Selective event removal')
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

async function mutateEventFileAndIndex(preimage, postimage, keys, backupFile, label) {
  let replaced = false
  try {
    await replaceEventFile(postimage)
    replaced = true
    await writeDiscoveryIndex(keys)
  } catch (error) {
    await rm(`${discoveryIndexFile}.${process.pid}.tmp`, { force: true }).catch(() => undefined)
    if (!replaced) throw error
    try {
      await replaceEventFile(preimage)
    } catch (recoveryError) {
      const reference = backupFile ? ` Recovery backup: ${path.basename(backupFile)}.` : ''
      const failure = new AggregateError([error, recoveryError], `${label} failed and automatic recovery was incomplete.${reference}`)
      failure.backupFile = backupFile
      throw failure
    }
    throw error
  }
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

async function withDiscoveryLock(operation, directory = dataDir) {
  await mkdir(directory, { recursive: true })
  const lockFile = directory === dataDir ? discoveryLockFile : path.join(directory, 'discovery-index.lock')
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
  if (!handle) throw new Error('Timed out waiting for the discovery index lock.')
  try {
    return await operation()
  } finally {
    await handle.close()
    await rm(lockFile, { force: true })
  }
}

function withEventMutationLock(operation, directory = dataDir) {
  return withDiscoveryLock(() => withEventLock(operation, directory), directory)
}

function mergeEventRecovery(preimage, current, postimage) {
  const before = preimage.split('\n').filter((line) => line.length)
  const committed = (postimage ?? preimage).split('\n').filter((line) => line.length)
  const remaining = new Map()
  for (const line of committed) remaining.set(line, (remaining.get(line) || 0) + 1)
  const appended = current.split('\n').filter((line) => line.length).filter((line) => {
    const count = remaining.get(line) || 0
    if (!count) return true
    remaining.set(line, count - 1)
    return false
  })
  const restored = [...before, ...appended]
  return restored.length ? `${restored.join('\n')}\n` : ''
}

export async function restoreEventsFromBackup(backupFile, postimage, { directory = dataDir } = {}) {
  if (!backupFile) return
  if (postimage !== undefined && typeof postimage !== 'string') throw new Error('Event recovery postimage is invalid.')
  const recoveryDirectory = path.resolve(directory)
  const file = path.join(recoveryDirectory, 'events.jsonl')
  const indexFile = path.join(recoveryDirectory, 'discovery-index.json')
  const target = path.resolve(file)
  const backup = path.resolve(backupFile)
  if (path.dirname(target) !== path.dirname(backup) || !path.basename(backup).startsWith(`${path.basename(target)}.backup-`)) {
    throw new Error('Event recovery backup is invalid.')
  }
  return withEventMutationLock(async () => {
    const [preimage, current] = await Promise.all([
      readFile(backup, 'utf8'),
      readFile(file, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
    ])
    const restored = mergeEventRecovery(preimage, current, postimage)
    const snapshot = parseEventLines(restored)
    if (snapshot.sourceStatus === 'partial') throw new Error('Event recovery source is partial.')
    const events = normalizeEvents(snapshot.events)
    const keys = new Set(events.filter((event) => event.event === 'skill.discovered').map(discoveryKey))
    const nonce = randomBytes(6).toString('hex')
    const temporary = `${file}.${process.pid}.${nonce}.recovery.tmp`
    const temporaryIndex = `${indexFile}.${process.pid}.${nonce}.recovery.tmp`
    let replaced = false
    try {
      await writeFile(temporary, restored, 'utf8')
      await rename(temporary, file)
      replaced = true
      if (recoveryDirectory === dataDir) invalidateEventCache()
      await writeFile(temporaryIndex, `${JSON.stringify([...keys].sort())}\n`, 'utf8')
      await rename(temporaryIndex, indexFile)
    } catch (error) {
      if (!replaced) throw error
      const rollback = `${file}.${process.pid}.${nonce}.rollback.tmp`
      try {
        await writeFile(rollback, current, 'utf8')
        await rename(rollback, file)
        if (recoveryDirectory === dataDir) invalidateEventCache()
        await rm(indexFile, { recursive: true, force: true })
      } catch (recoveryError) {
        const failure = new AggregateError([error, recoveryError], `Event recovery failed and automatic rollback was incomplete. Recovery backup: ${path.basename(backup)}.`)
        failure.backupFile = backup
        throw failure
      } finally {
        await rm(rollback, { force: true }).catch(() => undefined)
      }
      throw error
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      await rm(temporaryIndex, { force: true }).catch(() => undefined)
    }
  }, recoveryDirectory)
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
    if (created.length) {
      try {
        await writeDiscoveryIndex(existing)
      } catch (error) {
        await rm(discoveryIndexFile, { recursive: true, force: true })
        await rm(`${discoveryIndexFile}.${process.pid}.tmp`, { force: true })
        throw error
      }
    }
    return created
  }))
  discoveryQueue = operation.catch(() => undefined)
  return operation
}

export function compactDiscoveryEvents({ backup = true } = {}) {
  return withEventMutationLock(async () => {
    const snapshot = await readEventStoreUnlocked()
    if (snapshot.sourceStatus === 'partial') {
      throw new Error('Event store has a partial trailing record; no data was changed.')
    }
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
    await mutateEventFileAndIndex(contents, kept.length ? `${kept.join('\n')}\n` : '', seen, backupFile, 'Discovery compaction')
    return { removed, backupFile }
  })
}

export function pruneEventsBefore(cutoff, { backup = true, directory = dataDir, deferBackupCleanup = false } = {}) {
  const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff)
  if (!Number.isFinite(cutoffMs)) throw new Error('Event retention cutoff is invalid.')
  return withEventMutationLock(async () => {
    const file = path.join(directory, 'events.jsonl')
    const contents = await readFile(file, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    const kept = []
    let removed = 0
    if (contents !== null) {
      const snapshot = parseEventLines(contents)
      if (snapshot.sourceStatus === 'partial') {
        throw new Error('Event store has a partial trailing record; no data was changed.')
      }
      normalizeEvents(snapshot.events)
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        const timestamp = Date.parse(event?.timestamp)
        if (Number.isFinite(timestamp) && timestamp < cutoffMs) {
          removed += 1
          continue
        }
        kept.push(line)
      }
    }
    const expiredBackupFiles = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('events.jsonl.backup-')) continue
      const candidate = path.join(directory, entry.name)
      if ((await stat(candidate)).mtimeMs < cutoffMs) expiredBackupFiles.push(candidate)
    }
    let removedBackups = 0
    if (!deferBackupCleanup) {
      for (const candidate of expiredBackupFiles) {
        await rm(candidate)
        removedBackups += 1
      }
    }
    let backupFile
    const postimage = kept.length ? `${kept.join('\n')}\n` : ''
    if (removed) {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-')
      backupFile = backup ? `${file}.backup-${suffix}` : undefined
      if (backupFile) await copyFile(file, backupFile)
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(temporary, postimage, 'utf8')
        await rename(temporary, file)
        if (path.resolve(directory) === dataDir) invalidateEventCache()
        const keys = new Set(parseEventLines(kept.join('\n')).events
          .filter((event) => event.event === 'skill.discovered')
          .map(discoveryKey))
        const indexFile = path.join(directory, 'discovery-index.json')
        const temporaryIndex = `${indexFile}.${process.pid}.tmp`
        try {
          await writeFile(temporaryIndex, `${JSON.stringify([...keys].sort())}\n`, 'utf8')
          await rename(temporaryIndex, indexFile)
        } finally {
          await rm(temporaryIndex, { force: true }).catch(() => undefined)
        }
      } catch (error) {
        const recovery = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.recovery.tmp`
        try {
          await writeFile(recovery, contents ?? '', 'utf8')
          await rename(recovery, file)
          if (path.resolve(directory) === dataDir) invalidateEventCache()
        } catch (recoveryError) {
          const failure = new AggregateError([error, recoveryError], 'Event retention failed and automatic recovery was incomplete.')
          failure.retentionRecovery = { store: 'events', backupFile, recoveryPostimage: postimage }
          throw failure
        } finally {
          await rm(recovery, { force: true }).catch(() => undefined)
        }
        throw error
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    return {
      removed,
      retained: kept.length,
      removedBackups,
      backupFile,
      ...(deferBackupCleanup ? { expiredBackupFiles, recoveryPostimage: postimage } : {}),
    }
  }, directory)
}

export async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
