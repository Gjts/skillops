import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import './test-no-egress.mjs'

const port = 4188
const smokeData = await mkdtemp(path.join(tmpdir(), 'skillops-smoke-'))
const smokeReviewers = [
  { id: 'smoke-reviewer-one', token: 'smoke-reviewer-one-token'.padEnd(32, 'x') },
  { id: 'smoke-reviewer-two', token: 'smoke-reviewer-two-token'.padEnd(32, 'x') },
]
const governanceReadHeaders = { Authorization: `Bearer ${smokeReviewers[0].token}` }
const smokeCodexHome = path.join(smokeData, 'codex-home')
const stableProjectRoot = path.join(smokeData, 'stable-project')
await mkdir(stableProjectRoot, { recursive: true })
const baselineDirectory = path.join(smokeCodexHome, 'skills', 'smoke-baseline')
const candidateDirectory = path.join(smokeCodexHome, 'skills', 'smoke-candidate')
await mkdir(baselineDirectory, { recursive: true })
await mkdir(candidateDirectory, { recursive: true })
await writeFile(path.join(baselineDirectory, 'SKILL.md'), `---
name: smoke-baseline
description: Deterministic production smoke baseline
version: 1.0.0
---
Treat lifecycle completion as proof of success.
`, 'utf8')
await writeFile(path.join(candidateDirectory, 'SKILL.md'), `---
name: smoke-candidate
description: Deterministic production smoke candidate
version: 2.0.0
---
Require evaluation evidence before claiming success.
`, 'utf8')

const execute = promisify(execFile)
const promptWorkspace = path.join(smokeData, 'prompt-workspace')
const promptFile = path.join(promptWorkspace, 'prompts', 'release.prompt.json')
await mkdir(path.dirname(promptFile), { recursive: true })
async function git(...args) {
  const result = await execute('git', ['-C', promptWorkspace, ...args], { encoding: 'utf8', windowsHide: true })
  return result.stdout.trim()
}
async function commitPrompt(label, template) {
  await writeFile(promptFile, `${JSON.stringify({
    schemaVersion: 1,
    id: 'release-summary',
    name: 'Release summary',
    description: 'Synthetic production smoke Prompt.',
    system: 'Return text suitable for {{channel}}.',
    template,
    model: { provider: 'openai', name: 'gpt-smoke', configuration: { temperature: 0, max_tokens: 64 } },
  }, null, 2)}\n`, 'utf8')
  await git('add', 'prompts/release.prompt.json')
  await git('-c', 'user.name=SkillOps Smoke', '-c', 'user.email=skillops@example.invalid', 'commit', '-m', label)
  return git('rev-parse', 'HEAD')
}
await git('init', '-b', 'main')
const weakPromptCommit = await commitPrompt('weak baseline', 'SMOKE_WEAK_PROMPT: Write a generic note for {{audience}}.')
const firstPromptCommit = await commitPrompt('candidate A', 'SMOKE_STABLE_A: Summarize the status for {{audience}}.')
const secondPromptCommit = await commitPrompt('candidate B', 'SMOKE_STABLE_B: Summarize the verified release status for {{audience}}.')
const promptTarget = 'prompt:release-summary'

const provider = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const prompt = JSON.stringify(body.messages || [])
  // Give each synthetic upgrade a deterministic latency improvement without weakening production policy.
  await wait(prompt.includes('SMOKE_STABLE_B') || prompt.includes('smoke-candidate') || prompt.includes('Require evaluation evidence')
    ? 50 : prompt.includes('SMOKE_STABLE_A') ? 100 : 150)
  const output = prompt.includes('SMOKE_STABLE_B')
    ? 'The verified release status is ready for engineering leaders.'
    : prompt.includes('SMOKE_STABLE_A')
    ? 'The release status is ready for engineering leaders.'
    : prompt.includes('smoke-candidate') || prompt.includes('Require evaluation evidence')
    ? 'Evidence is required before a lifecycle completion can be called successful.'
    : 'Lifecycle completion is an observation.'
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({
    id: 'skillops-smoke-response', object: 'chat.completion', created: 0, model: 'deterministic-smoke',
    choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }))
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
const providerAddress = provider.address()
if (!providerAddress || typeof providerAddress === 'string') throw new Error('Deterministic provider did not bind.')
const noEgressImport = `--import=${pathToFileURL(path.resolve('scripts/test-no-egress.mjs')).href}`

