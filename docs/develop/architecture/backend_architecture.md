# Backend architecture: local event and inventory plane

> Version: v0.3.1
> Status: implemented

## 1. Backend goals

The backend provides a small local interface for:

- normalized append-only event persistence;
- atomic import and recoverable clearing;
- live installed-Skill inventory;
- public GitHub candidate discovery and deterministic local comparison;
- multi-provider A/B evaluation and assistant requests with optional local AI settings persistence;
- Codex Desktop incremental ingestion;
- runtime configuration health;
- production SPA serving.

It must remain local-first, tolerate missing runtime directories, and keep
collection failure isolated from the host coding runtime.

## 2. Technology and process model

| Area | Implementation |
| --- | --- |
| Runtime | Node.js 22.22+ ESM |
| HTTP | Built-in `node:http` production server |
| Development HTTP | Vite middleware with the same routes |
| Persistence | Local JSONL plus small JSON discovery index |
| Filesystem | `node:fs/promises` with atomic temp-file rename for rewrites |
| Validation | Shared allowlist normalizer in `app/shared` |
| Tests | Vitest Node tests and smoke process |

There is no database, account system, remote telemetry collector, or background
daemon. Skill Lab network calls occur only after an explicit browser request.

## 3. Backend modules

### `server.mjs`

Owns production HTTP routing, status codes, JSON responses, static MIME types,
SPA fallback, path traversal protection, and loopback binding.

### `event-store.mjs`

Owns event reads/appends/imports, ETag versioning, backups, clearing, selective
removal, discovery deduplication, and lock coordination.

### `skill-scanner.mjs`

Owns runtime home resolution, conventional scan locations, plugin registry
interpretation, bounded recursive traversal, frontmatter extraction, and
definition metadata. It resolves the active Codex plugin cache version, applies
Codex per-Skill disable entries, applies Claude file-setting precedence, and
computes a normalized local content hash without returning definition bodies.

### `runtime-connections.mjs`

Owns effective config inspection, SkillOps handler recognition, hook-script path
validation, and activity enrichment.

### `codex-desktop-ingest.mjs`

Owns incremental parsing of recent Codex Desktop session records and conservative
Skill path detection from actual file-read commands.

### `ai-settings-store.mjs`

Owns atomic read/write of Skill Lab AI provider settings under
`SKILLOPS_DATA_DIR/ai-settings.json`. Missing or corrupt files fall back to
catalog defaults. Writes validate known providers, field lengths, and reasoning
effort values. Credentials are never written to the event store.

### `skill-evaluations.mjs` and `evaluations/`

`skill-evaluations.mjs` is a compatibility facade for the existing exports,
legacy evaluation routes, `GET`/`PUT /api/ai-settings`, and the managed
evaluation, Prompt Registry, and governance API delegates. The implementation
is split behind that small interface:

- `errors.mjs` owns stable evaluation errors and input primitives;
- `request-guard.mjs` owns loopback/origin/content-type/body limits;
- `candidate-source.mjs` owns the GitHub Candidate adapter, discovery, local
  baseline definitions, and deterministic similarity;
- `artifact-definition.mjs` owns UTF-8/LF canonicalization, SHA-256 identity,
  Skill metadata adaptation, and kind-specific renderers;
- `provider-client.mjs` owns provider normalization and calls;
- `session-evaluator.mjs` owns sequential variants, blinded judging, and
  minimized assistant context.

All external evaluation JSON reaches the shared Evaluation Schema before these
modules. The current GitHub interface and response fields remain compatible.
Prompt Artifacts have a distinct renderer seam and are not represented as
`SKILL.md`. Tasks, prompts, and model responses are not written to disk;
provider credentials may exist in the current request or the explicit local AI
settings file after Save.

### `evaluation-agent.mjs`

Owns the optional read-only evaluation loop and its workspace tools. It exposes
only bounded file listing, literal search, and text-file reads; blocks secret,
runtime-data, dependency, build-output, traversal, and symlink paths; and has no
write, process, or network tool. Model rounds and total tool calls are capped.

## 4. HTTP contract

All successful JSON responses use `Content-Type: application/json`.
Evaluation and assistant POST handlers additionally reject non-loopback Host
headers, cross-site or mismatched browser Origins, and non-JSON content types
before scanning local inventory or contacting a provider.

### `GET /api/events`

Before reading, performs an incremental Codex Desktop sync. Returns the event
array and an ETag derived from file size and modification time. A matching
`If-None-Match` returns `304` with an empty body.

Responses:

- `200`: JSON array;
- `304`: unchanged;
- `500`: read or sync failure.

### `POST /api/events`

Accepts one event object. Normalizes it, appends one JSONL line, and returns the
stored event.

Responses:

- `201`: created event;
- `400`: invalid JSON or event;
- `405`: unsupported method.

### `DELETE /api/events`

Copies the active file to a timestamped backup, atomically replaces it with an
empty file, and resets the discovery index.

