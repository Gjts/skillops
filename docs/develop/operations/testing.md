# Testing and QA strategy

> Version: v0.3.2-rc.1
> Status: active verification standard

## 1. Quality risks

Tests prioritize the failures most harmful to SkillOps users:

- recording private content;
- reporting discovery as execution;
- reporting completion as success;
- corrupting existing runtime settings;
- duplicating events during repeated scans/refreshes;
- exposing the unauthenticated HTTP interface beyond loopback;
- mixing Codex/Claude/plugin/global/project inventory categories;
- clearing local history without a recoverable backup.
- leaking API keys, local Skill contents/paths, evaluation tasks, or model output;
- presenting one A/B judge result as a universal Skill-quality claim.
- persisting Managed Suite inputs, Prompt bodies, provider responses, or keys;
- promoting stale/unapproved evidence or silently following a moved remote head;
- leaving a partial installation when verification fails.
- rewriting a final Managed Decision or letting one run create two Release Candidates;
- accepting an approval without an authenticated configured principal;
- presenting failed setup prerequisites as a usable connection;
- fabricating zero Command Center KPIs when no execution/asset evidence exists.

## 2. Automated test layers

### Shared schema tests

Verify accepted events, invalid types/enums/timestamps, allowlist behavior,
numeric finiteness, tags, required Skill ID, and outcome contradictions.

### Backend module tests

Verify JSONL append/read/import, atomic validation, ID deduplication, discovery
locking/indexing, scanner sources, plugin enablement, runtime connection status,
Codex Desktop ingestion/deduplication, candidate bounds/similarity, baseline
allowlisting, hash pinning, provider HTTPS/loopback normalization, HTTP
origin/content-type guards, score-consistent blind judging, bounded workspace
agent tools, chat-context minimization, strict Suite parsing, Promptfoo isolation
and no-write behavior, default-deny child processes, nested-Node no-egress,
session-ID pseudonymization, sanitized evidence recovery, run
scheduling/cancellation, governance transitions, recoverable skeleton
installation, setup-preflight sanitization, one-final-Decision semantics,
immutable/concurrent Release Candidate origin reservation, authenticated-only
approval and audit reads, explicit protected-audit unlock/error states,
file-as-directory rejection, unavailable-vs-read-only preflight truth, retention
of every referenced Capability run across concurrent release and cross-process
registry activity, and Git-backed Prompt Registry validation/version handling.

Focused regressions also verify Suite Schema v1 Gate bounds and non-empty
requirements; stricter per-threshold policy merging, effective-policy hashing,
freshness, and Governance list/detail projections; both blocking
`sample-size` and `suite-case-coverage` requirements for **Create Candidate**;
fixed non-reflective Managed Evaluation errors; backup-first final-row migration
with byte-preserving failure on middle corruption; persisted reason
canonicalization; and immediate-previous rollback with preview invalidation when
the selected Candidate changes.

### Adapter tests

Verify configuration merge, backup/idempotency/uninstall, scope resolution,
privacy minimization, exact/heuristic detection, lifecycle closure, CC Switch
resolution, and non-blocking error behavior. Claude coverage includes every
documented `SessionEnd` reason and maps absent or unrecognized values to
`unknown`.

### Frontend tests

Verify analytics semantics, charts, routing/data modes, import/clear flows,
runtime connection UI, Registry separation/health filters, and run correlation.
Skill Lab tests exercise candidate discovery rendering, session provider setup,
reasoning-effort validation and compatibility, A/B result display, and
contextual chat. Drawer tests verify default non-rendering, contextual prompt
seeding, Escape dismissal, and focus restoration.
Managed evaluation, Governance, and Prompt Registry tests cover
polling/cancellation, metrics/cases, stale provenance, double confirmation,
six-language copy, HTML escaping, metadata-only browsing, branch selection,
component Diff, exact Decision fields, interrupted Candidate recovery,
same-turn distinct-run behavior, and explicit Candidate creation. Command Center
tests cover server-local calendar Today/7d scope, partial runtime sources, seven
readiness facts, three-action bounds, ratio denominators, six-language
reason/impact/definition rendering, true empty state, persistent and internally
consistent Demo separation, unavailable event-source metric/recent-run states,
Quick Actions, and full-row Recent Run routing.
Connection tests require an eligible preflight plus explicit dry-run review
confirmation before the Install command is exposed.

### Smoke test

Spawns the production server on an isolated loopback port and validates:

- built frontend and SPA fallback;
- local event HTTP operations;
- candidate-comparison HTTP behavior without an external model call;
- a deterministic Managed Suite through the production HTTP server;
- a temporary Git Prompt repository with three committed immutable versions;
- two local Prompt Candidates evaluated through the isolated Promptfoo process;
- evidence binding, independent approval, Canary, Stable, supersede, and
  offline rollback through the production governance API;
