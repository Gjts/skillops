# Runtime adapters: Codex and Claude Code

> Version: v0.3.1
> Status: Codex and Claude Code implemented; Cursor preview

## 1. Adapter role

Each adapter sits at the runtime-event seam. It translates host-specific hook
payloads into the normalized SkillOps event interface and installs/removes only
its own marked configuration.

Shared guarantees:

- telemetry failures do not block the host runtime;
- raw prompt/tool/transcript/source content is not persisted;
- unrelated config and hooks are preserved;
- preview output redacts credential-like existing settings;
- repeated installation is idempotent;
- uninstall removes SkillOps-marked handlers only.

## 2. Command overview

| Runtime | Preview | Install | Uninstall |
| --- | --- | --- | --- |
| Codex | `npm run codex:dry-run` | `npm run codex:install` | `npm run codex:uninstall` |
| Claude Code | `npm run claude:dry-run` | `npm run claude:install` | `npm run claude:uninstall` |
| Cursor | None | None | None |

Run commands from the SkillOps repository root.

## 3. Installation scopes

### User scope

Default for both adapters. Applies across projects for the current user.

### Shared project scope

```powershell
npm run codex:install -- --scope project --target D:\absolute\project
npm run claude:install -- --scope project --target D:\absolute\project
```

Codex loads project hooks only for trusted projects. Shared Claude settings are
written to `.claude/settings.json`.

### Claude local project scope

```powershell
npm run claude:install -- --scope local --target D:\absolute\project
```

Writes `.claude/settings.local.json` for an uncommitted per-project setup.

Use identical scope and target arguments during uninstall.

## 4. Codex adapter

Authoritative detailed guide: `adapters/codex/README.md`.

### Config location

User installation merges handlers into `~/.codex/hooks.json` or
`$CODEX_HOME/hooks.json`. Existing files are backed up before mutation.

### Observed host signals

- `SessionStart`;
- `UserPromptSubmit`;
- `PreToolUse` / `PostToolUse`;
- `SubagentStart` / `SubagentStop`;
- `Stop`.

### Skill detection

| Signal | Method | Confidence/guarantee |
| --- | --- | --- |
| Explicit `$skill-name` matching an installed Skill | `explicit_prompt` | Exact, `1.0` |
| Actual tool command reads `.../skills/<name>/SKILL.md` | `skill_path` | Heuristic, `0.92` |
| Implicit internal selection with neither signal | None | Cannot be proven |

Codex has no dedicated generic Skill lifecycle hook. Normal `Stop` closes active
Skill lifecycle with `outcome: unknown`.

### Codex Desktop ingestion

When using Codex Desktop/VS Code, API refresh also inspects recent Codex session
records. It accepts only actual file-read tool commands containing a Skill path,
not arbitrary mentions in messages or outputs. This fallback uses stable IDs and
deduplication.

### Trust after installation

Restart Codex, open `/hooks`, inspect the commands, and trust the new/changed
definitions. Codex can intentionally skip untrusted hooks even when the config
file is correct.

## 5. Claude Code adapter

Authoritative detailed guide: `adapters/claude/README.md`.

### Effective config resolution

Resolution order:

1. explicit `--claude-home`;
2. `CLAUDE_CONFIG_DIR`;
3. CC Switch `claude_config_dir`;
4. `~/.claude`.

This applies to settings, global Skills, legacy commands, and plugin resolution.

### Observed host signals

| Claude Code signal | SkillOps event | Detection |
| --- | --- | --- |
| `SessionStart` / `SessionEnd` | session start/completion | Exact |
| `UserPromptSubmit` | prompt submitted | Exact, length only |
| `UserPromptExpansion` for `/skill-name` | match + start | Exact slash command |
| `PreToolUse` with `Skill` tool | match + start | Exact Skill tool |
| Tool input reads a Skill path | match + start | Heuristic `0.92` |
| `PostToolUse` / failure | tool completion | Exact lifecycle outcome |
| `SubagentStart` / `SubagentStop` | subagent lifecycle | Exact |
| `Stop` / `StopFailure` | terminal Skill/turn | Exact lifecycle boundary |

Normal `Stop` creates lifecycle-only completion. `StopFailure` creates failure.

### CC Switch compatibility

SkillOps reads Claude Code's effective home rather than assuming `~/.claude`.
It scans the effective Skills folder, including links produced by CC Switch
`auto` and `symlink` synchronization modes. Provider changes may replace the
live settings file. If Settings changes to **Not installed**, rerun the Claude
installer; its merge is idempotent. CC Switch Common Config can keep hooks
shared across providers.

Inventory plugin state follows user, project, local, and file-managed settings
precedence, including ordered `managed-settings.d` drop-ins. Server-managed,
MDM, registry, and dynamic policy sources are not readable through the ordinary
filesystem scanner; use Claude Code `/status` to resolve a disagreement.

### Managed policy limitation

An organization using `allowManagedHooksOnly` can block user/project hooks. An
administrator must then distribute SkillOps through an approved managed or
plugin hook. Local installation cannot bypass policy.

## 6. Cursor status

Cursor is represented in inventory scans and the dashboard, but the adapter is
**Preview** in v0.3.1. Manual `npm run emit` can create Cursor-labeled events for
integration testing, but this is not native runtime observation.

## 7. Connection-status interpretation

| UI status | Interpretation | Next action |
| --- | --- | --- |
| Installed | Config markers and referenced scripts are valid | Invoke a Skill and confirm activity |
| Not installed | No effective SkillOps handlers | Run dry-run, then install |
| Broken | Handler exists but script path is invalid | Reinstall from current repository path |
| Config error | Effective settings cannot be parsed/read | Repair config, then refresh |
| Unavailable | SkillOps connection API cannot be reached | Start/restart local server |
| Preview | No production adapter | Do not treat as connected |

An Installed status with zero events is valid: configuration exists, but no
non-discovery lifecycle has been observed.

## 8. Real end-to-end verification

For each connected runtime:

1. Start SkillOps and confirm `/api/connections` says installed.
2. Record an ISO start time.
3. Explicitly invoke one known Skill.
4. Allow the runtime turn to reach a terminal hook.
5. Run:

```powershell
node scripts/check-skill-recording.mjs `
  --skill known-skill `
  --runtime claude-code `
  --since 2026-07-20T00:00:00.000Z
```

6. Inspect the returned events for runtime, session, detection method, and time.
7. Do not accept `skill.discovered` as a passing result.

## 9. Privacy map

| Host information | Persisted? |
| --- | --- |
| Prompt text | No |
| Prompt length | May be |
| Skill name/version/path | Yes |
| Skill argument text | No |
| Skill argument length | May be |
| Tool name and lifecycle ID | May be |
| Tool input/output | No |
| Transcript/model output | No |
| Source code | No |
| Raw provider config/env values | No |
| Session/turn/subagent identifiers | May be |

## 10. Adapter change checklist

- [ ] Dry-run output contains no secret values.
- [ ] Install preserves unrelated config and creates backup when needed.
- [ ] Repeat install produces no duplicate handler.
- [ ] Hook errors do not change host-runtime exit behavior.
- [ ] Only allowlisted metadata reaches the event store.
- [ ] Detection method/confidence matches the actual signal.
- [ ] Normal completion remains unknown unless evaluated.
- [ ] Uninstall removes only the adapter marker.
- [ ] Real non-discovery activity is verified after changes.
