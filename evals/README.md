# Managed evaluation suites

Files in this directory are deliberate product source, not runtime telemetry.
Use only synthetic data or cases that have been reviewed and sanitized for Git.

- `suites/*.json` uses SkillOps Suite Schema v1.
- `datasets/*.json` contains the bounded cases referenced by a suite.
- Suite list responses expose metadata and hashes, never case input.
- JavaScript, Python, `exec:`, `file://`, arbitrary providers, transforms,
  environment overrides, output paths, absolute paths, traversal, and symlinks
  are rejected before Promptfoo runs.
- API keys, Prompt/Skill content, workspace excerpts, provider responses, and
  raw errors do not belong in this directory.
- Prompt suites may declare only scalar, allowlisted case variables. Unsafe
  names, missing values, prototype-pollution keys, and nested values fail before
  provider execution.
- Prompt suites identify immutable `prompt-registry:` baseline and Candidate
  references. Prompt bodies are read from their pinned Git commits while the
  explicitly selected provider performs the run.

Promptfoo is an implementation detail. Do not add native Promptfoo YAML or JS
configuration here.
