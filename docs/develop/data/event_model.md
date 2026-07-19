# Event model and local data design

> Version: v0.3.1
> Status: implemented
> Authoritative implementation: `app/shared/event-schema.mjs`

## 1. Design goals

The event model creates one narrow interface across Codex, Claude Code, manual
emitters, imports, the local store, and the dashboard.

Principles:

1. Store lifecycle metadata, not task content.
2. Keep inventory evidence separate from execution evidence.
3. Normalize runtime differences without hiding detection quality.
4. Treat success as an evaluated claim, not a synonym for completion.
5. Reject invalid facts and discard fields outside the explicit allowlist.

## 2. Event families

### Skill lifecycle

| Event | Meaning | Requires `skillId` |
| --- | --- | --- |
| `skill.discovered` | A definition exists at scan time | Yes |
| `skill.matched` | A runtime signal selected or referenced a Skill | Yes |
| `skill.started` | Skill execution began or was inferred to begin | Yes |
| `skill.completed` | Lifecycle closed normally | Yes |
| `skill.failed` | Lifecycle closed with a failure signal | Yes |
| `skill.skipped` | Runtime/router intentionally did not execute it | Yes |

### Runtime lifecycle

| Event | Meaning |
| --- | --- |
| `session.started` | Host runtime session began |
| `session.completed` | Host runtime session ended |
| `turn.completed` | One host turn reached a terminal boundary |
| `prompt.submitted` | Prompt submission observed; only length may be stored |
| `tool.started` | Tool lifecycle began |
| `tool.completed` | Tool lifecycle ended |
| `subagent.started` | Subagent lifecycle began |
| `subagent.completed` | Subagent lifecycle ended |

Only `skill.completed` and `skill.failed` currently count as terminal Skill runs
in the dashboard.

## 3. Canonical event example

```json
{
  "id": "event-01",
  "event": "skill.completed",
  "skillId": "frontend-builder",
  "skillVersion": "2.1.0",
  "runtime": "codex",
  "timestamp": "2026-07-20T00:00:02.000Z",
  "durationMs": 2000,
  "sessionId": "session-123",
  "turnId": "turn-456",
  "project": "web-console",
  "outcome": "unknown",
  "detectionMethod": "skill_path",
  "confidence": 0.92
}
```

## 4. Field catalog

### Required/core fields

| Field | Type | Rule |
| --- | --- | --- |
| `id` | non-empty string | Generated when omitted; used for import deduplication |
| `event` | event enum | Must be one of the supported event names |
| `runtime` | `codex \| claude-code \| cursor` | Required for every event |
| `timestamp` | ISO date string | Normalized to ISO; generated when omitted |
| `skillId` | string | Required for every `skill.*` event |
| `skillVersion` | string | Optional; emitters generally use `unversioned` fallback |

### Correlation fields

| Field | Type | Purpose |
| --- | --- | --- |
| `sessionId` | string | Host session correlation |
| `turnId` | string | Turn correlation |
| `promptId` | string | Prompt correlation without prompt text |
| `toolUseId` | string | Tool-call correlation |
| `subagentId` | string | Subagent correlation |
| `project` | string | Local project label, generally basename only |

### Runtime metadata

| Field | Type | Purpose |
| --- | --- | --- |
| `model` | string | Host-reported model label |
| `toolName` | string | Tool name only, never its input/output |
| `subagentType` | string | Host-reported subagent type |
| `permissionMode` | string | Runtime permission/approval mode label |
| `commandSource` | string | Runtime-reported command origin |
| `startSource` | string | Session/start source such as desktop |

### Inventory metadata

| Field | Type | Allowed values/meaning |
| --- | --- | --- |
| `sourcePath` | string | Local definition path |
| `source` | enum | `global`, `project`, or `plugin` |
| `provider` | string | Runtime/plugin/project provider label |
| `kind` | enum | `skill` or `command` |
| `enabled` | boolean | Effective enabled state at scan time |
| `description` | string | Frontmatter description |
| `tags` | string[] | Frontmatter tags |

### Measurement and result metadata

| Field | Type | Rule |
| --- | --- | --- |
| `durationMs` | finite number | Lifecycle duration in milliseconds |
| `costUsd` | finite number | Reported USD cost, not estimated by SkillOps |
| `tokens` | finite number | Reported token count |
| `outcome` | enum | `success`, `failed`, or `unknown` |
| `error` | string | Sanitized error label/message only; adapters avoid raw details |
| `reason` | string | Sanitized skip/failure reason |

### Detection metadata

