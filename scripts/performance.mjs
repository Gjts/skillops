import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { normalizeEvent } from '../app/shared/event-schema.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SEED = 'skillops-personal-v1'
const EVENT_COUNT = 100_000
const DEFINITION_COUNT = 5_000
const FIXED_NOW = Date.parse('2026-07-25T12:00:00.000Z')
const SENTINEL = 'SKILLOPS_PRIVATE_SENTINEL_7f0d9a'
const COMMAND_CENTER = '/api/command-center?runtime=all&window=30d'
const RUNS = '/api/runs?page=1&pageSize=50'
const WARMUP_COUNT = 10
const SAMPLE_COUNT = 100

function argument(name, fallback) {
  const value = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))
  return value ? value.slice(name.length + 3) : fallback
}

function seededRandom() {
  let state = 0x51a11e7
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

async function generateFixture(directory) {
  const dataDirectory = path.join(directory, 'data')
  const runtimeHome = path.join(directory, 'home')
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(path.join(runtimeHome, '.codex'), { recursive: true }),
    mkdir(path.join(runtimeHome, '.claude'), { recursive: true }),
  ])
  const eventFile = path.join(dataDirectory, 'events.jsonl')
  const file = await open(eventFile, 'w')
  const hash = createHash('sha256')
  const random = seededRandom()
  let chunk = ''
  try {
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      const definition = index < DEFINITION_COUNT
      const failed = !definition && index % 11 === 0
      const raw = definition ? {
        id: `definition-${String(index).padStart(5, '0')}`,
        event: 'skill.discovered',
        skillId: `agent-${String(index).padStart(4, '0')}`,
        skillVersion: `1.${index % 10}.0`,
        runtime: index % 2 ? 'claude-code' : 'codex',
        timestamp: new Date(FIXED_NOW - (index % 20) * 86_400_000).toISOString(),
        source: index % 3 ? 'global' : 'project',
        sourcePath: `/synthetic/runtime/agents/agent-${String(index).padStart(4, '0')}/AGENT.md`,
        provider: 'Synthetic fixture',
        kind: 'agent',
        enabled: true,
      } : {
        id: `event-${String(index).padStart(6, '0')}`,
        event: failed ? 'skill.failed' : 'skill.completed',
        skillId: `agent-${String(index % DEFINITION_COUNT).padStart(4, '0')}`,
        skillVersion: `1.${index % 10}.0`,
        runtime: index % 2 ? 'claude-code' : 'codex',
        timestamp: new Date(FIXED_NOW - Math.floor(random() * 30 * 86_400_000)).toISOString(),
        durationMs: 40 + Math.floor(random() * 4_000),
        tokens: 100 + Math.floor(random() * 8_000),
        ...(index % 3 === 0 ? { costUsd: Number((random() * 0.1).toFixed(6)) } : {}),
        outcome: failed ? 'failed' : 'success',
        kind: 'agent',
        ...(index === DEFINITION_COUNT ? {
          prompt: SENTINEL,
          token: SENTINEL,
          sourceCode: SENTINEL,
          rawError: SENTINEL,
        } : {}),
      }
      const line = `${JSON.stringify(normalizeEvent(raw))}\n`
      if (line.includes(SENTINEL)) throw new Error('Privacy sentinel survived event normalization.')
      hash.update(line)
      chunk += line
      if (index % 1_000 === 999) {
        await file.write(chunk)
        chunk = ''
      }
    }
    if (chunk) await file.write(chunk)
  } finally {
    await file.close()
  }
  return {
    dataDirectory,
    eventFile,
    runtimeHome,
    hash: hash.digest('hex'),
    parameters: {
      seed: SEED,
      fixedNow: new Date(FIXED_NOW).toISOString(),
      timezone: 'UTC',
      events: EVENT_COUNT,
      definitions: DEFINITION_COUNT,
    },
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function serverEnvironment(fixture, port) {
  return {
    ...process.env,
    PORT: String(port),
    SKILLOPS_HOST: '127.0.0.1',
    SKILLOPS_DATA_DIR: fixture.dataDirectory,
    CODEX_HOME: path.join(fixture.runtimeHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(fixture.runtimeHome, '.claude'),
    HOME: fixture.runtimeHome,
    USERPROFILE: fixture.runtimeHome,
  }
}

async function startServer(fixture) {
  const port = await freePort()
  const child = spawn(process.execPath, ['app/backend/server.mjs'], {
    cwd: ROOT,
    env: serverEnvironment(fixture, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const capture = (chunk) => { output += String(chunk) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not become ready. ${output}`)), 30_000)
    const ready = (chunk) => {
      if (!String(chunk).includes('SkillOps is running')) return
      clearTimeout(timeout)
      child.stdout.off('data', ready)
      resolve()
    }
    child.stdout.on('data', ready)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited before readiness (${code}). ${output}`))
    })
  })
  return { child, output: () => output, origin: `http://127.0.0.1:${port}` }
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (server.child.exitCode === null) server.child.kill('SIGKILL')
}

