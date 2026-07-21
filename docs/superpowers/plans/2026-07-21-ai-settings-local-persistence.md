# AI Settings Local Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Skill Lab AI provider settings (including API keys) to local `data/ai-settings.json` via loopback `GET`/`PUT /api/ai-settings`, and restore them when Evaluations mounts.

**Architecture:** New backend store module owns atomic JSON file IO under `SKILLOPS_DATA_DIR`. Evaluation HTTP boundary gains settings routes with the same loopback guards. Frontend loads on mount and saves explicitly through the API. Docs/privacy copy stop claiming credentials never hit disk.

**Tech Stack:** Node ESM backend, Vitest, React/Vite frontend, existing shared AI provider catalog.

## Global Constraints

- Persist full `AiSettings` including API keys after explicit Save only.
- File path: `${SKILLOPS_DATA_DIR}/ai-settings.json` (gitignored `/data/`).
- Never persist evaluation tasks, criteria, chat, workspace excerpts, or model output.
- Never write credentials into events, discovery index, exports, diagnostics, or logs.
- Loopback-only unauthenticated API; `Cache-Control: no-store`.
- Keep production `server.mjs` and Vite middleware behavior aligned.
- TDD: failing test before production code for each behavior slice.
- Commit messages follow `docs/commit-convention.md` (Chinese conventional commits).

## File map

| File | Responsibility |
| --- | --- |
| Create `app/backend/ai-settings-store.mjs` | Defaults, normalize/validate, atomic read/write |
| Create `app/backend/ai-settings-store.test.mjs` | Store unit tests |
| Modify `app/backend/skill-evaluations.mjs` | HTTP routes + privacy string |
| Modify `app/backend/skill-evaluations.test.mjs` | Route/boundary tests |
| Modify `app/frontend/skillops/src/components/EvaluationWorkspace.tsx` | Load/save wiring |
| Modify `app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx` | Persistence UI tests |
| Modify `app/frontend/skillops/src/components/AiSettingsModal.tsx` | Privacy copy |
| Modify `scripts/smoke.mjs` | GET/PUT smoke coverage |
| Modify privacy docs listed in Task 4 | Align guarantees |

---

### Task 1: Backend AI settings store

**Files:**
- Create: `app/backend/ai-settings-store.mjs`
- Test: `app/backend/ai-settings-store.test.mjs`
- Consumes: `dataDir` from `./event-store.mjs`, catalog from `../shared/ai-provider-catalog.mjs`

**Interfaces:**
- Produces:
  - `export const aiSettingsFile`
  - `export function createDefaultAiSettings()`
  - `export function normalizeAiSettings(input, { strict = false } = {})`
  - `export async function readAiSettings()`
  - `export async function writeAiSettings(input)`
- Stored shape:
```js
{
  version: 1,
  activeProvider: AiProviderId,
  providers: Record<AiProviderId, {
    apiKey: string,
    model: string,
    baseUrl: string,
    reasoningEffort: '' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    apiVersion?: string,
  }>
}
```

- [ ] **Step 1: Write failing store tests**

Create `app/backend/ai-settings-store.test.mjs`:

```js
// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let dataDirectory
let store

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'skillops-ai-settings-'))
  process.env.SKILLOPS_DATA_DIR = dataDirectory
  const moduleUrl = `${pathToFileURL(path.resolve('app/backend/ai-settings-store.mjs')).href}?test=${Date.now()}-${Math.random()}`
  store = await import(/* @vite-ignore */ moduleUrl)
})

afterEach(async () => {
  delete process.env.SKILLOPS_DATA_DIR
  await rm(dataDirectory, { recursive: true, force: true })
})

describe('ai-settings-store', () => {
  it('returns catalog defaults when the settings file is missing', async () => {
    const settings = await store.readAiSettings()
    expect(settings.activeProvider).toBe('gemini')
    expect(settings.providers.openai.model).toBeTruthy()
    expect(settings.providers.openai.apiKey).toBe('')
    expect(settings.version).toBe(1)
  })

  it('round-trips full provider settings including API keys', async () => {
    const written = await store.writeAiSettings({
      activeProvider: 'openai',
      providers: {
        openai: {
          apiKey: 'sk-test-secret',
          model: 'gpt-test',
          baseUrl: 'https://api.openai.com/v1',
          reasoningEffort: 'none',
        },
      },
    })

    expect(written.activeProvider).toBe('openai')
    expect(written.providers.openai.apiKey).toBe('sk-test-secret')
    expect(written.providers.gemini.model).toBeTruthy()

    const raw = JSON.parse(await readFile(store.aiSettingsFile, 'utf8'))
    expect(raw.providers.openai.apiKey).toBe('sk-test-secret')
    expect(await store.readAiSettings()).toEqual(written)
  })

  it('strips unknown providers and merges missing slots from defaults', async () => {
    const written = await store.writeAiSettings({
      activeProvider: 'ollama',
      providers: {
        ollama: { apiKey: '', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1', reasoningEffort: '' },
        'not-a-provider': { apiKey: 'x', model: 'y', baseUrl: 'https://example.test', reasoningEffort: '' },
      },
    })
    expect(written.providers['not-a-provider']).toBeUndefined()
    expect(written.providers.openai.model).toBeTruthy()
  })

  it('rejects invalid reasoning effort and oversized fields on write', async () => {
    await expect(store.writeAiSettings({
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: 'k', model: 'm', baseUrl: 'https://example.test', reasoningEffort: 'extreme' },
      },
    })).rejects.toThrow(/reasoning/i)

    await expect(store.writeAiSettings({
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: 'k'.repeat(3_000), model: 'm', baseUrl: 'https://example.test', reasoningEffort: '' },
      },
    })).rejects.toThrow(/too long/i)
  })

  it('falls back to defaults for corrupt or unsupported files', async () => {
    await writeFile(store.aiSettingsFile, '{not-json', 'utf8')
    const corrupt = await store.readAiSettings()
    expect(corrupt.activeProvider).toBe('gemini')

    await writeFile(store.aiSettingsFile, JSON.stringify({ version: 99, activeProvider: 'openai', providers: {} }), 'utf8')
    const unsupported = await store.readAiSettings()
    expect(unsupported.activeProvider).toBe('gemini')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/backend/ai-settings-store.test.mjs`
Expected: FAIL because module is missing.

- [ ] **Step 3: Implement store module**

Create `app/backend/ai-settings-store.mjs` with:

- import `mkdir`, `readFile`, `rename`, `writeFile` from `node:fs/promises`
- import `path` from `node:path`
- import `{ dataDir }` from `./event-store.mjs`
- import `{ AI_PROVIDER_CATALOG, AI_PROVIDER_IDS, aiProviderDefinition }` from `../shared/ai-provider-catalog.mjs`
- constants:
  - `SETTINGS_VERSION = 1`
  - `MAX_FIELD_CHARS = 2_000`
  - `REASONING_EFFORTS = new Set(['', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])`
  - `export const aiSettingsFile = path.join(dataDir, 'ai-settings.json')`
- `createDefaultAiSettings()` matching frontend defaults (`activeProvider: 'gemini'`, empty keys, catalog models/base URLs, `reasoningEffort: ''`, azure `apiVersion: 'v1'`)
- `normalizeAiSettings(input, { strict = false } = {})`:
  - strict mode (write): throw on non-object body, unknown active provider, non-object providers map, non-string fields, oversized fields, invalid reasoning
  - non-strict (read): any problem → return defaults
  - always emit full provider map merged with defaults
  - include `version: 1`
  - only include `apiVersion` for `azure-openai`
