import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setJsonApiHeaders, sendApiError, sendJson } from './api-response.mjs'
import { dataDir } from './event-store.mjs'
import { EvaluationError } from './evaluations/errors.mjs'
import { assertLocalApiRequest } from './evaluations/request-guard.mjs'
import { readRuntimeConnections } from './runtime-connections.mjs'

const MINIMUM_NODE_VERSION = '22.22.0'
const runFile = promisify(execFile)
const runtimes = new Set(['codex', 'claude-code', 'cursor'])
const configurationStatuses = new Set(['installed', 'not-installed', 'broken', 'error', 'preview'])
const adapterHealth = {
  installed: 'healthy',
  'not-installed': 'not-configured',
  broken: 'unhealthy',
  error: 'unknown',
  preview: 'unsupported',
  unknown: 'unknown',
}

function versionAtLeast(version, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false
  const current = version.split('.').map(Number)
  const required = minimum.split('.').map(Number)
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index]
  }
  return true
}

async function gitAvailable() {
  try {
    await runFile('git', ['--version'], { timeout: 3_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function directoryWritable(directory) {
  let current = path.resolve(directory)
  while (true) {
    try {
      if (!(await stat(current)).isDirectory()) return false
      await access(current, constants.W_OK)
      return true
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR'].includes(error?.code)) return false
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

async function safeBoolean(probe, ...args) {
  try {
    return Boolean(await probe(...args))
  } catch {
    return false
  }
}

async function inspectBoolean(probe, ...args) {
  try {
    return { available: true, value: Boolean(await probe(...args)) }
  } catch {
    return { available: false, value: false }
  }
}

function sanitizedConnection(connection) {
  if (!runtimes.has(connection?.runtime)) return null
  const rawStatus = connection.configurationStatus || connection.status
  const configurationStatus = configurationStatuses.has(rawStatus) ? rawStatus : 'unknown'
  return {
    runtime: connection.runtime,
    configurationDetected: Boolean(connection.detected),
    configurationStatus,
    adapterReferenceHealth: adapterHealth[configurationStatus],
  }
}

async function inspectRuntimes(reader) {
  try {
    const connections = await reader()
    if (!Array.isArray(connections)) return { available: false, items: [] }
    return { available: true, items: connections.map(sanitizedConnection).filter(Boolean) }
  } catch {
    return { available: false, items: [] }
  }
}

export async function readSetupPreflight({
  nodeVersion = process.versions.node,
  checkGit = gitAvailable,
  probeDataDirectory = directoryWritable,
  dataDirectory = dataDir,
  readConnections = readRuntimeConnections,
  now = () => new Date().toISOString(),
} = {}) {
  const [git, directoryInspection, runtimeInspection] = await Promise.all([
    safeBoolean(checkGit),
    inspectBoolean(probeDataDirectory, dataDirectory),
    inspectRuntimes(readConnections),
  ])
  return {
    checkedAt: now(),
    node: { version: nodeVersion, minimumVersion: MINIMUM_NODE_VERSION, supported: versionAtLeast(nodeVersion, MINIMUM_NODE_VERSION) },
    git: { available: git },
    localApi: { available: true },
    dataDirectory: { available: directoryInspection.available, writable: directoryInspection.value },
    runtimes: runtimeInspection,
  }
}

export async function handleSetupPreflightApi(request, response, pathname, services = {}) {
  if (pathname !== '/api/setup/preflight') return false
  setJsonApiHeaders(response)
  try {
    assertLocalApiRequest(request)
    if (request.method !== 'GET') throw new EvaluationError('Method not allowed.', 405)
    sendJson(response, 200, await readSetupPreflight(services))
  } catch (error) {
    if (error?.status === 405) response.setHeader('Allow', 'GET')
    sendApiError(response, error, 'Setup preflight failed.')
  }
  return true
}
