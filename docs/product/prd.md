# PRD: SkillOps local Skill observability

> Version: v0.3.1
> Status: implemented MVP baseline
> Last reviewed: 2026-07-20

## 1. Product statement

SkillOps is a local-first observability and inventory workspace for Skills used
by Codex and Claude Code. It answers two different questions without confusing
them:

1. **What Skill definitions are available on this machine?**
2. **Which Skills were actually invoked, and what lifecycle evidence exists?**

Cursor appears as a preview runtime only. There is no installable Cursor adapter
in v0.3.1.

## 2. Problem

Skill users commonly have definitions spread across global folders, project
folders, plugin caches, legacy command folders, and runtime-specific config
locations. The runtimes do not expose identical lifecycle signals. This creates
four practical problems:

- inventory counts mix runtimes and installation sources;
- installation is mistaken for real execution;
- lifecycle completion is mistaken for successful task output;
- observability tools risk collecting prompts or source code unnecessarily.

SkillOps provides one normalized local view while preserving those distinctions.

## 3. Target users

### P0: Individual AI coding-tool user

Uses Codex and/or Claude Code, installs many Skills, and needs to know what is
available and whether runtime hooks are working.

### P1: Skill author or maintainer

Needs execution counts, lifecycle duration, runtime distribution, failure
records, version metadata, and a reliable way to inspect one run.

### P2: Local platform or security operator

Needs to verify hook configuration, inventory locations, data minimization,
loopback binding, export, retention, and removal behavior.

## 4. Product goals

### 4.1 Implemented goals

- Scan conventional Codex, Claude Code, Cursor, project, and plugin locations.
- Separate runtime, installation source, provider, definition type, and enabled state.
- Detect duplicates, version conflicts, disabled definitions, and missing metadata.
- Record normalized lifecycle metadata from installed Codex and Claude Code hooks.
- Keep all product telemetry in a local JSONL store by default.
- Show honest outcome coverage: lifecycle-only completions are not successes.
- Allow validated JSON/JSONL import, JSONL export, and recoverable clearing.
- Provide reload-safe dashboard routes and live local refresh.
- Discover public GitHub Skill candidates and rank overlap with enabled local definitions.
- Run an in-memory, blinded, task-specific A/B evaluation in prompt-only or bounded read-only agent mode.
- Provide contextual assistant chat without exposing local Skill paths or Skill-definition contents.

### 4.2 Product quality goals

- A failed telemetry hook must never block the host runtime.
- Unknown event fields must not silently expand the privacy surface.
- Existing unrelated hook configuration must survive install and uninstall.
- Empty local data must render as a real zero state.
- Demo data must be visibly labeled and must never be persisted as local data.

## 5. Non-goals for v0.3.1

- Cloud accounts, team workspaces, synchronization, or remote runtime/event ingestion.
- Persisting raw prompt text, transcripts, tool payloads, source code, model
  output, evaluation tasks, chat messages, or credentials outside the explicit
  Skill Lab AI settings file.
- Proving implicit Skill selection when the runtime exposes no observable signal.
- Declaring task success from a normal lifecycle completion.
- Installing, promoting, or deploying a Skill from Skill Lab.
- Managing or editing `SKILL.md` definitions.
- A production-ready Cursor adapter.

## 6. Core concepts

| Concept | Meaning |
| --- | --- |
| Definition | One Skill or command file at one path for one runtime. |
| Unique Skill | A case-insensitive Skill name within the selected inventory scope. |
| Discovery | Evidence that a definition exists at scan time. |
| Match | Evidence that the runtime signal selected or referenced a Skill. |
| Run | A terminal `skill.completed` or `skill.failed` lifecycle event. |
| Evaluated run | A run whose outcome is known as success or failed. |
| Lifecycle only | A completed run with `outcome: unknown`. |
| Connection | Inspection result for installed hook configuration plus observed activity. |
| Candidate | One public GitHub `SKILL.md` selected for comparison; not installed locally. |
| A/B evaluation | One task run against a local baseline and remote candidate, then blind-judged by the configured model. |

## 7. Primary user journeys

### 7.1 Connect Codex or Claude Code

1. User runs the runtime dry-run command.
2. User reviews the proposed configuration merge.
3. User installs the adapter and restarts the runtime.
4. User reviews/trusts hooks in the runtime when required.
5. SkillOps reports **Installed** only when configured hook script paths exist.
6. User invokes a real Skill and confirms a non-discovery event.