const server = spawn(process.execPath, ['app/backend/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, noEgressImport].filter(Boolean).join(' '),
    PORT: String(port),
    SKILLOPS_DATA_DIR: smokeData,
    CODEX_HOME: smokeCodexHome,
    HOME: smokeData,
    USERPROFILE: smokeData,
    CLAUDE_CONFIG_DIR: path.join(smokeData, 'claude-home'),
    ProgramData: path.join(smokeData, 'program-data'),
    PROGRAMDATA: path.join(smokeData, 'program-data'),
    ProgramFiles: path.join(smokeData, 'program-files'),
    APPDATA: path.join(smokeData, 'app-data'),
    LOCALAPPDATA: path.join(smokeData, 'local-app-data'),
    XDG_CONFIG_HOME: path.join(smokeData, 'xdg-config'),
    XDG_DATA_HOME: path.join(smokeData, 'xdg-data'),
    XDG_CACHE_HOME: path.join(smokeData, 'xdg-cache'),
    SKILLOPS_SKELETON_ROOT: stableProjectRoot,
    NODE_ENV: 'test',
    SKILLOPS_PROMPT_WORKSPACE: promptWorkspace,
    SKILLOPS_GOVERNANCE_PRINCIPALS: JSON.stringify(smokeReviewers),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk })

async function runManagedEvaluation(body, label) {
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/evaluation-runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const created = await createdResponse.json()
  if (createdResponse.status !== 202 || !created.run?.id) throw new Error(`${label} was not queued: ${JSON.stringify(created)}`)
  let run = created.run
  for (let attempt = 0; attempt < 120 && ['queued', 'running'].includes(run.status); attempt += 1) {
    await wait(100)
    const response = await fetch(`http://127.0.0.1:${port}/api/evaluation-runs/${encodeURIComponent(run.id)}`)
    run = await response.json()
    if (!response.ok) throw new Error(`${label} status could not be read.`)
  }
  if (run.status !== 'completed' || run.gateResult !== 'passed' || !run.evidenceHash) {
    throw new Error(`${label} did not complete with verified evidence: ${JSON.stringify(run)}`)
  }
  return run
}

