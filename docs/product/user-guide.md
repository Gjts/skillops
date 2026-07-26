# SkillOps user guide

> Applies to: v0.3.2-rc.1 local + Git Limited Preview

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

Open the connection dialog first. Its `GET /api/setup/preflight` check reports:

- the current and minimum supported Node.js versions;
- Git and loopback API availability;
- whether the configured local data path probe completed and, separately,
  whether that path is an actual writable directory;
- whether runtime inspection completed; and
- sanitized Codex, Claude Code, and Cursor configuration/reference health.

It does not return runtime configuration paths, hook commands, or credentials.
A writable regular file does not satisfy the directory check. A probe that
cannot complete is reported as unavailable, not as a factual read-only result.
Either state disables the dry-run review confirmation and keeps the Install
command hidden. When preflight is eligible, select **I reviewed the redacted
dry-run preview.** to reveal the command.

For manual CLI installation, connect Codex with:

```powershell
npm run codex:dry-run
npm run codex:install
```

Connect Claude Code with:

```powershell
npm run claude:dry-run
npm run claude:install
```

Restart the runtime after installation. In runtimes that require hook trust,
open `/hooks`, inspect the SkillOps commands, and approve them.

### Choose the interface language

Use the language selector at the bottom of the sidebar. The dashboard supports
Chinese, English, French, Russian, Spanish, and Japanese. The selected language
is saved in this browser and restored on the next visit. Command Center action
reasons and impacts, readiness reason-code labels, and metric definitions use
the same six-language message catalog rather than server-authored English.

## 3. Confirm that setup is real

An **Installed** badge confirms that the effective config contains SkillOps
handlers and their `.mjs` script paths exist. It does not confirm that a hook
has fired.

To verify end to end:

1. Open Settings and confirm the adapter says **Installed**.
2. Click **Check installation**. SkillOps derives the verification boundary
   from the current configuration and referenced hook files, and refreshes the
   sanitized preflight facts at the same time.
3. Explicitly invoke one known Skill in Codex or Claude Code.
4. Finish the turn.
5. Click **Check installation** again and confirm the adapter says
   **Verified**.
6. Open Activity, search for the Skill name, and confirm the runtime,
   timestamp, session, detection method, and terminal event.

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

### Command Center

Use the runtime filter plus **Today**, 7-day, 14-day, or 30-day range to inspect
one bounded deterministic projection from `GET /api/command-center`. **Today**
starts at midnight in the local server timezone; it is not a rolling 24-hour
window.

The Readiness panel checks Runtime evidence, Git, local data, inventory,
provider configuration, Managed Evaluations, and Governance separately. Each
fact has an explicit ready/attention/blocked/unknown state, check time, reason,
and a link to the owning page. Installed configuration remains distinct from
verified post-install lifecycle evidence.
Runtime readiness depends on both the event and connection sources. If either
source is unavailable or partial, Runtime is `unknown` with
`source-unavailable`; an empty fallback is never treated as verification truth.

**Next Actions** contains at most three deterministic actions. Every action
shows its priority, reason, evidence references, impact, and exactly one CTA.
Issues use the same backend facts; neither section claims that an AI inferred
causality.

Metric cards expose their definitions and ratio numerators/denominators.
Success rate is unavailable when no run has a known outcome. Outcome coverage
is known outcomes divided by all terminal Skill runs. Reported cost sums only
terminal runs with finite `costUsd`; its coverage is reported-cost runs divided
by terminal runs. Missing cost stays unreported, while explicit zero remains
`$0.00`.

When the event and connection sources were read completely, no Runtime is
installed or verified, and there are no terminal runs or observed assets, the
Command Center shows a privacy explanation and three-step quick start instead
of fabricated zero KPI cards. A verified Runtime with no activity in the
selected window shows truthful zero metrics instead of connection setup.
Partial or unavailable event or connection sources never trigger onboarding.
**Recent Runs** contains only terminal Skill runs, and every row opens Run
Detail. Quick Actions link directly to asset scan, connection verification, a
Managed Suite, Candidate review, and data export. Demo data always has a
persistent Demo label and is never mixed with local facts.

