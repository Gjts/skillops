# SkillOps user guide

> Applies to: v0.3.2-rc.1 local + Git release candidate

## 1. What SkillOps can tell you

SkillOps has two evidence levels:

- **Registry evidence**: a Skill or command definition exists and is available
  (or disabled) in a scanned location.
- **Execution evidence**: a runtime hook observed a match, start, completion, or
  failure event.

Never use a Registry count as proof that a Skill ran. Never treat a normal
`skill.completed` event as a passing evaluation when its outcome is `unknown`.

## 2. First-time setup

From the repository root:

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

Connect Codex:

```powershell
npm run codex:dry-run
npm run codex:install
```

Connect Claude Code:

```powershell
npm run claude:dry-run
npm run claude:install
```

Restart the runtime after installation. In runtimes that require hook trust,
open `/hooks`, inspect the SkillOps commands, and approve them.

### Choose the interface language

Use the language selector at the bottom of the sidebar. The dashboard supports
Chinese, English, French, Russian, Spanish, and Japanese. The selected language
is saved in this browser and restored on the next visit.

## 3. Confirm that setup is real

An **Installed** badge confirms that the effective config contains SkillOps
handlers and their `.mjs` script paths exist. It does not confirm that a hook
has fired.

To verify end to end:

1. Open Settings and confirm the adapter says **Installed**.
2. Record the current time.
3. Explicitly invoke one known Skill in Codex or Claude Code.
4. Finish the turn.
5. Open Runs and search for the Skill name.
6. Confirm the runtime, timestamp, session, detection method, and terminal event.

Command-line verification:

```powershell
node scripts/check-skill-recording.mjs `
  --skill your-skill-name `
  --runtime codex `
  --since 2026-07-20T00:00:00.000Z
```

Use `--runtime claude-code` for Claude Code. Add `--session <id>` when you need
to isolate one session.

## 4. Read the dashboard

### Overview

Use runtime and date filters to inspect terminal runs. The success rate may be
blank or marked lifecycle-only when no run has an evaluated outcome. Cost only
sums records that actually include `costUsd`.

### Skills

Shows execution metrics grouped by runtime and Skill name. One name used in
both Codex and Claude Code remains two runtime-specific rows.

### Runs

Shows `skill.completed` and `skill.failed` events. Select a run for correlated
session/turn detail. Search matches Skill name, event ID, and project.

### Skill Lab

Use Skill Lab to compare a public GitHub Skill with enabled definitions already
on this machine:

1. Paste a public GitHub repository, tree, blob, or raw `SKILL.md` URL.
2. Select the candidate when the repository contains multiple Skills.
3. Review deterministic similarity scores and choose the intended local baseline.
4. Describe one representative task and concrete acceptance criteria.
5. Choose prompt-only or read-only workspace agent execution.
6. Configure an AI provider and run the A/B test.

The local backend downloads the complete regular-file directory rooted at the
selected `SKILL.md` so evaluation, release, and rollback bind the same immutable
package hash. Packages are limited to 500 files / 10 MB and their bodies are not
returned to the browser.

The baseline and candidate receive identical task input and run sequentially,
followed by the blinded judge. This supports provider accounts that allow only
one in-flight request.
Prompt-only mode gives each definition one model call and no workspace access.
Read-only agent mode lets each side request bounded file listing, literal search,
and text-file reads; `.env`, credential/key files, `data/`, build output,
dependency caches, traversal, symlinks, writes, processes, and extra network
tools are blocked, and credential-like lines are redacted. Requested allowed
excerpts are sent to the selected provider, so review workspace source for
embedded sensitive data before selecting this mode. A final call receives the two outputs as anonymous Answer A/Answer B
values and returns consistent scores and rationale. This is evidence for one
task and one set of criteria, not a universal quality claim. The page never
installs, promotes, deploys, or edits either definition.

The assistant chat receives bounded inventory metadata plus the current task,
criteria, candidate/match descriptions, comparison signals, and in-memory
evaluation result/output when available. It does not receive local Skill paths
or local Skill file contents. Open it from **Ask SkillOps**, or use the contextual
actions beside baseline selection, A/B task setup, and the evaluation result.
The desktop chat opens in a right-side drawer instead of reducing the evaluation
workspace width; narrow screens use a bottom sheet. Closing the chat preserves
the in-memory conversation for the current page session.

### AI settings

AI settings support OpenAI, Gemini, Anthropic, Azure OpenAI, Ollama,
OpenRouter, MiniMax, GLM, and DeepSeek. After you click **Save settings**,
provider configuration including API keys is stored in the local SkillOps data
directory as `ai-settings.json` and restored when Skill Lab reloads. Settings
are not written to browser storage. Credentialed provider endpoints require HTTPS; keyless Ollama HTTP is
accepted only on a loopback address. A custom Base URL receives the configured
key, so use only an endpoint you trust. OpenAI-compatible transports expose
`none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts when the
selected model supports them. GPT-5.6 defaults to Medium when the field is left
at provider default; its Chat Completions tool calls require **None**, so Skill
Lab blocks read-only agent runs until that value is selected.