Acceptance:

- unrelated configuration is preserved;
- an existing file receives a timestamped backup before mutation;
- repeat installation is idempotent;
- removal deletes only SkillOps-marked handlers.

### 7.2 Inspect installed definitions

1. User opens Registry.
2. SkillOps performs a live filesystem scan through `POST /api/scan`.
3. User chooses Combined, Codex, Claude Code, or Cursor workspace.
4. User filters by global/project/plugin source, provider, enabled state, search,
   or inventory issue.
5. User reads definition path and status without conflating shared names.

Acceptance:

- runtime totals update with the selected workspace;
- unique Skill totals exclude commands and disabled definitions;
- definition totals include Skill and command files where applicable;
- duplicate/conflict calculations stay within the same runtime and Skill name.

### 7.3 Prove real Skill execution

1. User notes a start time or session ID.
2. User explicitly invokes a Skill in Codex or Claude Code.
3. The runtime adapter emits match/start/terminal lifecycle evidence where the
   runtime signal permits it.
4. User finds the run in Runs or executes the recording-check script.

Acceptance:

- `skill.discovered` alone never produces a run;
- the check can filter by runtime, Skill, session, and start time;
- normal completion remains `unknown` unless an evaluator supplied success.

### 7.4 Inspect and manage local data

1. User views event count and latest runtime activity in Settings.
2. User exports normalized JSONL when needed.
3. User may clear the active store after confirmation.
4. SkillOps creates a timestamped local backup before clearing.

Acceptance:

- export is disabled when the UI is showing demo data;
- imported data is fully validated before any record is appended;
- duplicate event IDs are skipped;
- one invalid imported record rejects the entire batch.

## 8. Surface requirements

### 8.1 Overview — `/`

Implemented:

- runtime and time-range filters;
- run, success-rate, active-Skill, and reported-cost summaries;
- daily run chart, runtime distribution, top Skill table, and recent activity;
- empty-state connection guidance;
- explicit local/demo data mode.

### 8.2 Skills — `/skills`

Implemented:

- terminal run metrics grouped by runtime and Skill name;
- search, expandable definition details, version and latest run metadata;
- lifecycle-only and evaluated outcome distinctions.

### 8.3 Runs — `/runs`

Implemented:

- terminal execution timeline;
- search by Skill, event ID, or project;
- pagination in groups of 20;
- correlated run detail;
- atomic JSON or JSONL import.

### 8.4 Evaluations — `/evaluations`

Implemented as Skill Lab:

- public GitHub candidate discovery with multi-Skill repository selection;
- deterministic comparison against enabled local definitions;
- explicit local baseline selection;
- task and acceptance-criteria input;
- sequential baseline/candidate prompt-only or read-only agent runs plus a final blind judge call;
- candidate SHA-256 pinning between analysis and execution;
- in-memory result/output display and contextual assistant chat;
- nine page-memory providers with editable model/Base URL and compatible reasoning effort;
- no promotion, rollout, installation, definition mutation, or result persistence.

### 8.5 Registry — `/registry`

Implemented:

- live scan and rescan;
- runtime-first workspace separation;
- source and provider categories;
- unique Skill and definition counts;
- health filters for duplicate, conflict, disabled, and missing metadata;
- exact local source paths.

### 8.6 Settings — `/settings`

Implemented:

- connection status and real activity counts;
- installation command guidance;
- JSONL export;
- confirmed clear with local backup;
- local privacy boundary explanation.

## 9. Functional requirements

### FR-1 Event validation

All persisted and imported events cross the shared normalization interface.
Unsupported event names/runtimes and invalid field types are rejected. Unknown
fields are discarded through an explicit allowlist.

### FR-2 Local persistence

The default store is `data/events.jsonl`; `SKILLOPS_DATA_DIR` may relocate it.
Readers tolerate one malformed or partially written line. Writers repair a
missing trailing newline before append.

### FR-3 Discovery deduplication

Discovery identity is runtime + Skill ID + version + source path. A persisted
discovery index and lock prevent repeated scans/processes from appending the
same discovery indefinitely.

### FR-4 Runtime connection truth

Configuration status is based on the effective runtime config and the existence
of referenced hook scripts, not historical events. Activity counts exclude
discovery events.

### FR-5 Local HTTP interface