- `readAiSettings()`: missing/corrupt/unsupported → defaults
- `writeAiSettings(input)`: `normalize(..., { strict: true })`, `mkdir(dataDir, { recursive: true })`, write `${aiSettingsFile}.${pid}.tmp`, rename to final, return normalized object
- export a small `AiSettingsError` or reuse plain `Error` with clear messages (HTTP layer can map to 400)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/backend/ai-settings-store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/backend/ai-settings-store.mjs app/backend/ai-settings-store.test.mjs
git commit -m "$(cat <<'EOF'
feat(evaluations): 持久化 AI 设置到本地 data 文件

新增 ai-settings-store，把 Skill Lab 的 provider/model/baseUrl/
reasoning/apiKey 原子写入 SKILLOPS_DATA_DIR/ai-settings.json，
缺文件或损坏时回退默认值。

验证：npx vitest run app/backend/ai-settings-store.test.mjs
EOF
)"
```

---

### Task 2: HTTP GET/PUT `/api/ai-settings`

**Files:**
- Modify: `app/backend/skill-evaluations.mjs`
- Modify: `app/backend/skill-evaluations.test.mjs`
- Modify: `scripts/smoke.mjs`
- Consumes: `readAiSettings`, `writeAiSettings` from `./ai-settings-store.mjs`

**Interfaces:**
- `GET /api/ai-settings` → normalized settings JSON
- `PUT /api/ai-settings` → body settings, response normalized settings
- PUT body cap: 64 KB
- GET skips JSON content-type requirement
- Update A/B `privacy` string to:
  `Task text, acceptance criteria, generated answers, and chat were not written to disk by SkillOps. Saved AI provider settings may exist in local data/ai-settings.json.`

- [ ] **Step 1: Write failing HTTP tests**

In `skill-evaluations.test.mjs`, extend helpers and add cases:

```js
function fakeRequest({ method = 'POST', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const bytes = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method,
    headers: {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) } : {}),
      ...headers,
    },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (bytes) yield bytes },
  }
}
```

Keep `fakeJsonRequest` as a thin wrapper if existing tests depend on it.

Add tests:

```js
it('loads default AI settings over GET without a JSON body', async () => {
  const response = fakeResponse()
  await handleEvaluationApi(fakeRequest({ method: 'GET' }), response, '/api/ai-settings')
  expect(response.statusCode).toBe(200)
  expect(JSON.parse(response.body).activeProvider).toBe('gemini')
  expect(response.headers['cache-control']).toBe('no-store')
})

it('persists AI settings over PUT and returns them on GET', async () => {
  const put = fakeResponse()
  await handleEvaluationApi(fakeRequest({
    method: 'PUT',
    body: {
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: 'persist-secret', model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', reasoningEffort: 'none' },
      },
    },
  }), put, '/api/ai-settings')
  expect(put.statusCode).toBe(200)
  expect(JSON.parse(put.body).providers.openai.apiKey).toBe('persist-secret')

  const get = fakeResponse()
  await handleEvaluationApi(fakeRequest({ method: 'GET' }), get, '/api/ai-settings')
  expect(JSON.parse(get.body).providers.openai.apiKey).toBe('persist-secret')
})