Example response:

```json
{
  "removed": 1301,
  "backupFile": "D:\\SkillOps\\data\\events.jsonl.backup-2026-07-20T00-00-00-000Z"
}
```

### `POST /api/import`

Accepts a JSON event array. The complete batch is normalized first. Existing
event IDs and repeated IDs in the batch are skipped.

Example response:

```json
{
  "created": [],
  "importedCount": 0
}
```

### `POST /api/scan`

Returns a current array of installed definitions. `GET` is intentionally not
supported and returns `405`.

### `GET /api/connections`

Performs Codex Desktop sync, reads effective runtime configuration, and returns:

```json
[
  {
    "runtime": "codex",
    "status": "installed",
    "checkedAt": "2026-07-20T00:00:00.000Z",
    "eventCount": 12,
    "lastEventAt": "2026-07-19T23:59:00.000Z"
  }
]
```

### `GET /api/ai-settings`

Returns the normalized Skill Lab AI provider settings document, including API
keys when previously saved. Missing files yield catalog defaults. Responses use
`Cache-Control: no-store` and the same loopback browser guards as other Skill
Lab routes, without requiring a JSON body.

### `PUT /api/ai-settings`

Accepts a full settings object, validates and merges it with catalog defaults,
and atomically writes `ai-settings.json` under `SKILLOPS_DATA_DIR`. Body size is
capped at 64 KB. Invalid fields return `400` without echoing secrets.

### `POST /api/evaluations/compare`

Accepts a public GitHub URL and optional candidate path. The server discovers at
most 40 `SKILL.md` entries, downloads one file with a 256 KB limit, reads
enabled local definitions, and returns candidate metadata plus the six closest
matches. Local Skill contents are not returned.

### `POST /api/evaluations/run`

Accepts a previously discovered candidate reference and SHA-256 content hash,
an exact baseline path from the current live scan, one task, acceptance
criteria, execution mode, and request-scoped provider configuration. The backend
re-downloads the candidate and rejects a changed hash. Baseline and candidate
run sequentially in prompt-only mode or through bounded read-only workspace
tools so concurrency-limited providers are supported; a final request judges
anonymous Answer A/Answer B and its winner must agree with the normalized
scores. Full results are returned to the requesting browser but are not
persisted. OpenAI-compatible requests may carry a validated `reasoning_effort`;
GPT-5.6 Chat Completions tool calls are rejected unless it is `none`.

### `POST /api/assistant/chat`

Accepts up to 24 in-memory user/assistant messages. Provider context contains
bounded enabled inventory names/versions/descriptions plus sanitized task,
criteria, candidate/match descriptions, similarity signals, and A/B outputs.
Local source paths and Skill contents are excluded from chat context.

## 5. Event-store invariants

### Append behavior

1. Normalize before any filesystem mutation.
2. Create the data directory lazily.
3. Repair a missing final newline left by a crashed writer.
4. Append exactly one newline-delimited JSON object.

### Read behavior

- Missing event file means an empty array.
- Blank lines are ignored.
- A malformed or partially written line is ignored so valid history remains readable.
- Reading does not rewrite the source file.

### Batch import behavior

- Validation is atomic; invalid event N rejects the whole batch.
- Existing IDs are not appended again.
- Duplicate IDs inside the submitted batch are appended once.
- An empty effective batch does not touch the event file.

### Rewrite behavior

Clear, selective removal, and discovery compaction use a temporary file plus
rename. Material destructive operations create a timestamped backup by default.

## 6. Discovery index and concurrency

`skill.discovered` identity is:

```text
runtime:skillId:skillVersion:sourcePath
```

The event file remains the source of truth. `discovery-index.json` is a rebuildable
optimization. Concurrent in-process calls are serialized by a promise queue;
concurrent processes coordinate with an exclusive lock file. A lock older than
30 seconds is considered stale and may be removed.

## 7. Scanner design

### Supported sources

- global Agents, Codex, Claude Code, legacy Claude commands, and Cursor folders;
- project-local `.agents`, `.codex`, `.claude`, and `.cursor` folders;
- active Codex plugin caches registered under the Codex home (`local` first,
  otherwise the highest valid semantic version; lexical maximum only when no
  valid semantic version exists);
- Claude installed plugin Skill and command folders that apply to the current project.

### Metadata

Each result contains Skill ID, version, runtime, source, path, kind, provider,
enabled state, optional disabled reason, normalized SHA-256 content hash,
optional description, and optional tags. The hash removes a UTF-8 BOM and
normalizes line endings before hashing; Skill contents do not cross the scan
API.

### Traversal safety

- recursion depth is bounded per source;
- canonical paths prevent symlink loops and duplicate paths;
- missing and access-denied conventional locations are treated as absent;
- only `SKILL.md` is accepted as a Skill; Claude command folders accept Markdown files.

### Plugin enablement