async function request(origin, endpoint) {
  const startedAt = performance.now()
  const response = await fetch(`${origin}${endpoint}`)
  const body = await response.text()
  const durationMs = performance.now() - startedAt
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}: ${body.slice(0, 300)}`)
  return { body, durationMs, headers: response.headers }
}

function nearestRankP95(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

async function coldSamples(fixture, endpoint) {
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const server = await startServer(fixture)
    try {
      samples.push(rounded((await request(server.origin, endpoint)).durationMs))
      if (server.output().includes(SENTINEL)) throw new Error('Privacy sentinel entered server output.')
    } finally {
      await stopServer(server)
    }
  }
  return samples
}

async function warmSamples(origin, endpoint) {
  for (let index = 0; index < WARMUP_COUNT; index += 1) await request(origin, endpoint)
  const samples = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) samples.push(rounded((await request(origin, endpoint)).durationMs))
  return samples
}

async function validateBoundaries(server, fixture) {
  const summaryResponse = await request(server.origin, '/api/events?summary=1')
  const summary = JSON.parse(summaryResponse.body)
  if (summary.count !== EVENT_COUNT || summaryResponse.body.includes(SENTINEL)) throw new Error('Event summary boundary failed.')

  const command = await request(server.origin, COMMAND_CENTER)
  const runs = await request(server.origin, RUNS)
  const agents = await request(server.origin, '/api/agents?tab=definitions&page=1&pageSize=50&window=30d')
  const connections = await request(server.origin, '/api/connections')
  const runPage = JSON.parse(runs.body)
  const agentPage = JSON.parse(agents.body)
  if (runPage.items?.length !== 50 || agentPage.items?.length !== 50 || agentPage.totalItems !== DEFINITION_COUNT) throw new Error('Bounded pagination validation failed.')
  if ([command.body, runs.body, agents.body, connections.body].some((body) => body.includes(SENTINEL))) throw new Error('Privacy sentinel entered an unrelated API.')

  const exported = await request(server.origin, '/api/events?download=1')
  if (!/^attachment; filename="skillops-events-\d{4}-\d{2}-\d{2}\.jsonl"$/.test(exported.headers.get('content-disposition') || '')) throw new Error('Event export did not provide a download filename.')
  if (exported.body.includes(SENTINEL)) throw new Error('Privacy sentinel entered event export.')
  if ((await readFile(fixture.eventFile, 'utf8')).includes(SENTINEL)) throw new Error('Privacy sentinel entered persistent event data.')
}

async function benchmarkEndpoints(fixture) {
  const cold = {
    commandCenter: await coldSamples(fixture, COMMAND_CENTER),
    runs: await coldSamples(fixture, RUNS),
  }
  const server = await startServer(fixture)
  try {
    await validateBoundaries(server, fixture)
    const commandCenter = await warmSamples(server.origin, COMMAND_CENTER)
    const runs = await warmSamples(server.origin, RUNS)
    const commandCenterP95 = rounded(nearestRankP95(commandCenter))
    const runsP95 = rounded(nearestRankP95(runs))
    return {
      protocol: { coldProcesses: 5, warmups: WARMUP_COUNT, samples: SAMPLE_COUNT, concurrency: 1, percentile: 'nearest-rank ceil(0.95 * n)' },
      cold,
      warm: {
        commandCenter: { samplesMs: commandCenter, p95Ms: commandCenterP95, budgetMs: 750, passed: commandCenterP95 <= 750 },
        runs: { samplesMs: runs, p95Ms: runsP95, budgetMs: 500, passed: runsP95 <= 500 },
      },
      boundaries: {
        browserReceivesFullEventArray: false,
        eventSummaryCount: EVENT_COUNT,
        runPageSize: 50,
        agentDefinitionPageSize: 50,
        exportedSentinel: false,
        unrelatedApiSentinel: false,
        persistentSentinel: false,
      },
    }
  } finally {
    await stopServer(server)
  }
}

async function waitForServer(origin) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/events?summary=1`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('In-process soak server did not become ready.')
}

