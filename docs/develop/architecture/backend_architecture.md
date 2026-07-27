# Backend architecture: local event and inventory plane

> Version: v0.3.2-rc.1
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
- sanitized first-run prerequisite inspection;
- final Managed Decisions and evidence-backed Release Candidate origin;
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

Owns event reads/appends/imports, ETag versioning, version-keyed in-memory read
caching, backups, clearing, selective removal, discovery deduplication, lock
coordination, and deterministic IDs for legacy JSONL rows that lack one.

### `runs-api.mjs`

Owns bounded run reads. `GET /api/runs` validates every query parameter before
event-store I/O, filters terminal Skill runs, preserves stable timestamp/ID
ordering, and returns 20/50/100-row pages plus scoped lifecycle counts.
`GET /api/runs/~:id` returns one terminal run in a bounded 200-event
correlation window, preserving the selected run and reporting total/truncation metadata.

### `command-center.mjs`

Owns the deterministic Command Center aggregate, truth labels, source status,
bounded terminal recent activity, readiness, and prioritized actions. It joins
events, connections, setup preflight, inventory, provider settings, Managed
Evaluations, and Capability state with partial-source handling. Responses expose
seven readiness facts, at most three actions, explicit ratio
numerators/denominators, and at most eight recent runs. Cache entries are keyed
by event-store version, runtime, time window, and a short TTL.

### `agents-api.mjs`

Joins live Agent definitions with Agent lifecycle events into separate,
runtime-aware Definitions and Observed Activity projections. List responses are
fixed at 50 rows; detail responses include a bounded 20-event timeline.

### `skill-scanner.mjs`

Owns runtime home resolution, conventional scan locations, plugin registry
interpretation, bounded recursive traversal, frontmatter extraction, and
definition metadata. It resolves the active Codex plugin cache version, applies
Codex per-Skill disable entries, applies Claude file-setting precedence, and
computes a normalized local content hash without returning definition bodies.

### `conflicts/conflict-service.mjs`

Owns conflict inspection, reviewed action plans, apply, and undo. Mutations use a
process-shared lock, atomically quarantine the exact target before hashing it,
and install regular files without clobbering a concurrently recreated path.
Failed apply or undo keeps recovery paths instead of overwriting editor bytes.

### `runtime-connections.mjs`

Owns effective config inspection, SkillOps handler recognition, hook-script path
validation, and activity enrichment.

### `setup-preflight.mjs`

Owns the read-only installation prerequisite check used by the connection
dialog. `GET /api/setup/preflight` reports the current/minimum Node.js version,
Git availability, loopback API availability, separate data-directory probe
availability and writability, runtime-inspection availability, and sanitized
runtime configuration/reference health. An existing path must be a directory;
a writable regular file fails closed, while a thrown probe remains unavailable
rather than becoming a read-only diagnosis. It does not return paths, hook
commands, raw config, or credentials.

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
  minimized assistant context;
- `suite-schema.mjs` owns strict Suite Schema v1 parsing, including the optional
  per-Suite Gate override.

All external evaluation JSON reaches the shared Evaluation Schema before these
modules. The current GitHub interface and response fields remain compatible.
Prompt Artifacts have a distinct renderer seam and are not represented as
`SKILL.md`. Tasks, prompts, and model responses are not written to disk;
provider credentials may exist in the current request or the explicit local AI
settings file after Save.

Suite Schema v1 accepts an optional `gate` object containing
`minSampleSize`, a positive integer, and/or `minSuiteCaseCoveragePct`, a finite
number from 0 through 100. At least one threshold is required when `gate` is
present; unknown Gate fields and an empty object are rejected.

### `evaluation-agent.mjs`

Owns the optional read-only evaluation loop and its workspace tools. It exposes
only bounded file listing, literal search, and text-file reads; blocks secret,
runtime-data, dependency, build-output, traversal, and symlink paths; and has no
write, process, or network tool. Model rounds and total tool calls are capped.

