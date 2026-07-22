# SkillOps

SkillOps is a local-first observability and evaluation control plane for Skills used by Codex, Claude Code, and Cursor.

## Codex + Claude Code quickstart

Install dependencies and preview the exact hooks without changing Codex:

```bash
npm install
npm run codex:dry-run
```

Install the Codex adapter for your user account:

```bash
npm run codex:install
```

Then restart Codex, run `/hooks`, review the new definitions, and trust them. Start the dashboard in a second terminal:

```bash
npm run dev
```

SkillOps now observes Codex sessions, prompts (length only), local tool calls, subagents, and detectable Skill invocations. See [`adapters/codex/README.md`](adapters/codex/README.md) for scope, uninstall, privacy, and detection guarantees.

To connect Claude Code, preview the settings merge and then install the native adapter:

```bash
npm run claude:dry-run
npm run claude:install
```

The Claude Code preview redacts existing `env` values and credential-like settings before printing the merged configuration.

Restart Claude Code and run `/hooks` to verify the definitions. The adapter observes direct `/skill-name` expansion, model-initiated `Skill` tool calls, tools, subagents, turns, and sessions. It stores lengths and normalized metadata, never prompt text, tool payloads, transcripts, or raw model output. See [`adapters/claude/README.md`](adapters/claude/README.md) for project-local installation, uninstall, privacy, and detection guarantees.

The MVP includes:

- A responsive dashboard for runs, success rate, cost, runtime distribution, Skill performance, and recent failures.
- A persistent language selector for Chinese, English, French, Russian, Spanish, and Japanese.
- A normalized event schema for `discovered`, `matched`, `started`, `completed`, `failed`, and `skipped` events.
- A local JSONL event store and HTTP API.
- A CLI that scans common Skill locations and emits lifecycle events from hooks.
- Runtime connection guidance plus a live candidate comparison, A/B evaluation,
  and AI-assisted interpretation surface.
- Managed Promptfoo Suites with sanitized evidence, gates, cancellation, and CI
  verification.
- A metadata-only governance registry with approval, Canary, Stable, rollback,
  and recoverable local installation.
- A local Git-backed Prompt Registry for immutable versions, component Diff,
  explicit Candidate creation, evaluation, promotion, and rollback.

## Project structure

```text
app/
  backend/             Local API, event storage, Skill scanning, runtime health
  frontend/skillops/   React/Vite dashboard
  shared/              Event schema and AI provider catalog shared across layers
adapters/               Codex and Claude Code runtime adapters
bin/                    SkillOps CLI
evals/                  Reviewed Suite Schema v1 files and sanitized datasets
docs/
  product/              Product requirements and user workflows
  develop/              Architecture, data, integrations, operations and roadmap
scripts/                Smoke and recording verification helpers
data/                   Generated local telemetry (ignored by Git)
```

The repository remains one npm package: run all development, build, test, CLI,
and adapter commands from the project root. See
[`docs/README.md`](docs/README.md) for the complete documentation map and
[`docs/develop/architecture/system_architecture.md`](docs/develop/architecture/system_architecture.md)
for dependency direction and placement rules.

## Documentation

- [`docs/commit-convention.md`](docs/commit-convention.md): Chinese Conventional
  Commits types, SkillOps scopes, verification, and forbidden content.
- [`docs/product/user-guide.md`](docs/product/user-guide.md): first-time setup,
  real execution verification, and dashboard interpretation.
- [`docs/product/prd.md`](docs/product/prd.md): implemented product requirements,
  non-goals, evidence semantics, and acceptance criteria.
- [`docs/develop/data/event_model.md`](docs/develop/data/event_model.md): event
  fields, lifecycle/outcome rules, storage, import, and schema evolution.
- [`docs/develop/integrations/runtime_adapters.md`](docs/develop/integrations/runtime_adapters.md):
  Codex, Claude Code, CC Switch, and Cursor adapter status.
- [`docs/develop/operations/troubleshooting.md`](docs/develop/operations/troubleshooting.md):
  setup, scan, hook, import, data, and network diagnosis.
