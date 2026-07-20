# Task ledger: SkillOps

> Baseline: v0.3.1
> Status notation: `[x]` verified implemented, `[ ]` planned/not complete

This ledger mirrors the RoleGarden milestone style but records SkillOps reality.
A checked item means the current repository contains the behavior; it does not
mean every future refinement is complete.

## 1. Priority definitions

- **P0**: privacy, data integrity, evidence truth, or core runtime breakage.
- **P1**: required for reliable daily local use.
- **P2**: valuable product expansion after the evidence loop is stable.

## 2. Milestone 0: Runnable local foundation

Priority: P0
Status: implemented

- [x] Root npm package and lock file.
- [x] React/TypeScript/Vite frontend.
- [x] Node loopback production server.
- [x] Reload-safe SPA routes.
- [x] Production build output under `dist/`.
- [x] Local runtime/build/data files ignored by Git.
- [x] Root AGENTS/CLAUDE project guidance.
- [x] Product/development documentation tree.

Acceptance:

- [x] `npm run dev` serves the local app.
- [x] `npm run build` creates production assets.
- [x] `npm start` serves the production build on loopback.
- [x] `npm run smoke` validates SPA, API, privacy, and host behavior.

## 3. Milestone 1: Event model and persistence

Priority: P0
Status: implemented

- [x] Skill and runtime lifecycle event enum.
- [x] Runtime/outcome/source/kind/detection enums.
- [x] Explicit field allowlist and type validation.
- [x] Outcome contradiction protection.
- [x] JSONL append/read with partial-line tolerance.
- [x] ETag event versioning.
- [x] Atomic batch validation and ID deduplication.
- [x] Discovery index, in-process queue, and cross-process lock.
- [x] Backup-first clear and selective cleanup helpers.

Acceptance:

- [x] Unknown fields do not persist.
- [x] Invalid imports append nothing.
- [x] Repeated discovery scans do not grow duplicate records.
- [x] Unknown completions remain outside the success denominator.

## 4. Milestone 2: Codex observation

Priority: P0
Status: implemented with documented signal limitation

- [x] User and trusted-project installer scopes.
- [x] Dry-run, backup, idempotent merge, and marker-only uninstall.
- [x] Session, prompt-length, tool, subagent, and turn hooks.
- [x] Exact explicit `$skill-name` detection.
- [x] Conservative Skill path inference.
- [x] Non-blocking hook errors and local diagnostics.
- [x] Codex Desktop incremental session ingestion.
- [x] Stable derived IDs and semantic deduplication.
- [x] False-positive protection for arbitrary path mentions.

Acceptance:

- [x] Installed config points to an existing hook file.
- [x] Normal Stop produces unknown, not success.
- [x] One real explicit/path-observed use can be found as non-discovery evidence.
- [ ] Implicit use without observable runtime signal can be proven (not currently possible).

## 5. Milestone 3: Claude Code observation

Priority: P0
Status: implemented

- [x] User, shared-project, and project-local installer scopes.
- [x] Effective config resolution through explicit home/env/CC Switch/default.
- [x] Secret-redacted dry-run.
- [x] Session, prompt-length, tool, subagent, turn, and failure hooks.
- [x] Exact slash-command expansion detection.
- [x] Exact Skill tool detection.
- [x] Conservative Skill path inference.
- [x] Global/project legacy command scanning.
- [x] Installed plugin Skill/command scanning with scope and enabled state.
- [x] CC Switch synchronized Skill path compatibility.

Acceptance:

- [x] Installer preserves unrelated settings and is idempotent.
- [x] Normal Stop remains unknown; StopFailure is failed.
- [x] Effective provider/config changes are reflected in connection status.
- [x] One real slash/Skill-tool use can be found as non-discovery evidence.

## 6. Milestone 4: Live Registry

Priority: P1
Status: implemented

- [x] Live POST scan endpoint.
- [x] Global/project/plugin source discovery.
- [x] Codex, Claude Code, and Cursor inventory locations.
- [x] Skill versus legacy command kind.
- [x] Provider and enabled-state metadata.
- [x] Runtime-first workspace selection.
- [x] Unique enabled Skill versus enabled definition counts.
- [x] Global/project/plugin and provider categories.
- [x] Search and status filters.
- [x] Duplicate, version conflict, disabled, and missing metadata filters.
- [x] Last-successful/discovery fallback when scan fails.

Acceptance:

- [x] Combined view groups rows by runtime.
- [x] Same-name cross-runtime Skills are not collapsed into one definition.
- [x] Duplicate/conflict health is calculated within one runtime/name.

