import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolveClaudeHome } from '../../adapters/claude/config.mjs'

function frontmatter(text, key) {
  const block = text.startsWith('---') ? text.split(/^---\s*$/m)[1] ?? '' : text
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  const value = match?.[1]?.trim()
  if (!value) return undefined
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim()
  }
  return value
}

function frontmatterList(text, key) {
  const value = frontmatter(text, key)
  if (!value) return undefined
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

async function nestedFiles(directory, accept, depth = 0, maxDepth = 3, visited = new Set()) {
  if (depth > maxDepth) return []
  try {
    const canonicalDirectory = pathKey(await realpath(directory))
    if (visited.has(canonicalDirectory)) return []
    visited.add(canonicalDirectory)
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(entries.map(async (entry) => {
      const location = path.join(directory, entry.name)
      if (entry.isFile() && accept(entry.name)) return [location]
      if (entry.isDirectory()) return nestedFiles(location, accept, depth + 1, maxDepth, visited)
      if (!entry.isSymbolicLink()) return []
      try {
        const target = await stat(location)
        if (target.isFile() && accept(entry.name)) return [location]
        return target.isDirectory() ? nestedFiles(location, accept, depth + 1, maxDepth, visited) : []
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') return []
        throw error
      }
    }))
    return nested.flat()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return []
    throw error
  }
}

function skillFiles(directory, depth = 0, maxDepth = 3) {
  return nestedFiles(directory, (name) => name === 'SKILL.md', depth, maxDepth)
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
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return []
    throw error
  }
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return fallback
    throw error
  }
}

async function pluginSettings(configFile) {
  try {
    const contents = await readFile(configFile, 'utf8')
    const settings = new Map()
    let plugin
    for (const line of contents.split(/\r?\n/)) {
      const section = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/)
      if (section) {
        plugin = section[1]
        continue
      }
      if (/^\s*\[/.test(line)) plugin = undefined
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/)
      if (plugin && enabled) settings.set(plugin, enabled[1] === 'true')
    }
    return settings
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') return new Map()
    throw error
  }
}

async function codexPluginLocations(pluginCache, settings) {
  const locations = []
  for (const marketplaceDirectory of await directories(pluginCache)) {
    const marketplace = marketplaceDirectory.name.replace(/-remote$/, '')
    for (const providerDirectory of await directories(marketplaceDirectory.path)) {
      for (const versionDirectory of await directories(providerDirectory.path)) {
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

async function claudePluginSettings(claudeHome, project) {
  const settings = new Map()
  for (const file of [path.join(claudeHome, 'settings.json'), path.join(project, '.claude/settings.json')]) {
    const contents = await readJson(file)
    if (!contents.enabledPlugins || typeof contents.enabledPlugins !== 'object') continue
    for (const [plugin, enabled] of Object.entries(contents.enabledPlugins)) {
      if (typeof enabled === 'boolean') settings.set(plugin, enabled)
    }
  }
  return settings
}

async function claudePluginLocations(claudeHome, project) {
  const registry = await readJson(path.join(claudeHome, 'plugins/installed_plugins.json'), { plugins: {} })
  const settings = await claudePluginSettings(claudeHome, project)
  const locations = []
  for (const [pluginId, installations] of Object.entries(registry.plugins || {})) {
    if (!Array.isArray(installations)) continue
    const provider = pluginId.split('@')[0] || 'plugin'
    for (const installation of installations) {
      if (!appliesToProject(installation, project) || typeof installation.installPath !== 'string') continue
      const metadata = {
        runtime: 'claude-code',
        source: 'plugin',
        provider,
        enabled: settings.get(pluginId) ?? true,
        version: typeof installation.version === 'string' ? installation.version : undefined,
      }
      locations.push({ ...metadata, directory: path.join(installation.installPath, 'skills'), kind: 'skill', maxDepth: 5 })
      locations.push({ ...metadata, directory: path.join(installation.installPath, 'commands'), kind: 'command', maxDepth: 5 })
    }
  }
  return locations
}

export async function scanInstalledSkills(options = {}) {
  const project = options.project || process.cwd()
  const runtime = options.runtime
  const home = options.home || homedir()
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(home, '.codex')
  const claudeHome = await resolveClaudeHome({ ...options, home })
  const pluginCache = path.join(codexHome, 'plugins/cache')
  const installedPlugins = await pluginSettings(path.join(codexHome, 'config.toml'))
  const locations = [
    { directory: path.join(home, '.agents/skills'), runtime: 'codex', source: 'global', kind: 'skill', provider: 'Agents', enabled: true },
    { directory: path.join(codexHome, 'skills'), runtime: 'codex', source: 'global', kind: 'skill', provider: 'Codex', enabled: true },
    ...await codexPluginLocations(pluginCache, installedPlugins),
    { directory: path.join(claudeHome, 'skills'), runtime: 'claude-code', source: 'global', kind: 'skill', provider: 'Claude Code', enabled: true },
    { directory: path.join(claudeHome, 'commands'), runtime: 'claude-code', source: 'global', kind: 'command', provider: 'Claude Code', enabled: true },
    ...await claudePluginLocations(claudeHome, project),
    { directory: path.join(home, '.cursor/skills'), runtime: 'cursor', source: 'global', kind: 'skill', provider: 'Cursor', enabled: true },
    { directory: path.join(project, '.agents/skills'), runtime: 'codex', source: 'project', kind: 'skill', provider: 'Project', enabled: true },
    { directory: path.join(project, '.codex/skills'), runtime: 'codex', source: 'project', kind: 'skill', provider: 'Project', enabled: true },
    { directory: path.join(project, '.claude/skills'), runtime: 'claude-code', source: 'project', kind: 'skill', provider: 'Project', enabled: true },
    { directory: path.join(project, '.claude/commands'), runtime: 'claude-code', source: 'project', kind: 'command', provider: 'Project', enabled: true },
    { directory: path.join(project, '.cursor/skills'), runtime: 'cursor', source: 'project', kind: 'skill', provider: 'Project', enabled: true },
  ].filter((location) => !runtime || location.runtime === runtime)

  const seen = new Set()
  const discovered = []
  for (const location of locations) {
    const files = location.kind === 'command'
      ? await commandFiles(location.directory, 0, location.maxDepth)
      : await skillFiles(location.directory, 0, location.maxDepth)
    for (const file of files) {
      const canonical = pathKey(file)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      let contents
      try {
        contents = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') continue
        throw error
      }
      discovered.push({
        skillId: frontmatter(contents, 'name') || (location.kind === 'command'
          ? path.basename(file, '.md')
          : path.basename(path.dirname(file))),
        skillVersion: frontmatter(contents, 'version') || location.version || 'unversioned',
        runtime: location.runtime,
        source: location.source,
        sourcePath: file,
        kind: location.kind,
        provider: location.provider,
        enabled: location.enabled,
        description: frontmatter(contents, 'description'),
        tags: frontmatterList(contents, 'tags'),
      })
    }
  }
  return discovered
}
