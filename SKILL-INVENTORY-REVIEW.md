# Skill inventory review

Review date: 2026-07-21

Scope: Codex and Claude Code Skill discovery, disabled state, duplicate/conflict
classification, runtime filtering, and Registry UI behavior.

## Result

The high-impact inventory errors found in this review are fixed. SkillOps now
classifies an installed definition by its runtime, source path, enabled state,
version, and normalized content hash. Disabled or missing definitions are kept
visible for diagnosis but are excluded from duplicate/conflict health counts.

## Findings fixed

| Priority | Finding | Resolution |
| --- | --- | --- |
| High | Disabled definitions still contributed to duplicate and conflict totals. | Centralized classification and excluded disabled/missing rows from collision groups. |
| High | A conflicting group was also counted as a duplicate group. | Made `duplicate` and `conflict` mutually exclusive. |
| High | Same name and version but different Skill content was treated as a harmless duplicate. | Added normalized SHA-256 content fingerprints; divergent content is now a definition conflict. |
| High | Every cached Codex plugin version was scanned, creating false conflicts from stale cache entries. | Select only the active plugin version: local wins, otherwise highest valid semantic version with a deterministic lexical fallback. |
| High | Codex `[[skills.config]]` entries with `enabled = false` were ignored. | Parse per-Skill configuration and expose both disabled state and reason. Plugin disable still wins over per-Skill enable. |
| Medium | Claude project-local and machine-managed settings were not applied. | Apply user, project, local, managed base, and alphabetically ordered managed drop-in settings in increasing precedence. |
| Medium | Registry health totals did not follow the selected runtime filter. | Compute totals from the runtime-scoped inventory. |
| Medium | Discovery event identity was less stable than the installed definition identity. | Reuse the normalized definition key for discovery fallback identity. |
| Medium | The UI said only “disabled,” hiding whether a plugin, Skill config, or both caused it. | Return and display a structured disabled reason. |

## Conflict policy implemented

1. Group definitions only when they belong to the same runtime and have the
   same case-insensitive Skill name.
2. Exclude missing and disabled definitions from health collisions.
3. When every row has a valid content hash, identical hashes mean duplicate;
   different hashes mean conflict.
4. For older scan records without hashes, use the version as a compatibility
   fallback: one version means duplicate; multiple versions mean conflict.
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

- 254 local tests passed across 33 test files after excluding test files that
  initialize the Promptfoo integration.
- The Skill scanner's 9 tests passed, including Codex per-Skill disable,
  active plugin selection, Claude local override, and managed drop-ins.
- Frontend tests cover disabled exclusion, same-version content divergence,
  Windows path normalization, cross-runtime isolation, and runtime-scoped UI
  totals.
- `npm run build` passed (`tsc -b` and Vite production build).
- A real local inventory scan completed with 104 Codex definitions, 2 disabled
  definitions, and valid hashes for every returned definition in this
  environment.

`npm test` and `npm run smoke` were not counted as successful because the
existing Promptfoo initialization attempted to contact `r.promptfoo.app`. That
external access was blocked instead of being bypassed. No rendered-browser QA
was performed because a browser runner was unavailable and the local server
path reaches the same Promptfoo initialization chain.

## Remaining risks and recommended backlog

| Priority | Remaining item | Recommended treatment |
| --- | --- | --- |
| High | Promptfoo initialization performs network work during nominally local tests and smoke startup. | Make offline mode the default for tests, inject the Promptfoo runner, and add a test that fails on unexpected egress. |
| Medium | Starting SkillOps inside a nested project directory does not yet walk ancestors to the repository root for every runtime Skill scope. | Resolve and expose the effective project root before scanning project and repository Skill directories. |
| Medium | Codex administrator/system Skill locations are not yet included in the inventory. | Add platform-aware admin roots and label their source scope without requiring elevated reads. |
| Medium | Claude server-managed, MDM, registry, or policy-helper settings are not reconstructible from filesystem files alone. | Show an “effective policy may be externally managed” diagnostic and offer runtime `/status` verification guidance. |
| Medium | The Registry is diagnostic and does not safely edit runtime configuration yet. | Add a preview-first resolution workflow with a backup, exact config diff, runtime-specific validation, and undo. |
| Low | Historical scan records may not contain `contentHash`. | Keep the version fallback for compatibility, but backfill hashes after the next successful scan. |

## Recommended resolution workflow

For each collision, show all source paths and disabled reasons, then let an
operator choose one explicit action: keep both, disable one, remove one, rename
one, or promote a reviewed version. Any configuration change should first show
the exact target and diff, preserve unrelated settings, create a recoverable
backup, validate by rescanning, and offer undo. SkillOps should never silently
delete a Skill or invent an effective winner.