try {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(100)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      const html = await response.text()
      if (!response.ok || !html.includes('<title>SkillOps</title>')) throw new Error('Frontend response is invalid.')
      ready = true
      break
    } catch {
      // The child process may still be binding the local port.
    }
  }
  if (!ready) throw new Error('Production server did not become ready.')
  if (!serverOutput.includes(`http://127.0.0.1:${port}`)) throw new Error('Production server did not bind to the loopback host by default.')

  const eventsResponse = await fetch(`http://127.0.0.1:${port}/api/events?source=smoke`)
  const events = await eventsResponse.json()
  if (!eventsResponse.ok || !Array.isArray(events)) throw new Error('Event API did not return an array.')
  const eventEtag = eventsResponse.headers.get('etag')
  const unchangedEvents = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'If-None-Match': eventEtag } })
  if (!eventEtag || unchangedEvents.status !== 304) throw new Error('Unchanged event polling did not use a lightweight 304 response.')

  const scanResponse = await fetch(`http://127.0.0.1:${port}/api/scan?source=smoke`, { method: 'POST' })
  const inventory = await scanResponse.json()
  if (!scanResponse.ok || !Array.isArray(inventory.definitions) || !inventory.scan?.id) throw new Error('Installed Skill scan API did not return definitions and scan diagnostics.')
  const baseline = inventory.definitions.find((item) => item.skillId === 'smoke-baseline')
  const candidate = inventory.definitions.find((item) => item.skillId === 'smoke-candidate')
  if (!baseline?.sourcePath || !candidate?.sourcePath) throw new Error('Deterministic smoke Skills were not discovered.')
  const escapedDefinition = inventory.definitions.find((item) => item.sourcePath
    && ![smokeData, process.cwd()].some((root) => {
      const relative = path.relative(path.resolve(root), path.resolve(item.sourcePath))
      return !relative.startsWith('..') && !path.isAbsolute(relative)
    }))
  if (escapedDefinition) throw new Error(`Production smoke read a Runtime asset outside its isolated homes: ${escapedDefinition.sourcePath}`)

  const conflictDetailResponse = await fetch(`http://127.0.0.1:${port}/api/conflicts/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: 'codex', skillId: baseline.skillId }),
  })
  const conflictDetail = await conflictDetailResponse.json()
  if (!conflictDetailResponse.ok || conflictDetail.definitions?.[0]?.contentHash !== baseline.contentHash) throw new Error('Conflict detail API did not return immutable definition evidence.')
  const conflictPlanResponse = await fetch(`http://127.0.0.1:${port}/api/conflicts/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'defer', runtime: 'codex', sourcePath: baseline.sourcePath }),
  })
  const conflictPlan = await conflictPlanResponse.json()
  if (!conflictPlanResponse.ok || conflictPlan.action !== 'defer' || !conflictPlan.previewToken) throw new Error('Conflict action API did not produce a dry-run plan.')
  const conflictApplyResponse = await fetch(`http://127.0.0.1:${port}/api/conflicts/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewToken: conflictPlan.previewToken, confirm: true, confirmedDefinitionKey: conflictPlan.definitionKey }),
  })
  const conflictApply = await conflictApplyResponse.json()
  if (!conflictApplyResponse.ok || conflictApply.status !== 'applied' || conflictApply.changed !== false) throw new Error('Confirmed no-change conflict action did not complete.')

  const invalidComparisonResponse = await fetch(`http://127.0.0.1:${port}/api/evaluations/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const invalidComparison = await invalidComparisonResponse.json()
  if (invalidComparisonResponse.status !== 400 || !invalidComparison.error?.includes('Candidate URL')) {
    throw new Error('Evaluation comparison API did not validate its candidate URL.')
  }

  const invalidChatResponse = await fetch(`http://127.0.0.1:${port}/api/assistant/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (invalidChatResponse.status !== 400) throw new Error('Evaluation assistant API did not reject an incomplete request.')

  const managedRun = await runManagedEvaluation({
    suiteId: 'deterministic-smoke',
    baselineRef: `local-scan:codex:${baseline.sourcePath}`,
    candidateRef: `local-scan:codex:${candidate.sourcePath}`,
    provider: { provider: 'ollama', model: 'deterministic-smoke', baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` },
    requestedBy: 'production-smoke',
    clientRequestId: 'production-smoke-managed-suite',
  }, 'Managed Skill Suite')
  const managedCasesResponse = await fetch(`http://127.0.0.1:${port}/api/evaluation-runs/${encodeURIComponent(managedRun.id)}/cases`)
  const managedCases = await managedCasesResponse.json()
  if (!managedCasesResponse.ok
    || !Number.isInteger(managedRun.metrics?.casesTotal)
    || managedCases.items?.length !== managedRun.metrics.casesTotal
    || !managedCases.items.every((item) => item.candidate.pass)) {
    throw new Error('Managed Suite case evidence is incomplete.')
  }
  const persistedEvidence = await readFile(path.join(smokeData, 'evaluations.jsonl'), 'utf8')
  if (persistedEvidence.includes('Require evaluation evidence') || persistedEvidence.includes('Lifecycle completion is an observation')) {
    throw new Error('Managed Suite persisted an Artifact body or provider output.')
  }

  const promptStatusResponse = await fetch(`http://127.0.0.1:${port}/api/prompt-registry/status`)
  const promptStatus = await promptStatusResponse.json()
  if (!promptStatusResponse.ok || !promptStatus.available || promptStatus.persistence !== 'git-source-only') throw new Error('Local Prompt Registry is not available.')

  async function promptAt(commit) {
    const response = await fetch(`http://127.0.0.1:${port}/api/prompt-registry/prompts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: commit }),
    })
    const result = await response.json()
    if (!response.ok || result.items?.length !== 1 || JSON.stringify(result).includes('SMOKE_STABLE')) {
      throw new Error(`Prompt Registry did not return safe metadata for ${commit}: ${JSON.stringify(result)}`)
    }
    return result.items[0]
  }
  const weakPrompt = await promptAt(weakPromptCommit)
  const firstPrompt = await promptAt(firstPromptCommit)
  const secondPrompt = await promptAt(secondPromptCommit)
  const comparisonResponse = await fetch(`http://127.0.0.1:${port}/api/prompt-registry/compare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leftRef: weakPrompt.artifact.sourceRef, rightRef: firstPrompt.artifact.sourceRef }),
  })
  const comparison = await comparisonResponse.json()
  if (!comparisonResponse.ok || !comparison.changed || !comparison.changedFields?.includes('prompt')) throw new Error('Prompt Registry version comparison failed.')

  async function nominatePrompt(record) {
    const response = await fetch(`http://127.0.0.1:${port}/api/prompt-registry/nominate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRef: record.artifact.sourceRef, targetSkeleton: promptTarget }),
    })
    const result = await response.json()
    if (!response.ok || !result.capability?.id || JSON.stringify(result).includes('SMOKE_STABLE')) throw new Error(`Local Prompt nomination failed: ${JSON.stringify(result)}`)
    return result.capability
  }

  const firstPromptCapability = await nominatePrompt(firstPrompt)
  const secondPromptCapability = await nominatePrompt(secondPrompt)
  const promptBaselineRef = weakPrompt.artifact.sourceRef
  const firstPromptRun = await runManagedEvaluation({
    suiteId: 'local-prompt-quality', baselineRef: promptBaselineRef, candidateRef: firstPromptCapability.artifact.sourceRef,
    provider: { provider: 'ollama', model: 'deterministic-smoke', baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` },
    requestedBy: 'production-smoke', clientRequestId: 'production-smoke-local-prompt-a',
  }, 'Local Prompt Suite A')

  async function promotePromptCapability(capability, run, reviewerToken) {
    const canaryProjectRoot = path.join(smokeData, `prompt-canary-${capability.id}`)
    await mkdir(canaryProjectRoot, { recursive: true })
    const capabilityUrl = `http://127.0.0.1:${port}/api/capabilities/${encodeURIComponent(capability.id)}`
    const action = async (name, body, token) => {
      const response = await fetch(`${capabilityUrl}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(`Local Prompt governance ${name} failed: ${JSON.stringify(result)}`)
      return result
    }
    const ready = await action('evaluate', { runId: run.id })
    if (ready.stage !== 'ready') throw new Error('Local Prompt evidence did not make the Capability Ready.')
    const approved = await action('approve', { decision: 'approved' }, reviewerToken)
    if (approved.stage !== 'approved') throw new Error('Local Prompt independent approval failed.')
    const canaryTarget = 'prompt-canary:release-summary'
    const canaryPreview = await action('canary', { action: 'preview', targetSkeleton: canaryTarget, projectRoot: canaryProjectRoot })
    const canary = await action('canary', {
      action: 'apply',
      previewToken: canaryPreview.previewToken,
      targetSkeleton: canaryTarget,
      projectRoot: canaryProjectRoot,
      confirm: true,
    })
    if (canary.capability?.stage !== 'canary' || !canary.applied?.referenceOnly) throw new Error('Local Prompt Canary deployment failed.')
    const preview = await action('promote', { action: 'preview' })
    const stable = await action('promote', { action: 'apply', previewToken: preview.previewToken, confirm: true })
    if (stable.capability?.stage !== 'stable' || !stable.applied?.referenceOnly) throw new Error('Local Prompt Stable promotion failed.')
    return stable.capability
  }

  const firstStable = await promotePromptCapability(firstPromptCapability, firstPromptRun, smokeReviewers[0].token)
  const secondPromptRun = await runManagedEvaluation({
    suiteId: 'local-prompt-quality', baselineRef: firstStable.artifact.sourceRef, candidateRef: secondPromptCapability.artifact.sourceRef,
    provider: { provider: 'ollama', model: 'deterministic-smoke', baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` },
    requestedBy: 'production-smoke', clientRequestId: 'production-smoke-local-prompt-b',
  }, 'Local Prompt Suite B')
  const secondStable = await promotePromptCapability(secondPromptCapability, secondPromptRun, smokeReviewers[1].token)
  const stableLockResponse = await fetch(`http://127.0.0.1:${port}/api/project-skeleton-lock`, { headers: governanceReadHeaders })
  const stableLock = await stableLockResponse.json()
  if (!stableLockResponse.ok || stableLock.targets?.[promptTarget]?.stable?.capabilityId !== secondStable.id) throw new Error('Local Prompt Stable reference was not locked.')
  const offlinePromptWorkspace = `${promptWorkspace}-offline`
  await rename(promptWorkspace, offlinePromptWorkspace)
  const offlineStatus = await fetch(`http://127.0.0.1:${port}/api/prompt-registry/status`)
  if (offlineStatus.status !== 409) throw new Error('Unavailable Prompt workspace did not return a safe Registry error.')
  const persistedRunResponse = await fetch(`http://127.0.0.1:${port}/api/evaluation-runs/${encodeURIComponent(secondPromptRun.id)}`)
  if (!persistedRunResponse.ok || (await persistedRunResponse.json()).evidenceHash !== secondPromptRun.evidenceHash) throw new Error('Prompt workspace loss affected persisted evidence.')

  const rollbackPreviewResponse = await fetch(`http://127.0.0.1:${port}/api/capabilities/${encodeURIComponent(secondStable.id)}/rollback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview' }),
  })
  const rollbackPreview = await rollbackPreviewResponse.json()
  if (!rollbackPreviewResponse.ok || !rollbackPreview.previewToken) throw new Error('Offline rollback preview failed.')
  const rollbackResponse = await fetch(`http://127.0.0.1:${port}/api/capabilities/${encodeURIComponent(secondStable.id)}/rollback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'apply', previewToken: rollbackPreview.previewToken, confirm: true }),
  })
  const rollback = await rollbackResponse.json()
  if (!rollbackResponse.ok || rollback.restoredCapabilityId !== firstStable.id) throw new Error(`Offline local Prompt rollback failed: ${JSON.stringify(rollback)}`)
  const rolledBackLockResponse = await fetch(`http://127.0.0.1:${port}/api/project-skeleton-lock`, { headers: governanceReadHeaders })
  const rolledBackLock = await rolledBackLockResponse.json()
  if (!rolledBackLockResponse.ok || rolledBackLock.targets?.[promptTarget]?.stable?.capabilityId !== firstStable.id) throw new Error('Rollback did not restore the immutable prior local Prompt reference.')

  const aiSettingsGet = await fetch(`http://127.0.0.1:${port}/api/ai-settings`)
  const aiSettings = await aiSettingsGet.json()
  if (!aiSettingsGet.ok || !aiSettings.activeProvider || !aiSettings.providers) {
    throw new Error('AI settings GET did not return persisted provider configuration.')
  }

  const aiSettingsPut = await fetch(`http://127.0.0.1:${port}/api/ai-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activeProvider: 'ollama',
      providers: {
        ollama: {
          apiKey: '',
          model: 'smoke-model',
          baseUrl: 'http://127.0.0.1:11434/v1',
          reasoningEffort: '',
        },
      },
    }),
  })
  const savedAiSettings = await aiSettingsPut.json()
  if (!aiSettingsPut.ok || savedAiSettings.activeProvider !== 'ollama' || savedAiSettings.providers?.ollama?.model !== 'smoke-model') {
    throw new Error('AI settings PUT did not persist provider configuration.')
  }
  const rawAiSettings = JSON.parse(await readFile(path.join(smokeData, 'ai-settings.json'), 'utf8'))
  if (rawAiSettings.providers?.ollama?.model !== 'smoke-model') {
    throw new Error('AI settings were not written under the smoke data directory.')
  }

  const connectionsResponse = await fetch(`http://127.0.0.1:${port}/api/connections`)
  const connections = await connectionsResponse.json()
  if (!connectionsResponse.ok || !Array.isArray(connections) || !connections.some((item) => item.runtime === 'codex')) {
    throw new Error('Runtime connection API did not return current adapter status.')
  }

  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'smoke-test', skillVersion: '0.1.0', runtime: 'codex', prompt: 'must-not-be-stored' }),
  })
  const created = await createdResponse.json()
  if (createdResponse.status !== 201 || created.skillId !== 'smoke-test') throw new Error('Valid event was not accepted.')
  if (created.outcome !== 'unknown') throw new Error('Lifecycle-only completion was incorrectly marked successful.')
  if (JSON.stringify(created).includes('must-not-be-stored')) throw new Error('Unknown event fields were not removed.')
  if ((await readFile(path.join(smokeData, 'events.jsonl'), 'utf8')).includes('must-not-be-stored')) throw new Error('Sensitive unknown fields reached the event store.')

  const crossSiteEvent = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'cross-site', runtime: 'codex' }),
  })
  if (crossSiteEvent.status !== 403) throw new Error('Cross-origin event mutation was not rejected.')
  const nonJsonEvent = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'non-json', runtime: 'codex' }),
  })
  if (nonJsonEvent.status !== 415) throw new Error('Non-JSON event mutation was not rejected.')

  const invalidNumberResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'invalid-number', runtime: 'codex', durationMs: 'abc' }),
  })
  if (invalidNumberResponse.status !== 400) throw new Error('Invalid numeric event data was not rejected.')

  const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'unknown.event' }),
  })
  if (invalidResponse.status !== 400) throw new Error('Invalid event was not rejected.')

  const invalidTimestampResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill.completed', skillId: 'bad-time', runtime: 'codex', timestamp: 'not-a-date' }),
  })
  if (invalidTimestampResponse.status !== 400) throw new Error('Invalid event timestamp was not rejected.')

  const importedEvent = { id: 'smoke-import', event: 'skill.completed', skillId: 'imported-smoke', runtime: 'claude-code', outcome: 'success' }
  const importResponse = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([importedEvent]),
  })
  const importResult = await importResponse.json()
  if (importResponse.status !== 201 || importResult.importedCount !== 1) throw new Error('Event import was not persisted.')
  const duplicateImport = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([importedEvent]),
  })
  if ((await duplicateImport.json()).importedCount !== 0) throw new Error('Duplicate imported event IDs were appended again.')

  const routeResponse = await fetch(`http://127.0.0.1:${port}/registry`)
  if (!routeResponse.ok || !(await routeResponse.text()).includes('<title>SkillOps</title>')) throw new Error('SPA route fallback failed.')
  const missingAsset = await fetch(`http://127.0.0.1:${port}/missing.js`)
  if (missingAsset.status !== 404) throw new Error('Missing asset did not return 404.')
  const nestedApiRoute = await fetch(`http://127.0.0.1:${port}/api/events/extra`)
  if (!(nestedApiRoute.headers.get('content-type') || '').includes('text/html')) throw new Error('Nested event path was incorrectly handled as the event API.')
  console.log('Smoke test passed: loopback frontend, SPA routing, privacy validation, deterministic Promptfoo evidence, local Prompt Registry governance/rollback, and local API are healthy.')
} finally {
  const exit = server.exitCode === null ? once(server, 'exit') : Promise.resolve()
  server.kill('SIGTERM')
  await exit
  const providerExit = once(provider, 'close')
  provider.close()
  await providerExit
  await rm(smokeData, { recursive: true, force: true })
}