## 4. HTTP contract

Successful structured responses use `Content-Type: application/json`.
`GET /api/events?download=1` is the explicit JSONL download exception.
Evaluation and assistant POST handlers additionally reject non-loopback Host
headers, cross-site or mismatched browser Origins, and non-JSON content types
before scanning local inventory or contacting a provider.

Primary page-based list routes accept only page sizes 20, 50, or 100 and return
`items`, `page`, `pageSize`, `totalItems`, `totalPages`, `hasPrevious`, and
`hasNext` after deterministic server-side sorting. Cursor-based evaluation
history keeps its existing bounded cursor contract. Every list response also
includes `generatedAt` or an immutable revision/commit.

### `GET /api/events`

Before reading, performs an incremental Codex Desktop sync. The compatibility
form returns a bounded normalized event page, `generatedAt`, `ok`/`partial`
source status, and an ETag derived from the store version. Mode conflicts and
page parameters are validated before a matching `If-None-Match` can return
`304`. Events sort by timestamp descending and ID descending. `summary=1`
returns only count, generated time, latest
non-discovery activity time, and source status. `download=1` streams the full
normalized store as an explicit attachment, reports the same status in
`X-SkillOps-Source-Status`, and never returns unknown persisted fields.

Responses:

- `200`: page envelope, bounded summary object, or normalized JSONL attachment;
- `304`: unchanged compatibility feed;
- `400`: conflicting query modes;
- `500`: read or sync failure.

### `GET /api/command-center`

Validates runtime plus a Today (`1d`), 7d, 14d, or 30d window and returns one
deterministic, bounded aggregate. Today begins at server-local midnight rather
than using a rolling 24-hour boundary. It contains metric definitions and
numerator/denominator provenance, per-source availability, seven readiness
facts, prioritized issues, at most three next actions, and at most eight
terminal recent runs; it never contains the full event array. A source-reader
failure becomes an explicit partial/unavailable fact rather than discarding the
remaining projection. Runtime readiness is unknown unless both event and
connection sources are readable.

### `GET /api/setup/preflight`

Requires a loopback request and returns the sanitized setup prerequisite
projection. Only `GET` is accepted. Probe failures fail closed to unavailable,
unsupported, or not-writable facts without echoing local paths.

### `GET /api/agents`

Validates tab, runtime, time window, query, and page before returning one 50-row
page. `/api/agents/:id` returns one matching projection with at most 20 recent
lifecycle events. Discovery remains definition evidence and cannot create an
Observed Activity item.

### `GET /api/runs`

Validates page, page-size, search, runtime, project, outcome, date, sort, and
reported-cost parameters before syncing or reading events. Returns one terminal
Skill run page; response items never exceed the requested 20, 50, or 100 rows.
Lifecycle metadata contains counts only and follows the runtime/date scope.

Responses:

- `200`: page metadata, scoped lifecycle counts, and validated run items;
- `400`: invalid or unbounded query parameter;
- `405`: unsupported method;
- `500`: read or sync failure.

### `GET /api/runs/~:id`

Returns the exact terminal run plus its correlation scope, ordered by timestamp
and ID. Correlated events must use the same runtime. A run with both session and
turn IDs includes matching-turn events from that session plus session-level
events without a turn ID; same-turn events from other sessions are excluded. A
bounded 200-event window always contains the selected run. The `~` envelope
keeps `.` and `..` IDs from being normalized as URL path segments. The full
event feed is not sent.

Responses:

- `200`: `run`, bounded `events`, `totalEvents`, and `truncated`;
- `400`: invalid encoded run ID;
- `404`: terminal run not found;
- `405`: unsupported method;
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

