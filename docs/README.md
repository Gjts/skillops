# SkillOps documentation

> Version: v0.3.1
> Baseline date: 2026-07-20
> Product state: runnable local MVP

This directory is the source of truth for SkillOps product intent, implemented
behavior, architecture, operations, privacy, and planned work. Its information
architecture follows the RoleGarden reference project while adapting it to a
local-first runtime observability product.

## Start here

| Reader | Recommended document |
| --- | --- |
| First-time user | [User guide](product/user-guide.md) |
| Contributor preparing a commit | [Commit convention](commit-convention.md) |
| Product or UX contributor | [Product requirements](product/prd.md) |
| Engineer changing module layout | [System architecture](develop/architecture/system_architecture.md) |
| Backend contributor | [Backend architecture](develop/architecture/backend_architecture.md) |
| Frontend contributor | [Frontend architecture](develop/architecture/frontend_architecture.md) |
| Event producer or importer | [Event model](develop/data/event_model.md) |
| Codex or Claude Code operator | [Runtime adapters](develop/integrations/runtime_adapters.md) |
| Local operator | [Getting started](develop/operations/getting_started.md) |
| Tester | [Testing and QA](develop/operations/testing.md) |
| Someone diagnosing a failure | [Troubleshooting](develop/operations/troubleshooting.md) |
| Security or privacy reviewer | [Privacy and security](develop/security/privacy-security.md) |
| Planner | [Roadmap](develop/roadmap/roadmap.md) and [task ledger](develop/roadmap/task.md) |

## Documentation map

```text
docs/
├─ README.md
├─ commit-convention.md
├─ product/
│  ├─ prd.md
│  └─ user-guide.md
└─ develop/
   ├─ architecture/
   │  ├─ system_architecture.md
   │  ├─ backend_architecture.md
   │  └─ frontend_architecture.md
   ├─ data/
   │  └─ event_model.md
   ├─ integrations/
   │  └─ runtime_adapters.md
   ├─ operations/
   │  ├─ getting_started.md
   │  ├─ testing.md
   │  └─ troubleshooting.md
   ├─ security/
   │  └─ privacy-security.md
   └─ roadmap/
      ├─ roadmap.md
      └─ task.md
```

## Status vocabulary

- **Implemented**: present in the current source and covered by code or manual verification.
- **Preview**: visible in the UI but deliberately does not mutate real systems.
- **Planned**: an intended capability that is not available yet.
- **Limitation**: behavior that cannot currently be guaranteed.

Documents must use these labels explicitly. A roadmap item is never evidence
that a feature exists, and a discovered Skill is never evidence that it ran.

## Maintenance rules

1. Update the relevant document in the same change as an interface, command,
   schema, directory, privacy guarantee, or runtime-detection change.
2. Describe current behavior in present tense and planned behavior in future
   tense under a **Planned** heading.
3. Prefer links to the authoritative adapter README or source module instead of
   duplicating volatile hook payload details.
4. Verify every documented command from the repository root.
5. Keep examples free of real prompts, transcripts, credentials, and user data.
