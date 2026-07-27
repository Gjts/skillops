# Task ledger: SkillOps

> Baseline: v0.3.1
> Base candidate commit: `v0.3.2-rc.1@0b703c6dcbbc6841a70c3a290ffae928abda85b8`
> Status notation: `[x]` implemented or recorded, `[ ]` open; validation gates
> are tracked separately from implementation

This ledger mirrors the RoleGarden milestone style but records SkillOps reality.
A checked item means the current repository contains the behavior; it does not
mean every future refinement is complete.

Implementation verification snapshot (2026-07-22):

- the implementation working tree started from
  `main@8e7de18ba2f9efbc67ec1a1aabfc2989690d4537`;
- Node `v24.18.0`, npm `11.5.2`;
- the pre-change baseline passed 181 tests, build, and production smoke;
- the current expanded suite passes 492 tests on Linux and 491 tests with one
  platform-specific skip on Windows;
- build, deterministic production Promptfoo smoke, CLI evidence verification,
  and governed rollback requalification pass;
- the Local Prompt Registry passes real temporary-Git branch/version tests and
  the production governance/rollback smoke without an external account;
- real Codex and Claude Code invocations produced non-discovery Skill lifecycle
  evidence through their installed adapters.

## Current v0.3.2-rc.1 audit correction

The authoritative product contract, work ledger, and release evidence are
[the repository PRD](../../product/prd.md), this file, and
[the versioned RC evidence record](../operations/rc-evidence/v0.3.2-rc.1.md).
Working copies outside the repository are audit inputs, not a release source of
truth.

The P0 personal loop ends at **Connect -> Verify -> Observe -> Benchmark ->
Evidence-backed Candidate Decision**. Governed Canary or Stable publishing is
conditional on approval from a reviewer principal distinct from the owner
principal; a single-principal flow stops at Candidate/Ready for review.

Current evidence state:

- The latest audit-corrected local rerun passed 78 test files with 765 tests
  passed and one Windows platform-specific skip, plus build, production smoke,
  docs, artifacts, critical audit, and both adapter dry-runs.