- [`docs/develop/security/privacy-security.md`](docs/develop/security/privacy-security.md):
  local trust model, collected/not-collected data, and operator controls.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. An empty local event store is shown as a real zero state. The deterministic demonstration dataset is used only when the local event API cannot be reached, and is labeled clearly in the UI.

Use the language selector in the sidebar to switch the complete dashboard UI.
SkillOps stores the preference locally in the browser, restores it on reload,
and updates the document language metadata. All supported languages use a
left-to-right layout.

The sidebar appearance control opens a catalog of 25 complete product styles.
It includes the original Synapse, Swiss, Lumina, nature, blueprint, Soft UI,
and DevTools directions plus Material You, an Apple-inspired glass web
approximation, Tesla Mono, Carbon, Fluent Mica, GitHub Primer, Polaris,
Bauhaus, editorial ink, Solarized, phosphor terminal, Vaporwave, Cypherpunk,
Nordic fjord, and Clay Studio. Each style changes typography, density,
geometry, material, cards, controls, charts, and tables across every route.
SkillOps maps
the operating-system light or dark preference to DevTools or Synapse until the
user makes a choice, then stores that choice locally and restores it before the
next page is painted. Existing `skillops.theme.v1` light/dark preferences are
migrated once to DevTools/Synapse so upgrades preserve the user's appearance.

The main surfaces have reload-safe URLs: `/skills`, `/runs`, `/evaluations`,
`/registry`, `/governance`, and `/settings`. Events refresh from the local store
every three seconds, while runtime connection health refreshes every five
seconds. Unchanged event polls use ETags and return an empty `304` response
instead of transferring and parsing the full history again.

For a production-style local build:

```bash
npm run build
npm start
```

Open `http://localhost:4173`.

The production server is loopback-only and rejects non-loopback `SKILLOPS_HOST` values. Authenticated network deployment is not available in this release.

## Scan installed Skills

```bash
npm run scan
```

The scanner checks these conventional locations when they exist:

- `~/.agents/skills`
- `~/.codex/skills`, `~/.codex/prompts`, `~/.codex/agents`, and `~/.codex/AGENTS.md`
- `~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents`, `~/.claude/rules`, and `~/.claude/CLAUDE.md`
- `~/.cursor/skills`
- Project-local `.agents/skills`, `.codex/skills`, `.codex/agents`, `.claude/skills`, `.claude/commands`, `.claude/agents`, `.claude/rules`, `AGENTS.md`, and `CLAUDE.md`
- Enabled Codex plugin Skill directories registered beneath `~/.codex/plugins/cache`
- Installed Claude Code plugin Skill, command, and Agent directories registered by `installed_plugins.json`

The Registry page reports unique enabled Skill names separately from enabled definitions, commands, plugin definitions, and disabled definitions. Runtime connection status is read from the current Codex and Claude Code hook configuration files rather than inferred from historical events. A configuration that still contains SkillOps entries but points to a missing hook script is reported as **Broken**.

The **Skill Lab** page accepts a public GitHub repository, tree, blob, or raw
`SKILL.md` URL. It downloads only public candidate definitions, ranks them
against enabled local Skills with a deterministic content comparison, and lets
the user select one local definition as an A/B baseline. Prompt-only mode runs
each definition as one model prompt. The optional read-only agent mode can list,
search, and read bounded allowed workspace text while blocking hidden/common
secret paths, credential-like lines, runtime data, build output, traversal, and
all writes. A final blinded model
request scores the outputs. The analyzed candidate's SHA-256 content hash is
rechecked before either run. Results and generated outputs stay in browser
memory; the workflow does not install, promote, deploy, or edit a Skill.

OpenAI, Gemini, Anthropic, Azure OpenAI, Ollama, OpenRouter, MiniMax, GLM, and DeepSeek are supported. After **Save settings**, AI provider configuration
including API keys is stored in the local SkillOps data directory as
`ai-settings.json` and restored through loopback `GET`/`PUT /api/ai-settings`.
Evaluation tasks, acceptance criteria, chat messages, workspace excerpts, and
model output stay in memory and are not written to disk. Credentialed endpoints
require HTTPS; keyless Ollama HTTP is limited to loopback. User-initiated
provider requests do send their stated content, and read-only agent mode may
send requested allowed workspace excerpts, to the selected provider. Review
allowed source for embedded sensitive data; the selected provider's own data
policy still applies.

