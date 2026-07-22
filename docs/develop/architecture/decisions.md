# Architecture decision record

> Status: accepted for the local + Git v1.0 architecture
> Decision date: 2026-07-22

These decisions define the seams that must remain stable while SkillOps is a
single-host, local-first product. A later hosted deployment must replace a
listed decision explicitly rather than silently weakening it.

## ADR-001: Git, SkillOps Registry, and PromptHub fact ownership

**Decision.** Each fact has one owner:

| Fact | Owner |
| --- | --- |
| Artifact body and authored version history | User-controlled Git repository at an immutable commit |
| Normalized Artifact identity, compatibility, dependencies, desired/observed state | SkillOps Unified Artifact Registry, derived from current sources |
| Evaluation evidence, approval, release state, locks, and audit | SkillOps governance stores |
| PromptHub remote ID, remote version, availability, and sync timestamp | PromptHub connector metadata |

PromptHub content can enter governance only after the exact Prompt semantics
are committed to user-controlled Git and re-resolved through an immutable
`git:` reference. The previewed remote component hashes must match that commit;
the remote body is never used as the governed Artifact. Import creates only a
Candidate and cannot overwrite Git, a local Stable lock, evidence, or approval.
The Registry never becomes an Artifact-body store, and Git never becomes the
store for runtime observations or local governance audit records.

**Consequence.** A source outage can prevent body resolution, but it cannot
rewrite or delete the last local Stable lock. Every displayed fact names its
source and immutable hash.

## ADR-002: Promptfoo process isolation and no-hidden-egress policy

**Decision.** Promptfoo runs in one disposable child process per evaluation
behind the evaluation-runner seam. SkillOps supplies a declarative, bounded
Suite; disables cache, telemetry, update checks, sharing, and both remote
generation modes; omits output paths and inherited secret-named environment
variables; uses a run-scoped temporary config directory; and removes it after
completion. Cancellation, timeout, and shutdown terminate the child.

The child has no approved network path of its own. The only intended model
egress is the user-selected SkillOps provider bridge. A strictly no-egress run
must use a deterministic/local adapter or a loopback model endpoint. Environment
switches are defense in depth, not an operating-system firewall, so every
Promptfoo upgrade must rerun the disk-sentinel and unexpected-network tests.
The automated test harness also denies undeclared child processes, allows only
an explicit offline Git subcommand set by default, and injects the no-egress
guard into nested Node processes even when callers replace `NODE_OPTIONS`.

**Consequence.** Promptfoo remains a replaceable execution adapter, not a
persistence, identity, provider-catalog, or governance module.

## ADR-003: Artifact bodies, evidence, and sensitive output storage

**Decision.** Persist by category, not convenience:

| Category | Storage rule |
| --- | --- |
| Skill, Prompt, Workflow, Rules, Agent, Template bodies | User Git/project files only; transient backend memory when execution requires them |
| Stable/Canary identity | Immutable source reference, semantic/content hashes, and metadata-only lock |
| Evaluation evidence | Sanitized status, scores, gate result, run/case identity, hashes, and path-pseudonymized local Artifact references only |
| Tasks, criteria, workspace excerpts, raw outputs/errors, judge rationale | Memory only; never evidence, events, exports, audit, or logs |
| Runtime telemetry | Shared normalized metadata allowlist only |
| Provider credentials | Only explicit `data/ai-settings.json` Save or operating-system credential storage where the connector requires it |
| Recovery bodies | Exact-byte target-adjacent backup; opaque metadata reference only in SkillOps data and no API exposure |

Unknown fields fail or are discarded at the relevant trust seam before
persistence. Hashes identify sensitive content but do not authorize storing the
content itself.

**Consequence.** Reports and Team exports are regenerated from sanitized
allowlists. They cannot be used as a back door for Artifact bodies or raw model
content.

## ADR-004: JSON/JSONL to SQLite or Postgres migration triggers

**Decision.** Keep atomic JSON and append-only JSONL for the current single-host
product. Move to SQLite when any measured condition persists in normal use:

- an active store exceeds 512 MiB or 1,000,000 records;
- p95 local list/filter/retention operations exceed two seconds;
- more than one process must write the same logical store; or
- a required invariant needs a transaction spanning multiple current files.