Accepts bounded `query`, `runtime`, `source`, `provider`, `status`,
`attention`, `page`, and `pageSize` query parameters. The first request creates
an in-memory scan snapshot; later filter and page requests project that
snapshot without rescanning. `refresh=1` performs an explicit rescan and
replaces the cache only after success. The response contains at most the
requested page (maximum 100 definitions), stable page metadata, aggregate
counts, current-page issue/shared-name keys, scan diagnostics, and
`generatedAt`. `GET` is intentionally not supported and returns `405`.

### `GET /api/connections`

Performs Codex Desktop sync, reads effective runtime configuration, and returns
the fixed runtime catalog through the shared page envelope. Runtime rows sort
by runtime ID and the response includes `generatedAt`:

```json
{
  "generatedAt": "2026-07-20T00:00:00.000Z",
  "items": [
    {
      "runtime": "codex",
      "status": "installed",
      "checkedAt": "2026-07-20T00:00:00.000Z",
      "eventCount": 12,
      "lastEventAt": "2026-07-19T23:59:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 50,
  "totalItems": 3,
  "totalPages": 1,
  "hasPrevious": false,
  "hasNext": false
}
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

### `GET/POST /api/evaluations/:id/decision`

Reads or records the one final Decision for a completed Managed Suite run.
Allowed values are `create-candidate`, `keep-baseline`, `reject-candidate`, and
`collect-more-evidence`. The persisted and public Decision has exactly:

```text
decisionId
evaluationRunId
artifactId
candidateRefHash
decision
recordedAt
```

The server derives identity fields from the authoritative run. Repeating the
same Decision is idempotent; submitting another value returns `409`, so a
changed judgment or supplemental evidence requires a new run. The compatibility
path `/api/evaluation-runs/:id/decision` resolves to the same store behavior.

The effective Gate policy takes the stricter, per-threshold maximum of the
current Capability policy and the Suite's optional `gate`. Its canonical hash
is the Gate-policy freshness boundary. The current Suite and dataset hashes are
separate definition freshness boundaries; changing any of the three makes
existing evidence stale. Capability list and detail projections recompute the
current result and expose
`effectiveGateResult`, `effectiveGates`, and `effectivePolicyHash`; callers do
not infer current eligibility from a stored stage or historical Gate result.

`create-candidate` additionally requires a completed, current run whose overall
Gate result passed and whose blocking `sample-size` and
`suite-case-coverage` Gates both passed under that effective policy. The backend
derives Suite case coverage from persisted `casesTotal / eligibleCases`; a
missing eligible count is `not-available` and fails closed.

### Managed Decision to Capability nomination

`POST /api/capabilities` may persist an exact-revision Candidate proposal
without `evaluationRunId`; that proposal cannot enter Ready. When the request
does include an origin claim, the run must be completed Managed Suite evidence
with a final `create-candidate` Decision. Governance derives the Artifact and
baseline from that run and merely verifies any client copies.

Every quality-evidence binding requires that bound run's final
`create-candidate` Decision. The first qualifying binding may claim an unowned
Candidate and atomically reserves that run across immutable
`originEvaluationRunId` and mutable
`latestEvidenceRunId`, reuses a same-target retry, rejects a different target,
and fails closed on conflicting legacy reservations. Later evidence binding may
change `latestEvidenceRunId` but cannot mutate the origin. Runs decided as
`keep-baseline`, `reject-candidate`, or `collect-more-evidence` cannot be bound.
Approval, Canary, Stable, install, rollback, and pending Canary/Stable
forward-release recovery re-read both the origin and latest-evidence Decisions
rather than trusting persisted Capability metadata alone.

Candidate approval is an authenticated action. It requires a valid Bearer token
from `SKILLOPS_GOVERNANCE_PRINCIPALS`; the local OS-account fallback used by
ordinary local governance operations is not accepted for approval. Protected
lock, global governance-audit, and capability-scoped audit reads use the same
authenticated-only resolver. The frontend performs a protected audit read only
after an explicit transient Bearer token is supplied; a rejection remains a
locked/error state rather than an empty audit.

The project skeleton lock is authoritative for Stable history. Promotion places
the former Stable at the head of `previous`; rollback can restore only that
immediate previous entry, not an arbitrary historical Candidate. Rollback
preview and confirmation are bound to the selected Capability/Candidate and
current lock hashes. Switching the rollback Candidate invalidates the prior
preview and confirmation, so the caller must preview and confirm again.

## 5. Event-store invariants

### Append behavior

1. Normalize before any filesystem mutation.
2. Create the data directory lazily.
3. Repair a missing final newline left by a crashed writer.
4. Append exactly one newline-delimited JSON object.

### Read behavior

- Missing event file means an empty array.
- Blank lines are ignored.
- An unterminated malformed final record returns the valid prefix with
  `sourceStatus: partial`.
- A malformed complete record or any malformed non-final record fails with an
  explicit corruption error.
- Reading does not rewrite the source file.

### Explicit migration behavior

Valid legacy rows can be normalized and migrated atomically. If migration must
repair corruption, only a malformed final row is eligible: the caller must
enable backup, the exact original file is copied to a timestamped backup first,
and only that final bad row is discarded. Malformed middle rows and other
non-final corruption fail closed, and the original file remains byte-for-byte
unchanged.

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

- global Agents, Codex, Claude Code, legacy command/Prompt Workflow, Rules,
  custom Agent, and Cursor folders;
- project-local `.agents`, `.codex`, `.claude`, Rules, and custom Agent folders;
- active Codex plugin caches registered under the Codex home (`local` first,
  otherwise the highest valid semantic version; lexical maximum only when no
  valid semantic version exists);
- Claude installed plugin asset folders that apply to the current project.

### Metadata

Each result contains Skill ID, version, runtime, source, path, kind, provider,
enabled state, optional disabled reason, deterministic SHA-256 content hash,
optional description, and optional tags. A Skill hash binds the relative path
and bytes of every regular file in its complete Skill directory; other
definitions remove a UTF-8 BOM and normalize line endings before hashing.
Definition contents do not cross the scan API.

### Traversal safety

- recursion depth is bounded per source;
- canonical paths prevent symlink loops and duplicate paths;
- missing and access-denied conventional locations are treated as absent;
- only `SKILL.md` is accepted as a Skill; Claude command folders accept Markdown files.
- Skill packages reject symlinks and filesystem-colliding paths and are bounded to 500 files / 10 MB;

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
| `SKILLOPS_SKELETON_ROOT` | unset | Explicit managed project root for governed new-file installation |
| `SKILLOPS_GOVERNANCE_PRINCIPALS` | unset | JSON array mapping 32+ character Bearer tokens to server-defined governance principals |
| `SKILLOPS_GOVERNANCE_TOKEN` | unset | Request-scoped Team Template CLI Bearer token; may be replaced by `--governance-token-env <name>` and is never persisted |

CC Switch configuration participates in Claude home resolution as documented in
[runtime adapters](../integrations/runtime_adapters.md).

**Implemented evaluation runtime:** Managed Suites are explicit repository files
under `evals/`. Promptfoo runs in a child process with cache, telemetry, update
checks, sharing, remote generation, and inherited secret environment variables
disabled in a run-scoped temporary config directory. Only sanitized evidence
summaries are stored separately from events and used to generate JSON/HTML
reports. The manager provides bounded FIFO concurrency, idempotency,
cancellation, timeout, child-process cleanup, and interrupted-run recovery.
Capability governance uses atomic lock-protected metadata registries, exact
evidence hashes, independent server-resolved principals, write-ahead audit
records, and compensated install/promotion/deprecation/rollback transactions.
Configured Bearer tokens resolve the required distinct reviewer without
accepting an identity from the browser; approval never falls back to the local
OS principal. New files must use a relative target beneath
`SKILLOPS_SKELETON_ROOT`; existing targets must resolve through the enabled
scan inventory. The installer rejects symlink/non-file targets, creates
exact-byte backups before replacement or removal, and verifies every file
operation with a fresh scan before committing the Capability registry and
project lock. Metadata-only recovery records persist across restarts while
opaque restore references and backup bytes stay outside API responses. The
exact evaluation package surface,
privacy controls, Red Team seam, and upgrade gate are documented in the
[Promptfoo integration contract](../integrations/promptfoo.md).

`app/backend/prompts/` owns the Local Prompt Registry. It reads strict Prompt
definitions from exact commits in a configured Git workspace, returns
metadata-only stable pages, derives semantic and component hashes, resolves
bodies only for backend evaluation, and creates Candidates only after an
explicit request.
It never edits files, changes branches, creates commits, or calls a hosted Prompt
service. The full contract is documented in
[Prompt Registry integration](../integrations/prompt-registry.md).

`app/backend/evaluations/artifact-registry.mjs` derives the Unified Artifact
Registry from live scans, committed Prompt metadata, governance capabilities,
and skeleton locks. The compatibility facade in
`app/backend/skill-evaluations.mjs` owns its HTTP exposure. The Registry owns
metadata Diff and GitHub Candidate preview, while Artifact body resolution stays
with the source adapter. Its opt-in migration accepts only the legacy scan
allowlist, serializes apply with a process-shared lock, verifies pre/post and
read-time snapshot hashes, and restores exact backup bytes.

`app/backend/team-control-plane.mjs` owns the local Team model and keeps its
interface small: state/role mutations, revocable device collection, derived
Artifact catalog and governance queues, policy exceptions, audit, export,
backup, and retention. It reuses the Artifact Registry and governance module
rather than copying lifecycle truth. Mutations run under the governance file
lock, preserve referenced-entity integrity, write state atomically, and append a
hash-chained metadata-only audit record. Collector commits compensate state and
collector bytes if the audit record cannot commit. The HTTP adapter in
`team-control-plane-api.mjs` applies loopback, JSON-size, route-field, principal,
Bearer-token, and stable pagination guards to catalog, queue, and audit reads.
The Team root read returns counts, template-adoption metrics, and the latest
collector time instead of embedding the seven entity arrays. Catalog and queue
pages include `generatedAt` because their Artifact/Governance sources can
change without a Team-state revision. The deployment metadata explicitly
reports local + Git, with network API, SSO, and SCIM disabled.

Explicit retention takes the governance release lock before the Team and
Capability locks, then snapshots Capability origin, latest, quality, and Red
Team run IDs and prunes evaluation evidence in that same critical section.
Concurrent service transactions and cross-process registry writes therefore
cannot leave a retained Capability pointing at deleted provenance.

`app/backend/project-template.mjs` is the governed Team Template boundary. It
accepts only schema-versioned Stable manifests tied to an immutable Git commit,
exact template/evidence hashes, and separate submitter/reviewer approval. Its
small interface previews or applies three initialization modes, reports drift
and pending upgrades, and previews/applies previous-Stable rollback. Existing
content is never overwritten unless it is a byte-identical managed preimage.
Migration and rollback require a clean non-default Git branch. Affected Managed
Suites run before the compensating multi-file transaction, so a gate failure
does not touch the project. The project lock stores references and hashes, not
file bodies. `bin/project-template-cli.mjs` supplies the existing evaluation
runner and rejects command-line provider keys and governance tokens. A Team
Template nomination or approval may resolve an independently configured
principal from an environment-named Bearer token.

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
- Managed Evaluation requests with unknown fields return the fixed public
  message `Evaluation request contains unsupported fields.` Unsupported
  providers return `Unsupported AI provider.` Neither response reflects the
  rejected field name or provider value.
- Managed evidence contains statuses, scores, gates, and identity hashes only;
  provider keys, Artifact bodies, case inputs, raw outputs, and raw errors are
  excluded by schema and store tests.
- Managed Decisions contain only the six documented identity/time fields; no
  rationale, task, prompt, output, or raw provider response is accepted or
  exported.

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