OpenAI-compatible transports also expose an explicit reasoning-effort control.
GPT-5.6 Chat Completions agent runs require reasoning effort **None**; prompt-only
runs may use the other supported efforts. Baseline, candidate, and judge provider
work runs sequentially so concurrency-limited endpoints can complete reliably.

### Evaluation privacy modes

The current **Quick Compare** workflow keeps its task, criteria, Skill contents,
workspace excerpts, model outputs, and judge response in memory. Provider
credentials are persisted only when the user explicitly saves AI settings, and
then only in local `data/ai-settings.json`; they are never copied into events or
evaluation evidence. The evaluation code uses a shared request/Artifact
contract and a compatibility facade so additional engines do not expand that
persistence surface.

**Implemented — Managed Suites and local Prompt Registry:** team-authored suites
and synthetic or deliberately sanitized datasets live under `evals/` as
reviewable product source. The separate evidence store retains sanitized
summaries, gates, statuses, and identity hashes only. Promptfoo `0.121.19` runs
in an isolated child process with a run-scoped timeout; cache, telemetry, update
checks, sharing, local/remote generation, and inherited secret environment
variables are disabled. The Prompt Registry reads only committed
`prompts/*.prompt.json` versions from a user-controlled Git repository. It
returns metadata and hashes to the UI while resolving Prompt bodies only in
backend memory. SkillOps calls the explicitly selected model provider directly;
no hosted Prompt-management service is required. A new Git version can only
create a Candidate explicitly and can never replace Stable automatically.

**Implemented — PromptHub v1 read connector:** remote Prompt versions can be
listed and diffed, but a preview cannot be nominated directly. Commit the exact
Prompt semantics to the configured Git workspace first, then submit the
resolver-issued immutable `git:` source reference with the preview token. The
backend re-resolves the commit and requires all Prompt component hashes to match
the preview before creating a Candidate. PromptHub identity/version/sync
metadata stays local; remote bodies, credentials, and raw Diffs are not
persisted, and PromptHub cannot publish, promote, replace Stable, or prevent
offline rollback.


**Implemented — Unified Artifact Registry:** the Registry page now derives one
metadata-only view of Skill, Prompt, Workflow, Rules, and Agent assets from the
live runtime scan, immutable GitHub Candidates, committed local Prompt
references, governance capabilities, and project locks. Artifact identity is
kind-scoped; immutable version identity includes the exact Git commit when
available plus a deterministic SHA-256. Skill hashes bind every regular file's
relative path and bytes in the complete Skill directory; other Artifact kinds
bind their normalized definition content.
Filters cover kind, source, status, runtime, and owner. The detail view exposes versions, compatibility,
dependencies, desired/observed installation state, drift, and a metadata-only
version Diff. GitHub import is preview-only, resolves a branch to a 40-character
commit, and preserves the selected repository path in a canonical resolvable
reference; it cannot replace Stable.

`GET /api/artifacts` and `POST /api/artifacts/refresh` return the derived view.
`POST /api/artifacts/diff` and `/api/artifacts/import-preview` expose safe
queries without returning Artifact bodies. An explicit migration workflow
accepts only the allowlisted legacy scan schema, rejects unknown preimages, and
provides preview, serialized apply, pre/post snapshot hashes, exact-byte backup,
and rollback under `/api/artifacts/migration/*`; it never runs during startup.

**Implemented — governed release lifecycle:** a Candidate is automatically
bound to the current Stable Artifact when one exists, and Managed Suite
evidence must evaluate that exact baseline. Fresh evidence plus an independent
approval can preview a deployment to a separate Canary target. Explicit
confirmation installs the complete immutable Skill directory (or the single
definition for other kinds), rescans that target, and records its observed hash
and time; no state-only Canary transition exists. Stable preview rechecks that
deployed Canary before a second explicit confirmation installs or promotes the
Stable target. Stable packages can be deprecated with a complete backup and
post-removal rescan. Rollback restores the previous immutable Stable or
just-deprecated version; stale historical evidence must first be rebound from a
current Managed Suite and independently approved.