- persisted evidence and immutable Stable/rollback behavior after the temporary
  Prompt source repository is moved out of reach;
- privacy validation;
- loopback host behavior;
- clean process shutdown.

## 3. Authoritative commands

Full suite:

```powershell
npm test
```

Production build:

```powershell
npm run build
```

Production smoke:

```powershell
npm run smoke
```

Deterministic endpoint performance acceptance:

```powershell
npm run performance
```

The default command is an **endpoint-only** acceptance check. It generates
100,000 normalized events and 5,000 scanner definitions from a seed that
actually initializes the reported PRNG. The report records the complete row
distribution, fixture hash, fixed UTC service clock, host/service time zones,
machine versions, commit, and a dirty-working-tree boolean. For each endpoint
it measures five cold processes, performs 10 warm-ups, then records 100
sequential samples at concurrency 1. Budgets are Command Center warm p95 <=
750 ms and Runs API/page warm p95 <= 500 ms.

The ignored `data/performance-report.json` uses separate
`acceptance.endpoint` and `acceptance.releaseCandidate` results. A successful
default command means only `acceptance.endpoint.passed=true`. The release result
remains incomplete and false while the 30-minute memory component, production
browser UI timing, browser-network boundary, immutable candidate, or other RC
evidence is absent. The Node harness explicitly reports browser networking as
not measured; it never invents a browser result.

Use `--soak-minutes=30` for the RC memory soak. UI timing is a separate
production-browser check: retain the fixture with
`--fixture-directory=<path>`, bring the measured browser tab to the foreground,
perform five warm page loads and 50 measured loads at 1366-by-768, and read
`skillops:primary-content` from the Performance API. Its product p95 budget is
<= 120 ms (stricter than the 500 ms release
ceiling). The soak records the five-minute baseline and five-minute trend,
requires the final `<20%` and `<100 MiB` limits, and treats the final 15 minutes
as a plateau only when both net drift and fitted growth stay within 5% and 5
MiB. Copy the raw endpoint, UI, and memory samples
into the sanitized [release evidence record](rc-evidence/v0.3.2-rc.1.md); the script
does not write browser measurements itself.

Repository hygiene:

```powershell
git diff --check
git status --short --branch
```

