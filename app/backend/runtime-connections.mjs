import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveEffectiveSettingsFile } from '../../adapters/claude/config.mjs'
import { hasSkillOpsHooks as hasClaudeHooks } from '../../adapters/claude/install.mjs'
import { hasSkillOpsHooks as hasCodexHooks, resolveHooksFile } from '../../adapters/codex/install.mjs'

function skillOpsHandlers(value, marker, handlers = []) {
  if (!value || typeof value !== 'object') return handlers
  if ((typeof value.command === 'string' && value.command.includes(marker)) ||
      (typeof value.commandWindows === 'string' && value.commandWindows.includes(marker))) {
    handlers.push(value)
  }
  for (const nested of Object.values(value)) skillOpsHandlers(nested, marker, handlers)
  return handlers
}

function hookPaths(handler) {
  const paths = new Set()
  for (const command of [handler.command, handler.commandWindows]) {
    if (typeof command !== 'string') continue
    for (const match of command.matchAll(/["']([^"']+\.mjs)["']/g)) paths.add(match[1])
    for (const match of command.matchAll(/(?:^|\s)([^\s"'&|]+\.mjs)(?=\s|$)/g)) paths.add(match[1])
  }
  return [...paths]
}

async function isFile(file) {
  try {
    return path.isAbsolute(file) && (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function inspectConfiguration(file, hasHooks, marker) {
  try {
    const config = JSON.parse(await readFile(file, 'utf8'))
    if (!hasHooks(config)) return 'not-installed'
    const paths = skillOpsHandlers(config, marker).flatMap(hookPaths)
    if (!paths.length || !(await Promise.all(paths.map(isFile))).every(Boolean)) return 'broken'
    return 'installed'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'not-installed'
    return 'error'
  }
}

export async function readRuntimeConnections({ codexHome, claudeHome, home, ccSwitchHome, environment } = {}) {
  const claudeSettings = await resolveEffectiveSettingsFile({ claudeHome, home, ccSwitchHome, environment })
  const [codex, claude] = await Promise.all([
    inspectConfiguration(resolveHooksFile({ codexHome }), hasCodexHooks, 'skillops-codex-hook'),
    inspectConfiguration(claudeSettings, hasClaudeHooks, 'skillops-claude-hook'),
  ])
  return [
    { runtime: 'codex', status: codex },
    { runtime: 'claude-code', status: claude },
    { runtime: 'cursor', status: 'preview' },
  ]
}

export function enrichRuntimeConnections(connections, events, checkedAt = new Date().toISOString()) {
  return connections.map((connection) => {
    const activity = events
      .filter((event) => event.runtime === connection.runtime && event.event !== 'skill.discovered' && !Number.isNaN(Date.parse(event.timestamp)))
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    return {
      ...connection,
      checkedAt,
      eventCount: activity.length,
      ...(activity[0] ? { lastEventAt: activity[0].timestamp } : {}),
    }
  })
}
