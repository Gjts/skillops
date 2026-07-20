# SkillOps user guide

> Applies to: v0.3.1 local MVP

## 1. What SkillOps can tell you

SkillOps has two evidence levels:

- **Registry evidence**: a Skill or command definition exists and is available
  (or disabled) in a scanned location.
- **Execution evidence**: a runtime hook observed a match, start, completion, or
  failure event.

Never use a Registry count as proof that a Skill ran. Never treat a normal
`skill.completed` event as a passing evaluation when its outcome is `unknown`.

## 2. First-time setup

From the repository root:

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

Connect Codex:

```powershell
npm run codex:dry-run
npm run codex:install
```

Connect Claude Code:

```powershell
npm run claude:dry-run
npm run claude:install
```

Restart the runtime after installation. In runtimes that require hook trust,
open `/hooks`, inspect the SkillOps commands, and approve them.

### Choose the interface language

Use the language selector at the bottom of the sidebar. The dashboard supports
Chinese, English, French, Russian, Spanish, and Japanese. The selected language
is saved in this browser and restored on the next visit.

## 3. Confirm that setup is real

An **Installed** badge confirms that the effective config contains SkillOps
handlers and their `.mjs` script paths exist. It does not confirm that a hook
has fired.

To verify end to end:

1. Open Settings and confirm the adapter says **Installed**.
2. Record the current time.
3. Explicitly invoke one known Skill in Codex or Claude Code.
4. Finish the turn.
5. Open Runs and search for the Skill name.
6. Confirm the runtime, timestamp, session, detection method, and terminal event.

Command-line verification:

```powershell
node scripts/check-skill-recording.mjs `
  --skill your-skill-name `
  --runtime codex `
  --since 2026-07-20T00:00:00.000Z
```

Use `--runtime claude-code` for Claude Code. Add `--session <id>` when you need
to isolate one session.

## 4. Read the dashboard

### Overview

Use runtime and date filters to inspect terminal runs. The success rate may be
blank or marked lifecycle-only when no run has an evaluated outcome. Cost only
sums records that actually include `costUsd`.

### Skills

Shows execution metrics grouped by runtime and Skill name. One name used in
both Codex and Claude Code remains two runtime-specific rows.

### Runs

Shows `skill.completed` and `skill.failed` events. Select a run for correlated
session/turn detail. Search matches Skill name, event ID, and project.

### Skill Lab

Use Skill Lab to compare a public GitHub Skill with enabled definitions already
on this machine:

1. Paste a public GitHub repository, tree, blob, or raw `SKILL.md` URL.
2. Select the candidate when the repository contains multiple Skills.
3. Review deterministic similarity scores and choose the intended local baseline.
4. Describe one representative task and concrete acceptance criteria.
5. Choose prompt-only or read-only workspace agent execution.
6. Configure an AI provider and run the A/B test.

The baseline and candidate receive identical task input and run sequentially,
followed by the blinded judge. This supports provider accounts that allow only
one in-flight request.
Prompt-only mode gives each definition one model call and no workspace access.
Read-only agent mode lets each side request bounded file listing, literal search,
and text-file reads; `.env`, credential/key files, `data/`, build output,
dependency caches, traversal, symlinks, writes, processes, and extra network
tools are blocked, and credential-like lines are redacted. Requested allowed
excerpts are sent to the selected provider, so review workspace source for
embedded sensitive data before selecting this mode. A final call receives the two outputs as anonymous Answer A/Answer B
values and returns consistent scores and rationale. This is evidence for one
task and one set of criteria, not a universal quality claim. The page never
installs, promotes, deploys, or edits either definition.

The assistant chat receives bounded inventory metadata plus the current task,
criteria, candidate/match descriptions, comparison signals, and in-memory
evaluation result/output when available. It does not receive local Skill paths
or local Skill file contents. Open it from **Ask SkillOps**, or use the contextual
actions beside baseline selection, A/B task setup, and the evaluation result.
The desktop chat opens in a right-side drawer instead of reducing the evaluation
workspace width; narrow screens use a bottom sheet. Closing the chat preserves
the in-memory conversation for the current page session.

### AI settings

AI settings support OpenAI, Gemini, Anthropic, Azure OpenAI, Ollama,
OpenRouter, MiniMax, GLM, and DeepSeek. Keys and settings exist only in React
page memory, are sent through the loopback SkillOps server only for a requested
call, and are removed by a reload or page close. They are not written to browser
storage. Credentialed provider endpoints require HTTPS; keyless Ollama HTTP is
accepted only on a loopback address. A custom Base URL receives the configured
key, so use only an endpoint you trust. OpenAI-compatible transports expose
`none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts when the
selected model supports them. GPT-5.6 defaults to Medium when the field is left
at provider default; its Chat Completions tool calls require **None**, so Skill
Lab blocks read-only agent runs until that value is selected.