File, Registry, and project-lock state are compensated together when a
downstream state step fails; append-only write-ahead audit records retain the
committed or failed outcome. Recovery metadata survives server restarts in
`data/governance-release-recoveries.json`; opaque recovery references and
backup bytes never cross the API boundary.

The browser cannot choose owner, reviewer, or operator IDs. Requests without
credentials use the server operating-system account. Set
`SKILLOPS_GOVERNANCE_PRINCIPALS` to a JSON array of
`{"id","displayName","token"}` records (tokens require at least 32 random
printable characters) and enter a configured token in the Governance review
form for an independent approval; the token remains in memory only.
Direct reads of `/api/project-skeleton-lock` and `/api/governance-audit` require
a configured Bearer principal because they expose release and actor metadata.

Set `SKILLOPS_SKELETON_ROOT` to the managed project root before installing a
new file and use a root-relative target such as
`.codex/skills/review/SKILL.md`. New-file paths are confined to that root.
Existing upgrades continue to target an enabled scanned inventory reference.
Release routes are `POST /api/capabilities/:id/install`, `/promote`,
`/deprecate`, and `/rollback`; each accepts `{"action":"preview"}` followed by
`{"action":"apply","previewToken":"…","confirm":true}`.

**Implemented — local Team control plane:** `/team` initializes a Team from the
server operating-system identity and presents the unified Artifact directory,
Approval Inbox, and Release Queue. The backend models Team, Workspace, Project,
Environment, Member, and Device entities with `Owner`, `Maintainer`, `Reviewer`,
`Developer`, and `Viewer` permissions. A Policy Pack carries the normalized
Gate Policy plus its matching SHA-256 content hash. Capability nomination binds
`projectId` and `policyId`; evidence is re-evaluated against that exact Team
policy before approval or release. An independently approved project exception
waives only the selected Team policy and falls back to the built-in gate policy.


Team state stays in `SKILLOPS_DATA_DIR/team-control-plane.json`. Device secrets
are returned once, persisted only as SHA-256 hashes, limited to
`collector:write`, and can be revoked. `/api/team/collector` accepts at most 100
events and 100 sanitized evidence summaries per request; it strips project
names, paths, errors, prompts, and all non-allowlisted event fields before
writing `team-collector.jsonl`. Hash-chained audit records contain actor,
action, subject ID, revision, and time but no Artifact or Prompt bodies.
Explicit backup/export and retention operations are available under
`/api/team/*`.

This phase remains **local + Git only**. It does not expose an authenticated
network service, SaaS tenant, SSO, or SCIM surface; those stay deferred until a
real multi-user deployment is chosen.

**Implemented — governed Team project templates:** `skillops init` consumes a
schema-versioned Team Template Manifest from an immutable Git commit. The
manifest can carry `AGENTS.md` / `CLAUDE.md`, Git and review rules, Skill Pack
references, Prompt/Workflow locks, Managed Suite gates, CI, runtime-adapter
declarations, and security/release Policy files. Every referenced asset records
an exact version, source, content hash, Evidence Hash, and approval ID. Stable
template evidence and approval bind the exact template hash, and submitter and
reviewer must differ.

Use `npm run template:init -- --manifest <draft.json> --hash` to calculate the
release `templateHash` before binding evaluation evidence and approval.

```bash
npm run template:init -- --manifest <draft.json> --hash
# Preview only (default)
npm run template:init -- --manifest <team-template.json> --target <project> --mode greenfield
npm run template:init -- --manifest <team-template.json> --target <project> --mode adopt-existing

# Upgrade only from a clean, non-default Git review branch
npm run template:init -- --manifest <team-template.json> --target <project> --mode migration
npm run template:init -- --manifest <team-template.json> --target <project> --mode migration --apply

# Inspect drift or preview/apply the previous-Stable rollback
npm run template:init -- --manifest <team-template.json> --target <project> --status
npm run template:init -- --manifest <team-template.json> --target <project> --rollback
npm run template:init -- --manifest <team-template.json> --target <project> --rollback --apply
```