The app exposes events, import, scanning, and connection inspection only through
the local Node/Vite interface. Production binding defaults to `127.0.0.1`.

### FR-6 Outcome honesty

Success rate is computed only from explicit success and failure outcomes.
Unknown lifecycle completions are shown separately and excluded from the
denominator.

### FR-7 Candidate and baseline safety

Candidate discovery is limited to bounded public GitHub `SKILL.md` content. A
local baseline is accepted only when its exact path appears in the current
enabled live scan; the frontend cannot use the evaluation interface to read an
arbitrary local path.

### FR-8 Local AI evaluation settings

AI credentials and settings are saved only after an explicit Skill Lab Save into
local `data/ai-settings.json` via loopback `GET`/`PUT /api/ai-settings`. They
are never written to browser storage, events, logs, backups, or exports. The
local server may hold a key, task, Skill contents, requested workspace excerpts,
generated output, or chat message for the current request, but must not append
evaluation content to another store. Credentialed endpoints require HTTPS;
keyless Ollama HTTP is restricted to loopback. Evaluation results are
task-specific evidence and never mutate lifecycle-event outcomes automatically.

### FR-9 Evaluation integrity and agent boundary

The backend must re-download the candidate and match its analyzed SHA-256 hash
before executing either variant. Prompt-only mode has no workspace access.
Read-only agent mode exposes only bounded list/read/literal-search tools over
allowed workspace text; it blocks hidden/common secret paths and credential-like
lines, runtime data, dependency and
build output, traversal, symlinks, process/network tools, and writes. The blind
judge winner must agree with its normalized scores.

## 10. Success measures

Product measures should be calculated locally and must not introduce remote
telemetry merely to measure SkillOps itself.

| Measure | Definition | Initial target |
| --- | --- | --- |
| Setup completion | Adapter installed and at least one runtime event observed | User can verify in one session |
| Scan correctness | Definitions grouped by correct runtime/source/provider | No known category mixing |
| Outcome coverage | Evaluated terminal runs / all terminal runs | Reported honestly, no fixed target |
| Hook safety | Host-runtime tasks blocked by telemetry failure | 0 |
| Privacy regressions | Forbidden content persisted by built-in adapters | 0 |
| Test health | Automated tests passing on supported Node version | 100% |

## 11. Risks and mitigations

### Runtime signal gaps

Codex cannot always expose implicit Skill selection. SkillOps labels path-based
inference with confidence and documents that absence of evidence is not proof
of non-use.

### False confidence from lifecycle completion

Normal stop events use `outcome: unknown`; success requires an evaluator or an
explicitly trusted emitter.

### Local API exposure

The production server binds to loopback. Non-loopback deployment requires an
explicit authentication/access-control seam that v0.3.1 does not provide.

### Configuration drift

Runtime updates and CC Switch provider changes may replace effective settings.
Connection inspection reports not-installed, broken, or config error instead
of assuming prior installation is still valid.

### Unbounded event growth

JSONL is appropriate for the current local MVP but has no automatic retention.
Export/clear and backup behavior exist; retention controls and aggregation are
planned.

### External candidate and model providers

Skill Lab intentionally crosses the local boundary only after a user action.
GitHub receives candidate file requests; the configured model endpoint receives
the Skill definitions, task/criteria or chat messages, the in-memory key, and—
only in read-only agent mode—requested allowed workspace excerpts. URL,
HTTPS/loopback, origin, size, count, timeout, hash, and local-path controls limit
SkillOps behavior, but each provider's data policy remains outside SkillOps
control.

## 12. MVP release acceptance

- [x] Local development and production-style start commands work.
- [x] Codex and Claude Code adapters can be previewed, installed, verified, and removed.
- [x] Registry separates runtime, source, provider, type, enabled state, and issues.
- [x] Real lifecycle records are distinct from installed/discovered definitions.
- [x] Unknown lifecycle outcomes do not inflate success rate.
- [x] Import, export, clear, and backup workflows exist.
- [x] Event polling supports ETag/304 responses.
- [x] Local API and SPA routes pass smoke verification.
- [x] Skill Lab compares public candidates with live local definitions.
- [x] Memory-only AI settings, hash-pinned blinded A/B results, bounded read-only agent mode, and contextual chat exist.
- [ ] Cursor native adapter is implemented.
- [ ] Multi-case evaluation confidence, report export, and real version promotion exist.
- [ ] Automatic retention and event-store compaction policy exist.