Evaluation tasks, acceptance criteria, generated outputs, judge rationales, and
chat messages remain in browser memory and are not appended to the event store.
They are sent to the selected model provider, whose data policy applies.
Read-only agent mode additionally sends only workspace excerpts requested
through its bounded tool interface.

### Registry

Choose a runtime workspace before interpreting counts:

- **Combined**: all definitions, grouped by runtime.
- **Codex / Claude Code / Cursor**: one runtime only.
- **Global / Project / Plugin**: installation source, not runtime.
- **Provider**: owner or plugin package source.
- **Skill / Command**: current Skill format versus legacy command definition.

Health labels mean:

- **duplicate**: multiple definition paths share a name in one runtime;
- **conflict**: those definitions report different versions;
- **disabled**: installed but explicitly disabled;
- **missing**: name or location metadata could not be established.

### Settings

Inspect config status, last activity, and event count. Export downloads the
normalized local JSONL data. Clear creates a timestamped backup before emptying
the active file.

## 5. Import event data

Runs accepts either a JSON array or newline-delimited JSON. Every event is
validated before anything is written. If one event is invalid, the entire
import is rejected. Existing IDs and duplicates inside the import batch are
not appended again.

Minimal JSONL example:

```json
{"id":"example-start","event":"skill.started","skillId":"example-skill","skillVersion":"1.0.0","runtime":"codex","timestamp":"2026-07-20T00:00:00.000Z"}
{"id":"example-end","event":"skill.completed","skillId":"example-skill","skillVersion":"1.0.0","runtime":"codex","timestamp":"2026-07-20T00:00:02.000Z","outcome":"unknown","durationMs":2000}
```

## 6. Manual event emission

Use manual emission for controlled integrations or tests, not to fabricate
runtime evidence:

```powershell
npm run emit -- skill.started --skill example-skill --runtime codex --version 1.0.0
npm run emit -- skill.completed --skill example-skill --runtime codex --version 1.0.0 --duration 2000
```

Only pass `--outcome success` when a real acceptance test or evaluator supplied
that verdict.

## 7. Data location and retention

Default active data:

```text
data/events.jsonl
```

Set an alternate directory before starting a command:

```powershell
$env:SKILLOPS_DATA_DIR = 'D:\SkillOpsData'
npm run dev
```

SkillOps does not automatically upload the store. Backups created by clear are
kept beside the active event file and must be removed manually if no longer
needed.

Skill Lab session state is separate from `data/events.jsonl`: AI credentials,
tasks, chat messages, and generated output are not written there.

## 8. Disconnect a runtime

```powershell
npm run codex:uninstall
npm run claude:uninstall
```

Use the same scope/target arguments used during installation. Uninstall removes
SkillOps-marked handlers and preserves unrelated hooks. Restart the runtime and
refresh Settings afterward.

## 9. Next references

- [Detailed local setup](../develop/operations/getting_started.md)
- [Runtime adapter guarantees](../develop/integrations/runtime_adapters.md)
- [Troubleshooting](../develop/operations/troubleshooting.md)
- [Privacy and security](../develop/security/privacy-security.md)