Codex plugin and `[[skills.config]]` state are merged from the user
`config.toml`, then the current trusted project's `.codex/config.toml`.
Per-Skill paths identify the directory containing `SKILL.md`; project entries
override user entries, but a disabled plugin cannot be re-enabled by a
per-Skill entry. Claude plugin installations are read from
`installed_plugins.json`; settings apply in increasing precedence from user,
project, and local files to system `managed-settings.json`, then alphabetically
ordered `managed-settings.d/*.json` drop-ins. Non-file managed Claude policy is
outside scanner visibility and must be verified with the runtime.

## 8. Codex Desktop ingestion

The ingester reads recent session JSONL files beneath the Codex home. Defaults:

- 7-day lookback;
- at most 50 most recently modified files;
- recursion depth at most 4;
- 30-second installed-Skill cache.

It accepts session sources `vscode`, `desktop`, and `codex-desktop`. Skill
detection requires an observable command that reads a `skills/.../SKILL.md`
path; mentioning a path in arbitrary output is insufficient.

Generated IDs and semantic keys are stable across refreshes. The parser tracks
active Skills per turn and closes them as lifecycle-only on task completion.

## 9. Connection statuses

| Status | Meaning |
| --- | --- |
| `installed` | Marked handlers exist and all referenced absolute scripts are files. |
| `not-installed` | Effective config exists or is absent but contains no SkillOps handlers. |
| `broken` | Handlers exist but a script path is missing or cannot be extracted. |
| `error` | Effective config could not be parsed/read for reasons other than absence. |
| `preview` | Runtime has UI representation but no production adapter. |

Activity is calculated from non-discovery events only.

## 10. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | Production server port |
| `SKILLOPS_HOST` | `127.0.0.1` | Production bind address |
| `SKILLOPS_DATA_DIR` | `<repo>/data` | Event/index/error storage directory |
| `CODEX_HOME` | `~/.codex` | Codex runtime home |
| `CLAUDE_CONFIG_DIR` | resolved by Claude adapter | Claude effective config home |

CC Switch configuration participates in Claude home resolution as documented in
[runtime adapters](../integrations/runtime_adapters.md).

**Implemented evaluation runtime:** Managed Suites are explicit repository files
under `evals/`. Promptfoo runs with cache, telemetry, update checks, sharing,
and remote generation disabled in a run-scoped temporary config directory.
Only sanitized evidence summaries are stored separately from events. The
manager provides bounded FIFO concurrency, idempotency, cancellation, and
interrupted-run recovery. Capability governance uses atomic lock-protected
metadata registries, exact evidence hashes, independent approvals, and
recoverable promotion/rollback. The exact package surface, privacy controls,
Red Team seam, and upgrade gate are documented in the
[Promptfoo integration contract](../integrations/promptfoo.md).

`app/backend/prompts/` owns the Local Prompt Registry. It reads strict Prompt
definitions from exact commits in a configured Git workspace, returns
metadata-only lists, derives semantic and component hashes, resolves bodies only
for backend evaluation, and creates Candidates only after an explicit request.
It never edits files, changes branches, creates commits, or calls a hosted Prompt
service. The full contract is documented in
[Prompt Registry integration](../integrations/prompt-registry.md).

## 11. Error and privacy behavior

- HTTP errors return JSON messages for local diagnosis.
- Adapter-level errors are written locally and swallowed by the host hook.
- Unknown event fields are discarded.
- Production static-file resolution rejects paths escaping `dist/`.
- The server is unauthenticated; non-loopback binding is an explicit operator risk.
- Raw source/transcript/tool data is not part of the backend event interface.
- Candidate discovery accepts only HTTPS `github.com` and
  `raw.githubusercontent.com` locations and rejects truncated/oversized inputs.
- Provider credentials for Skill Lab may be stored in local
  `data/ai-settings.json` after an explicit Save. They are still never written
  to the event store, diagnostics, backups created for event clear, or exported
  event JSON. Custom HTTP(S) Base URLs are allowed because local Ollama and
  compatible endpoints are a product requirement; the UI warns that the chosen
  endpoint receives the key.
- Evaluation prompts, generated answers, judge rationales, and chat messages are
  returned in memory and are never appended to the event store or diagnostics.
- Managed evidence contains statuses, scores, gates, and identity hashes only;
  provider keys, Artifact bodies, case inputs, raw outputs, and raw errors are
  excluded by schema and store tests.

## 12. Backend verification checklist

- [ ] Event normalization tests pass.
- [ ] Import atomicity and ID deduplication tests pass.
- [ ] Concurrent discovery appends remain unique.
- [ ] Scanner fixtures cover global/project/plugin/disabled/command cases.
- [ ] Connection tests cover installed, absent, broken, and config-error states.
- [ ] Codex Desktop parser tests reject false-positive path mentions.
- [ ] Candidate bounds, local baseline allowlisting, blind judging, provider
  normalization, and chat-context minimization tests pass.
- [ ] `npm run smoke` covers HTTP privacy, API, SPA routing, and loopback behavior.
