# Testing and QA strategy

> Version: v0.3.1
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
and no-write behavior, sanitized evidence recovery, run scheduling/cancellation,
governance transitions, recoverable skeleton installation, and Git-backed Prompt
Registry validation/version handling.

### Adapter tests

Verify configuration merge, backup/idempotency/uninstall, scope resolution,
privacy minimization, exact/heuristic detection, lifecycle closure, CC Switch
resolution, and non-blocking error behavior.

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
component Diff, and explicit Candidate creation.

### Smoke test

Spawns the production server on an isolated loopback port and validates:

- built frontend and SPA fallback;
- local event HTTP operations;
- candidate-comparison HTTP behavior without an external model call;
- a deterministic Managed Suite through the production HTTP server;
- a temporary Git Prompt repository with three committed immutable versions;
- two local Prompt Candidates evaluated through the Promptfoo worker;
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

Repository hygiene:

```powershell
git diff --check
git status --short --branch
```

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
2. Open Overview.
3. Confirm zero state is labeled local, not demo.
4. Confirm no run/success totals are fabricated.

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
`--runtime claude-code`.

### Scenario F: Import atomicity

1. Prepare JSONL containing one valid and one invalid event.
2. Import from Runs.
3. Confirm visible error and zero appended records.
4. Correct the file and import twice.
5. Confirm the second import adds zero duplicate IDs.

### Scenario G: Clear and recovery

1. Export current events.
2. Clear from Settings and confirm the dialog.
3. Confirm zero active events and a displayed backup path.
4. Verify the backup file exists.
5. Re-import only if the operator intends to restore it.

### Scenario H: Broken adapter path

Use isolated fixture settings that contain a SkillOps marker pointing to a
missing `.mjs` file. Confirm status is Broken, not Installed or Not installed.

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

1. Run a deterministic local Suite and inspect sample/coverage metrics.
2. Confirm persisted evidence contains hashes and sanitized status/score fields,
   not inputs, Prompt/Skill bodies, raw outputs/errors, or credentials.
3. Nominate a Candidate, bind the exact completed run, and evaluate the Gate.
4. Confirm the owner cannot self-approve as reviewer.
5. Approve with a second local identity, preview Canary/Stable, confirm twice,
   and inspect the lock/backup/verification result.
6. Roll back and confirm unrelated files are unchanged.

### Scenario K: Local Prompt Registry contract

Create a temporary Git repository with two branches and two committed versions
of the same `prompts/*.prompt.json` file. Verify metadata-only listing, provider
and model filters, immutable commit references, component Diff, and evaluation
resolution after an unrelated working-tree edit. The automated Registry and
production smoke tests cover this scenario; the exact contract is in
[Prompt Registry contract](../integrations/prompt-registry.md).

## 7. Browser route matrix

Every route must load directly and after refresh:

```text
/
/skills
/runs
/evaluations
/registry
/governance
/settings
```

Verify at desktop and narrow viewport widths. Registry tables may scroll
horizontally but must not obscure runtime selection or filters.

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

For read-only evaluation tools, also assert that `.env`, credential/key files,
`data/`, `.opc`, dependencies, build output, traversal, and symlinks cannot be
listed, searched, or read, and that no mutation/process/network tool is exposed.

Unknown fields should be absent from the stored JSONL record, not merely hidden
in the UI.

## 9. Completion gate

Before claiming a change is complete:

1. Run the narrowest relevant test.
2. Run `npm test` and read the failure count.
3. Run `npm run build` and confirm exit code 0.
4. Run `npm run smoke` for server/API/routing/build/privacy changes.
5. Perform the relevant real-user scenario for adapter or inventory changes.
6. Run link/path checks for documentation changes.
7. Inspect Git status and disclose untracked or generated files.

Past output or a code review is not a substitute for a fresh command result.
