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
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const SEED = 'skillops-personal-v1'
const EVENT_COUNT = 100_000
const DEFINITION_COUNT = 5_000
const FIXED_NOW = Date.parse('2026-07-25T12:00:00.000Z')
const FIXED_NOW_ISO = new Date(FIXED_NOW).toISOString()
const FIXED_TIMEZONE = 'UTC'
const SENTINEL = 'SKILLOPS_PRIVATE_SENTINEL_7f0d9a'
const COMMAND_CENTER = '/api/command-center?runtime=all&window=30d'
const RUNS = '/api/runs?page=1&pageSize=50'
const WARMUP_COUNT = 10
const SAMPLE_COUNT = 100
const SOAK_PROTOCOL = Object.freeze({
  requiredDurationMinutes: 30,
  refreshIntervalMs: 3_000,
  baselineMinute: 5,
  trendIntervalMinutes: 5,
  tailWindowMinutes: 15,
  maxFinalGrowthPct: 20,
  maxFinalGrowthBytes: 100 * 1024 * 1024,
  maxTailGrowthPct: 5,
  maxTailGrowthBytes: 5 * 1024 * 1024,
})
const FIXTURE_DISTRIBUTION = Object.freeze({
  definitionRows: DEFINITION_COUNT,
  lifecycleRows: EVENT_COUNT - DEFINITION_COUNT,
  runtimeCycle: ['codex', 'claude-code'],
  versionMinorModulo: 10,
  definitionTimeRangeDays: 20,
  lifecycleTimeRangeDays: 30,
  failureAbsoluteRowModulo: { divisor: 11, remainder: 0 },
  definitionSourceCycle: ['project', 'global', 'global'],
  durationMs: { minimum: 40, maximumExclusive: 4_040 },
  tokens: { minimum: 100, maximumExclusive: 8_100 },
  costUsd: { absoluteRowModulo: { divisor: 3, remainder: 0 }, maximumExclusive: 0.1, decimalPlaces: 6 },
})

function argument(name, fallback) {
  const value = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))
  return value ? value.slice(name.length + 3) : fallback
}