## 7. Milestone 5: Execution dashboard

Priority: P1
Status: implemented

- [x] Overview KPI, daily run, runtime distribution, Skill table, activity rail.
- [x] Runtime and time-range filters.
- [x] Skills page grouped by runtime + Skill.
- [x] Runs search, pagination, and detail correlation.
- [x] Session/prompt/tool/subagent lifecycle counters.
- [x] Local zero state and API-unavailable demo state.
- [x] Three-second event polling with ETag/304.
- [x] Five-second connection polling.
- [x] Lifecycle-only and outcome-coverage UI.

Acceptance:

- [x] Discovery events never appear as terminal runs.
- [x] Unknown completions do not inflate success.
- [x] Demo data is labeled and cannot be exported/cleared as local data.

## 8. Milestone 6: Local data operations

Priority: P1
Status: implemented baseline

- [x] JSON array and JSONL browser parsing.
- [x] Client and server validation.
- [x] Atomic persistent import.
- [x] JSONL export.
- [x] Confirmed clear with timestamped backup.
- [x] Configurable data directory.
- [x] Real recording verification script.
- [ ] UI retention window and backup management.
- [ ] Event-store size/health warning.
- [ ] User-facing compaction/recovery command.

## 9. Milestone 7: Testing and documentation

Priority: P1
Status: implemented baseline

- [x] Backend event-store/scanner/connection/desktop-ingest tests.
- [x] Codex and Claude adapter tests.
- [x] Frontend analytics/chart/modal/registry/run/app tests.
- [x] Production smoke test.
- [x] Product PRD and user guide.
- [x] System, backend, frontend, event, adapter, operation, and security docs.
- [x] Roadmap and task ledger.
- [ ] Automated Markdown link checker in CI.
- [ ] Cross-platform CI matrix.
- [ ] Release/version documentation automation.

## 10. Milestone 8: Real evaluation runner

Priority: P2
Status: in progress; one-off session evaluation is implemented

- [x] Define bounded one-task session evaluation input/result schema.
- [x] Add evaluator service distinct from lifecycle hooks and event persistence.
- [x] Discover public GitHub candidates and compare them with live local definitions.
- [x] Run current/candidate variants sequentially for constrained providers and blind the judge order.
- [x] Keep credentials, tasks, answers, and chat out of persistent storage.
- [ ] Store acceptance-test evidence references without task content leakage.
- [x] Compare current/candidate versions using real task-specific scores.
- [x] Offer explicit prompt-only and bounded read-only workspace agent modes.
- [x] Pin analyzed candidate content by SHA-256 before execution.
- [ ] Show sample size and outcome coverage.
- [ ] Export a read-only comparison report.
- [x] Replace the hard-coded sample with the live Skill Lab workspace.

Acceptance:

- [x] Every displayed score is traceable to the in-session judge response.
- [x] Unknown lifecycle completions cannot enter Skill Lab scores.
- [x] No install/promotion action is enabled in this milestone.

## 11. Milestone 9: Safe Skill actions

Priority: P2
Status: planned after Milestone 8

- [ ] Preview exact source, target, version, and conflicts.
- [ ] Create backup and rollback plan.
- [ ] Require explicit confirmation.
- [ ] Apply one exact local change.
- [ ] Rescan and verify runtime configuration afterward.
- [ ] Surface rollback result.

Acceptance:

- [ ] Unrelated definitions/configuration are unchanged.
- [ ] Failed action is recoverable.
- [ ] Comparison UI cannot mutate without explicit action workflow.

## 12. Milestone 10: Cursor adapter

Priority: P2
Status: planned only when stable runtime signals exist

- [ ] Document native hook signal contract.
- [ ] Implement dry-run/install/uninstall.
- [ ] Map exact/heuristic detection with confidence.
- [ ] Minimize and normalize payloads.
- [ ] Add connection truth inspection.
- [ ] Add adapter tests and one real-user execution test.

Acceptance:

- [ ] Cursor moves from Preview to Installed only with real config and activity evidence.

## 13. Release gate for future versions

- [ ] P0 defects are resolved or release is stopped.
- [ ] Full tests, build, and smoke pass freshly.
- [ ] Relevant real-runtime scenario passes for adapter changes.
- [ ] Privacy allowlist and documentation are synchronized.
- [ ] Roadmap items are not presented as implemented product behavior.
- [ ] Git status contains no accidental runtime data, secrets, or build output.