Evaluation tasks, acceptance criteria, generated outputs, judge rationales, and
chat messages remain in browser memory and are not appended to the event store.
They are sent to the selected model provider, whose data policy applies.
Read-only agent mode additionally sends only workspace excerpts requested
through its bounded tool interface.

### Registry

Choose a runtime workspace before interpreting counts:

- **Combined**: all definitions, grouped by runtime.
- **Codex / Claude Code / Cursor**: one runtime only.
- **Global / Project / Plugin**: installation source, not runtime.
- **Provider**: owner or plugin package source.
- **Skill / Command**: current Skill format versus legacy command definition.

The upper **Unified Artifact Registry** combines these live definitions with
committed Prompt references, governance Candidates/Stable versions, and project
lock state. Artifact IDs are scoped by type, so `skill:review` and
`prompt:review` remain distinct. Filter by type, source, lifecycle status,
runtime, owner, or search text. Select a row to inspect immutable commit/content
hashes, dependencies, Runtime compatibility, and desired versus observed
installations. `drifted` means the path exists but its observed hash differs
from the locked version; `missing` means the desired path was not found;
`unmanaged` means scanning found a definition with no desired lock.

**Preview a GitHub Candidate** resolves the entered branch or tag to an exact
commit and displays metadata without persisting the body or changing Stable.
When an Artifact has multiple versions, **Compare versions** returns changed
metadata fields only. Registry refresh and comparison cannot install, promote,
or delete a definition.

If the configured Prompt workspace is temporarily unavailable, the Registry
shows a source warning while retaining current local-scan and locked metadata.
It does not silently present that partial view as a complete refresh.

Health labels mean:

- **duplicate**: multiple enabled definition paths share a name and normalized
  contents in one runtime;
- **conflict**: multiple enabled definitions share a runtime and name but their
  normalized contents differ, even when they claim the same version;
- **disabled**: installed but explicitly disabled; it is excluded from
  duplicate and conflict calculations;
- **missing**: name or location metadata could not be established.

These labels do not select a winner. For a duplicate, keep one canonical team
path and disable or uninstall the redundant definition. For a conflict,
evaluate the candidates, choose the approved content hash, then disable the
other direct Skill or its containing plugin. Do not edit or delete files inside
a runtime plugin cache by hand. A cross-runtime shared name is informational,
not a conflict.

### Settings

Inspect config status, last activity, and event count. Export downloads the
normalized local JSONL data. Clear creates a timestamped backup before emptying
the active file.

## 5. Import event data

Runs accepts either a JSON array or newline-delimited JSON. Every event is
validated before anything is written. If one event is invalid, the entire
import is rejected. Existing IDs and duplicates inside the import batch are
not appended again.

Minimal JSONL example:

```json
{"id":"example-start","event":"skill.started","skillId":"example-skill","skillVersion":"1.0.0","runtime":"codex","timestamp":"2026-07-20T00:00:00.000Z"}
{"id":"example-end","event":"skill.completed","skillId":"example-skill","skillVersion":"1.0.0","runtime":"codex","timestamp":"2026-07-20T00:00:02.000Z","outcome":"unknown","durationMs":2000}
```

## 6. Manual event emission

Use manual emission for controlled integrations or tests, not to fabricate
runtime evidence:

```powershell
npm run emit -- skill.started --skill example-skill --runtime codex --version 1.0.0
npm run emit -- skill.completed --skill example-skill --runtime codex --version 1.0.0 --duration 2000
```

Only pass `--outcome success` when a real acceptance test or evaluator supplied
that verdict.

## 7. Data location and retention

Default active data:

```text
data/events.jsonl
```

Set an alternate directory before starting a command:

```powershell
$env:SKILLOPS_DATA_DIR = 'D:\SkillOpsData'
npm run dev
```

SkillOps does not automatically upload the store. Backups created by clear are
kept beside the active event file and must be removed manually if no longer
needed.

Skill Lab evaluation content is separate from `data/events.jsonl`: tasks, chat
messages, and generated output are not written there. Saved AI provider settings
may exist beside that store in `data/ai-settings.json`.

### Managed Suites, governance, and local Prompt privacy

Managed Suites are explicit files authored under `evals/`, using synthetic
or intentionally sanitized cases. They are not generated from hooks, prompts,
transcripts, or other telemetry. Only sanitized result summaries and identity
hashes are kept as evaluation evidence; raw prompts and outputs stay out of
the evidence store.

