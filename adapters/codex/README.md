# Codex adapter

The adapter observes Codex lifecycle hooks and writes privacy-minimized events to SkillOps. It stores identifiers and metadata, not prompt content, tool arguments, tool results, transcripts, or source code.

## Install for every Codex project

```bash
npm run codex:dry-run
npm run codex:install
```

The installer merges handlers into `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) and preserves unrelated hooks. When a hooks file already exists, it creates a timestamped backup first.

Restart Codex, run `/hooks`, review the exact commands, and trust the new SkillOps definitions. Codex intentionally skips new or changed non-managed hooks until they are trusted.

## Install for one trusted project

Run this from the SkillOps directory and replace the target path:

```bash
npm run codex:install -- --scope project --target /absolute/path/to/repository
```

Codex loads project-local `.codex/hooks.json` only for trusted projects.

## Uninstall

```bash
npm run codex:uninstall
```

This removes handlers containing the `skillops-codex-hook` marker and leaves every other handler intact.

## Detection guarantees

- Explicit `$skill-name` references matching an installed Skill: exact, confidence `1.0`.
- A `.../skills/<name>/SKILL.md` path in a local tool call: high-confidence inference, confidence `0.92`.
- Codex has no dedicated Skill lifecycle hook, so implicit internal selection that exposes neither signal cannot be proven.
- `Stop` proves that a turn ended, not that the Skill succeeded. These records use `outcome: "unknown"` and do not affect the success-rate denominator.

## Observed Codex events

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse` / `PostToolUse`
- `SubagentStart` / `SubagentStop`
- `Stop`

Adapter failures are swallowed so telemetry never blocks Codex. Diagnostics, if any, go to `data/codex-adapter-errors.log`.

The inventory scanner also reads `[[skills.config]]` entries from the effective
Codex home's `config.toml`. A definition whose exact `SKILL.md` path is set to
`enabled = false` remains visible in Registry as disabled and does not create a
duplicate or conflict. For plugin Skills, a disabled plugin always wins over a
per-Skill `enabled = true` entry.
