# Getting started and local operations

> Applies to: SkillOps v0.3.2-rc.1

## 1. Prerequisites

- Node.js 22.22 or newer (required by the pinned Promptfoo runtime).
- npm with access to the dependencies in `package-lock.json`.
- Windows, macOS, or Linux filesystem access to the runtime's user config.
- Codex and/or Claude Code only if you want real runtime collection.

No account, database, container, or remote collector is required.

## 2. Install and run development mode

From the repository root:

```powershell
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

Vite serves the frontend and the local event interface in one process.

## 3. Production-style local mode

```powershell
npm run build
npm start
```

Open:

```text
http://127.0.0.1:4173/
```

`npm start` requires a current `dist/`. Rebuild after frontend changes.

## 4. Connect runtimes

### Codex

```powershell
npm run codex:dry-run
npm run codex:install
```

Restart Codex, inspect `/hooks`, and trust the definitions when prompted.

### Claude Code

```powershell
npm run claude:dry-run
npm run claude:install
```

Restart Claude Code and inspect `/hooks`.

Dry-run is the required first step on a machine with existing hook settings. It
shows the intended merge without writing, while redacting sensitive existing
configuration from terminal output.

## 5. Verify connection and activity

Config health in PowerShell:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:5173/api/connections'
```

Live inventory:

```powershell
$skills = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:5173/api/scan'
$skills.Count
$skills | Group-Object runtime, source | Select-Object Name, Count
```

Real recording check:

```powershell
node scripts/check-skill-recording.mjs `
  --skill grill-me `
  --runtime codex `
  --since 2026-07-20T00:00:00.000Z
```

The script exits nonzero when it finds no non-discovery execution evidence.

## 6. Scan definitions from the CLI

```powershell
npm run scan
```

This reports installed definition count and appends only previously unseen
`skill.discovered` records. The Registry page instead performs a live scan
without turning every rescan into execution telemetry.

## 7. Emit a controlled lifecycle event

```powershell
npm run emit -- skill.started --skill example --runtime codex --version 1.0.0
npm run emit -- skill.completed --skill example --runtime codex --version 1.0.0 --duration 1500
```

Supported CLI event names are the six `skill.*` lifecycle events. Supported
runtimes are `codex`, `claude-code`, and `cursor`.

Manual events prove only that the emitter path works. They are not native host
runtime evidence unless a trusted integration executed the command.

## 8. Data directory

Default:

```text
<repository>/data
```

Override for an isolated environment:

```powershell
$env:SKILLOPS_DATA_DIR = 'D:\SkillOpsData\work'
npm run dev
```

Use a new directory for tests that must not touch real history. Do not point it
at a broad system or workspace root.

## 9. Host and port configuration

Production server only:

```powershell
$env:PORT = '4300'
$env:SKILLOPS_HOST = '127.0.0.1'
npm start
```

Do not set `SKILLOPS_HOST` to `0.0.0.0` or a LAN address unless an explicit
access-control layer has been added. The HTTP interface has no authentication.

## 10. Import, export, and clear

- Import JSON/JSONL from Runs.
- Export current normalized JSONL from Settings.
- Clear from Settings only after reviewing the confirmation.
- Clear creates a backup beside `events.jsonl` before replacing the active file.

Backups remain local and count toward storage usage.

## 11. Disconnect

```powershell
npm run codex:uninstall
npm run claude:uninstall
```

Restart the affected runtime and refresh Settings.

## 12. Managed evaluation

Suites and datasets under `evals/` are reviewed repository source. List and run
them without opening the UI:

```powershell
npm run eval:list
npm run eval:run -- --suite deterministic-smoke --baseline baseline-fixture --candidate candidate-fixture --deterministic --summary artifacts/evaluation-summary.json --html artifacts/evaluation-report.html
npm run eval:verify -- --run <run-id>
```

`eval:run` emits a deterministic summary and can emit JSON, JUnit, and a
read-only HTML report for CI. `--timeout-ms` overrides the ten-minute run
timeout. Provider credentials are accepted for that child process only and are
not written into the evidence store. The production History view exposes the
same sanitized JSON/HTML reports and the Governance route.

The Local Prompt Registry reads committed `prompts/*.prompt.json` files from the
current Git repository. Set `SKILLOPS_PROMPT_WORKSPACE` before `npm run dev` or
`npm start` to use another local repository; optionally set the repository-
relative `SKILLOPS_PROMPT_DIRECTORY`. It needs no hosted account or registry API
key. See the [Prompt Registry contract](../integrations/prompt-registry.md).

## 13. Governed project templates

Preview a reviewed Team Template Manifest before applying it:

```powershell
npm run template:init -- --manifest <team-template.json> --target <project> --mode greenfield
npm run template:init -- --manifest <draft.json> --hash
npm run template:init -- --manifest <team-template.json> --target <project> --mode migration
npm run template:init -- --manifest <team-template.json> --target <project> --mode migration --apply
npm run template:init -- --manifest <team-template.json> --target <project> --status
npm run template:init -- --manifest <team-template.json> --target <project> --rollback --apply
```

`greenfield` and `adopt-existing` reject divergent existing files. `migration`
and rollback require a clean, non-default Git review branch. Migration runs
every affected Managed Suite before writing and leaves an ordinary Git Diff;
it never commits. The metadata-only project lock binds the exact Stable
template, Artifact sources, evidence, approval, and previous Stable commit.

## 14. Command reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite development UI + local HTTP interface |
| `npm test` | Full automated test suite |
| `npm run build` | TypeScript build + production assets |
| `npm start` | Loopback production-style server |
| `npm run smoke` | Spawn production server and verify core behavior |
| `npm run scan` | Scan and record new discoveries |
| `npm run emit -- ...` | Append one controlled Skill event |
| `npm run eval:list` | List validated Managed Suites |
| `npm run eval:run -- --suite <id> ...` | Run a Managed Suite through Promptfoo |
| `npm run eval:verify -- --run <run-id>` | Verify stored evidence identity and gates |
| `npm run template:init -- --manifest <file> ...` | Preview/apply/status/rollback a governed Team project template |
| `npm run codex:*` | Preview/install/remove Codex adapter |
| `npm run claude:*` | Preview/install/remove Claude Code adapter |

## 15. Normal shutdown

Stop Vite or the production server with `Ctrl+C`. Hooks can continue appending
directly to the local event store even while the dashboard is closed, provided
their installed paths still point to the current SkillOps repository.