| Field | Type | Allowed values/meaning |
| --- | --- | --- |
| `detectionMethod` | enum | `explicit_prompt`, `slash_command`, `skill_tool`, `skill_path`, `manual`, `hook` |
| `confidence` | finite number | Detection confidence supplied by the adapter |
| `promptLength` | finite number | Character/byte length metadata only |
| `skillArgsLength` | finite number | Skill argument length only |

## 5. Normalization invariants

`normalizeEvent` enforces:

- input must be one object, not null or an array;
- event and runtime must be supported;
- Skill events require a non-empty Skill ID;
- supplied ID must be a non-empty string;
- supplied timestamp must parse as a date;
- numeric telemetry must be finite (no `NaN`/infinity);
- tags must be an array of strings;
- enum/boolean/string fields must have the documented type;
- unsupported fields are discarded.

Outcome invariants:

- `skill.completed` cannot carry `failed`;
- absent completion outcome becomes `unknown`;
- `skill.failed` cannot carry success/unknown and is normalized to `failed`.

`normalizeEvents` adds a one-based event index to validation errors for batch
diagnosis.

## 6. Lifecycle and outcome semantics

Typical exact lifecycle:

```text
skill.matched → skill.started → skill.completed(outcome=unknown)
```

Failure lifecycle:

```text
skill.matched → skill.started → skill.failed(outcome=failed)
```

Evaluated success:

```text
skill.started → evaluator/acceptance test → skill.completed(outcome=success)
```

Important rules:

- discovery may occur without any later run;
- match/start may be absent when a runtime exposes insufficient signals;
- normal stop proves a lifecycle boundary, not output correctness;
- a missing event is not proof that a Skill was not used;
- confidence describes detection evidence, not task quality.

## 7. JSONL persistence

Default files:

```text
data/
├─ events.jsonl
├─ discovery-index.json
├─ discovery-index.lock          transient
├─ events.jsonl.backup-*         created by destructive maintenance
├─ codex-adapter-errors.log      only when diagnostics occur
└─ claude-adapter-errors.log     only when diagnostics occur
```

The full `data/` directory is ignored by Git.

### Source of truth

`events.jsonl` is authoritative. The discovery index is rebuildable from
`skill.discovered` records. A malformed line is ignored on read but preserved by
maintenance rewrites unless the operation explicitly removes its event.

### Ordering

Append order is storage order. Consumers that need chronology sort by parsed
timestamp. Timestamps from multiple runtimes are not assumed to be perfectly
clock-synchronized.

## 8. Identity and deduplication

### Imported/general events

`id` is the deduplication key for batch import. The store does not globally
deduplicate every single-event append because legitimate external emitters own
their event identity.

### Discovery events

Discovery key:

```text
runtime + skillId + skillVersion + sourcePath
```

This preserves same-name definitions in different runtimes, versions, or paths.

### Codex Desktop derived events

Stable IDs include session, turn, Skill, and event. A semantic key of runtime,
session, turn, Skill, and event prevents a refresh from appending the same
derived lifecycle evidence again.

## 9. Import, export, and deletion

### Import

- Browser accepts JSON arrays and JSONL.
- Browser normalizes for useful local errors.
- Server normalizes again before mutation.
- One invalid record rejects the entire batch.
- Duplicate IDs are skipped.

### Export

Settings serializes the current local event array as JSONL. Demo events cannot
be exported through that control.

### Clear

The active event file is copied to a timestamped backup, then replaced
atomically with an empty file. Discovery index resets. Backups are not
automatically deleted.

### Selective test cleanup

Maintenance code can remove events by an ID prefix with a backup. This supports
controlled real-user tests without deleting unrelated history.

## 10. Schema evolution policy

Before adding a field or event:

1. State the user question it answers.
2. Confirm content cannot be represented with an existing allowlisted field.
3. Assess whether it can expose prompt, source, tool, transcript, credential, or
   personal data.
4. Update the shared normalizer and frontend TypeScript type together.
5. Add acceptance/rejection/privacy tests.
6. Update this document and adapter mapping.
7. Preserve read compatibility with existing JSONL where practical.

Do not add a generic payload/metadata object to bypass the allowlist.

## 11. Data-model acceptance checklist

- [ ] Unsupported fields do not persist.
- [ ] Numeric non-finite values are rejected.
- [ ] Contradictory outcome/event combinations are rejected.
- [ ] Unknown completions remain outside the success-rate denominator.
- [ ] Discovery events cannot appear as Runs.
- [ ] Import is atomic and duplicate IDs are skipped.
- [ ] Clear and selective removal create recoverable backups.
- [ ] New adapters emit only fields declared here.
