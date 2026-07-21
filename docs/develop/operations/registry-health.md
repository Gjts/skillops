# Registry health and Skill collision handling

> Status: implemented

This document defines the Registry rules used to distinguish shared names,
duplicates, conflicts, disabled definitions, and incomplete records. The rules
are deterministic and do not claim that one same-name definition automatically
wins.

## Identity and grouping

A definition is one runtime, definition type, and normalized source path. A
collision group uses the runtime plus the case-insensitive, trimmed Skill or
command name. Therefore:

- the same name in Codex and Claude Code is **shared**, not a collision;
- a Skill and legacy command with the same invocation name in one runtime share
  a collision group;
- disabled or incomplete definitions remain visible but are not collision
  candidates;
- Windows drive paths are compared case-insensitively after slash
  normalization; Unix paths remain case-sensitive.

Historical discovery rows without a known path use a structured fallback made
from normalized Skill name, source, provider, and exact version. `path:` and
`historical:` identities use separate namespaces, so a known path cannot
collide with that fallback.

## Health classification

| Label | Exact rule | Operator action |
| --- | --- | --- |
| Duplicate | Two or more enabled definitions have the same runtime, normalized name, and normalized content hash. Historical discovery rows without hashes fall back to exact version-string equality. | Select one canonical team path; disable or uninstall the redundant definition. |
| Conflict | Two or more enabled definitions have the same runtime and normalized name but different normalized content hashes. Historical discovery rows without hashes fall back to differing exact version strings. | Evaluate both definitions, approve one immutable hash, then disable the other definition or plugin. |
| Disabled | Runtime configuration explicitly makes the definition unavailable. | Leave it alone if intentional; otherwise change the owning runtime setting and rescan. |
| Missing | Name or source location could not be established. | Repair the definition metadata or rescan from the correct project root. |
| Shared | An enabled Skill name exists in more than one runtime. | No action unless the team wants cross-runtime parity. |

Conflict and duplicate are mutually exclusive. Disabled is excluded from both,
but disabled and missing may appear together because they describe independent
facts.

Content hashes are SHA-256 digests of the local UTF-8 definition after removing
a leading BOM and normalizing CRLF or CR to LF. The scanner returns the digest,
not the Skill body.

## Effective enablement

### Codex

1. Direct Skills are discovered from supported global and project locations.
2. Plugin state from the Codex config applies to the plugin as a whole.
3. The plugin cache contributes one active version: `local` when present;
   otherwise the highest valid semantic version, or the lexical maximum only
   when no valid semantic version exists.
4. Plugin and `[[skills.config]]` entries are merged from the user config, then
   the current trusted project's `.codex/config.toml`; project entries win.
5. `[[skills.config]]` applies to the exact normalized Skill directory that
   contains `SKILL.md`.
6. A disabled plugin remains disabled even if a per-Skill entry says
   `enabled = true`.

Codex intentionally presents same-name Skills separately rather than merging
them. SkillOps therefore reports the collision and does not invent an
“effective winner.”

### Claude Code

Plugin `enabledPlugins` values are applied from lowest to highest file
precedence:

1. user `~/.claude/settings.json`;
2. project `.claude/settings.json`;
3. local `.claude/settings.local.json`;
4. system `managed-settings.json`;
5. alphabetically ordered `managed-settings.d/*.json` drop-ins.

Server-managed settings, macOS or Windows MDM policy, Windows registry policy,
and a dynamic `policyHelper` cannot be reconstructed from ordinary filesystem
files. When those are in use, Claude Code `/status` is authoritative and a
Dashboard mismatch should be treated as an observability limitation.

## Safe resolution workflow

1. Select one runtime workspace before interpreting counts.
2. Filter the collision by name, then compare source, provider, path, version,
   content hash, and disabled reason.
3. Run the candidate through the managed evaluation gate; do not choose solely
   by version string.
4. Record the approved content hash in governance and the project skeleton
   lock.
5. Disable or uninstall the non-canonical definition through the runtime's
   supported configuration. Do not hand-edit plugin cache directories.
6. Rescan and require the collision count to reach zero before rollout.

For team baselines, direct project Skills should normally be generated from the
approved skeleton and reviewed in Git. Personal/global or plugin definitions
that intentionally share a name should be explicitly disabled for that
runtime, or renamed if both must remain selectable.

## Regression coverage

Automated tests cover directory-form per-Skill Codex disablement, user/project
configuration precedence, plugin-plus-Skill disablement, deterministic mixed
SemVer/non-SemVer plugin selection, Claude user/project/local/managed
precedence, content-identical duplicates, same-version divergent conflicts,
historical identity isolation, locale-independent names, exact fallback
versions, disabled exclusion, cross-runtime independence, path normalization,
and runtime-scoped health totals.
