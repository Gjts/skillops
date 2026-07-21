# Local Prompt Registry contract

> Status: implemented
> Storage model: Git/file source; metadata-only SkillOps persistence

## Purpose

The Local Prompt Registry brings Prompt lifecycle management into SkillOps
without depending on a hosted Prompt-management product. A user-managed Git
repository remains the source of truth for Prompt bodies. SkillOps reads exact
commits, derives immutable Artifact references and component hashes, and routes
those Artifacts through Promptfoo and Capability governance.

SkillOps does not create commits, change branches, edit Prompt files, contact a
Prompt registry service, or store Prompt bodies in `data/`.

## Workspace configuration

The production server reads the repository in `SKILLOPS_PROMPT_WORKSPACE`, or
the current working directory when the variable is absent. Prompt definitions
are discovered under `prompts/` by default. Set
`SKILLOPS_PROMPT_DIRECTORY` to another repository-relative directory when
needed.

Only files ending in `.prompt.json` from a Git commit are eligible. Working-tree
and index-only changes are intentionally ignored until the user commits them.
This makes every evaluation and promotion reference reproducible.

## Prompt Schema v1

```json
{
  "schemaVersion": 1,
  "id": "release-summary",
  "name": "Release summary",
  "description": "Summarizes a release for a selected audience.",
  "system": "Be precise for {{audience}}.",
  "template": "Summarize {{release}}.",
  "model": {
    "provider": "openai",
    "name": "gpt-5.6-sol",
    "configuration": { "temperature": 0.2 }
  },
  "variables": ["audience", "release"]
}
```

A definition must contain exactly one of `template` or `messages`. Message
roles are limited to `system`, `user`, and `assistant`. Model configuration is
an allowlist of scalar generation settings; executable hooks, provider code,
paths, environment variables, and nested objects are rejected. Variable names
are bounded and prototype-pollution segments are rejected. Variables found in
`{{name}}` placeholders are added to the required variable set.

Each file is limited to 256 KiB and each version is limited to 500 Prompt
definitions. Invalid files appear only as bounded validation warnings; their
bodies are never returned to the browser.

## Immutable identity

The source reference has this form:

```text
prompt-registry:<git-commit>:<encoded-repository-path>:<semantic-content-sha256>
```

The content hash is computed from canonical normalized Prompt structure, so
JSON formatting-only changes do not create a different Prompt body hash.
Component hashes separately cover system text, prompt/messages, provider/model,
configuration, and variables. Resolution always reads the path from the pinned
commit and rechecks the semantic hash.

## Local API

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/prompt-registry/status` | Repository label, directory, current commit, and local branches |
| `POST` | `/api/prompt-registry/prompts` | Metadata-only list for an exact branch or commit with search/provider/model filters |
| `POST` | `/api/prompt-registry/compare` | Component-hash comparison for two versions of the same Prompt ID |
| `POST` | `/api/prompt-registry/nominate` | Explicitly create or reuse a metadata-only governed Candidate |

POST bodies use the same loopback, Origin, JSON content-type, size, and unknown
field guards as Managed Evaluations. List, comparison, Candidate, evaluation,
and governance responses never include Prompt bodies.

## Evaluation and governance

The user selects two immutable Prompt references as baseline and Candidate.
SkillOps resolves their bodies only in backend memory, renders scalar variables,
and calls the selected model provider directly through the existing local AI
settings seam. Provider/model values in the Prompt file are hints and never
silently replace the current page settings.

A Candidate can then follow the existing evidence gate, independent approval,
Canary, Stable, supersede, and rollback flow. Stable stores a reference lock,
not a Prompt body. Rollback restores the prior immutable lock without requiring
the Prompt source repository to be available.

## Privacy guarantees

- Prompt bodies remain in the user-controlled Git repository and transient
  backend memory.
- SkillOps persists only hashes, source references, sanitized evaluation
  summaries, identities, approvals, and channel locks.
- Provider credentials may be stored only in local `data/ai-settings.json` after
  explicit Save; they are never written to the Prompt repository or evidence.
- No remote Prompt-management API, account, key, synchronization, telemetry, or
  pipeline is used.
