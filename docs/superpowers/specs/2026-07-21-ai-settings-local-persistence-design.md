# AI settings local persistence

> Date: 2026-07-21  
> Status: approved for implementation planning  
> Surface: Skill Lab (`/evaluations`) AI provider configuration

## 1. Problem

Skill Lab AI settings currently live only in React page memory. After reload or
page close, provider, model, base URL, reasoning effort, and API key are lost.
Users who configure AI for chat and A/B evaluation expect that configuration to
survive local restarts.

Product docs and tests currently encode the opposite guarantee: credentials and
provider configuration are never written to disk. That guarantee must be
narrowed so only the explicit AI settings file is persisted, while evaluation
tasks, chat, and model output remain memory-only.

## 2. Goals

- Persist the full configured `AiSettings` object locally, including API keys.
- Restore settings when the Evaluations workspace mounts.
- Keep persistence local-first and loopback-only.
- Leave evaluation tasks, acceptance criteria, chat messages, workspace
  excerpts, and model/judge output unpersisted.

## 3. Non-goals

- At-rest encryption of the settings file.
- Browser `localStorage` / `sessionStorage` for credentials.
- A global Settings-page secrets manager.
- Persisting evaluation runs, prompts, chat transcripts, or model output.
- Syncing settings across machines.

## 4. Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Persistence location | Backend file under `SKILLOPS_DATA_DIR` | User selected backend `data/` over browser storage so settings survive browser clears and stay with other local runtime state. |
| Filename | `ai-settings.json` | Single-purpose file beside `events.jsonl`; already covered by `/data/` gitignore. |
| Transport | `GET` + `PUT /api/ai-settings` | Matches existing loopback JSON API style; frontend never touches the filesystem. |
| Payload | Full `AiSettings` including every provider slot and keys | Matches user scope: configured AI should restore completely after reload. |
| Trust model | Loopback-only unauthenticated API + gitignored local file | Same trust boundary as the rest of SkillOps local control plane. |

## 5. Storage format

Path:

```text
${SKILLOPS_DATA_DIR}/ai-settings.json
```

Default path when unset:

```text
`<repo root>/data/ai-settings.json`
```

JSON shape:

```json
{
  "version": 1,
  "activeProvider": "openai",
  "providers": {
    "openai": {
      "apiKey": "…",
      "model": "gpt-4o-mini",
      "baseUrl": "https://api.openai.com/v1",
      "reasoningEffort": "none"
    },
    "gemini": {
      "apiKey": "",
      "model": "gemini-3.5-flash",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "reasoningEffort": ""
    }
  }
}
```

Rules:

- `version` is required and currently only `1`.
- `activeProvider` must be a known catalog id.
- `providers` is a map keyed by known catalog ids only.
- Each provider config accepts:
  - `apiKey` string
  - `model` string
  - `baseUrl` string
  - `reasoningEffort` string in `'' | none | low | medium | high | xhigh | max`
  - optional `apiVersion` string (Azure)
- Unknown provider ids and unknown fields are dropped.
- Missing provider slots are filled from catalog defaults.
- Invalid or oversized strings fail validation on write; on read they cause
  fallback to defaults rather than crashing the UI.
- Field length caps stay conservative (aligned with evaluation request limits,
  on the order of 2_000 chars per string field).
- Writes are atomic: write temp file in the same directory, then rename.
- Missing file is not an error: readers return `createDefaultAiSettings()`-
  equivalent defaults.
- Corrupt JSON / unsupported version: log-free fallback to defaults for GET;
  never return partial secrets mixed with thrown stack traces.

## 6. Backend design

### 6.1 Module

Add `app/backend/ai-settings-store.mjs` responsible for:

- resolving the settings path from `event-store` `dataDir` (or the same
  `SKILLOPS_DATA_DIR` resolution rule)
- `readAiSettings()`
- `writeAiSettings(input)`
- normalization / validation helpers

Do not fold this into `event-store.mjs`; event history and credentials are
different durability concerns.

Shared provider identity continues to come from
`app/shared/ai-provider-catalog.mjs`.

### 6.2 HTTP interface

Extend the evaluation HTTP boundary so these routes are handled with the same
protections already used by Skill Lab POSTs where applicable:

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/api/ai-settings` | none | normalized settings JSON |
| `PUT` | `/api/ai-settings` | JSON body = full settings | normalized settings JSON |

Shared response headers:

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`

Request guards:

- loopback `Host` only
- browser `Origin` same-origin / non-cross-site when present
- `PUT` requires `application/json`
- `PUT` body size cap (~64 KB)
- unsupported methods → `405`

Error behavior:

- validation failures → `400` with generic field messages
- unexpected IO failures → `500` without echoing secrets
- never include API keys in error strings

Routing placement:

- Prefer handling inside/near `handleEvaluationApi` or a sibling handler invoked
  from the same server/middleware entrypoints (`server.mjs` and Vite dev
  middleware) so production and development stay aligned.
- `GET` must be first-class; the current evaluation handler is POST-only and
  therefore needs an explicit method split for these routes.

### 6.3 Privacy boundary updates

Update backend docs and runtime privacy copy:

- Old: provider credentials exist only in the current request / never written.
- New: provider credentials for Skill Lab may be stored in local
  `data/ai-settings.json` after an explicit Save. They are still never written
  to the event store, diagnostics, backups created for event clear, or exported
  event JSON.
- Evaluation task text, criteria, chat, workspace excerpts, and model output
  remain memory-only.

A/B result payload `privacy` string must stop claiming credentials were not
written to disk if the user has saved settings. Prefer a stable statement such
as:

> Task text, acceptance criteria, generated answers, and chat were not written
> to disk by SkillOps. Saved AI provider settings may exist in local
> `data/ai-settings.json`.

## 7. Frontend design

### 7.1 Load

`EvaluationWorkspace`:

1. Initialize state with `createDefaultAiSettings()`.
2. On mount, `GET /api/ai-settings`.
3. On success, replace settings state with the response.
4. On failure, keep defaults and optionally surface a non-blocking notice only
   if later save/run needs it; do not block candidate analysis.

### 7.2 Save

`AiSettingsModal` still edits a draft and calls `onSave(next)`.

`saveSettings` in `EvaluationWorkspace`:

1. `PUT /api/ai-settings` with the draft settings.
2. On success, set state from the normalized response and close the modal.
3. On failure, keep the modal open or reopenable and show the error; do not
   claim local persistence succeeded.

Saving remains explicit via **Save settings**. No autosave on every keystroke.

### 7.3 Runtime requests

`/api/evaluations/run` and `/api/assistant/chat` continue to receive the
provider block from the frontend request body. Persistence restores UI state; it
does not create a hidden server-side “active key” implicit auth path in v1.

### 7.4 Copy

Update `AiSettingsModal` privacy note to state:

- configured provider settings, including API keys, are stored on the local
  SkillOps data directory after Save
- evaluation prompts, chat messages, and model output are still not written
- provider requests still follow the selected provider’s data policy

## 8. Documentation and agent-guide updates

Keep these synchronized with the implementation:

- `README.md` privacy paragraph
- `AGENTS.md` privacy bullet that currently forbids persisting credentials /
  provider configuration
- `docs/develop/architecture/system_architecture.md` storage table
- `docs/develop/architecture/backend_architecture.md`
- `docs/develop/architecture/frontend_architecture.md`
- `docs/develop/operations/testing.md` if it asserts keys never hit disk

The new rule:

- **Allowed:** explicit Skill Lab AI settings file under `SKILLOPS_DATA_DIR`
- **Forbidden:** credentials in events, discovery index, exports, adapter
  diagnostics, chat/evaluation transcripts, or logs

## 9. Testing plan

### Backend

- missing file → defaults
- round-trip write/read preserves active provider, model, baseUrl, reasoning,
  apiVersion, and apiKey
- unknown provider ids stripped; defaults merged for missing providers
- invalid reasoning effort / oversized fields rejected on write
- corrupt file does not crash GET
- atomic write leaves no truncated primary file on failure
- GET/PUT reject non-loopback / cross-site browser requests
- PUT rejects non-JSON and oversized bodies
- error responses do not contain submitted secrets

### Frontend

- mount issues `GET /api/ai-settings` and applies returned settings
- Save issues `PUT /api/ai-settings` and keeps returned settings in memory
- failed PUT does not close as success
- remove assertions that require session/local storage emptiness as the privacy
  proof; replace with API persistence expectations
- existing A/B + chat flows still send provider in request bodies

### Smoke / docs

- smoke coverage includes the new routes if the smoke suite enumerates
  evaluation APIs
- privacy docs no longer over-claim “never writes credentials”

## 10. Rollout and compatibility

- No migration from browser storage; there is nothing stored today.
- Absence of `ai-settings.json` preserves current first-run defaults.
- Future catalog provider additions remain compatible because readers merge with
  current catalog defaults.
- Removing a provider from the catalog drops that slot on next normalize.

## 11. Implementation sequence

1. Backend store + tests.
2. HTTP routes + boundary tests.
3. Frontend load/save wiring + component tests.
4. Privacy string / docs / AGENTS updates.
5. Targeted tests, full `npm test`, `npm run build`, and smoke if API surface
   changed.

## 12. Open implementation notes

- Reuse `dataDir` resolution from `event-store.mjs` rather than inventing a
  second env var.
- Keep the settings module injectable in tests via temp `SKILLOPS_DATA_DIR`.
- Do not print dry-run previews of `ai-settings.json` contents in any installer
  or diagnostic path.