- [x] `VAL-001` Candidate commit
  `0b703c6dcbbc6841a70c3a290ffae928abda85b8` passed the
  [four-job GitHub Actions matrix](https://github.com/Gjts/skillops/actions/runs/30145860716):
  Windows, Ubuntu, and macOS on Node 22.22, plus Ubuntu on Node 24.
- [ ] `VAL-002` The audit-corrected working tree passed the deterministic
  100k/5k endpoint and 30-minute memory fixture plus local browser-network,
  UI-timing, responsive, accessibility-tree, and current axe-core checks on
  2026-07-25/26. The final endpoint rerun p95 was 16.21/94.80 ms for Command
  Center/Runs;
  foreground 1366-by-768 UI p95 was 114.70 ms, with 0/50 samples above the
  500 ms release ceiling and 1/50 above 120 ms. The isolated GP-03 UI path took
  3.337 seconds and exposed none of its injected prompt/output/raw-error
  sentinels; automated privacy contracts cover task/source and all forbidden
  classes. The recorded 14-core/34-GB/NVMe host meets or exceeds the specified
  4-core/16-GB/SSD reference environment.
  Project-scoped Codex CLI `0.145.0` and Claude Code `2.1.218` runs both
  produced qualifying post-boundary lifecycle evidence. The Claude turn still
  failed at a pre-inference account gate, so its lifecycle outcome remains
  `unknown` and is not counted as product success. An isolated
  Broken-to-Repair path passed in 48.321 seconds. All isolated fixtures created
  by the current checks were moved to the recycle bin. Bind the reruns to an
  immutable candidate.
- [ ] `VAL-003` Record the five-person first-value and decision-loop sample.
- [ ] `VAL-004` Record independent end-to-end keyboard-only sign-off.
- [ ] `VAL-005` Record an independent P0 Blocker / P1 Critical defect review.
- [x] `VAL-006` Resolve the dependency advisory with a compatible scoped
  override and record a zero-vulnerability audit.
- [ ] `VAL-007` Complete the RC packet fields: independent executor/reviewer,
  remaining per-Golden-Path result/duration, linked issues, and
  cleanup/rollback. Exact local Runtime versions and the timed GP-03 result are
  now recorded.

The implementation audit found and closed these P0 contract-reconciliation
tasks in the current working tree:

- [x] `AUD-001` GP-02 discovery-only/post-install state is
  `awaiting-verification` across projection, UI copy, and tests.
- [x] `AUD-002` `/api/setup/preflight` is a metadata-only product contract with
  backend, UI, privacy, writable-file rejection, unavailable-vs-read-only
  tri-state, failure locking, and explicit dry-run review confirmation before
  Install is revealed. Rechecking installation refreshes both connection and
  preflight facts after repair.
- [x] `AUD-003` Command Center exposes known-outcome and reported-cost
  numerators/denominators, server-local calendar Today, partial-source unknown
  truth, unavailable event metric/recent-run states, six-language explanation
  mapping, and persistent consistent Demo truth.
- [x] `AUD-004` Readiness uses the fixed recent-evidence boundary independently
  from the Agents 7/14/30-day display filter.
- [x] `AUD-005` Vite and production reuse the same local data and Agents API
  handlers, including event summary and direct download behavior.
- [x] `AUD-006` Canonical routes are documented and tested; `/team` replaces
  itself with `/settings?section=advanced-team`.
- [x] `AUD-007` A completed Managed Suite run has one immutable six-field final
  Decision and can originate at most one Release Candidate; same-value retries
  reuse the record, changed judgment requires a new run, and Team retention
  preserves every origin/latest/quality/Red Team run referenced by a Capability.
  The reference snapshot and evaluation prune share the governance release
  transaction and Capability registry locks, so concurrent evidence rebinding
  or cross-process registry writes cannot create a dangling run reference.
- [x] `AUD-008` The Chinese README now matches the current IA, Limited Preview
  boundary, setup preflight, and evidence-backed Candidate decision.
- [x] `AUD-009` Protected lock, global audit, and capability-scoped audit reads
  require a configured Bearer principal and never use the OS fallback; the
  Candidate audit UI requires an explicit transient token and distinguishes
  rejection from a valid empty audit.
- [x] `AUD-010` Event, evaluation, governance, Team, and conflict JSONL stores
  distinguish a genuinely truncated final object from complete syntax or
  semantic corruption. Ordinary writes, clear, conflict apply, and retention
  fail closed before destructive mutation; the explicit event recovery command
  remains backup-first. Event/index recovery preserves concurrent appends under
  one lock order.
- [x] `AUD-011` Runs, Agent definitions, Scan, and Artifact Registry responses
  use server-side filtering and bounded pages. Browser evidence records the
  returned row counts without loading the complete event source.
- [x] `AUD-012` The eight canonical routes and seven legacy mappings pass
  direct-load/refresh checks at narrow and desktop widths. Axe-core `4.10.3`
  found one shared Command Center contrast root cause; the existing
  higher-contrast `accent-hover` token fixes it, and all eight routes now pass
  at four viewports with zero violations.
- [x] `AUD-013` Every production list read now has bounded page/cursor
  semantics, deterministic ordering, and `generatedAt` or revision metadata.
  Managed History consumes its cursor; Capability recovery is run-filtered;
  release deep links and previous Stable references resolve outside the current
  page; Team root returns counts instead of seven full entity arrays; Prompt
  warnings remain count-only. Prompt branch pages are navigable, Managed History
  serializes page requests, and invalid event queries are rejected before ETag
  handling.
- [x] `AUD-014` An unevaluated Candidate proposal cannot enter Ready or any
  release path. Every bound quality run requires its own final
  `create-candidate` Decision; the first claims immutable origin and later runs
  only refresh latest evidence. Approval, Canary, Stable, install, rollback,
  legacy reapproval, and pending Canary/Stable forward-release recovery
  revalidate both Decisions instead of trusting persisted Capability metadata. The Registry
  rejects duplicate Capability IDs, mismatched latest/evidence bindings, and
  duplicate evaluation-run reservations in both v1 and v2 data.

General RC promotion remains **no-ship** until the open validation gates are
closed. Green implementation tests are necessary but do not close missing,
human, real-runtime, or unbound evidence.

In the historical checklist below, `current/candidate` means evaluation
baseline/challenger. A governed `Candidate` is a persisted proposal; it becomes
a `Release Candidate` only after a final `create-candidate` Decision claims its
immutable origin.

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
- [x] Backup-first clear and selective cleanup helpers that reject a partial
  live tail before creating or applying a mutation.

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
- [x] Non-blocking hook errors and atomic fixed local diagnostics that redact
  an existing entry without following symlink or hardlink targets.
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
- [x] Duplicate definition, definition conflict, disabled, and missing metadata filters.
- [x] Last-successful/discovery fallback when scan fails.
- [x] Stable server filtering and bounded pagination for definition and Artifact lists.

Acceptance:

- [x] Combined view groups rows by runtime.
- [x] Same-name cross-runtime Skills are not collapsed into one definition.
- [x] Duplicate/conflict health is calculated within one runtime/name.
- [x] Browser list responses contain only the requested page and page-scoped detail metadata.

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
- [x] Automated Markdown link checker in CI.
- [x] Cross-platform CI matrix.
- [ ] Release/version documentation automation.

## 10. Milestone 8: Real evaluation runner

Priority: P2
Status: implemented; Quick Compare and Managed Suites coexist

- [x] Define bounded one-task session evaluation input/result schema.
- [x] Add evaluator service distinct from lifecycle hooks and event persistence.
- [x] Discover public GitHub candidates and compare them with live local definitions.
- [x] Run current/candidate variants sequentially for constrained providers and blind the judge order.
- [x] Keep tasks, answers, and chat out of persistent storage; allow only explicit AI settings file persistence for provider credentials.
- [x] Store acceptance-test evidence references without task content leakage.
- [x] Compare current/candidate versions using real task-specific scores.
- [x] Offer explicit prompt-only and bounded read-only workspace agent modes.
- [x] Pin analyzed candidate content by SHA-256 before execution.
- [x] Show sample size and outcome coverage.
- [x] Export deterministic sanitized JSON, JUnit, and inert HTML reports through the CLI and API.
- [x] Replace the hard-coded sample with the live Skill Lab workspace.
- [x] Split the evaluation implementation behind the legacy facade.
- [x] Add the shared Evaluation Schema and reject invalid nested request data.
- [x] Adapt Skill definitions to the shared Artifact contract.
- [x] Normalize UTF-8 Artifact line endings before SHA-256 hashing.
- [x] Route GitHub Candidate discovery through an adapter interface and reserve
  a distinct Prompt renderer.
- [x] Document Quick Compare, Managed Suite, Promptfoo, Evidence, and Prompt Registry
  privacy boundaries.
- [x] Integrate the pinned Promptfoo Node package in a secret-filtered child
  process with bounded timeout, cancellation, and orphan cleanup.
- [x] Add asynchronous Managed Suite runs and sanitized evidence history.
- [x] Apply bounded Suite-defined task, scalar-input, and provider-output
  redaction, with output sanitized before assertions.

Acceptance:

- [x] Every displayed score is traceable to the in-session judge response.
- [x] Unknown lifecycle completions cannot enter Skill Lab scores.
- [x] Quick Compare itself has no install/promotion action; governance is a
  separate explicit workflow.
- [x] Existing Quick Compare HTTP/UI fields remain compatible after modularization.

## 11. Milestone 9: Safe Skill actions

Priority: P2
Status: implemented for governed Skill skeletons and Prompt reference locks

- [x] Preview exact source, target, version, and conflicts.
- [x] Create backup and rollback plan.
- [x] Require explicit confirmation, including a second stable action.
- [x] Apply one exact local change or reference-only Prompt lock.
- [x] Rescan and verify the installed Skill skeleton afterward.
- [x] Surface rollback result.

Acceptance:

- [x] Unrelated definitions/configuration are unchanged.
- [x] Failed action is recoverable.
- [x] Comparison UI cannot mutate without explicit action workflow.

### Local Prompt Registry source

Status: implemented without a hosted Prompt-management dependency

- [x] Read strict `prompts/*.prompt.json` definitions from user-controlled Git.
- [x] Keep Prompt bodies in Git/backend memory and out of list, evidence, and
  governance persistence.
- [x] Pin exact commits, repository paths, semantic SHA-256, and component hashes.
- [x] Ignore uncommitted working-tree drift and recheck immutable references
  before evaluation or promotion.
- [x] Browse local branches, filter metadata, and compare component hashes.
- [x] Run Prompt Candidates through Promptfoo, Gate, Approval, Canary, Stable,
  local reference lock, supersede, and rollback.
- [x] Require explicit Candidate nomination and never mutate Git branches,
  commits, Prompt files, or Stable automatically.
- [x] Verify real temporary-Git contracts, metadata privacy, production HTTP
  behavior, and rollback while the source repository is unavailable.

## 12. Milestone 10: Unified Artifact Registry

Priority: P0
Status: implemented

- [x] `REG-001` Define unified Artifact and ArtifactVersion schemas for Skill,
  Prompt, Workflow, Rules, and Agent assets.
- [x] `REG-002` Use kind-scoped Artifact IDs and commit-plus-content-hash
  immutable version IDs.
- [x] `REG-003` Map live scans, commit-pinned GitHub Candidates, committed local
  Prompt records, governance capabilities, and project locks into one view.
- [x] `REG-004` Represent Draft, Candidate, Ready, Canary, Stable, Deprecated,
  and Blocked lifecycle states.
- [x] `REG-005` Store and expose version metadata, dependencies, runtime
  targets, and repository identity without Artifact bodies.
- [x] `REG-006` Publish an explicit Runtime compatibility matrix.
- [x] `REG-007` Track desired versus observed installation state and drift.
- [x] `REG-008` Provide metadata-only immutable version Diff.
- [x] `REG-009` Preview GitHub imports as Candidate without changing Stable.
- [x] `REG-010` Expose reusable local APIs and a filterable Registry UI.
- [x] Provide an opt-in preview/apply/rollback migration with a strict legacy
  metadata allowlist, process-shared locking, pre/post hashes, atomic write, and
  exact-byte backup restoration.

Acceptance:

- [x] Five Artifact kinds have one shared schema and remain kind-distinct.
- [x] GitHub-backed versions are pinned to an exact commit plus content hash.
- [x] Artifact bodies do not enter Registry responses, migration snapshots, or
  version Diff.
- [x] Legacy metadata migration is not automatic and is safely reversible.
- [x] Canonical GitHub source references retain an encoded candidate path and
  round-trip through the resolver at the recorded content hash.
- [x] Unknown legacy migration preimages are rejected without overwrite.

## 13. Milestone 11: Policy, approval, and release governance

Priority: P0
Status: implemented for the local-first governance control plane

- [x] `GOV-001` Define and validate a versioned Policy-as-Code schema.
- [x] `GOV-002` Gate quality, cost, latency, privacy, and runtime
  compatibility.
- [x] `GOV-003` Resolve principals on the server and prohibit owner
  self-approval.
- [x] `GOV-004` Bind approval to the exact Artifact version and combined
  Evidence Hash; invalidate it when either changes.
- [x] `GOV-005` Require a separate canonical Canary project root, rescan only
  that root, and lock its identity and observed hash before Stable preview.
- [x] `GOV-006` Pin target-specific Canary and Stable deployments in
  `project-skeleton.lock.json`.
- [x] `GOV-007` Preview install, upgrade, removal, and rollback plans with
  target, hashes, Diff, backup, and recovery details.
- [x] `GOV-008` Rescan after file writes/removals before committing release
  metadata.
- [x] `GOV-009` Restore the previous immutable Stable or the just-deprecated
  version through one explicit rollback workflow.
- [x] `GOV-010` Persist metadata-only write-ahead and completion records in an
  append-only audit log.

Acceptance:

- [x] Canary and Stable reject missing, stale, forged, or policy-incompatible
  Managed Suite evidence.
- [x] Artifact/evidence changes clear old approvals.
- [x] Failed file or metadata operations compensate the file, registry, and
  lock without replacing the prior Stable.
- [x] Every transition records principal, exact Artifact identity, evidence
  hash, source/target stage, outcome, and time without Artifact bodies.

## 14. Milestone 12: PromptHub v1 connector

Priority: P1
Status: optional pull-only integration; write synchronization is outside the current product scope

- [x] `PHB-001` Pin PromptHub v1 HTTPS endpoints and Bearer authorization.
- [x] `PHB-002` Map remote Prompt metadata to kind-scoped SkillOps Artifacts.
- [x] `PHB-003` Require an exact component-matched, committed Git Prompt and
  import only that immutable version as a governed Candidate.
- [x] `PHB-004` Preview remote version, hashes, source, and metadata/content Diff.
- [x] `PHB-005` Block local/remote bidirectional conflicts.
- **Deferred — `PHB-006`:** push-only and manual bidirectional synchronization
  are not required by the current product decision. The optional connector remains pull-only because PromptHub's published v1 contract has no write endpoint.
- [x] `PHB-007` Store credentials only in the operating-system credential store.
- [x] `PHB-008` Preserve local Stable when remote content disappears or fails.
- [x] `PHB-009` Persist metadata-only remote ID/version/sync audit records.
- [x] `PHB-010` Verify the contract with a local Mock Server and no live account.

Acceptance:

- [x] PromptHub is not required for local evaluation, Stable, or rollback.
- [x] Bidirectional conflicts never auto-overwrite.
- [x] Imports still require local evaluation and approval.
- [x] Remote deletion never removes local Stable.
- [x] A PromptHub preview cannot enter governance until its exact semantics are
  committed to Git and re-resolved at the immutable commit.

## 15. Milestone 13: Local Team control plane

Priority: P1
Status: implemented as local + Git; hosted multi-user deployment is deferred

- [x] `TEAM-001` Model Team, Workspace, Project, Environment, Member, and Device.
- [x] `TEAM-002` Enforce Owner, Maintainer, Reviewer, Developer, and Viewer.
- [x] `TEAM-003` Accept only allowlisted runtime metadata and evidence summaries.
- [x] `TEAM-004` Register/revoke one-time, hashed, `collector:write` device tokens.
- [x] `TEAM-005` Derive a Team Artifact directory from Registry/governance facts.
- [x] `TEAM-006` Expose Approval Inbox and Release Queue.
- [x] `TEAM-007` Store Policy Packs and independently reviewed project exceptions.
- [x] `TEAM-008` Hash-chain metadata-only audit events and sanitized export.
- [x] `TEAM-009` Provide explicit retention, dependency-safe deletion, backup,
  and export.
- [x] `TEAM-010` Keep SSO/SCIM disabled until a real enterprise customer and
  network deployment require them.

Acceptance:

- [x] Local workflows remain available without a network service.
- [x] Revoked Device tokens cannot upload another batch.
- [x] Collector persistence excludes prompts, paths, project names, and errors.
- [x] Team backup/export omits token hashes and collector records.

## 16. Milestone 14: Governed Team project templates

Priority: P1
Status: implemented as Git-reviewed local project initialization and upgrade

- [x] `TPL-001` Validate a schema-versioned Team Template Manifest.
- [x] `TPL-002` Preview exact initialization paths, actions, hashes, conflicts,
  affected Suites, and review state.
- [x] `TPL-003` Support greenfield, adopt-existing, and migration modes.
- [x] `TPL-004` Reject divergent existing and drifted managed files.
- [x] `TPL-005` Write a metadata-only version/source/evidence/approval lock.
- [x] `TPL-006` Require upgrade/rollback on a clean non-default Git review branch
  and leave an uncommitted Diff.
- [x] `TPL-007` Run every affected Managed Suite before mutation.
- [x] `TPL-008` Preserve the prior Stable when release or project gates fail.
- [x] `TPL-009` Report per-project current/drift/pending status and aggregate Team
  adoption, drift, and pending-upgrade counts.
- [x] `TPL-010` Restore the complete previous managed template state from its
  exact Git commit.

Acceptance:

- [x] Greenfield generation produces a reviewable metadata/path Diff.
- [x] Existing-project adoption never overwrites divergent rules.
- [x] Locks retain exact asset version, source, evidence, and approval metadata.
- [x] Upgrade failure leaves the previous Stable bytes and lock unchanged.
- [x] Rollback touches only managed paths and restores the previous lock.

## 17. Architecture decisions

- [x] `ADR-001` Assign Artifact bodies to Git, derived state/evidence to
  SkillOps, and remote identity/availability to PromptHub.
- [x] `ADR-002` Isolate Promptfoo and permit model egress only through the
  selected provider bridge.
- [x] `ADR-003` Keep Artifact/evaluation bodies out of metadata stores and
  persist only explicit allowlists.
- [x] `ADR-004` Define measured JSON/JSONL-to-SQLite/Postgres migration triggers.
- [x] `ADR-005` Select local + Git for v1.0 and gate self-hosted/SaaS on demand
  plus a new security architecture.
- [x] `ADR-006` Bind five-role authorization and independent approval to
  server-resolved principals.
- [x] `ADR-007` Define Observed, Git-pinned, Governed, and future signed-bundle
  trust levels.
- [x] `ADR-008` Block PromptHub bidirectional conflicts and preserve offline
  Stable/rollback state.

The accepted rationale and replacement triggers are in
[Architecture decisions](../architecture/decisions.md).

## 18. Milestone 15: Cursor adapter

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

## 19. Sprint 1: Trustworthy scanning and offline quality gate

Priority: P0
Status: implementation snapshot delivered in v0.3.2-rc.1; audit corrections
captured in the audit-corrected candidate, while external validation gates
above remain open

- [x] `S1-01` Resolve project roots with cross-platform tests.
- [x] `S1-02` Report source, scope, origin config, and diagnostics for scan roots.
- [x] `S1-03` Inspect Codex administrator paths without requesting elevation.
- [x] `S1-04` Report Claude external-policy visibility limits.
- [x] `S1-05` Apply the no-egress guard to the complete test process.
- [x] `S1-06` Keep Promptfoo execution behind an injectable Engine seam.
- [x] `S1-07` Configure Node 22 on Windows, macOS, and Linux plus Node 24 on Linux.
- [x] `S1-08` Synchronize Scanner, Registry, Testing, and Privacy documentation.
- [x] `S1-09` Verify real Codex and Claude Code non-discovery lifecycle events.
- [x] `S1-10` Produce the v0.3.2-rc.1 release candidate.

Acceptance:

- [x] 492 tests pass on Linux; 491 tests pass with one platform-specific skip on Windows.
- [x] Build, production smoke, build-artifact privacy, and documentation checks pass.
- [x] Scanner fixtures explain inaccessible paths without changing permissions.
- [x] Product documentation distinguishes implemented local behavior from deferred
  network, signing, Cursor, and hosted-team work.

## 20. Release gate for this and future versions

- [ ] P0 defects are resolved or release is stopped.
- [ ] Full tests, build, smoke, and the supported OS/Node matrix pass on the
  immutable candidate.
- [ ] Performance, browser, accessibility, and real-runtime evidence is bound
  to that same candidate or has a recorded equivalence attestation.
- [ ] Relevant real-runtime scenario passes for adapter changes.
- [ ] Privacy allowlist and documentation are synchronized.
- [ ] Roadmap items are not presented as implemented product behavior.
- [ ] The RC evidence record names the executor, exact environments, per-Golden-
  Path result/duration, linked issues, and cleanup/rollback status.
- [ ] Required distinct-principal and manual review gates are recorded.
- [ ] Git status contains no accidental runtime data, secrets, or build output.