async function memorySoak(fixture, minutes) {
  if (!minutes) return null
  if (typeof global.gc !== 'function') throw new Error('Memory soak requires node --expose-gc.')
  const port = await freePort()
  Object.assign(process.env, serverEnvironment(fixture, port))
  await import(`../app/backend/server.mjs?performance-soak=${Date.now()}`)
  const origin = `http://127.0.0.1:${port}`
  await waitForServer(origin)

  const durationMs = minutes * 60_000
  const startedAt = performance.now()
  const trend = []
  let baseline = null
  let nextTrendAt = 5 * 60_000
  let nextRequestAt = startedAt
  while (performance.now() - startedAt < durationMs) {
    await request(origin, COMMAND_CENTER)
    const elapsed = performance.now() - startedAt
    if (elapsed >= nextTrendAt || elapsed >= durationMs - 1_500) {
      global.gc()
      const heapUsed = process.memoryUsage().heapUsed
      trend.push({ minute: rounded(elapsed / 60_000), heapUsed })
      if (!baseline && elapsed >= 5 * 60_000) baseline = heapUsed
      nextTrendAt += 5 * 60_000
    }
    nextRequestAt += 3_000
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextRequestAt - performance.now())))
  }
  global.gc()
  const finalHeapUsed = process.memoryUsage().heapUsed
  baseline ??= finalHeapUsed
  const growthBytes = finalHeapUsed - baseline
  const growthPct = baseline ? growthBytes / baseline * 100 : 0
  return {
    durationMinutes: minutes,
    refreshIntervalMs: 3_000,
    baselineHeapUsed: baseline,
    finalHeapUsed,
    growthBytes,
    growthPct: rounded(growthPct),
    trend,
    passed: growthPct < 20 && growthBytes < 100 * 1024 * 1024,
  }
}

function commit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return null }
}

const soakMinutes = Number(argument('soak-minutes', '0'))
if (!Number.isFinite(soakMinutes) || soakMinutes < 0) throw new Error('--soak-minutes must be a non-negative number.')
const reportPath = path.resolve(ROOT, argument('report', 'data/performance-report.json'))
const retainedFixtureDirectory = argument('fixture-directory', '')
const fixtureDirectory = retainedFixtureDirectory
  ? path.resolve(ROOT, retainedFixtureDirectory)
  : await mkdtemp(path.join(tmpdir(), 'skillops-performance-'))
if (retainedFixtureDirectory) await mkdir(fixtureDirectory, { recursive: true })
let report
try {
  const fixture = await generateFixture(fixtureDirectory)
  const endpoints = await benchmarkEndpoints(fixture)
  const memory = await memorySoak(fixture, soakMinutes)
  report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: { ...fixture.parameters, hash: fixture.hash },
    fixtureRetained: Boolean(retainedFixtureDirectory),
    environment: {
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
      homeRedacted: homedir() ? '<local-home>' : null,
      commit: commit(),
    },
    endpoints,
    ui: null,
    memory,
    passed: endpoints.warm.commandCenter.passed && endpoints.warm.runs.passed && (!memory || memory.passed),
  }
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (!retainedFixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
}
if (soakMinutes) process.exit(process.exitCode || 0)
