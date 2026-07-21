# Promptfoo integration contract

**Status: Implemented.** SkillOps uses Promptfoo as an isolated evaluation
engine for Quick Compare, managed quality suites, and the bounded Red Team
probe set. Promptfoo is not a persistence layer or a provider catalog.

## Supported package contract

The contract was last checked on 2026-07-21 with both the npm registry and the
published package artifact:

| Contract | SkillOps value |
| --- | --- |
| Dependency | exact `promptfoo@0.121.19` |
| Upstream Node range | `^20.20.0 || >=22.22.0` |
| SkillOps minimum | `>=22.22.0` |
| CI runtime | Node 24 |
| License | MIT |

SkillOps imports only the package root and relies on this public Node surface:

- `evaluate(testSuite, options)` returns an `Eval` record;
- `Eval.toEvaluateSummary()` produces the result passed to the SkillOps
  normalizer;
- `EvaluateOptions` used here are `cache`, `maxConcurrency`,
  `showProgressBar`, and `silent`;
- suite configuration sets `writeLatestResults: false` and `sharing: false`.

The deterministic public-contract fixture is
`app/backend/evaluations/fixtures/promptfoo-0.121.19-summary.json`. UI and
governance code consume only the normalized SkillOps evaluation schema, so a
Promptfoo upgrade is contained to the runtime adapter, fixture, and normalizer.

## Isolation and privacy boundary

`promptfoo-runtime.mjs` creates a worker thread for each run. Before that worker
imports Promptfoo, SkillOps gives it a per-run `PROMPTFOO_CONFIG_DIR` and sets:

```text
PROMPTFOO_DISABLE_TELEMETRY=1
PROMPTFOO_DISABLE_UPDATE=1
PROMPTFOO_DISABLE_SHARING=1
PROMPTFOO_DISABLE_REMOTE_GENERATION=true
PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION=true
PROMPTFOO_CACHE_ENABLED=false
PROMPTFOO_LOG_LEVEL=error
```

Every evaluation also passes `cache: false`, uses concurrency 1 inside the
worker, disables latest-result writes and sharing, audits the temporary runtime
directory for secrets and evaluation content, and removes that directory after
the run. A cancellation terminates the worker. The contract tests additionally
verify that the user's default `~/.promptfoo` directory is unchanged.

The remote-generation switches are defense in depth, not a network firewall.
Promptfoo's own documentation warns that the general switch does not disable
providers, telemetry, sharing, or account checks. SkillOps therefore controls
those features independently. The only intended model egress is through the
user-selected SkillOps provider bridge. Credentials may originate from the
explicit local AI settings file, stay in request and Worker memory during a run,
and are excluded from normalized evidence.

## Red Team experimental seam

Red Team execution is separate from quality-suite execution. The pinned
package's root export and public type declaration expose `redteam.Graders` and
`RedteamGraderBase.renderRubric()`. SkillOps confines that experimental surface
to `promptfoo-redteam-adapter.mjs`; no Promptfoo experimental type enters the
shared domain schema.

The bounded default set covers prompt injection, prompt extraction, PII/secret
leakage, and excessive agency. It does not invoke Promptfoo remote generation
or full attack strategies. Only aggregate pass/fail evidence, attack success
rate, and critical/high counts may persist; attack prompts, rubrics, model
outputs, and grader reasons do not.

Because this is an experimental API, any Promptfoo version change must confirm
the root export and generated type declaration still contain the adapter
surface. A missing grader fails closed with a stable SkillOps error instead of
silently skipping a probe.

## Upgrade checklist

1. Run `npm view promptfoo version engines license` and review the upstream
   Node API documentation and release notes.
2. Change the exact dependency, `PROMPTFOO_VERSION`, and versioned contract
   fixture together.
3. Confirm all used values remain package-root exports; do not add deep imports
   into `promptfoo/dist` or undocumented source paths.
4. Run the Promptfoo contract, provider, runner, Red Team, manager, store, API,
   CLI, and privacy tests, including the sentinel scan of the entire temporary
   runtime directory.
5. Run `npm test`, `npm run build`, `npm run smoke`, and `npm audit` before
   accepting the upgrade.

## Known dependency advisory

As of 2026-07-21, `npm audit` reports four high-severity entries along the
transitive chain
`promptfoo -> @huggingface/transformers -> onnxruntime-node -> adm-zip` for
`GHSA-xcpc-8h2w-3j85`. npm's offered remediation downgrades Promptfoo to
`0.121.3`, outside this tested contract, so it has not been applied
automatically. Re-evaluate the advisory on every Promptfoo upgrade and avoid
feeding untrusted archive/model artifacts to the affected optional inference
path.

## Official references

- <https://www.promptfoo.dev/docs/usage/node-package/>
- <https://www.promptfoo.dev/docs/usage/node-api-reference/>
- <https://www.promptfoo.dev/docs/usage/node-api-quick-reference/>
- <https://www.promptfoo.dev/docs/configuration/caching/>
- <https://www.promptfoo.dev/docs/configuration/telemetry/>
- <https://www.promptfoo.dev/docs/usage/sharing/>
- <https://www.promptfoo.dev/docs/red-team/configuration/>
- <https://www.promptfoo.dev/docs/red-team/troubleshooting/data-handling/>