export function seededRandom(seed = SEED) {
  let state = createHash('sha256').update(seed, 'utf8').digest().readUInt32LE(0) || 0x51a11e7
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
  const random = seededRandom(SEED)
  let chunk = ''
  try {
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      const definition = index < DEFINITION_COUNT
      const failed = !definition
        && index % FIXTURE_DISTRIBUTION.failureAbsoluteRowModulo.divisor === FIXTURE_DISTRIBUTION.failureAbsoluteRowModulo.remainder
      const raw = definition ? {
        id: `definition-${String(index).padStart(5, '0')}`,
        event: 'skill.discovered',
        skillId: `agent-${String(index).padStart(4, '0')}`,
        skillVersion: `1.${index % FIXTURE_DISTRIBUTION.versionMinorModulo}.0`,
        runtime: FIXTURE_DISTRIBUTION.runtimeCycle[index % FIXTURE_DISTRIBUTION.runtimeCycle.length],
        timestamp: new Date(FIXED_NOW - (index % FIXTURE_DISTRIBUTION.definitionTimeRangeDays) * 86_400_000).toISOString(),
        source: FIXTURE_DISTRIBUTION.definitionSourceCycle[index % FIXTURE_DISTRIBUTION.definitionSourceCycle.length],
        sourcePath: `/synthetic/runtime/agents/agent-${String(index).padStart(4, '0')}/AGENT.md`,
        provider: 'Synthetic fixture',
        kind: 'agent',
        enabled: true,
      } : {
        id: `event-${String(index).padStart(6, '0')}`,
        event: failed ? 'skill.failed' : 'skill.completed',
        skillId: `agent-${String(index % DEFINITION_COUNT).padStart(4, '0')}`,
        skillVersion: `1.${index % FIXTURE_DISTRIBUTION.versionMinorModulo}.0`,
        runtime: FIXTURE_DISTRIBUTION.runtimeCycle[index % FIXTURE_DISTRIBUTION.runtimeCycle.length],
        timestamp: new Date(FIXED_NOW - Math.floor(random() * FIXTURE_DISTRIBUTION.lifecycleTimeRangeDays * 86_400_000)).toISOString(),
        durationMs: FIXTURE_DISTRIBUTION.durationMs.minimum
          + Math.floor(random() * (FIXTURE_DISTRIBUTION.durationMs.maximumExclusive - FIXTURE_DISTRIBUTION.durationMs.minimum)),
        tokens: FIXTURE_DISTRIBUTION.tokens.minimum
          + Math.floor(random() * (FIXTURE_DISTRIBUTION.tokens.maximumExclusive - FIXTURE_DISTRIBUTION.tokens.minimum)),
        ...(index % FIXTURE_DISTRIBUTION.costUsd.absoluteRowModulo.divisor === FIXTURE_DISTRIBUTION.costUsd.absoluteRowModulo.remainder
          ? { costUsd: Number((random() * FIXTURE_DISTRIBUTION.costUsd.maximumExclusive).toFixed(FIXTURE_DISTRIBUTION.costUsd.decimalPlaces)) }
          : {}),
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
      randomAlgorithm: 'sha256-seeded-xorshift32',
      fixedNow: FIXED_NOW_ISO,
      timezone: FIXED_TIMEZONE,
      events: EVENT_COUNT,
      definitions: DEFINITION_COUNT,
      distribution: FIXTURE_DISTRIBUTION,
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
    TZ: FIXED_TIMEZONE,
    PORT: String(port),
    SKILLOPS_HOST: '127.0.0.1',
    SKILLOPS_DATA_DIR: fixture.dataDirectory,
    CODEX_HOME: path.join(fixture.runtimeHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(fixture.runtimeHome, '.claude'),
    HOME: fixture.runtimeHome,
    USERPROFILE: fixture.runtimeHome,
  }
}

function fixedClockPreloadUrl() {
  const source = `
const RealDate = globalThis.Date
const fixedNow = ${FIXED_NOW}
class SkillOpsPerformanceDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixedNow]))
  }
  static now() {
    return fixedNow
  }
}
Object.defineProperties(SkillOpsPerformanceDate, {
  parse: { value: RealDate.parse },
  UTC: { value: RealDate.UTC },
})
globalThis.Date = SkillOpsPerformanceDate
process.on('message', (message) => {
  if (!message || message.type !== 'skillops:heap-sample') return
  if (typeof globalThis.gc === 'function') globalThis.gc()
  if (typeof process.send === 'function') {
    process.send({
      type: 'skillops:heap-sample',
      requestId: message.requestId,
      heapUsed: process.memoryUsage().heapUsed,
    })
  }
})
`
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
}

async function startServer(fixture, { memoryTelemetry = false } = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [
    ...(memoryTelemetry ? ['--expose-gc'] : []),
    '--import',
    fixedClockPreloadUrl(),
    'app/backend/server.mjs',
  ], {
    cwd: ROOT,
    env: serverEnvironment(fixture, port),
    stdio: memoryTelemetry ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
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
  return { child, memoryTelemetry, output: () => output, origin: `http://127.0.0.1:${port}` }
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

let heapSampleSequence = 0
async function sampleServerHeap(server) {
  if (!server.memoryTelemetry || typeof server.child.send !== 'function') {
    throw new Error('Server heap telemetry is unavailable.')
  }
  heapSampleSequence += 1
  const requestId = `heap-${heapSampleSequence}`
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      server.child.off('message', onMessage)
      server.child.off('exit', onExit)
    }
    const onMessage = (message) => {
      if (message?.type !== 'skillops:heap-sample' || message.requestId !== requestId) return
      cleanup()
      resolve(message.heapUsed)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`Memory-soak server exited before heap sampling (${code}).`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Memory-soak server did not return a heap sample.'))
    }, 10_000)
    server.child.on('message', onMessage)
    server.child.once('exit', onExit)
    server.child.send({ type: 'skillops:heap-sample', requestId }, (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
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
  const today = await request(server.origin, '/api/command-center?runtime=all&window=1d')
  const runs = await request(server.origin, RUNS)
  const agents = await request(server.origin, '/api/agents?tab=definitions&page=1&pageSize=50&window=30d')
  const connections = await request(server.origin, '/api/connections')
  const commandProjection = JSON.parse(command.body)
  const todayProjection = JSON.parse(today.body)
  const runPage = JSON.parse(runs.body)
  const agentPage = JSON.parse(agents.body)
  if (commandProjection.generatedAt !== FIXED_NOW_ISO) {
    throw new Error(`Service clock boundary failed: expected ${FIXED_NOW_ISO}, received ${commandProjection.generatedAt || '<missing>'}.`)
  }
  const expectedTodayStart = `${FIXED_NOW_ISO.slice(0, 10)}T00:00:00.000Z`
  if (todayProjection.window?.from !== expectedTodayStart) {
    throw new Error(`Service timezone boundary failed: expected Today to start at ${expectedTodayStart}, received ${todayProjection.window?.from || '<missing>'}.`)
  }
  if (runPage.items?.length !== 50 || agentPage.items?.length !== 50 || agentPage.totalItems !== DEFINITION_COUNT) throw new Error('Bounded pagination validation failed.')
  if ([command.body, today.body, runs.body, agents.body, connections.body].some((body) => body.includes(SENTINEL))) throw new Error('Privacy sentinel entered an unrelated API.')

  const exported = await request(server.origin, '/api/events?download=1')
  if (!/^attachment; filename="skillops-events-\d{4}-\d{2}-\d{2}\.jsonl"$/.test(exported.headers.get('content-disposition') || '')) throw new Error('Event export did not provide a download filename.')
  if (exported.body.includes(SENTINEL)) throw new Error('Privacy sentinel entered event export.')
  if ((await readFile(fixture.eventFile, 'utf8')).includes(SENTINEL)) throw new Error('Privacy sentinel entered persistent event data.')
  return {
    serviceClockObservedAt: commandProjection.generatedAt,
    serviceTodayWindowStartedAt: todayProjection.window.from,
  }
}

async function benchmarkEndpoints(fixture) {
  const cold = {
    commandCenter: await coldSamples(fixture, COMMAND_CENTER),
    runs: await coldSamples(fixture, RUNS),
  }
  const server = await startServer(fixture)
  try {
    const validated = await validateBoundaries(server, fixture)
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
        browserNetwork: {
          measured: false,
          result: null,
          reason: 'This Node endpoint harness does not observe production-browser network traffic.',
        },
        serviceClockObservedAt: validated.serviceClockObservedAt,
        serviceTodayWindowStartedAt: validated.serviceTodayWindowStartedAt,
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

export function assessTailGrowth(trend, baselineHeapUsed, durationMinutes) {
  const tailStartMinute = Math.max(SOAK_PROTOCOL.baselineMinute, durationMinutes - SOAK_PROTOCOL.tailWindowMinutes)
  const samples = trend.filter((sample) => sample.minute >= tailStartMinute)
  const toleranceBytes = Math.min(
    SOAK_PROTOCOL.maxTailGrowthBytes,
    baselineHeapUsed * SOAK_PROTOCOL.maxTailGrowthPct / 100,
  )
  if (samples.length < 3) {
    return {
      windowMinutes: SOAK_PROTOCOL.tailWindowMinutes,
      sampleCount: samples.length,
      toleranceBytes: Math.round(toleranceBytes),
      netGrowthBytes: null,
      slopeBytesPerMinute: null,
      projectedGrowthBytes: null,
      plateau: false,
      reason: 'At least three tail samples are required.',
    }
  }

  const meanMinute = samples.reduce((sum, sample) => sum + sample.minute, 0) / samples.length
  const meanHeap = samples.reduce((sum, sample) => sum + sample.heapUsed, 0) / samples.length
  const denominator = samples.reduce((sum, sample) => sum + (sample.minute - meanMinute) ** 2, 0)
  const slopeBytesPerMinute = denominator
    ? samples.reduce((sum, sample) => sum + (sample.minute - meanMinute) * (sample.heapUsed - meanHeap), 0) / denominator
    : 0
  const netGrowthBytes = samples.at(-1).heapUsed - samples[0].heapUsed
  const projectedGrowthBytes = Math.max(0, slopeBytesPerMinute * SOAK_PROTOCOL.tailWindowMinutes)
  const plateau = netGrowthBytes <= toleranceBytes && projectedGrowthBytes <= toleranceBytes
  return {
    windowMinutes: SOAK_PROTOCOL.tailWindowMinutes,
    sampleCount: samples.length,
    toleranceBytes: Math.round(toleranceBytes),
    netGrowthBytes,
    slopeBytesPerMinute: Math.round(slopeBytesPerMinute),
    projectedGrowthBytes: Math.round(projectedGrowthBytes),
    plateau,
    reason: plateau
      ? 'Tail drift and fitted growth remain within both the 5% and 5 MiB plateau tolerance.'
      : 'Tail drift or fitted growth exceeds the plateau tolerance.',
  }
}

async function memorySoak(fixture, minutes) {
  if (!minutes) return null
  const server = await startServer(fixture, { memoryTelemetry: true })
  try {
    const durationMs = minutes * 60_000
    const startedAt = performance.now()
    const trend = []
    let baseline = null
    let baselineAtMinute = null
    let nextTrendAt = SOAK_PROTOCOL.baselineMinute * 60_000
    let nextRequestAt = startedAt
    while (performance.now() - startedAt < durationMs) {
      await request(server.origin, COMMAND_CENTER)
      const elapsed = performance.now() - startedAt
      if (elapsed >= nextTrendAt) {
        const heapUsed = await sampleServerHeap(server)
        const minute = rounded(elapsed / 60_000)
        trend.push({ minute, heapUsed })
        if (baseline === null && elapsed >= SOAK_PROTOCOL.baselineMinute * 60_000) {
          baseline = heapUsed
          baselineAtMinute = minute
        }
        nextTrendAt += SOAK_PROTOCOL.trendIntervalMinutes * 60_000
      }
      nextRequestAt += SOAK_PROTOCOL.refreshIntervalMs
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextRequestAt - performance.now())))
    }
    const finalHeapUsed = await sampleServerHeap(server)
    const finalMinute = rounded((performance.now() - startedAt) / 60_000)
    const finalSample = { minute: finalMinute, heapUsed: finalHeapUsed }
    if (trend.at(-1)?.minute >= finalMinute - 0.1) trend[trend.length - 1] = finalSample
    else trend.push(finalSample)
    baseline ??= finalHeapUsed
    const growthBytes = finalHeapUsed - baseline
    const growthPct = baseline ? growthBytes / baseline * 100 : 0
    const finalThresholdsPassed = growthPct < SOAK_PROTOCOL.maxFinalGrowthPct
      && growthBytes < SOAK_PROTOCOL.maxFinalGrowthBytes
    const tail = assessTailGrowth(trend, baseline, finalMinute)
    const protocolComplete = minutes >= SOAK_PROTOCOL.requiredDurationMinutes
      && baselineAtMinute !== null
      && finalMinute >= SOAK_PROTOCOL.requiredDurationMinutes
    return {
      requestedDurationMinutes: minutes,
      observedDurationMinutes: finalMinute,
      refreshIntervalMs: SOAK_PROTOCOL.refreshIntervalMs,
      baselineAtMinute,
      baselineHeapUsed: baseline,
      finalHeapUsed,
      growthBytes,
      growthPct: rounded(growthPct),
      trend,
      tail,
      protocol: {
        requiredDurationMinutes: SOAK_PROTOCOL.requiredDurationMinutes,
        baselineMinute: SOAK_PROTOCOL.baselineMinute,
        trendIntervalMinutes: SOAK_PROTOCOL.trendIntervalMinutes,
        finalGrowthLimits: {
          percentExclusive: SOAK_PROTOCOL.maxFinalGrowthPct,
          bytesExclusive: SOAK_PROTOCOL.maxFinalGrowthBytes,
        },
        tailPlateauLimits: {
          windowMinutes: SOAK_PROTOCOL.tailWindowMinutes,
          percentInclusive: SOAK_PROTOCOL.maxTailGrowthPct,
          bytesInclusive: SOAK_PROTOCOL.maxTailGrowthBytes,
        },
      },
      protocolComplete,
      finalThresholdsPassed,
      passed: protocolComplete && finalThresholdsPassed && tail.plateau,
    }
  } finally {
    await stopServer(server)
  }
}

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: ROOT, encoding: 'utf8' }).trim())
    return { commit, dirty }
  } catch {
    return { commit: null, dirty: null }
  }
}

