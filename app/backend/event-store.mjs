import { appendFile, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeEvent, normalizeEvents } from '../shared/event-schema.mjs'

export const dataDir = path.resolve(process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
export const eventFile = path.join(dataDir, 'events.jsonl')
const discoveryIndexFile = path.join(dataDir, 'discovery-index.json')
const discoveryLockFile = path.join(dataDir, 'discovery-index.lock')

export function discoveryKey(event) {
  return `${event.runtime}:${event.skillId}:${event.skillVersion || 'unversioned'}:${event.sourcePath || ''}`
}

function parseEventLines(contents) {
  const events = []
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object') events.push(event)
    } catch {
      // A crashed writer can leave one partial JSONL record. Keep all other events readable.
    }
  }
  return events
}

export async function readEvents() {
  try {
    const contents = await readFile(eventFile, 'utf8')
    return parseEventLines(contents)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
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
  const normalized = normalizeEvent(event)
  await mkdir(dataDir, { recursive: true })
  await repairTrailingNewline()
  await appendFile(eventFile, `${JSON.stringify(normalized)}\n`, 'utf8')
  return normalized
}

export async function appendEvents(events) {
  const normalized = normalizeEvents(events)
  const existingIds = new Set((await readEvents()).map((event) => event.id).filter(Boolean))
  const batchIds = new Set()
  const created = normalized.filter((event) => {
    if (existingIds.has(event.id) || batchIds.has(event.id)) return false
    batchIds.add(event.id)
    return true
  })
  if (!created.length) return []
  await mkdir(dataDir, { recursive: true })
  await repairTrailingNewline()
  await appendFile(eventFile, `${created.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  return created
}

export async function clearEvents({ backup = true } = {}) {
  const events = await readEvents()
  let existing = false
  try {
    await stat(eventFile)
    existing = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!existing) return { removed: 0, backupFile: undefined }
  await mkdir(dataDir, { recursive: true })
  const suffix = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
  if (backupFile) await copyFile(eventFile, backupFile)
  const temporary = `${eventFile}.${process.pid}.tmp`
  await writeFile(temporary, '', 'utf8')
  await rename(temporary, eventFile)
  await writeDiscoveryIndex(new Set())
  return { removed: events.length, backupFile }
}

export async function removeEventsByIdPrefix(prefix, { backup = true } = {}) {
  if (typeof prefix !== 'string' || !prefix) throw new Error('A non-empty event id prefix is required.')
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
  await mkdir(dataDir, { recursive: true })
  const suffix = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = backup ? `${eventFile}.backup-${suffix}` : undefined
  if (backupFile) await copyFile(eventFile, backupFile)
  const temporary = `${eventFile}.${process.pid}.tmp`
  await writeFile(temporary, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
  await rename(temporary, eventFile)
  const discoveryKeys = new Set(parseEventLines(kept.join('\n'))
    .filter((event) => event.event === 'skill.discovered')
    .map(discoveryKey))
  await writeDiscoveryIndex(discoveryKeys)
  return { removed, backupFile }
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

export async function compactDiscoveryEvents({ backup = true } = {}) {
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
  const temporary = `${eventFile}.${process.pid}.tmp`
  await writeFile(temporary, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
  await rename(temporary, eventFile)
  await writeDiscoveryIndex(seen)
  return { removed, backupFile }
}

export async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