Use the **Suites** and **History** tabs on `/evaluations` to start, cancel, and
inspect asynchronous Promptfoo runs. Completed and failed runs expose
downloadable JSON and read-only HTML reports containing sanitized evidence
only. Saved credentials live only in local `data/ai-settings.json`; each run
holds them in request and isolated child-process memory and never copies them
into evaluation evidence. The runner disables cache, telemetry, update checks,
sharing, remote generation, and inherited secret environment variables, and
uses a temporary isolated config directory. Governance binds a completed run
to exact Artifact, suite, dataset, engine, and policy hashes. When a target
already has a Stable Artifact, nomination automatically binds that exact
version as the baseline and rejects evidence produced against another version.
Ready additionally requires an independent approval before Canary or Stable.

The browser cannot submit owner, reviewer, or release-operator IDs. Requests
without credentials use the account running the local SkillOps server. To
review without restarting the server under another operating-system account,
set `SKILLOPS_GOVERNANCE_PRINCIPALS` before startup, for example:

```json
[{"id":"reviewer:alice","displayName":"Alice","token":"REPLACE_WITH_32_OR_MORE_RANDOM_CHARACTERS"}]
```

Enter that value in **Reviewer access token** only when approving. It is sent
as a Bearer credential, cleared after the request, and is not persisted by the
browser or SkillOps. An owner still cannot approve the same Candidate.
Direct API reads of `/api/project-skeleton-lock` and `/api/governance-audit`
also require a configured Bearer credential.

After approval, enter an **absolute Canary project root** that resolves to a
different physical directory from every governed Stable project, plus a path
relative to that root such as `.codex/skills/review/SKILL.md`. SkillOps
canonicalizes the project root, binds it into the preview token, and rejects
same-project, missing, or non-absolute roots. Confirming the preview writes the
Candidate only under that Canary project, rescans that exact project root, and
records the canonical root, target, observed hash, and time; root or content
drift blocks Stable promotion. Then choose **Preview promotion** and confirm
again to write the nominated Stable target. Every preview shows source, project
root when applicable, target, hashes, Diff, backup, and recovery details.

A Stable version offers **Preview deprecation and removal** and **Preview
rollback**. Deprecation takes an exact-byte backup, removes only the selected
file, rescans, and records `Deprecated`. Rollback restores the exact previous
immutable Stable or just-deprecated file. If that historical version's evidence
is stale, select it, bind a current Managed Suite run, and obtain a new
independent approval first; rollback then atomically rebinds the lock to the new
Evidence Hash. Failed apply or state commit compensates the file, Capability
registry, and project lock; the append-only audit retains the failed outcome.
Opaque recovery metadata survives restarts in
`SKILLOPS_DATA_DIR/governance-release-recoveries.json`; backup bytes remain
beside the managed target and never enter API responses.

The Local Prompt Registry needs no account or Prompt-service API key. Configure
`SKILLOPS_PROMPT_WORKSPACE` when Prompt files live in a repository other than
the directory where SkillOps starts. Commit strict `prompts/*.prompt.json`
definitions, open Managed Suites, choose **Local Git Prompt**, select a branch,
then set immutable versions as the baseline and Candidate.

The browser receives only names, paths, model hints, variables, commit IDs, and
hashes. Prompt bodies are read from the pinned Git commit only while the backend
renders the evaluation. **Compare versions** reports changed components without
returning the text. **Create governed Candidate** starts the existing evidence,
approval, Canary, Stable, and rollback workflow. Stable remains usable and
rollback restores the previous lock even when the source repository is
temporarily unavailable. See the
[Prompt Registry contract](../develop/integrations/prompt-registry.md).

### Local Team control plane

Open **Team** or `/team`. On first use, choose a stable Team ID and display
name. SkillOps assigns the account running the local server as `Owner`; the UI
then shows the Registry-derived Artifact directory, project usage, lifecycle
status, owner, Evidence Hash, Approval Inbox, and Release Queue.

Team entity and role mutations use the loopback `/api/team/entities/*`,
`/api/team/devices/*`, and `/api/team/exceptions/*` routes. Roles are ordered
`Owner`, `Maintainer`, `Reviewer`, `Developer`, and `Viewer`. A policy-exception
requester cannot review the same exception. Referenced Workspaces, Projects,
Members, and Policy Packs must have their dependent records removed first.

To enforce a Team Policy Pack, save its normalized `gatePolicy` together with a
`contentHash` equal to that policy's canonical SHA-256 hash. Nominate the
Capability with both `projectId` and `policyId`. SkillOps re-evaluates immutable
Managed Suite metrics against the selected policy when binding evidence and
marks existing evidence stale if the policy or exception state changes. An
approved project exception falls back to the built-in policy; pending, rejected,
cross-project, or self-reviewed exceptions never waive a gate.