export function buildAcceptance({ endpoints, memory, dirty }) {
  const endpointPassed = endpoints.warm.commandCenter.passed && endpoints.warm.runs.passed
  const blockers = []
  if (!endpointPassed) blockers.push('endpoint-performance-failed')
  if (!memory) blockers.push('memory-soak-not-run')
  else if (!memory.protocolComplete) blockers.push('memory-soak-protocol-incomplete')
  else if (!memory.passed) blockers.push('memory-soak-failed')
  blockers.push('browser-ui-timing-not-measured')
  blockers.push('browser-network-boundary-not-measured')
  if (dirty === true) blockers.push('working-tree-dirty')
  else if (dirty === null) blockers.push('git-state-unavailable')

  const checks = {
    endpointPerformance: {
      passed: endpointPassed,
      status: endpointPassed ? 'passed' : 'failed',
    },
    memorySoak: {
      passed: memory?.passed ?? null,
      status: !memory ? 'not-run' : memory.protocolComplete ? (memory.passed ? 'passed' : 'failed') : 'protocol-incomplete',
    },
    browserUiTiming: {
      passed: null,
      status: 'not-measured-by-script',
    },
    browserNetworkBoundary: {
      passed: null,
      status: 'not-measured-by-script',
    },
    immutableCandidate: {
      passed: dirty === false ? true : dirty === true ? false : null,
      status: dirty === false ? 'clean' : dirty === true ? 'dirty' : 'unavailable',
    },
  }
  return {
    commandScope: memory ? 'endpoint-and-memory-component' : 'endpoint-only',
    endpoint: {
      complete: true,
      passed: endpointPassed,
    },
    releaseCandidate: {
      complete: false,
      passed: false,
      checks,
      blockers,
      note: 'Release acceptance also requires immutable-candidate browser UI timing and browser-network evidence, which this Node harness does not collect.',
    },
  }
}

