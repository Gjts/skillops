import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveEffectiveSettingsFile } from '../../adapters/claude/config.mjs'
import { hasSkillOpsHooks as hasClaudeHooks } from '../../adapters/claude/install.mjs'
import { hasSkillOpsHooks as hasCodexHooks, resolveHooksFile } from '../../adapters/codex/install.mjs'
import { connectionStage as deriveConnectionStage, isQualifyingLifecycle } from '../shared/truth-semantics.mjs'

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

async function fileStats(file) {
  try {
    const info = path.isAbsolute(file) ? await stat(file) : null
    return info?.isFile() ? info : null
  } catch {
    return null
  }
}

async function inspectConfiguration(file, hasHooks, marker) {
  let configStats
  try {
    configStats = await stat(file)
    const config = JSON.parse(await readFile(file, 'utf8'))
    if (!hasHooks(config)) return { configurationStatus: 'not-installed', detected: true }
    const paths = skillOpsHandlers(config, marker).flatMap(hookPaths)
    const hookStats = await Promise.all(paths.map(fileStats))
    const verificationBoundaryAt = new Date(Math.max(configStats.mtimeMs, ...hookStats.filter(Boolean).map((info) => info.mtimeMs))).toISOString()
    if (!paths.length || hookStats.some((info) => !info)) return { configurationStatus: 'broken', detected: true, verificationBoundaryAt }
    return { configurationStatus: 'installed', detected: true, verificationBoundaryAt }
  } catch (error) {
    if (error?.code === 'ENOENT') return { configurationStatus: 'not-installed', detected: false }
    return {
      configurationStatus: 'error',
      detected: Boolean(configStats),
      ...(configStats ? { verificationBoundaryAt: new Date(configStats.mtimeMs).toISOString() } : {}),
    }
  }
}

export async function readRuntimeConnections({ codexHome, claudeHome, home, ccSwitchHome, environment } = {}) {
  const claudeSettings = await resolveEffectiveSettingsFile({ claudeHome, home, ccSwitchHome, environment })
  const [codex, claude] = await Promise.all([
    inspectConfiguration(resolveHooksFile({ codexHome }), hasCodexHooks, 'skillops-codex-hook'),
    inspectConfiguration(claudeSettings, hasClaudeHooks, 'skillops-claude-hook'),
  ])
  return [
    { runtime: 'codex', status: codex.configurationStatus, ...codex },
    { runtime: 'claude-code', status: claude.configurationStatus, ...claude },
    { runtime: 'cursor', status: 'preview', configurationStatus: 'preview', detected: false },
  ]
}

export function enrichRuntimeConnections(connections, events, checkedAt = new Date().toISOString()) {
  return connections.map((connection) => {
    const activity = events
      .filter((event) => event.runtime === connection.runtime && event.event !== 'skill.discovered' && !Number.isNaN(Date.parse(event.timestamp)))
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    const boundary = Date.parse(connection.verificationBoundaryAt || '')
    const qualifying = activity.filter((event) => isQualifyingLifecycle(event)
      && (!Number.isFinite(boundary) || Date.parse(event.timestamp) > boundary))
    const terminal = qualifying.filter((event) => event.event === 'skill.completed' || event.event === 'skill.failed')
    const configurationStatus = connection.configurationStatus || connection.status
    const verifiedEvidenceAt = qualifying[0]?.timestamp
    return {
      ...connection,
      configurationStatus,
      connectionStage: deriveConnectionStage({
        configurationStatus,
        detected: connection.detected,
        eventCount: activity.length,
        verifiedEvidenceAt,
      }),
      checkedAt,
      eventCount: activity.length,
      activityObserved: activity.length > 0,
      skillUseObserved: qualifying.length > 0,
      terminalRunObserved: terminal.length > 0,
      ...(verifiedEvidenceAt ? { verifiedEvidenceAt } : {}),
      ...(activity[0] ? { lastEventAt: activity[0].timestamp, lastActivityAt: activity[0].timestamp } : {}),
      ...(qualifying[0] ? { lastSkillUseAt: qualifying[0].timestamp } : {}),
      ...(terminal[0] ? { lastTerminalRunAt: terminal[0].timestamp } : {}),
    }
  })
}