it('rejects non-loopback AI settings access and oversized PUT bodies', async () => {
  const blocked = fakeResponse()
  await handleEvaluationApi(fakeRequest({
    method: 'GET',
    headers: { host: 'evil.example:4173', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }), blocked, '/api/ai-settings')
  expect(blocked.statusCode).toBe(403)

  const oversized = fakeResponse()
  await handleEvaluationApi(fakeRequest({
    method: 'PUT',
    headers: { 'content-length': '70000' },
    body: { activeProvider: 'openai', providers: {} },
  }), oversized, '/api/ai-settings')
  expect(oversized.statusCode).toBe(413)
})

it('maps invalid AI settings writes to 400 without echoing secrets', async () => {
  const response = fakeResponse()
  const secret = 'super-secret-key-value'
  await handleEvaluationApi(fakeRequest({
    method: 'PUT',
    body: {
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: secret, model: 'm', baseUrl: 'https://example.test', reasoningEffort: 'extreme' },
      },
    },
  }), response, '/api/ai-settings')
  expect(response.statusCode).toBe(400)
  expect(response.body).not.toContain(secret)
})
```

Also update any assertion on the A/B privacy string if present.

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `npx vitest run app/backend/skill-evaluations.test.mjs -t "AI settings"`
Expected: FAIL on missing route behavior.

- [ ] **Step 3: Implement route handling**

In `skill-evaluations.mjs`:

1. Import store functions.
2. Split request assertion:
   - `assertLocalBrowserRequest(request, { requireJsonBody = true } = {})`
   - JSON content-type only when `requireJsonBody`
3. Add `readAiSettingsBody(request)` with `MAX_AI_SETTINGS_REQUEST_BYTES = 64_000`.
4. Expand `handleEvaluationApi`:
```js
if (pathname === '/api/ai-settings') {
  // set shared headers
  try {
    if (request.method === 'GET') {
      assertLocalBrowserRequest(request, { requireJsonBody: false })
      response.end(JSON.stringify(await (options.readAiSettings || readAiSettings)()))
      return true
    }
    if (request.method === 'PUT') {
      assertLocalBrowserRequest(request, { requireJsonBody: true })
      const body = await readAiSettingsBody(request)
      response.end(JSON.stringify(await (options.writeAiSettings || writeAiSettings)(body)))
      return true
    }
    response.statusCode = 405
    response.end(JSON.stringify({ error: 'Method not allowed' }))
    return true
  } catch (error) {
    // map store validation errors to 400, EvaluationError statuses, else 500
  }
}
```
5. Keep existing POST handlers unchanged except privacy string update in `runSkillABTest`.
6. Ensure store validation errors become `EvaluationError(..., 400)` either in the store adapter or catch block.

- [ ] **Step 4: Extend smoke checks**

In `scripts/smoke.mjs` after chat validation:

```js
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
const saved = await aiSettingsPut.json()
if (!aiSettingsPut.ok || saved.activeProvider !== 'ollama' || saved.providers.ollama.model !== 'smoke-model') {
  throw new Error('AI settings PUT did not persist provider configuration.')
}
const rawSettings = JSON.parse(await readFile(path.join(smokeData, 'ai-settings.json'), 'utf8'))
if (rawSettings.providers.ollama.model !== 'smoke-model') {
  throw new Error('AI settings were not written under the smoke data directory.')
}
```

- [ ] **Step 5: Run tests**

Run:
- `npx vitest run app/backend/skill-evaluations.test.mjs app/backend/ai-settings-store.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/backend/skill-evaluations.mjs app/backend/skill-evaluations.test.mjs scripts/smoke.mjs
git commit -m "$(cat <<'EOF'
feat(evaluations): 增加 AI 设置读写 API

通过 loopback GET/PUT /api/ai-settings 读写本地 ai-settings.json，
并更新 A/B 隐私说明与 smoke 覆盖。

验证：npx vitest run app/backend/skill-evaluations.test.mjs app/backend/ai-settings-store.test.mjs
EOF
)"
```

---

### Task 3: Frontend load/save wiring

**Files:**
- Modify: `app/frontend/skillops/src/components/EvaluationWorkspace.tsx`
- Modify: `app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx`
- Modify: `app/frontend/skillops/src/components/AiSettingsModal.tsx`

**Interfaces:**
- On mount: `GET /api/ai-settings`
- On save: `PUT /api/ai-settings` then apply response
- Failed PUT surfaces error and keeps/reopens settings UX without false success

- [ ] **Step 1: Update failing/updated frontend tests**

In default `beforeEach` fetch mock, add:

```ts
const defaultSettings = {
  activeProvider: 'gemini',
  providers: {
    gemini: { apiKey: '', model: 'gemini-3.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', reasoningEffort: '' },
    openai: { apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', reasoningEffort: '' },
    // include remaining providers with empty keys / catalog defaults as needed by UI
  },
}

if (input === '/api/ai-settings') {
  if (init?.method === 'PUT') {
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(String(init.body)) })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => defaultSettings })
}
```

Replace the no-storage privacy assertions:

```ts
// old
expect(window.sessionStorage.getItem('skillops-ai-settings')).toBeNull()
expect(window.localStorage.length).toBe(0)

