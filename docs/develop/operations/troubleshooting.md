# Troubleshooting SkillOps

> Applies to: v0.3.2-rc.1

## 1. Dashboard does not open

### Symptom

`http://127.0.0.1:5173/` refuses connection.

### Checks

```powershell
npm install
npm run dev
```

Look for another process using the port:

```powershell
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
```

For production-style mode, build before start and use port 4173:

```powershell
npm run build
npm start
```

## 2. Dashboard shows Demo data

Demo mode means the initial `/api/events` request failed. It does not mean real
history is empty.

Check:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/api/events'
```

Restart the Vite/Node process and inspect terminal errors. A successful empty
response is `[]` and should render Local zero state.

## 3. Registry scan returns `405 Method not allowed`

`/api/scan` is POST-only.

Correct PowerShell request:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:5173/api/scan'
```

## 4. Registry finds no Skills

Confirm the runtime homes and project working directory are the ones SkillOps
should scan. Common locations include:

```text
~/.agents/skills
~/.codex/skills
~/.claude/skills
~/.claude/commands
~/.cursor/skills
<project>/.agents/skills
<project>/.codex/skills
<project>/.claude/skills
<project>/.claude/commands
<project>/.cursor/skills
```

Run `npm run scan` from the intended project root. For Claude Code managed by CC
Switch, verify its effective `claude_config_dir` and synchronization mode.

## 5. Counts look duplicated

One Skill name may have multiple valid definitions:

- Codex and Claude Code each have their own runtime definition;
- global and project locations may both define the name;
- an active plugin can overlap a direct global or project definition;
- Claude legacy commands count as definitions but not unique Skills.

Use Registry's runtime workspace first, then source/provider filters. A
**duplicate** means enabled definitions in one runtime share the same normalized
name and content hash. A **conflict** means those enabled definitions have
different normalized contents, even if their version strings are equal. The
two labels are mutually exclusive. Disabled definitions remain visible but do
not create either label.

For Codex plugins, Registry scans only Codex's active cache version (`local`
first, otherwise the highest valid semantic version; lexical maximum only when
no valid semantic version exists), so an obsolete cache directory is not a
second enabled definition. If a direct Codex Skill should remain installed but
inactive, add its containing Skill directory under `[[skills.config]]` with
`enabled = false` and rescan. The current trusted project's
`.codex/config.toml` overrides matching user entries. For Claude plugin
disagreement, compare `~/.claude/settings.json`, project
`.claude/settings.json`, `.claude/settings.local.json`, and file-managed policy
in that order. Use Claude `/status` for server-managed or MDM policy that the
filesystem scanner cannot inspect.

## 6. Adapter says Not installed

Run the corresponding dry-run and install command from the current SkillOps
repository, then restart the runtime:

```powershell
npm run codex:dry-run
npm run codex:install

npm run claude:dry-run
npm run claude:install
```

For Claude Code, a CC Switch provider change may have replaced the effective
settings file. Reinstalling is idempotent.

## 7. Adapter says Broken

The config contains SkillOps markers but one or more referenced `.mjs` files do
not exist. This often happens after moving or renaming the SkillOps repository.

Reinstall from the current path:

```powershell
npm run codex:install
npm run claude:install
```

Then refresh Settings. Do not manually delete unrelated hooks.

## 8. Adapter says Installed but no activity appears

Installed verifies configuration, not hook execution.

Checklist:

1. Restart the runtime after installation.
2. Review `/hooks`; trust Codex hooks if required.
3. Explicitly invoke a known Skill rather than relying on implicit selection.
4. Complete the turn so a terminal hook can fire.
5. Check the correct runtime and time range.
6. Use the recording-check script with `--since` and optional `--session`.
7. Inspect local adapter error logs under `data/`.

Codex cannot prove an implicit Skill use when neither an explicit Skill name nor
an observable Skill file read exists.

## 9. Claude Code works in one provider but not another

CC Switch can replace the live Claude settings when providers change. Confirm
which `claude_config_dir` is effective. Use Common Config to share hooks, or run
the installer after switching providers. If managed policy enables
`allowManagedHooksOnly`, request administrator deployment.

## 10. Events show Lifecycle only instead of success

This is expected for normal completion hooks. A host `Stop` event does not know
whether the user's acceptance criteria passed. Only a trusted evaluator/manual
integration should emit `outcome: success`.

Do not edit lifecycle-only records just to produce a success percentage.

## 11. Import fails

Common causes:

- file is empty;
- JSONL has malformed JSON on the reported line;
- top-level JSON is not an array;
- unsupported event/runtime/outcome;
- Skill event lacks `skillId`;
- timestamp is invalid;
- numeric field is not finite;
- `skill.completed` contradicts `outcome: failed`.

The batch is atomic. Fix the reported record and retry; no earlier records from
the failed batch were appended.

## 12. Event file has a partial line

Readers ignore a malformed line and keep valid records available. The next
append repairs a missing trailing newline before writing. Preserve the file for
diagnosis, export valid events, and only perform cleanup after making a backup.

## 13. Event history grows too large

Automatic retention is not implemented. Use Settings to export, then clear with
a backup. Check for accumulated `events.jsonl.backup-*` files; remove them only
after resolving exact paths and confirming they are no longer needed.

## 14. Production server is reachable from another machine

Expected default binding is `127.0.0.1`. Check whether `SKILLOPS_HOST` was set:

```powershell
Get-Item Env:SKILLOPS_HOST -ErrorAction SilentlyContinue
```

Stop the server and restore loopback binding. The local HTTP interface has no
authentication and must not be exposed to untrusted networks.

## 15. Build or tests fail after moving folders

Check all path consumers:

- package scripts;
- Vite frontend root and backend middleware imports;
- TypeScript include paths;
- adapter imports and installed absolute hook paths;
- CLI/script imports;
- smoke-test server path.

Then run:

```powershell
npm test
npm run build
npm run smoke
```

If adapter paths changed, reinstall both affected hooks.

## 16. Safe diagnostic bundle

When reporting a problem, include only:

- SkillOps version and Node version;
- operating system;
- command and exit code;
- runtime name and connection status;
- sanitized event type/ID/timestamp/detection method;
- whether data directory or runtime home is overridden.

Do not paste prompts, transcripts, environment values, credentials, complete
runtime settings, or private source paths unless explicitly required and safe.
