# Claude Code adapter

The SkillOps Claude Code adapter observes native lifecycle hooks and writes normalized metadata to the local `data/events.jsonl` store.

## Install

Preview the merged settings without writing anything:

```bash
npm run claude:dry-run
```

The preview preserves setting names while redacting existing `env` values and credential-like settings from terminal output.

Install for your user account. Resolution order is `--claude-home`, `CLAUDE_CONFIG_DIR`, CC Switch's `claude_config_dir`, then `~/.claude`:

```bash
npm run claude:install
```

Or install into one project:

```bash
npm run claude:install -- --scope project --target /absolute/path/to/project
```

Use `--scope local` instead of `project` to write `.claude/settings.local.json`, which is appropriate for an uncommitted per-project setup.

Restart Claude Code after installation, then run `/hooks` to verify that the SkillOps definitions are loaded. Start the dashboard from the SkillOps directory in a second terminal:

```bash
npm run dev
```

## What is observed

| Claude Code signal | SkillOps event | Detection |
| --- | --- | --- |
| `SessionStart` / `SessionEnd` | `session.started` / `session.completed` | Exact |
| `SessionStart` inventory scan finds `CLAUDE.md` / `.claude/rules/*.md` | Rules discovery only | Definition presence; Claude Code exposes no Rule-load lifecycle signal |
| `UserPromptSubmit` | `prompt.submitted` | Exact; length only |
| `UserPromptExpansion` for `/skill-name` | `skill.matched`, `skill.started` | Exact |
| `PreToolUse` with the `Skill` tool | `skill.matched`, `skill.started` | Exact |
| A tool input references `skills/<name>/SKILL.md` | `skill.matched`, `skill.started` | Heuristic, confidence `0.92` |
| `PostToolUse` / `PostToolUseFailure` | `tool.completed` | Exact lifecycle outcome |
| `SubagentStart` / `SubagentStop` | `subagent.started` / `subagent.completed` | Exact |
| `SubagentStart` matching `.claude/agents/*.md` | Agent match + start | Exact definition match |
| `Stop` / `StopFailure` | terminal Skill and turn events | Exact lifecycle boundary |

Normal `Stop` events produce `skill.completed` with `outcome: "unknown"`. This means the Skill finished running, not that its output passed an evaluation. `StopFailure` produces `skill.failed`. Keep task acceptance tests and A/B evaluations separate from lifecycle telemetry.

Rules remain discovery-only. Inventory presence does not prove that Claude Code loaded or applied a particular Rules file.

The scanner covers Skills, legacy custom-command Workflows, Rules, and Agents:

- `~/.claude/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`
- `~/.claude/commands/<name>.md` and `.claude/commands/<name>.md`
- `~/.claude/CLAUDE.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md`
- `~/.claude/agents/<name>.md` and `.claude/agents/<name>.md`

When `CLAUDE_CONFIG_DIR` or CC Switch's `claude_config_dir` is set, global
assets and `settings.json` are resolved beneath that directory. CC
Switch-managed Skills are scanned from Claude Code's effective `skills`
directory, including the links produced by CC Switch's `auto` and `symlink`
synchronization modes. This avoids reporting an SSOT Skill as Claude-enabled
before CC Switch has actually synchronized it.

Plugin enablement follows Claude Code's file precedence: user
`settings.json`, shared project `settings.json`, project
`settings.local.json`, then system `managed-settings.json` and ordered
`managed-settings.d/*.json` drop-ins. Server-managed settings, macOS/Windows
MDM policy, and Windows registry policy are not exposed through the filesystem
scanner; verify those sources with Claude Code `/status` when Dashboard and the
runtime disagree.

## Privacy and performance

SkillOps does not store prompt text, command arguments, tool inputs, tool outputs, transcripts, last assistant messages, raw host session IDs, or raw error details. It stores per-install HMAC session pseudonyms, timestamps, runtime metadata, lengths, lifecycle outcomes, and discovered Skill paths.

High-frequency generic hooks run asynchronously. The hooks that must establish or close exact Skill state run synchronously to prevent lifecycle races. Adapter errors are written locally and never block Claude Code.

## Safe configuration behavior

The installer:

- preserves unrelated settings and hook handlers;
- removes an older SkillOps handler before merging, so repeat installs are idempotent;
- creates a timestamped backup before changing an existing settings file;
- supports user, shared-project, and project-local scopes;
- never modifies any `SKILL.md` file.

CC Switch provider changes replace Claude Code's live `settings.json`. SkillOps checks that effective file whenever connections refresh. If Claude Code changes to **Not installed** after a provider switch, rerun `npm run claude:install`; the merge is idempotent and preserves unrelated settings. CC Switch's Common Config can also keep hooks shared across providers.

If your organization enables `allowManagedHooksOnly`, user or project hooks can be blocked by managed policy. In that case, an administrator must distribute SkillOps as an approved managed or plugin hook.

## Uninstall

```bash
npm run claude:uninstall
```

Use the same `--scope` and `--target` arguments used during installation. Uninstall removes only handlers marked `skillops-claude-hook`.
