# Skill inventory review

Review date: 2026-07-21

Scope: Codex and Claude Code Skill discovery, disabled state, duplicate/conflict
classification, runtime filtering, and Registry UI behavior.

## Result

The high-impact inventory errors found in this review are fixed. SkillOps now
classifies an installed definition by runtime, definition type, normalized
source path, enabled state, exact fallback version, and normalized content
hash. Disabled or missing definitions remain visible for diagnosis but are
excluded from duplicate/conflict health counts.

## Findings fixed

| Priority | Finding | Resolution |
| --- | --- | --- |
| High | Disabled definitions still contributed to duplicate and conflict totals. | Centralized classification and excluded disabled/missing rows from collision groups. |
| High | A conflicting group was also counted as a duplicate group. | Made `duplicate` and `conflict` mutually exclusive. |
| High | Same name and version but different Skill content was treated as a harmless duplicate. | Added normalized SHA-256 content fingerprints; divergent content is now a definition conflict. |
| High | Every cached Codex plugin version was scanned, and mixed valid/non-SemVer cache names made active-version selection depend on filesystem order. | Select `local` first, otherwise the highest valid semantic version; use the lexical maximum only when no valid semantic version exists. |
| High | Codex `[[skills.config]]` entries were compared with the `SKILL.md` file path instead of its containing directory. | Normalize both configured directories and each discovered Skill's parent directory before applying enablement. |
| High | The current trusted project's `.codex/config.toml` did not override matching user plugin and per-Skill settings. | Merge user configuration first and project configuration second for both setting maps while preserving plugin-disable dominance. |
| Medium | Claude project-local and machine-managed settings were not applied. | Apply user, project, local, managed base, and alphabetically ordered managed drop-in settings in increasing precedence. |
| Medium | Registry health totals did not follow the selected runtime filter. | Compute totals from the runtime-scoped inventory. |
| Medium | Unknown-path historical definitions could collapse under one identity, and the fallback namespace could collide with a known path. | Use a structured metadata fallback plus disjoint `path:` and `historical:` key branches. |
| Medium | Skill-name grouping depended on the host locale and historical version fallback ignored case. | Use locale-independent name normalization and trimmed, case-sensitive version equality. |
| Medium | Discovery event identity was less stable than the installed definition identity. | Reuse the normalized definition key for discovery fallback identity. |
| Medium | Duplicate/conflict explanations omitted the hash-first rule and disabled-row opacity compounded muted text. | Synchronize all six locales with the implemented rule and retain explicit disabled styling without reducing row opacity. |
| Medium | The UI said only “disabled,” hiding whether a plugin, Skill config, or both caused it. | Return and display a structured disabled reason. |

## Conflict policy implemented

1. Group definitions only when they belong to the same runtime and have the
   same case-insensitive Skill name.
2. Exclude missing and disabled definitions from health collisions.
3. When every row has a valid content hash, identical hashes mean duplicate;
   different hashes mean conflict.
4. For older scan records without hashes, use the trimmed, case-sensitive
   version string as a compatibility fallback: one exact version means
   duplicate; multiple exact versions mean conflict.
5. Do not choose an automatic winner for an unresolved same-name conflict.
   The runtime remains the source of truth, and the operator should disable,
   remove, rename, or promote a reviewed definition.

## Runtime rules covered

### Codex

- User and project Skills remain separate definitions.
- Per-Skill `enabled = false` and disabled plugin state are observable.
- Cached plugin versions that are not active no longer enter the inventory.
- Same-name Skills are shown as collisions because Codex does not merge them.

### Claude Code

- Filesystem settings precedence is reconstructed as user, project, local,
  managed base, then managed drop-ins.
- Plugin disable state is calculated from the effective filesystem settings.
- Non-file policy sources, such as server-managed or MDM settings, cannot be
  proven from a local file scan and are therefore not guessed.

## Verification completed

- The scanner regression file passed all 11 tests, including directory-form
  per-Skill settings, user/project precedence, plugin-disable dominance, and
  deterministic mixed-version selection.
- Frontend inventory, Registry, localization, and theme-accessibility coverage
  passed in a combined 86-test run. The identity helper alone passed 10 tests,
  including the known-path versus historical-key collision regression.
- The complete suite passed: 45 test files and 300 tests.
- `npm run build` passed (`tsc -b` and Vite production build).
- `npm run smoke` passed, covering the loopback frontend, SPA routing, privacy
  validation, deterministic Promptfoo evidence, Registry governance/rollback,
  and the local API.
- In this review environment, a real `POST /api/scan` returned HTTP 200 with
  247 definitions (138 Codex, 109 Claude Code), 81 disabled definitions, and
  valid SHA-256 content hashes for every returned definition. These
  machine-specific inventory counts are evidence for this run, not a portable
  product baseline.
- Rendered-browser QA confirmed the disabled filter exposes 81 rows and keeps
  disabled-reason text fully opaque. At this review snapshot, measured contrast
  was 5.74:1 in the DevTools light theme and 9.96:1 in the Vaporwave dark theme.

## Remaining limitations outside this review

No unresolved P1/P2 finding from this review remains. The following are
separate product limitations rather than regressions introduced by this
change:

| Remaining item | Recommended treatment |
| --- | --- |
| Starting SkillOps inside a nested project directory does not yet walk ancestors to the repository root for every runtime Skill scope. | Resolve and expose the effective project root before scanning project and repository Skill directories. |
| Codex administrator/system Skill locations are not yet included in the inventory. | Add platform-aware admin roots and label their source scope without requiring elevated reads. |
| Claude server-managed, MDM, registry, or policy-helper settings are not reconstructible from filesystem files alone. | Show an “effective policy may be externally managed” diagnostic and offer runtime `/status` verification guidance. |
| The Registry is diagnostic and does not safely edit runtime configuration yet. | Add a preview-first resolution workflow with a backup, exact config diff, runtime-specific validation, and undo. |
| Historical scan records may not contain `contentHash`. | Keep the exact-version fallback for compatibility, but backfill hashes after the next successful scan. |

## Recommended resolution workflow

For each collision, show all source paths and disabled reasons, then let an
operator choose one explicit action: keep both, disable one, remove one, rename
one, or promote a reviewed version. Any configuration change should first show
the exact target and diff, preserve unrelated settings, create a recoverable
backup, validate by rescanning, and offer undo. SkillOps should never silently
delete a Skill or invent an effective winner.
