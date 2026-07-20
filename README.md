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
- Runtime connection guidance and a version evaluation surface.

## Project structure

```text
app/
  backend/             Local API, event storage, Skill scanning, runtime health
  frontend/skillops/   React/Vite dashboard
  shared/              Normalized event schema shared across application layers
adapters/               Codex and Claude Code runtime adapters
bin/                    SkillOps CLI
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

The sidebar appearance control switches the complete dashboard between light
and dark themes. SkillOps follows the operating-system preference until the
user makes a choice, then stores that choice locally and restores it before the
next page is painted.

The main surfaces have reload-safe URLs: `/skills`, `/runs`, `/evaluations`, `/registry`, and `/settings`. Events refresh from the local store every three seconds, while runtime connection health refreshes every five seconds. Unchanged event polls use ETags and return an empty `304` response instead of transferring and parsing the full history again.

For a production-style local build:

```bash
npm run build
npm start
```

Open `http://localhost:4173`.

The production server binds to `127.0.0.1` by default so the unauthenticated local event API is not exposed to the LAN. Set `SKILLOPS_HOST` explicitly only when you intentionally need another bind address and have added an appropriate access-control boundary.

## Scan installed Skills

```bash
npm run scan
```

The scanner checks these conventional locations when they exist:

- `~/.agents/skills`
- `~/.codex/skills`
- `~/.claude/skills`
- `~/.claude/commands` (legacy custom commands)
- `~/.cursor/skills`
- Project-local `.agents/skills`, `.codex/skills`, `.claude/skills`, `.claude/commands`, and `.cursor/skills`
- Enabled Codex plugin Skill directories registered beneath `~/.codex/plugins/cache`
- Installed Claude Code plugin Skill and command directories registered by `installed_plugins.json`

The Registry page reports unique enabled Skill names separately from enabled definitions, commands, plugin definitions, and disabled definitions. Runtime connection status is read from the current Codex and Claude Code hook configuration files rather than inferred from historical events. A configuration that still contains SkillOps entries but points to a missing hook script is reported as **Broken**.

The Evaluations page is an explicitly labeled local sample. Its comparison and promotion controls update sample UI state only; they do not install, deploy, or modify a runtime Skill.

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

Events are appended to `data/events.jsonl`. Raw source code and transcripts are not collected.
Set `SKILLOPS_DATA_DIR` to keep the event file in another local directory.
The event store enforces this privacy boundary with an allowlist: unknown fields are discarded and numeric telemetry must be finite.

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
  "sessionId": "session-123",
  "project": "web-console",
  "outcome": "unknown"
}
```

The important distinction is intentional: scanning proves a Skill is installed, while hooks prove it was actually invoked. A model considering a Skill but not invoking it cannot be inferred reliably without a router-level `skill.matched` event.

Lifecycle-only completions (`outcome: "unknown"`) are displayed as **Lifecycle only**, not as a success percentage. They prove that execution ended but do not claim the result passed an acceptance test. Evaluated events with known outcomes continue to produce success-rate metrics.
