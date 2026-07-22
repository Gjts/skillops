import { createHash, randomUUID } from 'node:crypto'
import { appendFile, cp, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { readRuntimeConnections } from '../runtime-connections.mjs'
import { canonicalSkillContentHash, scanSkillInventory } from '../skill-scanner.mjs'
import { readArtifactPackage } from '../evaluations/artifact-package.mjs'
import { withGovernanceFileLock } from '../governance/skeleton-lock.mjs'

const actions = new Set(['keep', 'enable', 'disable', 'remove', 'rename', 'replace', 'defer'])

export class ConflictError extends Error {
  constructor(message, statusCode = 422) {
    super(message)
    this.name = 'ConflictError'
    this.statusCode = statusCode
  }
}

function rawHash(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function normalized(value) {
  return String(value || '').trim().toLowerCase()
}

function samePath(left, right) {
  const first = path.resolve(left).replace(/\\/g, '/')
  const second = path.resolve(right).replace(/\\/g, '/')
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second
}

function definitionKey(definition) {
  return `${definition.runtime}:${definition.kind}:${path.resolve(definition.sourcePath)}`
}

function scanDefinitions(result) {
  return Array.isArray(result) ? result : result?.definitions
}

function parseDefinition(contents) {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const frontmatter = {}
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const field = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
      if (field) frontmatter[field[1]] = field[2].trim()
    }
  }
  return { frontmatter, instructions: match ? contents.slice(match[0].length) : contents }
}

async function auxiliaryFiles(directory) {
  const result = []
  async function visit(current, prefix = '') {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES' || error?.code === 'EPERM') return
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (result.length >= 100) return
      const relative = path.join(prefix, entry.name).replace(/\\/g, '/')
      const location = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(location, relative)
      else if (entry.isFile()) result.push({ path: relative, contentHash: rawHash(await readFile(location)) })
    }
  }
  await visit(directory)
  return result
}

async function readDefinition(definition) {
  const info = await lstat(definition.sourcePath).catch((error) => {
    if (error?.code === 'ENOENT') throw new ConflictError('The selected definition no longer exists.', 409)
    throw error
  })
  if (!info.isFile() || info.isSymbolicLink()) throw new ConflictError('Conflict actions require a regular non-symlink definition file.')
  const contents = await readFile(definition.sourcePath, 'utf8')
  const parsed = parseDefinition(contents)
  const directory = path.dirname(definition.sourcePath)
  const tools = String(parsed.frontmatter.tools || parsed.frontmatter['allowed-tools'] || '')
    .split(',').map((item) => item.trim()).filter(Boolean)
  const [references, scripts, packageRecord] = await Promise.all([
    auxiliaryFiles(path.join(directory, 'references')),
    auxiliaryFiles(path.join(directory, 'scripts')),
    definition.kind === 'skill' ? directorySnapshot(directory) : null,
  ])
  return {
    definition,
    contents,
    contentHash: packageRecord?.contentHash || canonicalSkillContentHash(contents),
    byteHash: rawHash(contents),
    ...parsed,
    tools,
    references,
    scripts,
  }
}

function section(before, after, redactContents = false) {
  const changed = JSON.stringify(before) !== JSON.stringify(after)
  if (!redactContents) return { changed, before, after }
  return {
    changed,
    beforeHash: rawHash(before),
    afterHash: rawHash(after),
    beforeBytes: Buffer.byteLength(before),
    afterBytes: Buffer.byteLength(after),
  }
}

function compareDefinitions(before, after) {
  return {
    before: definitionKey(before.definition),
    after: definitionKey(after.definition),
    sections: {
      frontmatter: section(before.frontmatter, after.frontmatter),
      instructions: section(before.instructions, after.instructions, true),
      tools: section(before.tools, after.tools),
      references: section(before.references, after.references),
      scripts: section(before.scripts, after.scripts),
    },
  }
}