Device registration returns its `collector:write` token once. Store that token
outside Git and send it only as `Authorization: Bearer …` to the loopback
`POST /api/team/collector` route. Revocation takes effect before the next
upload. Collector uploads accept normalized runtime metadata and sanitized
evaluation summaries only; prompts, paths, project names, raw errors, source,
tool input/output, and provider credentials are never stored there.

**Create backup** writes a sanitized Team export under
`SKILLOPS_DATA_DIR/backups/`. `PUT /api/team/retention` changes the local
collector-retention window and prunes expired records under the same file lock.
Team audit records remain append-only and hash chained. Team mode is currently
local + Git only: network deployment, SSO, and SCIM are not available.

### Governed Team project templates

Obtain a reviewed Team Template Manifest from your Team's Git source. It must
name an immutable commit, a Stable release, passing Evidence Hash, independent
approval, the files to manage, immutable Artifact references, and the affected
Managed Suites. SkillOps does not bundle or silently select an organization
template.
Run `npm run template:init -- --manifest <draft.json> --hash` while authoring a
manifest, then bind that exact hash into both `release.evidence.templateHash`
and `release.approval.templateHash`.
Every Suite requires an immutable `candidateRef`; its stored run must evaluate
that exact reference and match one declared Git asset by kind, ID, version,
content hash, repository, and commit. A supplied `baselineRef` must also match
the run's exact baseline reference.


Minimal shape (file `contentHash` values are computed from `content`; Artifact
hashes are supplied explicitly):

```json
{
  "schemaVersion": 1,
  "id": "team-default",
  "version": "1.0.0",
  "source": {
    "kind": "git",
    "repository": "https://git.example/team/templates",
    "revision": "<40-64 hex commit>",
    "manifestPath": "templates/team-default.json"
  },
  "files": [
    {
      "path": "AGENTS.md",
      "content": "# Team rules\n",
      "sourceRef": "git:<revision>:AGENTS.md"
    }
  ],
  "assets": [
    {
      "kind": "skill",
      "id": "review",
      "version": "2.0.0",
      "sourceRef": "git:<revision>:skills/review/SKILL.md",
      "contentHash": "<sha256>",
      "evidenceHash": "<sha256>",
      "approvalId": "approval-review-2"
    }
  ],
  "evaluationSuites": [
    {
      "id": "template-smoke",
      "files": ["**"],
      "baselineRef": "<Artifact ref>",
      "candidateRef": "<Artifact ref>"
    }
  ],
  "release": {
    "channel": "stable",
    "evidence": {
      "runId": "run-1",
      "suiteId": "template-smoke",
      "gateResult": "passed",
      "evidenceHash": "<sha256>",
      "templateHash": "<skillops init --hash output>"
    },
    "approval": {
      "id": "approval-template-1",
      "submitterId": "user:author",
      "reviewerId": "user:reviewer",
      "decision": "approved",
      "evidenceHash": "<same evidence sha256>",
      "templateHash": "<same template sha256>"
    }
  }
}
```
Run `npm run template:init -- --manifest <file> --target <project> --mode
greenfield` for a new project or use `adopt-existing` to accept byte-identical
existing files. The command previews by default. Add `--apply` only after
reviewing its paths, actions, hashes, conflicts, and Suite list. Divergent
existing files block the entire operation and remain unchanged.

For upgrades, create a clean non-default Git branch, then use `--mode migration`.
SkillOps validates the existing template lock, rejects managed-file drift, runs
the affected Suites, and blocks writes when any gate fails. A successful apply
returns `git add --intent-to-add . && git diff HEAD -- . && git reset -- .`;
run it to review updates, deletions, and created files, then restore the index.
SkillOps neither commits nor updates the default branch. `--status` reports
current version, drift, and a pending version.
`--rollback` previews restoration from the exact previous Stable Git commit;
combine it with `--apply` to restore only the managed files and lock.

`.skillops/team-template.lock.json` contains versions, Git/source references,
content and Evidence hashes, approval IDs, Suite run IDs, and the previous
Stable commit. It contains no template file bodies, Prompt bodies, credentials,
or provider output. A Team Project may record the returned `current`,
`drifted`, or `upgrade-available` status so the Team page can aggregate
adoption, drift, and pending upgrades.

## 8. Disconnect a runtime

```powershell
npm run codex:uninstall
npm run claude:uninstall
```

Use the same scope/target arguments used during installation. Uninstall removes
SkillOps-marked handlers and preserves unrelated hooks. Restart the runtime and
refresh Settings afterward.

## 9. Next references

- [Detailed local setup](../develop/operations/getting_started.md)
- [Runtime adapter guarantees](../develop/integrations/runtime_adapters.md)
- [Troubleshooting](../develop/operations/troubleshooting.md)
- [Privacy and security](../develop/security/privacy-security.md)