// new
expect(fetchMock).toHaveBeenCalledWith('/api/ai-settings', expect.objectContaining({ method: 'PUT' }))
const putRequest = fetchMock.mock.calls.find(([url, init]) => url === '/api/ai-settings' && init?.method === 'PUT')?.[1]
expect(JSON.parse(String(putRequest?.body))).toEqual(expect.objectContaining({
  activeProvider: 'openai',
  providers: expect.objectContaining({
    openai: expect.objectContaining({ apiKey: 'session-secret', model: 'gpt-5.6-sol', reasoningEffort: 'none' }),
  }),
}))
```

Add tests:

```ts
it('restores saved AI settings from the local API on mount', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
    if (input === '/api/ai-settings') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          activeProvider: 'openai',
          providers: {
            openai: { apiKey: 'restored-secret', model: 'gpt-restored', baseUrl: 'https://api.openai.com/v1', reasoningEffort: 'none' },
            gemini: { apiKey: '', model: 'gemini-3.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', reasoningEffort: '' },
          },
        }),
      })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })
  }))

  render(<EvaluationWorkspace />)
  expect(await screen.findByRole('button', { name: /OpenAI · gpt-restored/ })).toBeTruthy()
})

it('keeps the settings dialog open when persistence fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
    if (input === '/api/ai-settings' && init?.method === 'PUT') {
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Disk unavailable' }) })
    }
    if (input === '/api/ai-settings') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        activeProvider: 'gemini',
        providers: {
          gemini: { apiKey: '', model: 'gemini-3.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', reasoningEffort: '' },
          openai: { apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', reasoningEffort: '' },
        },
      }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })
  }))

  render(<EvaluationWorkspace />)
  fireEvent.click(await screen.findByRole('button', { name: 'Configure AI' }))
  const dialog = screen.getByRole('dialog', { name: 'AI settings' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'OpenAI' }))
  fireEvent.change(within(dialog).getByPlaceholderText('Enter OpenAI API key'), { target: { value: 'new-secret' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }))
  expect(await screen.findByText(/Disk unavailable/)).toBeTruthy()
  expect(screen.getByRole('dialog', { name: 'AI settings' })).toBeTruthy()
})
```

Ensure custom fetch mocks used by other tests also answer `GET /api/ai-settings` so mount does not break them.

- [ ] **Step 2: Run frontend tests to verify failure**

Run: `npx vitest run app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx`
Expected: FAIL on missing GET/PUT behavior and/or privacy assertion changes.

- [ ] **Step 3: Implement frontend changes**

`EvaluationWorkspace.tsx`:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || `Local API returned ${response.status}.`)
  return result
}

// keep postJson as wrapper around readJson with POST defaults
```

Mount load:

```ts
useEffect(() => {
  let cancelled = false
  ;(async () => {
    try {
      const loaded = await readJson<AiSettings>('/api/ai-settings')
      if (!cancelled) setSettings(loaded)
    } catch {
      // Keep defaults when local settings are unavailable.
    }
  })()
  return () => { cancelled = true }
}, [])
```

Save:

```ts
const saveSettings = useCallback(async (next: AiSettings) => {
  try {
    const saved = await readJson<AiSettings>('/api/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    setSettings(saved)
    setError(null)
    setSettingsOpen(false)
  } catch (problem) {
    setError(problem instanceof Error ? problem.message : 'Failed to save AI settings.')
    setSettingsOpen(true)
  }
}, [])
```

`AiSettingsModal.tsx` privacy note:

```tsx
<p><strong>Privacy</strong> Saving stores provider settings, including API keys, in the local SkillOps data directory (`data/ai-settings.json`). Evaluation prompts, chat messages, and model output are still not written to disk. Read-only agent mode can send requested allowed workspace excerpts to the provider; review source for embedded sensitive data. Provider requests follow that provider's data policy.</p>
```

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/frontend/skillops/src/components/EvaluationWorkspace.tsx app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx app/frontend/skillops/src/components/AiSettingsModal.tsx
git commit -m "$(cat <<'EOF'
feat(evaluations): 从本地 API 恢复并保存 AI 配置

Evaluations 挂载时 GET /api/ai-settings，保存时 PUT 持久化；
失败时保留设置弹层并提示错误，同时更新隐私文案。

验证：npx vitest run app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx
EOF
)"
```

---

### Task 4: Docs, agent guide, and final verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/develop/architecture/system_architecture.md`
- Modify: `docs/develop/architecture/backend_architecture.md`
- Modify: `docs/develop/architecture/frontend_architecture.md`
- Modify: `docs/develop/operations/testing.md`
- Modify: `docs/develop/security/privacy-security.md`
- Modify: `docs/product/prd.md`
- Modify: `docs/product/user-guide.md`
- Modify: `docs/develop/roadmap/task.md` (credentials bullet only)

**Copy rules to apply consistently:**
- Allowed: explicit Skill Lab AI settings file under `SKILLOPS_DATA_DIR`
- Forbidden: credentials in events/exports/logs/diagnostics; tasks/chat/model output on disk
- Reload no longer clears saved AI settings

- [ ] **Step 1: Update docs**

Key replacements:

`README.md`:
- AI settings are saved to local `data/ai-settings.json` after Save via loopback API
- tasks/chat/model output still not written

`AGENTS.md` privacy:
- Do not persist prompts/transcripts/tool IO/source/raw errors/tokens
- Provider credentials may be stored only in `data/ai-settings.json` after explicit Skill Lab save; never in events or exports

Architecture docs:
- storage table row for AI settings → backend `data/ai-settings.json`
- add GET/PUT route rows
- frontend loads/saves through API, not page-memory-only
- backend module list includes `ai-settings-store.mjs`

Testing/privacy/product docs:
- remove “reload clears API key”
- note saved settings restore after reload
- keep “no evaluation content in event store”

- [ ] **Step 2: Run full verification**

```bash
npx vitest run app/backend/ai-settings-store.test.mjs app/backend/skill-evaluations.test.mjs app/frontend/skillops/src/components/EvaluationWorkspace.test.tsx
npm test
npm run build
npm run smoke
git diff --check
git status --short --branch
```

Expected: all green; smoke writes/reads `ai-settings.json` under smoke data dir.

- [ ] **Step 3: Commit docs**

```bash
git add README.md AGENTS.md docs/develop/architecture/system_architecture.md docs/develop/architecture/backend_architecture.md docs/develop/architecture/frontend_architecture.md docs/develop/operations/testing.md docs/develop/security/privacy-security.md docs/product/prd.md docs/product/user-guide.md docs/develop/roadmap/task.md
git commit -m "$(cat <<'EOF'
docs: 同步 AI 设置本地持久化隐私边界

说明 Skill Lab 配置（含 API key）可写入 data/ai-settings.json，
同时保持任务、聊天与模型输出不落盘。

验证：npm test；npm run build；npm run smoke
EOF
)"
```

---

## Spec coverage checklist

- Full settings incl. API key → Task 1/2/3
- Restore on Evaluations mount → Task 3
- Backend `data/ai-settings.json` + atomic write → Task 1
- GET/PUT loopback API + guards/size limit → Task 2
- No task/chat/output persistence → unchanged paths + docs Task 4
- Privacy string + docs/AGENTS updates → Task 2/4
- Frontend failure handling → Task 3
- Smoke coverage → Task 2/4