The current four-job cross-platform CI baseline passed with Ubuntu/Node 22,
macOS/Node 22, Windows/Node 22, and Ubuntu/Node 24:
[GitHub Actions run 30145860716](https://github.com/Gjts/skillops/actions/runs/30145860716).
This automated baseline does not close the five-person validation,
independent-review/keyboard, audit-correction commit-binding,
immutable-candidate real-runtime, Broken-to-Repair, performance, browser/axe,
or complete-packet evidence gates. P1 SET/ACT/AST work remains gated until
those P0 gates close.

### Pull-request Artifact gate

`.github/workflows/evaluation-gate.yml` publishes the stable
**Required Artifact evaluation** check for `pull_request`, merge queue, and
manual runs. It runs the deterministic managed baseline and `npm run
eval:changed` against the exact base/head commits. Every changed Skill, Prompt,
Workflow, Rules, Agent, Evaluation Suite, or Policy Pack must resolve as an
immutable Git Artifact, have a matching deterministic Suite, and produce
hash-valid passing evidence; a missing Suite, unresolved Candidate, failed Gate,
or stale hash exits nonzero. The workflow does not receive a provider API key.
The dedicated fixed CI Suite is resolved from the exact base commit and must
keep its synthetic cases inline. When a mapping first introduces a Suite that
does not yet exist at the base, the gate uses the base commit's
`local-prompt-quality` as its trust anchor and rebinds the requested ID and
Artifact kind in memory. The initial Evaluation Suite mapping uses two built-in
structural markers after schema-validating the exact head Suite content; no
Candidate-checkout Suite supplies its own assertions. The dedicated Suite takes
over automatically after it exists at the base.
The default score-delta threshold is zero: equal quality passes, while any
measured regression against a distinct baseline fails. New Artifacts therefore
remain subject to absolute score and every other blocking gate without requiring
an impossible improvement over themselves.
Deleting a governed Artifact is also part of the diff and fails closed because
no immutable head Candidate can be resolved.
Native Codex Agent Definitions under `.codex/agents/*.toml` are classified as
Agent Artifacts, read from the tested commit, and targeted to the Codex runtime.

The `main` branch ruleset must require **Required Artifact evaluation** and the
platform CI jobs before merge. GitHub stores that ruleset outside the repository;
administrators select these exact check names after the workflow exists on the
default branch.


## 4. Narrow test examples

Run one backend file:

```powershell
npx vitest run app/backend/event-store.test.mjs --root .
```

Run one adapter file:

```powershell
npx vitest run adapters/claude/claude-adapter.test.mjs --root .
```

Run one frontend file:

```powershell
npx vitest run app/frontend/skillops/src/App.test.tsx --root .
```

Always run the full suite after the narrow test passes.

## 5. Isolated data setup

Tests that call real CLI/backend behavior must not use the operator's default
event store. Create a dedicated temporary directory and set:

```powershell
$env:SKILLOPS_DATA_DIR = 'D:\Temp\skillops-test-run'
```

Confirm the resolved path is the intended test directory before any clear or
removal operation. Automated tests normally create their own temporary folders.

## 6. Manual real-user scenarios

### Scenario A: Empty first run

1. Start with a new isolated data directory.
2. Open Command Center.
3. Confirm zero state is labeled local, not demo.
4. Confirm the privacy explanation and three-step quick start replace KPI cards.
5. Confirm no run/success totals are fabricated.

### Scenario B: API unavailable

1. Open a built/static frontend without the local event interface.
2. Confirm deterministic data is clearly labeled Demo.
3. Confirm export and clear are disabled.

### Scenario C: Live inventory separation

1. Open Registry and wait for scan completion.
2. Record Combined total.
3. Select Codex then Claude Code.
4. Confirm each source/provider count stays inside the selected runtime.
5. Confirm same-name cross-runtime Skills are marked shared only in Combined view.

### Scenario D: Codex real execution

1. Confirm adapter Installed.
2. Record an ISO start time.
3. Explicitly invoke a known Skill.
4. Finish the turn.
5. Run `check-skill-recording.mjs` with Codex/runtime/time filters.
6. Confirm at least one non-discovery event and inspect detection method.

### Scenario E: Claude Code real execution

Repeat Scenario D using an explicit `/skill-name` or Skill tool invocation and
`--runtime claude-code`. End sessions with documented reasons where practical
and confirm only `clear`, `resume`, `logout`, `prompt_input_exit`,
`bypass_permissions_disabled`, `other`, or the fallback `unknown` persists.

### Scenario F: Import atomicity and migration repair

1. Prepare JSONL containing one valid and one invalid event.
2. Import from Runs.
3. Confirm visible error and zero appended records.
4. Correct the file and import twice.
5. Confirm the second import adds zero duplicate IDs.
6. In an isolated store, append one malformed final row and run explicit legacy
   migration with backup enabled.
7. Confirm the exact original has a timestamped backup and only the final bad
   row was removed.
8. Repeat with a malformed middle row and confirm migration fails while the
   original file remains byte-for-byte unchanged.

### Scenario G: Clear and recovery

1. Export current events.
2. Clear from Settings and confirm the dialog.
3. Confirm zero active events and a displayed backup path.
4. Verify the backup file exists.
5. Re-import only if the operator intends to restore it.

### Scenario H: Broken adapter path

Use isolated fixture settings that contain a SkillOps marker pointing to a
missing `.mjs` file. Confirm status is Broken, not Installed or Not installed.
Open the connection dialog and confirm `/api/setup/preflight` reports unhealthy
adapter reference health without returning the missing absolute path.

### Scenario I: Skill Lab session flow

1. Paste a public GitHub Skill URL and confirm candidate metadata renders.
2. Confirm the top local match comes from the live enabled inventory.
3. Open AI settings, select a provider, and verify the key is hidden by default.
4. Confirm no key/config value appears in local or session browser storage.
5. Select an explicit reasoning effort and confirm the provider receives it.
6. Run one prompt-only task and confirm the result labels that mode.
7. For GPT-5.6, confirm read-only agent mode is blocked until reasoning effort
   is `none`.
8. Select read-only workspace agent mode, acknowledge its provider-disclosure
   text, run again, and confirm the result labels read-only agent mode.
9. Confirm the evaluation stays full width until **Ask SkillOps** or a contextual
   assistant action opens the drawer.
10. Close the drawer with Escape and confirm focus returns to its invoking
    control; on a narrow viewport confirm it renders as a bottom sheet.
11. Confirm the result says no Skill was installed or promoted.
12. Reload and confirm saved AI settings (including the API key) restore from local data.

### Scenario J: Managed Suite governance

1. Validate that an optional Suite Schema v1 `gate` accepts a positive
   `minSampleSize` and/or 0-through-100 `minSuiteCaseCoveragePct`, and rejects an
   empty Gate or an out-of-range threshold.
2. Run a deterministic local Suite with one Suite threshold above and one below
   the Capability policy. Confirm each effective threshold is the stricter
   maximum and that its hash is the evidence freshness boundary.
3. Change the Suite or dataset hash and confirm existing Release evidence turns
   stale and cannot be rebound without a current Managed Suite run.
4. Confirm Capability list and detail responses expose matching
   `effectiveGateResult`, `effectiveGates`, and `effectivePolicyHash`.
5. Confirm **Create Candidate** requires a current run whose overall result and
   both blocking `sample-size` and `suite-case-coverage` Gates passed.
6. Confirm persisted evidence contains hashes and sanitized status/score fields,
   not inputs, Prompt/Skill bodies, raw outputs/errors, or credentials.
7. Record one final `create-candidate` Decision. Confirm the response contains
   exactly the six public Decision fields, a same-value retry reuses it, and a
   different Decision returns `409`.
8. Nominate twice from that run and confirm the same Release Candidate is
   reused; a concurrent different-target nomination must not create another.
9. Bind later evidence and confirm `latestEvidenceRunId` changes while
   `originEvaluationRunId` remains fixed.
10. Apply Team retention past the origin run and confirm origin, latest, quality,
   and Red Team evidence references all remain resolvable. Repeat while a
   governance release transaction and a separate-process Capability registry
   write contend with pruning.
11. Confirm approval without a configured Bearer token fails even when the local
    OS principal is available, and confirm the owner cannot self-approve.
12. Confirm the audit timeline begins locked, loads only with an authenticated
    transient token, clears that token, and does not map `403` to an empty audit.
13. Approve with a distinct configured principal, preview Canary/Stable, confirm
    twice, and inspect the lock/backup/verification result.
14. Preview rollback to the lock's immediate previous Stable. Switch the selected
    Candidate and confirm the old preview/confirmation is rejected; preview
    again, roll back, and confirm arbitrary older history and unrelated files
    are unchanged.

### Scenario K: Local Prompt Registry contract

Create a temporary Git repository with two branches and two committed versions
of the same `prompts/*.prompt.json` file. Verify metadata-only listing, provider
and model filters, immutable commit references, component Diff, and evaluation
resolution after an unrelated working-tree edit. The automated Registry and
production smoke tests cover this scenario; the exact contract is in
[Prompt Registry contract](../integrations/prompt-registry.md).

### Scenario L: PromptHub Git source-of-truth gate

Use the local PromptHub Mock Server to preview a remote Prompt. Confirm import
without `gitSourceRef`, with a non-Git reference, or with one mismatched component
hash is rejected. Commit an exact semantic copy under the configured Git
workspace, pass its resolver-issued immutable `git:` reference, and confirm the
new capability is Candidate with the Git source/commit while connector state
retains only remote identity/version/hash and the local content hash.

## 7. Browser route matrix

Every route must load directly and after refresh:

```text
/
/agents
/activity
/assets
/benchmarks
/releases
/settings
/settings?section=advanced-team
```

Also verify legacy `/overview`, `/skills`, `/runs`, `/evaluations`, `/registry`,
and `/governance` map to their canonical page, while `/team` is replaced with
`/settings?section=advanced-team`. Verify at desktop and narrow viewport widths.
Registry tables may scroll horizontally but must not obscure runtime selection
or filters.

## 8. Privacy regression checklist

For every new hook payload field, test that events do not persist:

- prompt text;
- Skill arguments;
- tool input/output;
- transcript/model output;
- source code;
- environment values/tokens;
- full provider configuration outside the explicit AI settings file;
- raw error payloads;
- evaluation tasks/criteria and generated/judge output;
- assistant chat messages;
- AI provider API keys outside `data/ai-settings.json`.
- raw host session IDs rather than stable per-install HMAC pseudonyms.

For read-only evaluation tools, also assert that `.env`, credential/key files,
`data/`, `.opc`, dependencies, build output, traversal, and symlinks cannot be
listed, searched, or read, and that no mutation/process/network tool is exposed.
The process-wide no-egress setup must also reject undeclared child executables
and remote Git commands, and must inject itself into nested Node processes.

Unknown fields should be absent from the stored JSONL record, not merely hidden
in the UI.

For Managed Evaluation API rejection tests, include sentinel field names and
provider values. Assert the public messages are exactly
`Evaluation request contains unsupported fields.` and
`Unsupported AI provider.`, and that neither sentinel appears in the response.

## 9. Completion gate

Before claiming a change is complete:

1. Run the narrowest relevant test.
2. Run `npm test` and read the failure count.
3. Run `npm run build` and confirm exit code 0.
4. Run `npm run smoke` for server/API/routing/build/privacy changes.
5. Run `npm run performance` for projection, pagination, event-store, scanner,
   or release-candidate changes.
6. Perform the relevant real-user scenario for adapter or inventory changes.
7. Run link/path checks for documentation changes.
8. Inspect Git status and disclose untracked or generated files.

Past output or a code review is not a substitute for a fresh command result.
