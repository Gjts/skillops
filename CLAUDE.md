# Claude Code project guide

SkillOps is a single-package local observability application for Codex and
Claude Code Skill usage. Read `AGENTS.md` first; it is the authoritative
operating guide for repository layout, commands, privacy, and verification.
Use `docs/README.md` to select the product, architecture, event, adapter,
operations, security, or roadmap document relevant to the change.

## Working layout

- `app/frontend/skillops/`: React/Vite dashboard.
- `app/backend/`: loopback server, event store, Skill scanner, runtime health.
- `app/shared/`: normalized event schema shared by frontend and backend.
- `adapters/claude/` and `adapters/codex/`: native runtime hook adapters.
- `bin/`: CLI.
- `scripts/`: smoke and recording checks.
- `data/`: generated local telemetry; never commit it.

Run commands from the repository root:

```powershell
npm run dev
npm test
npm run build
npm run smoke
```

Do not store raw prompts, transcripts, tool payloads, source code, secrets, or
raw provider configuration. A discovered Skill is not proof of invocation;
execution claims require real lifecycle events from the runtime adapter.
