# SkillOps Agent Operating Guide

## Current project facts

SkillOps is a runnable local-first observability dashboard for Skill usage in
Codex and Claude Code. It contains a React/Vite frontend, a loopback-only Node
server, runtime hook adapters, a CLI, and automated tests.

The repository is a single npm package. Keep the root `package.json` as the
small interface for development, build, test, adapter installation, and CLI
operations. Do not create nested packages unless a real independent deployment
or dependency boundary appears.

## Required reading

Before changing architecture or runtime collection behavior, read:

1. `README.md` for supported workflows and product guarantees.
2. `docs/README.md` for the documentation map and
   `docs/develop/architecture/system_architecture.md` for directory
   responsibilities and dependency direction.
3. The relevant adapter README under `adapters/<runtime>/README.md` for hook,
   privacy, and installation behavior.

Before preparing any commit, read `docs/commit-convention.md`. Do not stage,
commit, push, or open a PR unless the user explicitly requests that action.

## Directory map

```text
.
├─ app/
│  ├─ backend/             # Local API, event store, scanning, runtime health
│  ├─ frontend/skillops/   # React UI and Vite entry document
│  └─ shared/              # Event normalization shared across frontend/backend
├─ adapters/
│  ├─ claude/              # Claude Code hook and installer
│  └─ codex/               # Codex hook and installer
├─ bin/                    # SkillOps CLI
├─ docs/
│  ├─ product/             # PRD and user workflows
│  └─ develop/             # Architecture, data, integrations, operations, security, roadmap
├─ scripts/                # Smoke and real-recording verification helpers
├─ data/                   # Generated local telemetry; ignored by Git
├─ package.json            # Single command and dependency interface
├─ vite.config.ts          # Frontend build plus development API middleware
└─ tsconfig*.json          # Root TypeScript build configuration
```

`data/`, `.opc/`, build output, caches, credentials, and user telemetry are
local runtime state, not product source. Never stage or commit them.

## Commands

Run every authoritative command from the repository root:

```powershell
npm run dev
npm test
npm run build
npm run smoke
npm start
npm run scan
```

Adapter commands are also root-scoped:

```powershell
npm run codex:dry-run
npm run codex:install
npm run codex:uninstall
npm run claude:dry-run
npm run claude:install
npm run claude:uninstall
```

Moving an adapter changes the absolute hook command installed in the user's
runtime configuration. If an adapter path changes, reinstall it and verify
`/api/connections` before reporting completion.

## Architecture rules

- `app/backend/` owns filesystem and process integration. Frontend code must
  call its local HTTP interface rather than import backend implementation.
- `app/frontend/skillops/` owns rendering, routing, interaction, and client-side
  analysis. It must not read user runtime files directly.
- `app/shared/` is limited to behavior genuinely used on both sides. Do not turn
  it into a miscellaneous utilities directory.
- `app/backend/skill-evaluations.mjs` is a compatibility facade. Evaluation
  source, provider, session, request-guard, and Artifact behavior belongs under
  `app/backend/evaluations/`; callers should not depend on those internals.
- `adapters/` translate external runtime hook payloads into the normalized event
  interface. They must never block Codex or Claude Code because telemetry failed.
- `bin/` and `scripts/` call the same backend modules as the application; do not
  duplicate event validation or Skill scanning logic.

## Privacy and safety

SkillOps stores normalized metadata only. Do not persist prompts, transcripts,
tool inputs, tool outputs, source code, raw error details, or tokens in the
event store. Provider credentials and AI configuration may be stored only in
the explicit Skill Lab file `data/ai-settings.json` (under `SKILLOPS_DATA_DIR`)
after the user saves settings; never write them into events, exports,
diagnostics, or logs. Preserve the event allowlist in
`app/shared/event-schema.mjs` and cover privacy changes with tests.

The HTTP server binds to loopback by default. Do not expose the unauthenticated
event API to a LAN or public interface without an explicit access-control seam.

Quick Compare remains memory-only. Managed Suites are explicit, reviewed
product files under `evals/`, never telemetry-derived content. Evaluation
evidence may persist only sanitized summaries and hashes, never provider keys,
prompt/Skill bodies, task text, workspace excerpts, raw outputs, or raw errors.
Promptfoo integrations must disable cache, telemetry, update checks, sharing,
and remote generation and must use an isolated temporary config directory.
The Local Prompt Registry reads only committed files from a configured Git
workspace. SkillOps may persist their immutable references, semantic/component
hashes, and sanitized evidence, but never Prompt bodies. Registry code must not
edit Prompt files, mutate branches, create commits, or call a hosted Prompt
management service.

Installer updates must preserve unrelated runtime settings, redact secrets from
previews, create recoverable backups when changing existing files, and be
idempotent when the desired configuration is already present.

## Verification

For code or structure changes, run in this order:

1. The narrowest relevant test file.
2. `npm test`.
3. `npm run build`.
4. `npm run smoke` when server, build, routing, or API behavior changed.
5. `git diff --check` and `git status --short --branch`.

For adapter changes, also run the corresponding dry-run and inspect
`/api/connections`. Do not claim a Skill execution passed merely because a
discovery event exists; require a real non-discovery lifecycle event.

## Agent conduct

- Preserve unrelated user changes and local runtime data.
- Prefer small, reversible changes and one authoritative implementation per
  behavior.
- Do not commit, push, rewrite history, or delete runtime data unless the user
  explicitly requests it.
- Keep this guide, `docs/README.md`, and the relevant `docs/develop/` documents
  synchronized with real filesystem, interface, privacy, and command changes.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **skillops** (947 symbols, 1806 relationships, 80 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/skillops/context` | Codebase overview, check index freshness |
| `gitnexus://repo/skillops/clusters` | All functional areas |
| `gitnexus://repo/skillops/processes` | All execution flows |
| `gitnexus://repo/skillops/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