SQLite is the first migration target because it preserves local deployment and
backup simplicity. Postgres is considered only when a supported multi-host
Team deployment requires concurrent network writers, server-side tenancy, or
high availability. Migration must be explicit preview/apply, preserve an
exact-byte backup, verify record counts and hashes, and support rollback before
the old store is retired.

**Consequence.** Database abstraction is not added before a trigger is observed.
Scale work follows measurements, not forecasted volume.

## ADR-005: Local, self-hosted, and SaaS Team architecture

**Decision.** v1.0 supports one local SkillOps server plus user-controlled Git.
The operating-system account is the default principal; optional configured
Bearer principals exist only for local role separation. Export/import covers
team handoff. Network collection, hosted synchronization, tenancy, SSO, and SCIM
remain disabled.

A self-hosted server is the next eligible architecture only after repeated demand
cannot be met by Git and export/import. Before implementation it requires
authentication, TLS, tenant isolation, durable database selection, credential
management, retention enforcement, and a revised threat model. SaaS is a later
business/deployment decision and cannot reuse the unauthenticated loopback
interface.

**Consequence.** Local Team operation is not evidence of hosted security or
availability. The UI and deployment metadata must keep those capabilities marked
unavailable.

## ADR-006: RBAC and independent approval

**Decision.** Team authorization uses five ordered roles: Owner, Maintainer,
Reviewer, Developer, and Viewer. The server resolves principals; browser payloads
cannot choose an actor, submitter, reviewer, or release operator. Owner controls
Team membership, devices, backup, and retention; Maintainer manages project and
policy state; Reviewer decides governed approvals and exceptions; Developer can
submit bounded work; Viewer is read-only.

Any high-risk Stable release binds an exact Artifact version, content hash,
evidence hash, and submitter. Approval requires a different resolved principal
and becomes invalid when any bound identity changes. Release execution remains a
separate confirmed operation and writes an append-only audit transition.

**Consequence.** A single local account can develop and operate the product, but
cannot fabricate independent approval. A second configured principal or OS
identity is required for that gate.

## ADR-007: Bundle integrity, provenance, and trust levels

**Decision.** SkillOps assigns explicit trust levels:

1. **Observed** — runtime or filesystem discovery; no release authority.
2. **Git-pinned** — supported source, immutable commit, path, and matching content
   hash; integrity and provenance are inspectable but not independently signed.
3. **Governed** — Git-pinned identity plus passing evidence, independent approval,
   and Stable/Canary lock; required for managed installation and Team Templates.
4. **Signed bundle** — reserved for future external distribution and not accepted
   by v1.0.

If signed bundles are introduced, use detached Ed25519 signatures over a
canonical manifest containing every file hash, source commit, dependency, Suite,
and policy identity. Verification must use an explicit Team trust store with key
IDs, expiry/revocation, and rotation; no trust-on-first-use or signature that
covers only an archive checksum is sufficient.

**Consequence.** Current Git-reviewed templates are Governed, not cryptographically
publisher-signed. The product must not label them signed or trusted beyond the
recorded level.

## ADR-008: PromptHub conflicts and offline behavior

**Decision.** PromptHub v1 is a read connector. It accepts only pull-only mode;
manual and push-only configuration fail at startup because the published v1
contract has no version-write endpoint. Import requires a separately committed
Git Prompt with the same Artifact ID and system, prompt, model, and configuration
component hashes; only that Git Artifact can become a Candidate. Import never
promotes directly to Stable and still requires local evaluation and independent approval.

Sync compares the last synchronized remote hash with current local and remote
hashes. Remote-only change may be previewed for pull. Local-only change remains
local. Concurrent local and remote changes produce a blocking conflict with both
identities and no automatic winner. Remote deletion or outage records metadata
only and preserves the local Stable lock, rollback target, and audit history.
Credentials remain in the operating-system credential store and never enter Git,
SkillOps JSON/JSONL, logs, exports, or frontend persistence.

**Consequence.** PromptHub is optional collaboration infrastructure, never a
single point of release, rollback, or offline operation.