function classifications(definitions) {
  const result = new Set()
  const enabledByKind = Map.groupBy(
    definitions.filter((item) => item.enabled && item.status !== 'disabled' && item.status !== 'inactive'),
    (item) => item.kind,
  )
  for (const enabled of enabledByKind.values()) {
    const hashes = new Set(enabled.map((item) => item.contentHash).filter(Boolean))
    const versions = new Set(enabled.map((item) => item.skillVersion).filter(Boolean))
    if (enabled.length > 1 && hashes.size === 1) result.add('exact-duplicate')
    if (enabled.length > 1 && hashes.size > 1) result.add('content-conflict')
    if (enabled.length > 1 && versions.size > 1) result.add('version-conflict')
  }
  if (definitions.some((item) => item.status === 'shadowed' || item.shadowedBy)) result.add('shadowed-definition')
  if (definitions.some((item) => !item.enabled || item.status === 'disabled' || item.status === 'inactive')) result.add('disabled-definition')
  if (definitions.some((item) => !normalized(item.skillId) || item.skillId === 'unknown-skill' || item.skillVersion === 'unversioned' || !item.sourcePath)) result.add('missing-metadata')
  return [...result]
}

function replaceName(contents, name) {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  if (/^---\r?\n/.test(contents)) {
    if (/^name\s*:/m.test(contents)) return contents.replace(/^name\s*:.*$/m, `name: ${name}`)
    return contents.replace(/^---\r?\n/, `---${newline}name: ${name}${newline}`)
  }
  return `---${newline}name: ${name}${newline}---${newline}${contents}`
}

