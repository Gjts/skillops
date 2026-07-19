# Backend architecture: local event and inventory plane

> Version: v0.3.1
> Status: implemented

## 1. Backend goals

The backend provides a small local interface for:

- normalized append-only event persistence;
- atomic import and recoverable clearing;
- live installed-Skill inventory;
- Codex Desktop incremental ingestion;
- runtime configuration health;
- production SPA serving.

It must remain local-first, tolerate missing runtime directories, and keep
collection failure isolated from the host coding runtime.

## 2. Technology and process model

| Area | Implementation |
| --- | --- |
| Runtime | Node.js 20+ ESM |
| HTTP | Built-in `node:http` production server |
| Development HTTP | Vite middleware with the same routes |
| Persistence | Local JSONL plus small JSON discovery index |
| Filesystem | `node:fs/promises` with atomic temp-file rename for rewrites |
| Validation | Shared allowlist normalizer in `app/shared` |
| Tests | Vitest Node tests and smoke process |

There is no database, account system, remote collector, or background daemon.

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
definition metadata.

### `runtime-connections.mjs`

Owns effective config inspection, SkillOps handler recognition, hook-script path
validation, and activity enrichment.

### `codex-desktop-ingest.mjs`

Owns incremental parsing of recent Codex Desktop session records and conservative
Skill path detection from actual file-read commands.

## 4. HTTP contract

All successful JSON responses use `Content-Type: application/json`.

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
- Codex plugin caches registered under the Codex home;
- Claude installed plugin Skill and command folders that apply to the current project.

### Metadata

Each result contains Skill ID, version, runtime, source, path, kind, provider,
enabled state, optional description, and optional tags.

### Traversal safety

- recursion depth is bounded per source;
- canonical paths prevent symlink loops and duplicate paths;
- missing and access-denied conventional locations are treated as absent;
- only `SKILL.md` is accepted as a Skill; Claude command folders accept Markdown files.

### Plugin enablement

Codex plugin state is read from `config.toml`. Claude plugin installations are
read from `installed_plugins.json`, while effective user/project settings
determine enabled state.

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

## 11. Error and privacy behavior

- HTTP errors return JSON messages for local diagnosis.
- Adapter-level errors are written locally and swallowed by the host hook.
- Unknown event fields are discarded.
- Production static-file resolution rejects paths escaping `dist/`.
- The server is unauthenticated; non-loopback binding is an explicit operator risk.
- Raw source/transcript/tool data is not part of the backend event interface.

## 12. Backend verification checklist

- [ ] Event normalization tests pass.
- [ ] Import atomicity and ID deduplication tests pass.
- [ ] Concurrent discovery appends remain unique.
- [ ] Scanner fixtures cover global/project/plugin/disabled/command cases.
- [ ] Connection tests cover installed, absent, broken, and config-error states.
- [ ] Codex Desktop parser tests reject false-positive path mentions.
- [ ] `npm run smoke` covers HTTP privacy, API, SPA routing, and loopback behavior.