async function main() {
  const soakMinutes = Number(argument('soak-minutes', '0'))
  if (!Number.isFinite(soakMinutes) || soakMinutes < 0) throw new Error('--soak-minutes must be a non-negative number.')
  const reportPath = path.resolve(ROOT, argument('report', 'data/performance-report.json'))
  const retainedFixtureDirectory = argument('fixture-directory', '')
  const fixtureDirectory = retainedFixtureDirectory
    ? path.resolve(ROOT, retainedFixtureDirectory)
    : await mkdtemp(path.join(tmpdir(), 'skillops-performance-'))
  if (retainedFixtureDirectory) await mkdir(fixtureDirectory, { recursive: true })
  try {
    const fixture = await generateFixture(fixtureDirectory)
    const endpoints = await benchmarkEndpoints(fixture)
    const memory = await memorySoak(fixture, soakMinutes)
    const git = gitState()
    const acceptance = buildAcceptance({ endpoints, memory, dirty: git.dirty })
    const cpuInfo = cpus()
    const report = {
      schemaVersion: 2,
      reportKind: 'performance-components',
      generatedAt: new Date().toISOString(),
      fixture: { ...fixture.parameters, hash: fixture.hash },
      fixtureRetained: Boolean(retainedFixtureDirectory),
      serviceProtocol: {
        clock: { mode: 'fixed', value: FIXED_NOW_ISO },
        timezone: FIXED_TIMEZONE,
        clockObservedAt: endpoints.boundaries.serviceClockObservedAt,
        todayWindowStartedAt: endpoints.boundaries.serviceTodayWindowStartedAt,
      },
      environment: {
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpuCount: cpuInfo.length,
        cpuModel: cpuInfo[0]?.model || null,
        memoryBytes: totalmem(),
        node: process.version,
        hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        homeRedacted: homedir() ? '<local-home>' : null,
        commit: git.commit,
        dirty: git.dirty,
      },
      endpoints,
      ui: {
        status: 'not-measured-by-script',
        samplesMs: null,
        p95Ms: null,
      },
      memory,
      acceptance,
    }
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report, null, 2))
    if (!acceptance.endpoint.passed || (memory && !memory.passed)) process.exitCode = 1
  } finally {
    if (!retainedFixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_FILE)) await main()
