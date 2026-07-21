# Roadmap: SkillOps

> Version: v0.3.1 baseline
> Status: evidence-driven roadmap; dates intentionally uncommitted

## 1. Roadmap principle

SkillOps should deepen the evidence loop before adding breadth:

```text
Find definitions
  → connect runtime safely
  → observe real lifecycle
  → distinguish evaluated outcomes
  → compare versions
  → act only with explicit user control
```

Inventory breadth is not useful if execution truth, privacy, and outcome
semantics are weak.

## 2. Current implemented scope

- Single-package local React/Vite/Node application.
- Loopback local HTTP interface and JSONL store.
- Shared allowlisted event schema.
- Codex hook adapter plus conservative Codex Desktop ingestion.
- Claude Code native hook adapter with CC Switch-aware config resolution.
- Live Registry across global/project/plugin definitions.
- Runtime-first inventory, source/provider categories, duplicate/conflict health.
- Overview, Skills, Runs, Registry, Settings, and live Skill Lab surfaces.
- Public GitHub candidate discovery, deterministic local overlap ranking,
  memory-only prompt/agent multi-provider A/B evaluation, and contextual assistant chat.
- Restricted multi-case Promptfoo Suites, asynchronous runs, sanitized evidence,
  Gate policies, local Red Team summaries, CLI/CI reports, and production smoke.
- Metadata-only Capability governance with independent approval, Canary, Stable,
  recoverable skeleton installation/reference locks, supersede, and rollback.
- A local Git-backed Prompt Registry for metadata-only browsing, immutable
  branch/commit versions, component Diff, explicit model-hint adoption,
  direct-provider evaluation, and the common governance/rollback path without
  a hosted Prompt-management dependency.
- Outcome coverage and lifecycle-only semantics.
- Atomic import, local export, backup-first clear, discovery deduplication.
- Automated unit/integration/UI tests, build, and smoke verification.

## 3. Phase 1: Operational hardening

Goal: make long-running local use predictable.

Candidate outcomes:

- explicit retention policy and backup management;
- event-store size/health indicator;
- documented recovery or compaction command for malformed/large stores;
- cross-platform CI for supported Node versions;
- structured adapter diagnostics with safe redaction;
- migration/version marker for future event-schema evolution.

Exit criteria:

- users can understand and control disk growth;
- every destructive maintenance action is recoverable and exact-targeted;
- supported operating systems run the same verification suite.

## 4. Phase 2: Evaluation truth

Goal: deepen the initial memory-only evaluator into repeatable evaluation evidence.

Status: implemented for reviewed local Managed Suites.

Implemented outcomes:

- multi-case evaluation-suite input and result schema;
- optional metadata-only evidence persistence separate from lifecycle adapters;
- repeatable version A/B comparison across representative cases;
- outcome-coverage thresholds and confidence presentation;
- read-only report export;
- no promotion/mutation from Quick Compare; governance consumes only verified
  Managed Suite evidence.

Exit criteria:

- every success claim links to evaluator evidence;
- lifecycle-only records cannot enter evaluated denominators;
- one-off judge results remain labeled as task-specific evidence.

## 5. Phase 3: Controlled Skill lifecycle actions

Goal: enable safe local action only after evaluation is trustworthy.

Status: implemented for allowlisted Skill skeleton targets and Prompt reference
locks.

Implemented outcomes:

- preview-only installation/promotion plan;
- exact source/target/version and conflict display;
- backup/rollback plan;
- explicit confirmation before filesystem/runtime mutation;
- post-action rescan and runtime verification.

Exit criteria:

- action is reversible;
- unrelated definitions/config remain unchanged;
- Registry and runtime config prove the final state;
- no action occurs from the current comparison preview.

## 6. Phase 4: Additional runtime adapters

Goal: add a runtime only when it exposes a real, testable event interface.

Cursor is the first candidate, but implementation depends on stable host hook
signals. Requirements:

- install/preview/uninstall contract;
- documented exact and heuristic detection signals;
- non-blocking failure behavior;
- privacy-minimized event mapping;
- real-user execution test;
- connection truth inspection.

A label or manual emitter is not sufficient to call a runtime connected.

## 7. Phase 5: Scale and collaboration decision

Goal: decide from measured user evidence whether SkillOps remains single-user
local or needs shared/team operation.

Possible work only if justified:

- indexed local storage or server-side aggregation for large histories;
- multiple local workspaces;
- signed/exported evaluation reports;
- opt-in remote collector with authentication, encryption, tenant isolation,
  retention, and privacy review.

Remote synchronization is not an automatic next step. It materially changes the
trust model and requires a separate product/security decision.

## 8. Explicitly deferred

- cloud accounts and billing;
- social/team feed;
- automatic remote prompt/source upload;
- opaque AI-generated success verdicts;
- automatic Skill promotion based only on lifecycle counts;
- generic runtime adapters without observable host signals;
- editing arbitrary Skill contents from the dashboard.

## 9. Decision checkpoints

### Checkpoint A: retention

Measure active store sizes and backup accumulation. If normal users remain small,
prefer a simple retention control over premature database migration.

### Checkpoint B: evaluation

Confirm users have real acceptance-test inputs. If not, improve evidence export
before building ranking/promotion UX.

### Checkpoint C: Cursor

Proceed only when native runtime signals can prove use with documented limits.

### Checkpoint D: remote/team demand

Require repeated user need that cannot be met by export/import. Revisit the full
privacy/security model before adding network collection.

## 10. Roadmap metrics

| Area | Measure |
| --- | --- |
| Reliability | Hook-induced host-runtime failures = 0 |
| Data quality | Duplicate derived/discovery records after repeated refresh = 0 |
| Truthfulness | Unknown completions counted as success = 0 |
| Privacy | Forbidden content persisted by built-in adapters = 0 |
| Setup | Installed adapter plus real activity can be verified in one session |
| Inventory | Runtime/source/provider totals reconcile with definition rows |
| Maintenance | Clear/compaction actions have verified backup/rollback |

## 11. Prioritization rule

Work order is:

1. privacy or data-integrity defects;
2. incorrect evidence/metric semantics;
3. hook installation and runtime-connection reliability;
4. inventory correctness and real-user usability;
5. operational scale;
6. new runtimes;
7. mutation and collaboration features.