Preview returns exact paths, actions, hashes, line counts, conflicts, affected
Suites, and the review branch without writing. Greenfield and adopt-existing
never overwrite divergent files. Migration verifies the existing metadata-only
`.skillops/team-template.lock.json`, blocks drift, runs every affected Suite,
and writes only after every gate passes. Applied upgrades return
`git add --intent-to-add . && git diff HEAD -- . && git reset -- .` for a
complete review of updates, deletions, and created files; the final reset
restores the clean index. SkillOps never commits or writes to the default
branch. The lock records source, version, hashes, evidence, approval, and the
previous Stable commit, never template file bodies. Rollback restores only
managed paths from that exact Git commit. Team Project metadata can record
current, drifted, and upgrade-available template states; `/team` reports
adoption, drift, and pending-upgrade totals.

Managed Suite commands run from the repository root:

```bash
npm run eval:list
npm run eval:run -- --suite <suite-id> --baseline <ref> --candidate <ref> --provider <id> --summary <summary.json> --html <report.html>
npm run eval:verify -- --run <run-id>
```

History exposes the same sanitized evidence as downloadable JSON and an inert
HTML report. Suite authors can configure separate task, scalar-input, and
provider-output redaction rules; output redaction runs before assertions.

The Prompt Schema, workspace variables, immutable reference format, API, and
privacy boundary are documented in
[`docs/develop/integrations/prompt-registry.md`](docs/develop/integrations/prompt-registry.md).

The pinned Promptfoo dependency currently inherits five high-severity and seven
moderate `npm audit` entries through optional Promptfoo dependency chains. The
adapter's no-write, no-telemetry contract and restricted Suite schema reduce
exposure but do not remove the dependency risk; npm's offered remediation is a
breaking Promptfoo downgrade, so upgrades require contract revalidation.

## Emit lifecycle events

Add these commands to runtime hooks or Skill-scoped hooks:

```bash
npm run emit -- skill.started \
  --skill frontend-builder \
  --runtime codex \
  --version 2.1.0

npm run emit -- skill.completed \
  --skill frontend-builder \
  --runtime codex \
  --version 2.1.0 \
  --duration 82000 \
  --cost 0.12 \
  --outcome success
```

Events are appended to `data/events.jsonl`. Raw source code, transcripts, and host session identifiers are not collected.
Set `SKILLOPS_DATA_DIR` to keep the event file in another local directory.
The event store enforces this privacy boundary with an allowlist: unknown fields are discarded, numeric telemetry must be finite, and session IDs are replaced with stable per-install HMAC pseudonyms before persistence.

`skill.completed` without `--outcome success` is intentionally stored as `outcome: "unknown"`: completion proves the lifecycle ended, not that acceptance criteria passed. Use `--outcome success` only when a real evaluator or acceptance test supplied that result. `skill.failed` is always normalized to `outcome: "failed"`; contradictory event/outcome combinations are rejected.

On the Runs page, **Import JSON or JSONL** validates the complete file and appends it to the same local event store. The import is atomic (one invalid record prevents the whole batch), existing event IDs are not duplicated, and imported data remains after a reload. Runs can be searched by Skill, run ID, or project and are paginated in groups of 20.

## Event schema

```json
{
  "id": "run_9f3a7c2d",
  "event": "skill.completed",
  "skillId": "frontend-builder",
  "skillVersion": "2.1.0",
  "runtime": "codex",
  "timestamp": "2026-07-18T14:30:00.000Z",
  "durationMs": 82000,
  "costUsd": 0.12,
  "sessionId": "hmac-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "project": "web-console",
  "outcome": "unknown"
}
```

The important distinction is intentional: scanning proves a Skill is installed, while hooks prove it was actually invoked. A model considering a Skill but not invoking it cannot be inferred reliably without a router-level `skill.matched` event.

Lifecycle-only completions (`outcome: "unknown"`) are displayed as **Lifecycle only**, not as a success percentage. They prove that execution ended but do not claim the result passed an acceptance test. Evaluated events with known outcomes continue to produce success-rate metrics.
