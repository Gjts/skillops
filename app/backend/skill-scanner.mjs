import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolveClaudeHome } from '../../adapters/claude/config.mjs'
import { artifactIdFromPath } from './artifact-identity.mjs'
import { resolveProjectRoot } from './project-root.mjs'
import { readArtifactPackage } from './evaluations/artifact-package.mjs'

function unavailablePath(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES' || error?.code === 'EPERM'
}

function frontmatter(text, key) {
  const block = text.startsWith('---') ? text.split(/^---\s*$/m)[1] ?? '' : ''
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  const value = match?.[1]?.trim()
  if (!value) return undefined
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim()
  }
  return value
}

function definitionValue(text, key, format) {
  if (format !== 'toml') return frontmatter(text, key)
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'))
  if (!match) return undefined
  if (match[1].startsWith("'")) return match[1].slice(1, -1).trim()
  try {
    return JSON.parse(match[1]).trim()
  } catch {
    return undefined
  }
}

function frontmatterList(text, key) {
  const value = frontmatter(text, key)
  if (!value) return undefined
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

async function nestedFiles(directory, accept, depth = 0, maxDepth = 3, visited = new Set(), reportError, readDirectory = readdir) {
  if (depth > maxDepth) return []
  try {
    const canonicalDirectory = pathKey(await realpath(directory))
    if (visited.has(canonicalDirectory)) return []
    visited.add(canonicalDirectory)
    const entries = await readDirectory(directory, { withFileTypes: true })
    const nested = await Promise.all(entries.map(async (entry) => {
      const location = path.join(directory, entry.name)
      if (entry.isFile() && accept(entry.name)) return [location]
      if (entry.isDirectory()) return nestedFiles(location, accept, depth + 1, maxDepth, visited, reportError, readDirectory)
      if (!entry.isSymbolicLink()) return []
      try {
        const target = await stat(location)
        if (target.isFile() && accept(entry.name)) return [location]
        return target.isDirectory() ? nestedFiles(location, accept, depth + 1, maxDepth, visited, reportError, readDirectory) : []
      } catch (error) {
        if (unavailablePath(error)) {
          if (error?.code === 'EACCES' || error?.code === 'EPERM') reportError?.(error, location)
          return []
        }
        throw error
      }
    }))
    return nested.flat()
  } catch (error) {
    if (unavailablePath(error)) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') reportError?.(error, directory)
      return []
    }
    throw error
  }
}

function skillFiles(directory, depth = 0, maxDepth = 3, reportError, readDirectory) {
  return nestedFiles(directory, (name) => name === 'SKILL.md', depth, maxDepth, new Set(), reportError, readDirectory)
}

function commandFiles(directory, depth = 0, maxDepth = 3) {
  return nestedFiles(directory, (name) => name.endsWith('.md'), depth, maxDepth)
}

async function directories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
  } catch (error) {
    if (unavailablePath(error)) return []
    throw error
  }
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (unavailablePath(error)) return fallback
    throw error
  }
}

async function pluginSettings(configFile) {
  try {
    const contents = await readFile(configFile, 'utf8')
    const settings = new Map()
    let plugin
    for (const line of contents.split(/\r?\n/)) {
      const section = line.match(/^\s*\[plugins\."([^"]+)"\]\s*(?:#.*)?$/)
      if (section) {
        plugin = section[1]
        continue
      }
      if (/^\s*\[/.test(line)) plugin = undefined
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/)
      if (plugin && enabled) settings.set(plugin, enabled[1] === 'true')
    }
    return settings
  } catch (error) {
    if (unavailablePath(error)) return new Map()
    throw error
  }
}

async function jsonFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name))
      .sort()
  } catch (error) {
    if (unavailablePath(error)) return []
    throw error
  }
}