function managedSection(contents, id, definitionDirectory, enabled) {
  const start = `# skillops:conflict:${id}:start`
  const end = `# skillops:conflict:${id}:end`
  const block = `${start}\n[[skills.config]]\npath = ${JSON.stringify(definitionDirectory.replace(/\\/g, '/'))}\nenabled = ${enabled}\n${end}\n`
  const expression = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`)
  const previous = contents.match(expression)?.[0] || ''
  const after = previous
    ? contents.replace(expression, block)
    : `${contents}${contents && !contents.endsWith('\n') ? '\n' : ''}${contents ? '\n' : ''}${block}`
  return { previous, block, after }
}

function skipWhitespace(contents, start) {
  let index = start
  while (/\s/.test(contents[index] || '')) index += 1
  return index
}

function jsonStringEnd(contents, start) {
  for (let index = start + 1; index < contents.length; index += 1) {
    if (contents[index] === '\\') index += 1
    else if (contents[index] === '"') return index + 1
  }
  throw new ConflictError('Claude settings JSON is malformed.', 409)
}

function jsonValueEnd(contents, start) {
  if (contents[start] === '"') return jsonStringEnd(contents, start)
  if (contents[start] === '{' || contents[start] === '[') {
    const opening = contents[start]
    const closing = opening === '{' ? '}' : ']'
    let depth = 0
    for (let index = start; index < contents.length; index += 1) {
      if (contents[index] === '"') index = jsonStringEnd(contents, index) - 1
      else if (contents[index] === opening) depth += 1
      else if (contents[index] === closing && --depth === 0) return index + 1
    }
    throw new ConflictError('Claude settings JSON is malformed.', 409)
  }
  let end = start
  while (end < contents.length && !',}]'.includes(contents[end])) end += 1
  while (end > start && /\s/.test(contents[end - 1])) end -= 1
  return end
}

function jsonObjectSpan(contents, start) {
  if (contents[start] !== '{') throw new ConflictError('Claude enabledPlugins must be a JSON object.', 409)
  const entries = []
  let cursor = skipWhitespace(contents, start + 1)
  while (contents[cursor] !== '}') {
    if (contents[cursor] !== '"') throw new ConflictError('Claude settings JSON is malformed.', 409)
    const keyStart = cursor
    const keyEnd = jsonStringEnd(contents, keyStart)
    const key = JSON.parse(contents.slice(keyStart, keyEnd))
    cursor = skipWhitespace(contents, keyEnd)
    if (contents[cursor] !== ':') throw new ConflictError('Claude settings JSON is malformed.', 409)
    const valueStart = skipWhitespace(contents, cursor + 1)
    const valueEnd = jsonValueEnd(contents, valueStart)
    entries.push({ key, keyStart, valueStart, valueEnd })
    cursor = skipWhitespace(contents, valueEnd)
    if (contents[cursor] === ',') cursor = skipWhitespace(contents, cursor + 1)
    else if (contents[cursor] !== '}') throw new ConflictError('Claude settings JSON is malformed.', 409)
  }
  return { entries, end: cursor }
}

function setPluginEnabled(contents, pluginId, enabled) {
  const source = contents || '{}\n'
  try { JSON.parse(source) } catch { throw new ConflictError('Claude settings JSON is malformed.', 409) }
  const root = jsonObjectSpan(source, skipWhitespace(source, 0))
  const enabledPlugins = root.entries.find((entry) => entry.key === 'enabledPlugins')
  const property = `${JSON.stringify(pluginId)}:${enabled}`
  if (!enabledPlugins) {
    const addition = `${root.entries.length ? ',' : ''}"enabledPlugins":{${property}}`
    return { before: '', afterSnippet: property, after: `${source.slice(0, root.end)}${addition}${source.slice(root.end)}` }
  }
  const plugins = jsonObjectSpan(source, enabledPlugins.valueStart)
  const plugin = plugins.entries.find((entry) => entry.key === pluginId)
  if (plugin) {
    const previous = source.slice(plugin.keyStart, plugin.valueEnd)
    const replacement = `${source.slice(plugin.keyStart, plugin.valueStart)}${enabled}`
    return {
      before: previous,
      afterSnippet: replacement,
      after: `${source.slice(0, plugin.keyStart)}${replacement}${source.slice(plugin.valueEnd)}`,
    }
  }
  const addition = `${plugins.entries.length ? ',' : ''}${property}`
  return {
    before: '',
    afterSnippet: property,
    after: `${source.slice(0, plugins.end)}${addition}${source.slice(plugins.end)}`,
  }
}

async function directorySnapshot(directory) {
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new ConflictError('Conflict actions require a regular non-symlink Skill directory.')
  try {
    const { packageFiles, contentHash } = await readArtifactPackage(directory)
    return {
      contentHash,
      entries: packageFiles.map((file) => ({
        path: file.relativePath,
        type: 'file',
        contentHash: rawHash(file.contents),
      })),
    }
  } catch (error) {
    if (error?.name === 'EvaluationError') throw new ConflictError(error.message, error.status)
    throw error
  }
}

async function readOptional(file) {
  try {
    return { exists: true, contents: await readFile(file, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, contents: '' }
    throw error
  }
}

async function writeUnoccupied(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await link(temporary, file)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ConflictError('Action target changed while applying the reviewed change.', 409)
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export function createConflictService(options = {}) {
  const scan = options.scanSkillInventory || (() => scanSkillInventory(options))
  const readConnections = options.readRuntimeConnections || (() => readRuntimeConnections(options))
  const dataDir = path.resolve(options.dataDir || process.env.SKILLOPS_DATA_DIR || path.join(process.cwd(), 'data'))
  const recordFile = path.join(dataDir, 'conflict-actions.jsonl')
  const previews = new Map()
  const records = new Map()
  const mutationLockFile = path.join(dataDir, 'conflict-actions.lock')
  let mutationQueue = Promise.resolve()

  function serializeMutation(operation) {
    const pending = mutationQueue.then(() => withGovernanceFileLock(mutationLockFile, operation))
    mutationQueue = pending.catch(() => undefined)
    return pending
  }

  async function inventory() {
    const definitions = scanDefinitions(await scan())
    if (!Array.isArray(definitions)) throw new ConflictError('The installed definition scan returned an invalid response.', 500)
    return definitions
  }

  async function resolveDefinition(runtime, sourcePath) {
    if (typeof runtime !== 'string' || typeof sourcePath !== 'string') throw new ConflictError('Runtime and sourcePath are required.')
    const definition = (await inventory()).find((item) => item.runtime === runtime && samePath(item.sourcePath, sourcePath))
    if (!definition) throw new ConflictError('The selected definition is not in the current installed inventory.', 404)
    return definition
  }

  async function appendRecord(record) {
    await mkdir(dataDir, { recursive: true })
    await appendFile(recordFile, `${JSON.stringify(record)}\n`, 'utf8')
  }

  async function loadRecord(recordId) {
    if (records.has(recordId)) return records.get(recordId)
    const contents = await readFile(recordFile, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return ''
      throw error
    })
    let record
    const lines = contents.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue
      let entry
      try { entry = JSON.parse(lines[index]) } catch {
        if (index === lines.length - 1) break
        throw new ConflictError('Conflict action history is malformed.', 500)
      }
      if (entry.recordId !== recordId) continue
      if (entry.status === 'applied' && entry.changed && entry.target) record = entry
      else if (record && entry.status === 'undone') record = { ...record, status: 'undone', undoneAt: entry.undoneAt }
    }
    if (record) records.set(recordId, record)
    return record
  }

  async function targetHash(change) {
    if (change.hashType === 'tree') {
      try { return (await directorySnapshot(change.target)).contentHash } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    }
    const current = await readOptional(change.target)
    if (!current.exists) return null
    return change.hashType === 'skill' ? canonicalSkillContentHash(current.contents) : rawHash(current.contents)
  }

  async function backupHash(backup, hashType) {
    if (!backup?.path) return null
    return hashType === 'tree'
      ? (await directorySnapshot(backup.path)).contentHash
      : hashType === 'skill'
        ? canonicalSkillContentHash(await readFile(backup.path, 'utf8'))
        : rawHash(await readFile(backup.path))
  }

  async function verify(preview) {
    const [definitions, connections] = await Promise.all([inventory(), readConnections()])
    const selected = definitions.find((item) => item.runtime === preview.definition.runtime && samePath(item.sourcePath, preview.definition.sourcePath))
    if (preview.action === 'disable' && ['write-managed-section', 'write-json-property'].includes(preview.change.operation) && selected?.status !== 'disabled') {
      throw new Error('Definition remained enabled after disable.')
    }
    if (preview.action === 'enable' && (!selected || selected.enabled === false || ['disabled', 'inactive'].includes(selected.status))) {
      throw new Error('Definition remained disabled after enable.')
    }
    if ((preview.action === 'disable' && ['move', 'move-directory'].includes(preview.change.operation)) || preview.action === 'remove') {
      if (selected) throw new Error('Definition remained visible after removal from the Runtime path.')
    }
    if (preview.action === 'rename' && normalized(selected?.skillId) !== normalized(preview.newName)) throw new Error('Renamed definition was not observed by the verification scan.')
    if (preview.action === 'replace' && selected?.contentHash !== preview.expectedDefinitionHash) throw new Error('Replacement content was not observed by the verification scan.')
    const before = preview.connections.find((item) => item.runtime === preview.definition.runtime)?.status
    const after = connections.find((item) => item.runtime === preview.definition.runtime)?.status
    if (!['broken', 'error'].includes(before) && ['broken', 'error'].includes(after)) throw new Error('Runtime connection became unhealthy after the action.')
    return { scan: { definitionFound: Boolean(selected), status: selected?.status || 'absent' }, connections }
  }

  function recoveryLocation(change, backup) {
    const directory = backup?.path
      ? path.dirname(backup.path)
      : path.join(path.dirname(change.target), '.skillops-backups', `failed-${randomUUID()}`)
    return path.join(directory, `${path.basename(change.target)}.failed-${randomUUID()}`)
  }

  async function putBack(change, source) {
    try {
      if (change.hashType === 'tree') {
        if (await targetHash(change) !== null) return false
        await rename(source, change.target)
      } else {
        await link(source, change.target)
        await rm(source, { force: true })
      }
      return true
    } catch (error) {
      if (['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) return false
      throw error
    }
  }

  async function restore(change, backup, expectedHash) {
    let displaced
    const recoverablePaths = new Set(backup?.path ? [backup.path] : [])
    const failed = () => ({ restored: false, recoverablePaths: [...recoverablePaths] })
    try {
      if (await targetHash(change) !== expectedHash) return failed()
      if (expectedHash !== null) {
        displaced = recoveryLocation(change, backup)
        await mkdir(path.dirname(displaced), { recursive: true })
        await rename(change.target, displaced)
        recoverablePaths.add(displaced)
        if (await backupHash({ path: displaced }, change.hashType) !== expectedHash) {
          if (await putBack(change, displaced)) recoverablePaths.delete(displaced)
          return failed()
        }
      }
      if (await targetHash(change) !== null) return failed()
      if (change.targetExisted) {
        if (!backup?.path) return failed()
        if (change.hashType === 'tree') await rename(backup.path, change.target)
        else await link(backup.path, change.target)
      }
      const restoredHash = change.targetExisted ? backup.contentHash : null
      if (await targetHash(change) !== restoredHash) throw new Error('Restored target checksum verification failed.')
      if (displaced) {
        await rm(displaced, { recursive: true, force: true })
        recoverablePaths.delete(displaced)
      }
      return { restored: true, recoverablePaths: [] }
    } catch {
      if (displaced && await putBack(change, displaced).catch(() => false)) recoverablePaths.delete(displaced)
      return failed()
    }
  }

  async function inspect({ runtime, skillId }) {
    if (typeof runtime !== 'string' || typeof skillId !== 'string') throw new ConflictError('Runtime and skillId are required.')
    const definitions = (await inventory()).filter((item) => item.runtime === runtime && normalized(item.skillId) === normalized(skillId))
    if (!definitions.length) throw new ConflictError('No matching installed definitions were found.', 404)
    const details = await Promise.all(definitions.map(readDefinition))
    const comparisons = []
    // ponytail: conflict groups are tiny; replace pairwise comparison only if real inventories make this expensive.
    for (let left = 0; left < details.length; left += 1) {
      for (let right = left + 1; right < details.length; right += 1) comparisons.push(compareDefinitions(details[left], details[right]))
    }
    return {
      runtime,
      skillId,
      classifications: classifications(definitions),
      definitions: definitions.map((item) => ({ ...item, definitionKey: definitionKey(item) })),
      possibleLoadedDefinitions: definitions
        .filter((item) => item.enabled && item.status !== 'disabled' && item.status !== 'inactive' && item.status !== 'missing')
        .map((item) => ({ definitionKey: definitionKey(item), possible: true, status: item.status || 'active', shadowedBy: item.shadowedBy || null })),
      impact: {
        projects: [...new Set(definitions.map((item) => item.projectRoot).filter(Boolean))],
        runtimes: [...new Set(definitions.map((item) => item.runtime))],
        installationSources: [...new Set(definitions.map((item) => item.source))],
        providers: [...new Set(definitions.map((item) => item.provider).filter(Boolean))],
      },
      comparisons,
    }
  }

  function claudePluginSettingsFile(definition) {
    if (definition.configurationSource === 'managed') throw new ConflictError('Managed Claude plugin policy cannot be changed locally.', 409)
    const configured = definition.originConfigs?.at(-1)
    const registryFile = path.join(options.claudeHome || path.join(options.home || homedir(), '.claude'), 'plugins', 'installed_plugins.json')
    if (configured && !samePath(configured, registryFile)) return path.resolve(configured)
    if (definition.installationScope === 'project' && definition.projectRoot) return path.join(definition.projectRoot, '.claude', 'settings.local.json')
    return path.join(options.claudeHome || path.join(options.home || homedir(), '.claude'), 'settings.json')
  }

  function backupLocation(target, previewToken) {
    return path.join(path.dirname(path.dirname(target)), '.skillops-backups', previewToken, path.basename(target))
  }

  async function preview(request) {
    if (!actions.has(request?.action)) throw new ConflictError('Action must be keep, enable, disable, remove, rename, replace, or defer.')
    const definition = await resolveDefinition(request.runtime, request.sourcePath)
    const selected = await readDefinition(definition)
    if (definition.contentHash && definition.contentHash !== selected.contentHash) throw new ConflictError('Definition content changed after the inventory scan.', 409)
    const id = rawHash(definitionKey(definition)).slice(0, 12)
    const previewToken = randomUUID()
    let change = {
      operation: 'none',
      target: definition.sourcePath,
      targetExisted: true,
      hashType: 'raw',
      beforeHash: selected.byteHash,
      afterHash: selected.byteHash,
      diff: { before: '', after: '' },
    }
    let afterContents = selected.contents
    let expectedDefinitionHash = selected.contentHash
    let newName

    if (['disable', 'enable'].includes(request.action) && definition.runtime === 'codex' && definition.kind === 'skill') {
      const configFile = path.resolve(options.codexConfigFile || (definition.source === 'project' && definition.projectRoot
        ? path.join(definition.projectRoot, '.codex', 'config.toml')
        : path.join(options.codexHome || process.env.CODEX_HOME || path.join(options.home || homedir(), '.codex'), 'config.toml')))
      const current = await readOptional(configFile)
      const managed = managedSection(current.contents, id, path.dirname(definition.sourcePath), request.action === 'enable')
      change = {
        operation: 'write-managed-section',
        target: configFile,
        targetExisted: current.exists,
        hashType: 'raw',
        beforeHash: current.exists ? rawHash(current.contents) : null,
        afterHash: rawHash(managed.after),
        diff: { before: managed.previous, after: managed.block },
      }
      afterContents = managed.after
    } else if (definition.source === 'plugin') {
      if (!['disable', 'enable'].includes(request.action) || definition.runtime !== 'claude-code') {
        if (!['keep', 'defer'].includes(request.action)) throw new ConflictError('Plugin cache definitions cannot be removed, enabled, renamed, or replaced; change the Runtime plugin configuration instead.', 409)
      } else {
        if (!definition.pluginId) throw new ConflictError('Claude plugin identity is unavailable.', 409)
        const settingsFile = claudePluginSettingsFile(definition)
        const current = await readOptional(settingsFile)
        const update = setPluginEnabled(current.contents, definition.pluginId, request.action === 'enable')
        change = {
          operation: 'write-json-property',
          target: settingsFile,
          targetExisted: current.exists,
          hashType: 'raw',
          beforeHash: current.exists ? rawHash(current.contents) : null,
          afterHash: rawHash(update.after),
          diff: { before: update.before, after: update.afterSnippet },
        }
        afterContents = update.after
      }
    } else if (request.action === 'enable') {
      throw new ConflictError('This definition has no supported Runtime enablement setting.', 409)
    } else if (request.action === 'disable') {
      throw new ConflictError('This definition has no supported Runtime disablement setting; use Remove explicitly.', 409)
    } else if (request.action === 'remove') {
      const directory = definition.kind === 'skill'
      change = {
        operation: directory ? 'move-directory' : 'move',
        target: directory ? path.dirname(definition.sourcePath) : definition.sourcePath,
        targetExisted: true,
        hashType: directory ? 'tree' : 'raw',
        beforeHash: directory ? (await directorySnapshot(path.dirname(definition.sourcePath))).contentHash : selected.byteHash,
        afterHash: null,
        diff: { before: directory ? path.dirname(definition.sourcePath) : definition.sourcePath, after: '' },
      }
    } else if (request.action === 'rename') {
      if (typeof request.newName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(request.newName)) throw new ConflictError('A rename requires a valid newName.')
      newName = request.newName
      afterContents = replaceName(selected.contents, newName)
      expectedDefinitionHash = canonicalSkillContentHash(afterContents)
      change = {
        ...change,
        operation: 'write',
        afterHash: rawHash(afterContents),
        diff: section(selected.contents, afterContents, true),
      }
    } else if (request.action === 'replace') {
      const replacement = await resolveDefinition(definition.runtime, request.replacementSourcePath)
      if (samePath(replacement.sourcePath, definition.sourcePath)) throw new ConflictError('Replacement must be a different scanned definition.')
      if (replacement.kind !== definition.kind) throw new ConflictError('Replacement must use the same artifact kind.')
      const source = await readDefinition(replacement)
      expectedDefinitionHash = source.contentHash
      if (definition.kind === 'skill') {
        const targetDirectory = path.dirname(definition.sourcePath)
        const sourceDirectory = path.dirname(replacement.sourcePath)
        const [before, after] = await Promise.all([directorySnapshot(targetDirectory), directorySnapshot(sourceDirectory)])
        change = {
          operation: 'replace-directory',
          target: targetDirectory,
          targetExisted: true,
          hashType: 'tree',
          beforeHash: before.contentHash,
          afterHash: after.contentHash,
          replacementSourceDirectory: sourceDirectory,
          diff: { before: before.entries, after: after.entries },
          replacementDefinitionKey: definitionKey(replacement),
        }
      } else {
        afterContents = source.contents
        change = {
          ...change,
          operation: 'write',
          afterHash: source.byteHash,
          diff: section(selected.contents, source.contents, true),
          replacementDefinitionKey: definitionKey(replacement),
        }
      }
    }
    change = {
      ...change,
      backupTarget: change.operation === 'none' || !change.targetExisted ? null : backupLocation(change.target, previewToken),
    }
    if (['move', 'move-directory'].includes(change.operation)) change.diff.after = change.backupTarget

    const expiresAt = Date.now() + 10 * 60_000
    const connections = await readConnections()
    const plan = {
      schemaVersion: 1,
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
      action: request.action,
      definitionKey: definitionKey(definition),
      definition: {
        skillId: definition.skillId,
        runtime: definition.runtime,
        source: definition.source,
        sourcePath: definition.sourcePath,
        version: definition.skillVersion,
        contentHash: selected.contentHash,
      },
      changes: change.operation === 'none' ? [] : [{ ...change }],
      rollback: change.operation === 'none' ? 'No filesystem change to undo.' : 'Restore the checksum-verified backup and rescan the Runtime.',
    }
    previews.set(previewToken, {
      action: request.action,
      definition,
      definitionKey: plan.definitionKey,
      change,
      afterContents,
      expectedDefinitionHash,
      reviewedDefinitionHash: selected.contentHash,
      newName,
      connections,
      expiresAt,
      plan,
    })
    return plan
  }

  async function applyUnlocked(previewToken, confirmation = {}) {
    if (!confirmation.confirm) throw new ConflictError('Explicit action confirmation is required.')
    const preview = previews.get(previewToken)
    if (!preview || preview.expiresAt < Date.now()) throw new ConflictError('Action preview is missing or expired.', 409)
    if (confirmation.confirmedDefinitionKey !== preview.definitionKey) throw new ConflictError('Confirmation does not match the previewed definition.', 409)
    previews.delete(previewToken)

    if (preview.change.operation === 'none') {
      const record = { recordId: randomUUID(), action: preview.action, definitionKey: preview.definitionKey, status: 'applied', changed: false, appliedAt: new Date().toISOString() }
      records.set(record.recordId, record)
      await appendRecord(record)
      return record
    }

    const currentDefinition = await resolveDefinition(preview.definition.runtime, preview.definition.sourcePath)
    if (definitionKey(currentDefinition) !== preview.definitionKey
      || (await readDefinition(currentDefinition)).contentHash !== preview.reviewedDefinitionHash) {
      throw new ConflictError('The reviewed definition changed after preview.', 409)
    }
    if (await targetHash(preview.change) !== preview.change.beforeHash) throw new ConflictError('Action target changed after preview.', 409)
    if (preview.change.operation === 'replace-directory') {
      const replacement = await directorySnapshot(preview.change.replacementSourceDirectory)
      if (replacement.contentHash !== preview.change.afterHash) throw new ConflictError('Replacement source changed after preview.', 409)
    }

    const recordId = randomUUID()
    const backupPath = preview.change.backupTarget
    const backup = preview.change.targetExisted
      ? { path: backupPath, contentHash: null }
      : { path: null, contentHash: null }
    const temporaryDirectory = preview.change.operation === 'replace-directory'
      ? `${preview.change.target}.skillops-replacement-${randomUUID()}`
      : null
    let quarantined = false
    let targetInstalled = false
    if (backupPath) await mkdir(path.dirname(backupPath), { recursive: true })
    try {
      if (preview.change.operation === 'replace-directory') {
        await cp(preview.change.replacementSourceDirectory, temporaryDirectory, { recursive: true, errorOnExist: true, force: false })
        if ((await directorySnapshot(temporaryDirectory)).contentHash !== preview.change.afterHash) throw new Error('Replacement copy checksum verification failed.')
      }
      if (preview.change.targetExisted) {
        await rename(preview.change.target, backupPath)
        quarantined = true
        backup.contentHash = await backupHash(backup, preview.change.hashType)
        if (backup.contentHash !== preview.change.beforeHash) throw new Error('Backup checksum verification failed.')
      }
      if (preview.change.operation === 'replace-directory') {
        if (await targetHash(preview.change) !== null) throw new ConflictError('Action target changed while applying the reviewed change.', 409)
        await rename(temporaryDirectory, preview.change.target)
        targetInstalled = true
      } else if (!['move', 'move-directory'].includes(preview.change.operation)) {
        await writeUnoccupied(preview.change.target, preview.afterContents)
        targetInstalled = true
      }
      const verification = await verify(preview)
      const record = {
        recordId,
        action: preview.action,
        definitionKey: preview.definitionKey,
        status: 'applied',
        changed: true,
        target: preview.change.target,
        operation: preview.change.operation,
        hashType: preview.change.hashType,
        targetExisted: preview.change.targetExisted,
        beforeHash: preview.change.beforeHash,
        afterHash: preview.change.afterHash,
        backup,
        verification,
        appliedAt: new Date().toISOString(),
      }
      records.set(recordId, record)
      await appendRecord(record)
      return record
    } catch {
      let rollback = {
        restored: false,
        recoverablePaths: quarantined && backup.path ? [backup.path] : [],
      }
      if (quarantined || targetInstalled) {
        rollback = await restore(preview.change, backup, targetInstalled ? preview.change.afterHash : null)
      }
      if (rollback.restored && backup.path) await rm(path.dirname(backup.path), { recursive: true, force: true })
      const record = {
        recordId,
        action: preview.action,
        definitionKey: preview.definitionKey,
        status: 'failed',
        changed: quarantined || targetInstalled,
        target: preview.change.target,
        operation: preview.change.operation,
        hashType: preview.change.hashType,
        targetExisted: preview.change.targetExisted,
        beforeHash: preview.change.beforeHash,
        afterHash: preview.change.afterHash,
        backup,
        rollback,
        errorCode: 'ACTION_VERIFICATION_FAILED',
        appliedAt: new Date().toISOString(),
      }
      records.set(recordId, record)
      await appendRecord(record)
      return record
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
  function apply(previewToken, confirmation = {}) {
    return serializeMutation(() => applyUnlocked(previewToken, confirmation))
  }

  async function applyBatch(items) {
    if (!Array.isArray(items) || !items.length) throw new ConflictError('Batch items are required.')
    for (const item of items) {
      const preview = previews.get(item?.previewToken)
      if (!item?.confirmed || !preview || item.confirmedDefinitionKey !== preview.definitionKey) throw new ConflictError('Every batch definition must be previewed and individually confirmed.')
    }
    const results = []
    for (const item of items) results.push(await apply(item.previewToken, { confirm: true, confirmedDefinitionKey: item.confirmedDefinitionKey }))
    return { results }
  }

  async function undoUnlocked(recordId) {
    const record = await loadRecord(recordId)
    if (!record || record.status !== 'applied' || !record.changed) throw new ConflictError('Undo record is missing or cannot be undone.', 409)
    if (record.undoneAt) throw new ConflictError('Action was already undone.', 409)
    let rollback
    try {
      if (record.targetExisted) {
        const expectedBackupHash = record.backup?.contentHash || record.beforeHash
        if (await backupHash(record.backup, record.hashType) !== expectedBackupHash) {
          throw new ConflictError('Undo backup checksum verification failed.', 409)
        }
      }
      const expectedCurrentHash = ['move', 'move-directory'].includes(record.operation) ? null : record.afterHash
      rollback = await restore(record, record.backup, expectedCurrentHash)
      if (!rollback.restored) throw new ConflictError('Undo target changed while restoring the action.', 409)
    } catch (error) {
      await appendRecord({
        recordId,
        status: 'undo-failed',
        restored: false,
        recoverablePaths: rollback?.recoverablePaths || (record.backup?.path ? [record.backup.path] : []),
        undoneAt: new Date().toISOString(),
      }).catch(() => undefined)
      throw error
    }

    record.undoneAt = new Date().toISOString()
    record.status = 'undone'
    const result = { recordId, status: 'undone', restored: true, undoneAt: record.undoneAt }
    await appendRecord(result)
    let verification = { status: 'passed' }
    try {
      await Promise.all([inventory(), readConnections()])
    } catch {
      verification = { status: 'failed' }
      await appendRecord({ recordId, status: 'undo-verification-failed', restored: true, checkedAt: new Date().toISOString() }).catch(() => undefined)
    }
    if (record.backup?.path) {
      await rm(path.dirname(record.backup.path), { recursive: true, force: true }).catch(async () => {
        await appendRecord({ recordId, status: 'undo-cleanup-pending', restored: true, checkedAt: new Date().toISOString() }).catch(() => undefined)
      })
    }
    return { ...result, verification }
  }
  function undo(recordId) {
    return serializeMutation(() => undoUnlocked(recordId))
  }

  return { inspect, preview, apply, applyBatch, undo }
}