### Agents

The **Observed Activity** tab shows runtime-scoped Agent lifecycle projections;
the **Definitions** tab shows installed Agent files. Discovery alone never
creates observed activity. Runtime, time, search, and page state stay in the
URL, and `GET /api/agents` returns one bounded 50-row page at a time.

### Activity

Shows `skill.completed` and `skill.failed` events. The page requests only the
current 20, 50, or 100 rows from `GET /api/runs`. Opening a run then requests
that run in a bounded 200-event correlated session/turn window from canonical
`GET /api/runs/~:id`; the selected run is preserved and the UI labels loaded
and total counts when the window is truncated. Search matches Skill name,
event ID, and project. Runtime, project, outcome, date, sort, and reported-cost
filters run on the server. Page, page size, filters, and sort stay in the URL,
so refresh and browser history restore the same view. Page navigation enters
history only after the requested page loads; failures restore the last fully
loaded view. A newest-first bounded poll detects replacement arrivals by
timestamp/ID, moves an out-of-range page after deletions, and retries the local
API from Demo mode without downloading `/api/events` or inserting rows into a
page already being read.

### Benchmarks

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
directory as `ai-settings.json` and restored when Skill Lab reloads. A saved
key is shown only as a fixed mask in the settings dialog; revealing the field
never returns the full stored value. Settings are not written to browser
storage. Credentialed provider endpoints require HTTPS; keyless Ollama HTTP is
accepted only on a loopback address. A custom Base URL receives the configured
key, so use only an endpoint you trust.
OpenAI-compatible transports expose
`none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts when the
selected model supports them. GPT-5.6 defaults to Medium when the field is left
at provider default; its Chat Completions tool calls require **None**, so Skill
Lab blocks read-only agent runs until that value is selected.

Evaluation tasks, acceptance criteria, generated outputs, judge rationales, and
chat messages remain in browser memory and are not appended to the event store.
They are sent to the selected model provider, whose data policy applies.
Read-only agent mode additionally sends only workspace excerpts requested
through its bounded tool interface.

### Assets

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

Both definition and Artifact tables use stable server-side filtering and
50-row pages. The browser receives the current rows and aggregate counts, not
the complete inventory. Filter and page state remains in the URL. **Scan
again** or **Refresh** explicitly replaces the relevant in-memory snapshot;
ordinary search, filter, and page changes reuse it.

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

### Releases

Quick Compare can carry an in-memory Candidate draft into Managed Suites, but it
cannot create a Capability or bind governed evidence. A completed Managed Suite
must receive one final Decision: **Create Candidate**, **Keep baseline**,
**Reject Candidate**, or **Collect more evidence**. The canonical API is
`GET/POST /api/evaluations/:runId/decision`; the older
`/api/evaluation-runs/:runId/decision` path remains compatible.

The persisted Decision contains exactly `decisionId`, `evaluationRunId`,
`artifactId`, `candidateRefHash`, `decision`, and `recordedAt`. Retrying the
same Decision returns the existing record. A different judgment or
supplemental evidence requires a new Managed Suite run.

Suite case coverage is persisted as evaluated cases divided by the run's
authoritative eligible-case count. **Create Candidate** requires current,
passing evidence at exactly 100% coverage; incomplete or legacy evidence
without an eligible-case count can only be kept, rejected, or sent back for
more evidence.

Registry and PromptHub import flows may first persist an exact-revision
**Candidate** proposal without evaluation evidence. It remains at Candidate and
cannot enter Ready or any release stage. Only a final **Create Candidate**
Decision may claim that proposal, or create a new one, as a **Release
Candidate**. That run ID becomes the immutable `originEvaluationRunId`: one run
can own at most one Release Candidate, including under concurrent requests.
Later re-evaluation may update `latestEvidenceRunId` but cannot reassign the
origin. Every quality-evidence refresh must first receive its own final
**Create Candidate** Decision; **Keep baseline**, **Reject Candidate**, and
**Collect more evidence** runs cannot be bound for release. Every approval,
Canary, Stable, install, rollback, and pending Canary/Stable forward-release
recovery revalidates the origin and latest-evidence Decisions and fails closed
if either is missing or invalid. The release service preserves the authoritative
Capability stages, blocks stale or insufficient evidence, requires an
independent reviewer for approval, and uses preview, confirmation,
authoritative rescan, and rollback for filesystem changes.

### Settings

Settings groups runtime connections, AI Providers, Appearance, Data & Privacy,
and links to the existing Advanced controls. Runtime rows keep configuration
truth, connection stage, real activity, and last verified evidence separate.
Provider status shows the active model and endpoint without echoing a saved key.
System, Light, and Dark are the stable appearance choices; the remaining
catalog stays available under **Experimental themes**.

The data section reads only a bounded count/latest-activity summary. Export
streams normalized JSONL directly from the loopback backend. Clear requires
confirmation and creates a timestamped backup before replacing the active file.
The page explicitly reports the lack of automatic retention and application-level
encryption.

## 5. Import event data

Activity accepts either a JSON array or newline-delimited JSON. Every event is
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

SkillOps does not manage encryption at rest. Protect the data directory, event
exports, and retained backups with operating-system permissions and disk
encryption.

### Managed Suites, governance, and local Prompt privacy

Managed Suites are explicit files authored under `evals/`, using synthetic
or intentionally sanitized cases. They are not generated from hooks, prompts,
transcripts, or other telemetry. Only sanitized result summaries and identity
hashes are kept as evaluation evidence; raw prompts and outputs stay out of
the evidence store.

Use the **Suites** and **History** tabs on `/benchmarks` to start, cancel, and
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

The browser cannot submit owner, reviewer, or release-operator IDs. Ordinary
local governance operations without a Bearer credential resolve to the account
running the local SkillOps server. Approval is stricter: it requires an
authenticated principal configured through `SKILLOPS_GOVERNANCE_PRINCIPALS`
and never falls back to that operating-system account. Configure a distinct
reviewer before startup, for example:

```json
[{"id":"reviewer:alice","displayName":"Alice","token":"REPLACE_WITH_32_OR_MORE_RANDOM_CHARACTERS"}]
```

Enter that value in **Reviewer access token** only when approving. It is sent
as a Bearer credential, cleared after the request, and is not persisted by the
browser or SkillOps. A missing, unknown, or malformed token fails closed, and
an owner still cannot approve the same Candidate. Direct API reads of
`/api/project-skeleton-lock`, `/api/governance-audit`, and
`/api/capabilities/:capabilityId/audit` use the same authenticated-principal
requirement with no OS fallback. The Candidate audit timeline therefore starts
locked rather than pretending a rejected read is empty. Enter an **Audit access
token** and choose **Load protected audit**; that token is also kept only in
component memory and cleared immediately after the request.

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

Open **Settings → Advanced → Team**. Its canonical URL is
`/settings?section=advanced-team`; the legacy `/team` route immediately replaces
itself with that canonical location. On first use, choose a stable Team ID and
display name. SkillOps assigns the account running the local server as `Owner`;
the UI then shows the Registry-derived Artifact directory, project usage,
lifecycle status, owner, Evidence Hash, Approval Inbox, and Release Queue.

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
collector-retention window and prunes expired records under the ordered
governance-release, Team, and Capability locks. The prune preserves every
Capability's immutable origin run, latest evidence run, and referenced
quality/Red Team runs so a retained Candidate cannot point to deleted
provenance, including during concurrent release or registry activity. Team
audit records remain append-only and hash chained.
Team mode is currently local + Git only: network deployment, SSO, and SCIM are
not available.

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

This release remains a local + Git Limited Preview. P0 implementation is
present, but the five-person validation sample, independent manual
review/keyboard evidence, the corrected-candidate four-job matrix,
immutable-candidate real-runtime, Broken-to-Repair, performance, browser/axe
evidence, complete packet fields, and the dependency-risk decision remain
external release gates.
P1 SET/ACT/AST work stays gated until those P0 gates close. The current
four-job cross-platform baseline is
[GitHub Actions run 30145860716](https://github.com/Gjts/skillops/actions/runs/30145860716).