function parseSemver(value) {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return undefined
  const prerelease = match[4]?.split('.')
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return undefined
  return {
    core: match.slice(1, 4).map(Number),
    prerelease,
  }
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0
  if (!left) return 1
  if (!right) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    if (left[index] === right[index]) continue
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : undefined
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function comparePluginVersions(left, right) {
  const leftSemver = parseSemver(left)
  const rightSemver = parseSemver(right)
  if (!leftSemver || !rightSemver) return left < right ? -1 : left > right ? 1 : 0
  for (let index = 0; index < leftSemver.core.length; index += 1) {
    if (leftSemver.core[index] !== rightSemver.core[index]) return leftSemver.core[index] - rightSemver.core[index]
  }
  return comparePrerelease(leftSemver.prerelease, rightSemver.prerelease)
}

function activePluginVersion(versionDirectories) {
  const local = versionDirectories.find((directory) => directory.name === 'local')
  if (local) return local
  const semverDirectories = versionDirectories.filter((directory) => parseSemver(directory.name))
  const candidates = semverDirectories.length ? semverDirectories : versionDirectories
  return candidates.sort((left, right) => comparePluginVersions(left.name, right.name)).at(-1)
}

export function canonicalSkillContentHash(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
}

function tomlString(value) {
  try {
    if (value.startsWith('"')) return JSON.parse(value)
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  } catch {
    return undefined
  }
  return undefined
}

async function codexSkillSettings(configFile) {
  try {
    const contents = await readFile(configFile, 'utf8')
    const settings = new Map()
    let current
    const commit = () => {
      if (!current?.path) return
      const configuredPath = path.isAbsolute(current.path)
        ? current.path
        : path.resolve(path.dirname(configFile), current.path)
      settings.set(pathKey(configuredPath), current.enabled ?? true)
    }
    for (const line of contents.split(/\r?\n/)) {
      if (/^\s*\[\[\s*skills\.config\s*\]\]\s*(?:#.*)?$/.test(line)) {
        commit()
        current = {}
        continue
      }
      if (/^\s*\[/.test(line)) {
        commit()
        current = undefined
        continue
      }
      if (!current) continue
      const configuredPath = line.match(/^\s*path\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/)
      if (configuredPath) current.path = tomlString(configuredPath[1])
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/)
      if (enabled) current.enabled = enabled[1] === 'true'
    }
    commit()
    return settings
  } catch (error) {
    if (unavailablePath(error)) return new Map()
    throw error
  }
}

async function mergedSettings(configFiles, reader) {
  const settings = new Map()
  for (const configFile of configFiles) {
    for (const [key, enabled] of await reader(configFile)) settings.set(key, enabled)
  }
  return settings
}

async function codexPluginLocations(pluginCache, settings) {
  const locations = []
  for (const marketplaceDirectory of await directories(pluginCache)) {
    const marketplace = marketplaceDirectory.name.replace(/-remote$/, '')
    for (const providerDirectory of await directories(marketplaceDirectory.path)) {
      const versionDirectory = activePluginVersion(await directories(providerDirectory.path))
      if (!versionDirectory) continue
      locations.push({
        directory: path.join(versionDirectory.path, 'skills'),
        runtime: 'codex',
        source: 'plugin',
        kind: 'skill',
        maxDepth: 4,
        provider: providerDirectory.name,
        enabled: settings.get(`${providerDirectory.name}@${marketplace}`) ?? true,
        version: versionDirectory.name,
      })
    }
  }
  return locations
}

function pathKey(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function appliesToProject(installation, project) {
  return installation?.scope === 'user' ||
    (installation?.scope === 'project' && typeof installation.projectPath === 'string' && pathKey(installation.projectPath) === pathKey(project))
}

function claudeManagedSettingsDirectory(options = {}) {
  if (options.claudeManagedSettingsDirectory) return options.claudeManagedSettingsDirectory
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (process.platform === 'win32') {
    const environment = options.environment || process.env
    return path.join(environment.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
  }
  return '/etc/claude-code'
}

async function claudePluginSettings(claudeHome, project, options = {}) {
  const settings = new Map()
  const managedDirectory = claudeManagedSettingsDirectory(options)
  const files = [
    { file: path.join(claudeHome, 'settings.json'), configurationSource: 'user' },
    { file: path.join(project, '.claude/settings.json'), configurationSource: 'project' },
    { file: path.join(project, '.claude/settings.local.json'), configurationSource: 'local' },
    { file: path.join(managedDirectory, 'managed-settings.json'), configurationSource: 'managed' },
    ...(await jsonFiles(path.join(managedDirectory, 'managed-settings.d')))
      .map((file) => ({ file, configurationSource: 'managed' })),
  ]
  for (const { file, configurationSource } of files) {
    const contents = await readJson(file)
    if (!contents.enabledPlugins || typeof contents.enabledPlugins !== 'object') continue
    for (const [plugin, enabled] of Object.entries(contents.enabledPlugins)) {
      if (typeof enabled === 'boolean') settings.set(plugin, { enabled, configurationSource, originConfig: file })
    }
  }
  return settings
}

async function claudePluginLocations(claudeHome, project, options = {}) {
  const registryFile = path.join(claudeHome, 'plugins/installed_plugins.json')
  const registry = await readJson(registryFile, { plugins: {} })
  const settings = await claudePluginSettings(claudeHome, project, options)
  const locations = []
  for (const [pluginId, installations] of Object.entries(registry.plugins || {})) {
    if (!Array.isArray(installations)) continue
    const provider = pluginId.split('@')[0] || 'plugin'
    const setting = settings.get(pluginId)
    for (const installation of installations) {
      if (!appliesToProject(installation, project) || typeof installation.installPath !== 'string') continue
      const metadata = {
        runtime: 'claude-code',
        source: 'plugin',
        provider,
        pluginId,
        installationScope: installation.scope,
        enabled: setting?.enabled ?? true,
        version: typeof installation.version === 'string' ? installation.version : undefined,
        configurationSource: setting?.configurationSource ?? 'plugin',
        scope: setting?.configurationSource ?? 'plugin',
        originConfigs: [registryFile, ...(setting?.originConfig ? [setting.originConfig] : [])],
      }
      locations.push({ ...metadata, directory: path.join(installation.installPath, 'skills'), kind: 'skill', maxDepth: 5 })
      locations.push({ ...metadata, directory: path.join(installation.installPath, 'commands'), kind: 'command', maxDepth: 5 })
      locations.push({ ...metadata, directory: path.join(installation.installPath, 'agents'), kind: 'agent', maxDepth: 5 })
    }
  }
  return locations
}

function directoryChain(start, root) {
  const resolvedStart = path.resolve(start)
  const resolvedRoot = path.resolve(root)
  const relative = path.relative(resolvedRoot, resolvedStart)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [resolvedRoot]
  const result = []
  let current = resolvedStart
  while (true) {
    result.push(current)
    if (pathKey(current) === pathKey(resolvedRoot)) return result
    current = path.dirname(current)
  }
}

function directLocation(directory, runtime, source, kind, provider, configurationSource) {
  return {
    directory,
    runtime,
    source,
    kind,
    provider,
    enabled: true,
    configurationSource,
    scope: configurationSource,
    originConfigs: [],
  }
}

function configuredLocation(directory, enabled, project) {
  const relative = path.relative(project, directory)
  const inProject = !relative.startsWith('..') && !path.isAbsolute(relative)
  return {
    directory,
    runtime: 'codex',
    source: inProject ? 'project' : 'global',
    kind: 'skill',
    provider: 'Codex config',
    enabled,
    configured: true,
    maxDepth: 0,
    configurationSource: inProject ? 'project' : 'user',
    scope: inProject ? 'project' : 'user',
    originConfigs: [],
  }
}

async function createScanState(options = {}) {
  const projectStart = path.resolve(options.project || process.cwd())
  const project = path.resolve(options.projectRoot || await resolveProjectRoot(projectStart))
  const runtime = options.runtime
  const home = options.home || homedir()
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(home, '.codex')
  const claudeHome = await resolveClaudeHome({ ...options, home })
  const pluginCache = path.join(codexHome, 'plugins/cache')
  const codexConfigs = [
    path.join(codexHome, 'config.toml'),
    path.join(project, '.codex/config.toml'),
  ]
  const [installedPlugins, configuredSkills] = await Promise.all([
    mergedSettings(codexConfigs, pluginSettings),
    mergedSettings(codexConfigs, codexSkillSettings),
  ])
  const [codexPlugins, claudePlugins] = await Promise.all([
    codexPluginLocations(pluginCache, installedPlugins),
    claudePluginLocations(claudeHome, project, options),
  ])
  const projectDirectories = directoryChain(projectStart, project)
  const environment = options.environment || process.env
  const adminDirectories = options.codexAdminSkillsDirectories || ((options.platform || process.platform) === 'win32'
    ? [path.join(environment.ProgramData || environment.PROGRAMDATA || 'C:\\ProgramData', 'OpenAI', 'Codex', 'skills')]
    : ['/etc/codex/skills'])
  const locations = [
    directLocation(path.join(home, '.agents/skills'), 'codex', 'global', 'skill', 'Agents', 'user'),
    directLocation(path.join(codexHome, 'skills'), 'codex', 'global', 'skill', 'Codex', 'user'),
    { ...directLocation(path.join(codexHome, 'agents'), 'codex', 'global', 'agent', 'Codex', 'user'), fileExtension: '.toml', format: 'toml' },
    directLocation(path.join(codexHome, 'prompts'), 'codex', 'global', 'command', 'Codex', 'user'),
    ...adminDirectories.map((directory) => directLocation(directory, 'codex', 'global', 'skill', 'Codex Admin', 'admin')),
    ...codexPlugins.map((location) => ({
      ...location,
      configurationSource: 'plugin',
      scope: 'plugin',
      originConfigs: codexConfigs,
    })),
    directLocation(path.join(claudeHome, 'skills'), 'claude-code', 'global', 'skill', 'Claude Code', 'user'),
    { ...directLocation(claudeHome, 'claude-code', 'global', 'rules', 'Claude Code', 'user'), fileNames: ['CLAUDE.md'], maxDepth: 0 },
    directLocation(path.join(claudeHome, 'rules'), 'claude-code', 'global', 'rules', 'Claude Code', 'user'),
    directLocation(path.join(claudeHome, 'agents'), 'claude-code', 'global', 'agent', 'Claude Code', 'user'),
    directLocation(path.join(claudeHome, 'commands'), 'claude-code', 'global', 'command', 'Claude Code', 'user'),
    ...claudePlugins.map((location) => ({
      ...location,
      configurationSource: location.configurationSource || 'plugin',
      scope: location.scope || 'plugin',
      originConfigs: location.originConfigs || [path.join(claudeHome, 'plugins/installed_plugins.json')],
    })),
    directLocation(path.join(home, '.cursor/skills'), 'cursor', 'global', 'skill', 'Cursor', 'user'),
    { ...directLocation(codexHome, 'codex', 'global', 'rules', 'Codex', 'user'), fileNames: ['AGENTS.md', 'AGENTS.override.md'], maxDepth: 0 },
    ...projectDirectories.flatMap((directory) => [
      directLocation(path.join(directory, '.agents/skills'), 'codex', 'project', 'skill', 'Project', 'project'),
      directLocation(path.join(directory, '.claude/skills'), 'claude-code', 'project', 'skill', 'Project', 'project'),
      directLocation(path.join(directory, '.claude/commands'), 'claude-code', 'project', 'command', 'Project', 'project'),
      { ...directLocation(directory, 'codex', 'project', 'rules', 'Project', 'project'), fileNames: ['AGENTS.md', 'AGENTS.override.md'], maxDepth: 0 },
      { ...directLocation(path.join(directory, '.codex/agents'), 'codex', 'project', 'agent', 'Project', 'project'), fileExtension: '.toml', format: 'toml' },
      { ...directLocation(directory, 'claude-code', 'project', 'rules', 'Project', 'project'), fileNames: ['CLAUDE.md'], maxDepth: 0 },
      { ...directLocation(path.join(directory, '.claude'), 'claude-code', 'project', 'rules', 'Project', 'project'), fileNames: ['CLAUDE.md'], maxDepth: 0 },
      directLocation(path.join(directory, '.claude/rules'), 'claude-code', 'project', 'rules', 'Project', 'project'),
      directLocation(path.join(directory, '.claude/agents'), 'claude-code', 'project', 'agent', 'Project', 'project'),
    ]),
    directLocation(path.join(project, '.codex/skills'), 'codex', 'project', 'skill', 'Project', 'project'),
    directLocation(path.join(project, '.cursor/skills'), 'cursor', 'project', 'skill', 'Project', 'project'),
    ...[...configuredSkills].map(([directory, enabled]) => configuredLocation(directory, enabled, project)),
  ].filter((location) => !runtime || location.runtime === runtime)
  return { projectStart, project, configuredSkills, locations }
}

function shadowDefinition(definition, winner) {
  return {
    ...definition,
    enabled: false,
    status: 'shadowed',
    shadowedBy: winner.sourcePath,
  }
}

function classifyDefinitionStatuses(definitions) {
  const groups = new Map()
  definitions.forEach((definition, index) => {
    if (definition.runtime !== 'claude-code' || definition.source === 'plugin' || definition.status !== 'active') return
    const key = `${['skill', 'command'].includes(definition.kind) ? 'invocable' : definition.kind}:${definition.skillId.trim().toLowerCase()}`
    const group = groups.get(key) || []
    group.push(index)
    groups.set(key, group)
  })
  for (const indexes of groups.values()) {
    const active = indexes.map((index) => definitions[index])
    const managed = active.filter((item) => item.configurationSource === 'managed')
    const personal = active.filter((item) => item.configurationSource === 'user')
    const highest = managed.length ? managed : personal
    const skillWinner = highest.filter((item) => item.kind === 'skill')
    const winners = skillWinner.length ? skillWinner : highest
    if (winners.length === 1) {
      const winner = winners[0]
      indexes.forEach((index) => {
        const definition = definitions[index]
        if (definition !== winner && definition.configurationSource !== winner.configurationSource) {
          definitions[index] = shadowDefinition(definition, winner)
        }
      })
    }
    const current = indexes.map((index) => definitions[index])
    const activeSkills = current.filter((item) => item.status === 'active' && item.kind === 'skill')
    if (activeSkills.length === 1) {
      current.forEach((definition) => {
        if (definition.status !== 'active' || definition.kind !== 'command') return
        const index = definitions.indexOf(definition)
        definitions[index] = shadowDefinition(definition, activeSkills[0])
      })
    }
  }
  return definitions
}

async function scanDefinitions(state, options = {}, errors = []) {
  const seen = new Set()
  const discovered = []
  const readDirectory = options.readDirectory || readdir
  for (const location of state.locations) {
    const reportError = (error, failedPath) => {
      if (errors.some((item) => item.runtime === location.runtime && item.path === failedPath && item.code === error.code)) return
      errors.push({
        code: error.code,
        path: failedPath,
        runtime: location.runtime,
        source: location.source,
        configurationSource: location.configurationSource,
        scope: location.scope,
        originConfigs: location.originConfigs,
        scanRoot: location.directory,
        message: 'Nested scan path is not accessible.',
      })
    }
    const files = location.kind === 'skill'
      ? await skillFiles(location.directory, 0, location.maxDepth, reportError, readDirectory)
      : await nestedFiles(location.directory, (name) => location.fileNames
          ? location.fileNames.includes(name)
          : name.endsWith(location.fileExtension || '.md'), 0, location.maxDepth, new Set(), reportError, readDirectory)
    if (!files.length && location.configured) {
      discovered.push({
        skillId: path.basename(location.directory),
        skillVersion: 'unversioned',
        runtime: location.runtime,
        source: location.source,
        sourcePath: path.join(location.directory, 'SKILL.md'),
        kind: location.kind,
        provider: location.provider,
        enabled: false,
        status: 'missing',
        configurationSource: location.configurationSource,
        scope: location.scope,
        originConfigs: location.originConfigs,
        projectRoot: state.project,
      })
      continue
    }
    for (const file of files) {
      let identity
      let contents
      let packageRecord
      try {
        const info = await stat(file, { bigint: true })
        identity = info.dev !== 0n || info.ino !== 0n
          ? `inode:${info.dev}:${info.ino}`
          : `path:${pathKey(await realpath(file))}`
        if (seen.has(identity)) continue
        if (location.kind === 'skill') {
          packageRecord = await readArtifactPackage(path.dirname(file))
          const primary = packageRecord.packageFiles.find((item) => item.relativePath === path.basename(file))
          if (!primary) throw new Error('Scanned Skill package does not contain its definition.')
          contents = primary.contents.toString('utf8')
        } else {
          contents = await readFile(file, 'utf8')
        }
      } catch (error) {
        if (unavailablePath(error)) continue
        throw error
      }
      seen.add(identity)
      const skillSetting = location.runtime === 'codex' && location.kind === 'skill'
        ? state.configuredSkills.get(pathKey(path.dirname(file)))
        : undefined
      const enabled = location.enabled && skillSetting !== false
      const disabledReason = !enabled
        ? (!location.enabled && skillSetting === false
            ? 'plugin-and-skill-config'
            : !location.enabled ? 'plugin' : 'skill-config')
        : undefined
      discovered.push({
        skillId: definitionValue(contents, 'name', location.format) || artifactIdFromPath(file, location.kind),
        skillVersion: definitionValue(contents, 'version', location.format) || location.version || 'unversioned',
        runtime: location.runtime,
        source: location.source,
        sourcePath: file,
        kind: location.kind,
        provider: location.provider,
        pluginId: location.pluginId,
        installationScope: location.installationScope,
        enabled,
        disabledReason,
        status: enabled ? 'active' : 'disabled',
        configurationSource: location.configurationSource,
        scope: location.scope,
        originConfigs: location.originConfigs,
        projectRoot: state.project,
        contentHash: packageRecord?.contentHash || canonicalSkillContentHash(contents),
        packageFileCount: packageRecord?.packageFiles.length,
        description: definitionValue(contents, 'description', location.format),
        tags: location.format === 'toml' ? undefined : frontmatterList(contents, 'tags'),
      })
    }
  }
  return classifyDefinitionStatuses(discovered)
}

async function inspectCoverage(locations, inspectPath) {
  const coverage = []
  const errors = []
  const seen = new Set()
  for (const location of locations) {
    const key = `${location.runtime}:${pathKey(location.directory)}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = {
      runtime: location.runtime,
      directory: location.directory,
      source: location.source,
      configurationSource: location.configurationSource,
      scope: location.scope,
      originConfigs: location.originConfigs,
    }
    try {
      const details = await inspectPath(location.directory)
      coverage.push({ ...item, state: typeof details?.isDirectory === 'function' && !details.isDirectory() ? 'missing' : 'scanned' })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        coverage.push({ ...item, state: 'missing' })
        continue
      }
      const inaccessible = error?.code === 'EACCES' || error?.code === 'EPERM'
      coverage.push({ ...item, state: inaccessible ? 'inaccessible' : 'error' })
      errors.push({
        code: typeof error?.code === 'string' ? error.code : 'SCAN_PATH_ERROR',
        path: location.directory,
        runtime: location.runtime,
        message: inaccessible ? 'Scan location is not accessible.' : 'Scan location could not be inspected.',
      })
    }
  }
  return { coverage, errors }
}

export async function scanInstalledSkills(options = {}) {
  return scanDefinitions(await createScanState(options), options)
}

export async function scanSkillInventory(options = {}) {
  const startedAt = new Date()
  const started = Date.now()
  const state = await createScanState(options)
  const inspectPath = options.inspectPath || stat
  const nestedErrors = []
  const [{ coverage, errors }, definitions] = await Promise.all([
    inspectCoverage(state.locations, inspectPath),
    scanDefinitions(state, options, nestedErrors),
  ])
  const partialRoots = new Set(nestedErrors.map((error) => `${error.runtime}:${pathKey(error.scanRoot)}`))
  const completedAt = new Date()
  return {
    definitions,
    scan: {
      id: `scan_${randomUUID()}`,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Date.now() - started,
      projectStart: state.projectStart,
      projectRoot: state.project,
      coverage: coverage.map((item) => item.state === 'scanned' && partialRoots.has(`${item.runtime}:${pathKey(item.directory)}`)
        ? { ...item, state: 'partial' }
        : item),
      errors: [...errors, ...nestedErrors.map(({ scanRoot: _, ...error }) => error)],
      observability: options.runtime && options.runtime !== 'claude-code' ? [] : [{
        runtime: 'claude-code',
        state: 'partial',
        reason: 'Server-managed settings, MDM policy, and Windows registry policy cannot be reconstructed from filesystem data.',
      }],
    },
  }
}
