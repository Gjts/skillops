# Frontend architecture: SkillOps dashboard

> Version: v0.3.2-rc.1
> Status: implemented, including the live Skill Lab evaluation workspace

## 1. Frontend goals

The frontend turns normalized local evidence into an honest operational view.
Its primary responsibilities are:

- separate inventory from execution;
- separate runtime workspaces before category totals;
- distinguish lifecycle completion from evaluated success;
- make local/demo/unavailable state obvious;
- provide usable import, export, clear, connection, comparison, and evaluation workflows;
- remain responsive and reload-safe without a routing dependency.

## 2. Stack

| Area | Implementation |
| --- | --- |
| UI | React 19 + TypeScript |
| Build/dev | Vite |
| Icons | Lucide React |
| Routing | Browser history plus pathname map |
| State | React local state and derived memoized selectors |
| Internationalization | Typed in-repo message catalog + React context; browser-local locale preference |
| Theming | Root semantic design-system tokens; system-mapped light/dark mode with a browser-local 25-style override |
| Charts | Lightweight React/SVG/CSS modules |
| Tests | Vitest + Testing Library + jsdom |

There is no remote client SDK, hosted-account authentication state, router
package, or global state library. AI provider credentials are loaded from and
saved through loopback `GET`/`PUT /api/ai-settings` into local
`data/ai-settings.json`. Browser storage is not used for credentials.

## 3. Routes and page intent

| Path | Page | Data source |
| --- | --- | --- |
| `/` | Overview | Events + connections |
| `/skills` | Skills | Terminal events + discovery metadata |
| `/runs` | Runs | Terminal and correlated lifecycle events |
| `/evaluations` | Skill Lab | Live GitHub candidate comparison, A/B evaluation, and assistant chat |
| `/registry` | Registry | Live scan, falling back to discovery events on failure |
| `/governance` | Governance | Capability lifecycle, evidence, approvals, previews, and rollback |
| `/team` | Team | Team state, unified Artifact directory, approval/release queues, and local backup |
| `/settings` | Settings | Connections + local events |

`popstate` restores the matching page. Navigation updates browser history. The
production server falls back to `index.html` for extensionless SPA paths.

## 4. Application state

### Source state

- `events`: current event array;
- `connections`: runtime configuration/activity results;
- `mode`: `loading`, `local`, or `demo`;
- `eventEtag`: last event-store version;
- selected page, runtime, time range, menu, modal, and requested run;
- selected UI locale, persisted under the versioned browser key
  `skillops.locale.v1`;
- selected appearance from the 25-style product catalog after a manual choice,
  persisted under `skillops.theme.v2`; before a manual choice, the dashboard
  maps `prefers-color-scheme` to the DevTools or Synapse design system. The
  pre-paint bootstrap and React hook both migrate the legacy
  `skillops.theme.v1` light/dark preference to those two themes;
- candidate URL/selection, local baseline, A/B inputs/results, and chat messages;
- active AI provider settings loaded from `/api/ai-settings` and kept in page state while the workspace is open.
- Team state, derived Artifact catalog, Approval Inbox, and Release Queue loaded
  on `/team`; device secrets are never held by this page.

Evaluation request/result and Artifact types come from the shared Evaluation
Schema declaration. The frontend does not define parallel Candidate/result
interfaces or import backend implementations.

`src/lib/themeCatalog.ts` is the authoritative source for theme IDs, color
schemes, browser theme colors, storage keys, legacy mappings, and system
defaults. A Vite HTML transform serializes its bootstrap subset into the inline
head script so the initial paint and the React runtime cannot drift.

### Derived state

The frontend derives runs, outcome coverage, Skill metrics, charts, inventory
issues, filtered tables, and pagination. Derived values are not persisted.

## 5. Data refresh behavior

### Events

- initial and repeated `GET /api/events`;
- refresh every 3 seconds;
- sends `If-None-Match` after the first successful response;
- ignores a `304` without reparsing or replacing state;
- on initial API failure only, loads deterministic sample events and marks Demo mode;
- later polling failures preserve the last known view.

### Connections

- `GET /api/connections` on mount and every 5 seconds;
- API failure maps Codex/Claude to `unavailable` while Cursor stays `preview`.

### Registry

- `POST /api/scan` on page mount and manual rescan;
- retains the last successful scan on a later failure;
- before any successful live scan, can display persisted discovery events.

## 6. Metric semantics

A terminal run is only:

```text
skill.completed OR skill.failed
```

Success metrics:

- success = `skill.completed` with `outcome: success`;
- failure = any `skill.failed` event;
- known outcomes = successes + failures;
- success rate = successes / known outcomes;
- lifecycle-only = at least one terminal run and zero known outcomes;
- outcome coverage = known outcomes / all terminal runs.

Unknown completions remain visible in activity charts but never inflate success.
Missing cost fields are treated as unreported, not as evidence of zero provider cost.

## 7. Page composition

### Overview

```text
KpiStrip
├─ RunsChart
├─ RuntimeDistribution
├─ SkillTable (top four)
└─ ActivityRail
```

If no terminal events match the filters, the page renders connection guidance
instead of empty charts.

### Skills

Uses `SkillTable` with search and expandable definition information. Metrics are
grouped by `runtime:skillId`, keeping same-name Skills in separate runtimes.

### Runs

Combines runtime lifecycle counters, search, 20-row pagination, import control,
activity rail, and `RunDetail`. Run detail correlates events using available
session/turn metadata rather than assuming all same-name events belong together.

### Registry

The primary filter is runtime workspace. All totals and secondary categories
follow that scope. Definitions are then categorized by:

- source: global, project, plugin;
- provider;
- enabled/disabled state;
- kind: Skill or command;
- attention issue: duplicate definition, definition conflict, disabled, or missing metadata.

Combined view inserts runtime group rows and marks Skill names present in more
than one runtime as shared.

### Team

`TeamPage` initializes the local Team from the server principal, then presents a
bounded-height Registry-derived Artifact table so the approval and release
queues remain visible. Summary cards report Artifact versions, active members,
pending approvals, and pending releases. Refresh is explicit; backup invokes
the sanitized backend export. The page does not offer network deployment, SSO,
SCIM, or browser-selected identities.

### Settings

Connection rows show config truth separately from activity. Export serializes
the current local event array as JSONL. Clear requires a confirmation dialog and
uses the server's backup-first operation.

### Skill Lab

`EvaluationWorkspace` owns the user-visible workflow but reads no filesystem
content directly. Candidate discovery, local baseline resolution, Skill-content
comparison, and provider requests all cross the loopback API. The workspace:

- accepts a public GitHub Skill location and handles repositories with multiple
  `SKILL.md` candidates;
- displays deterministic overlap scores and lets the user choose a live scanned
  local baseline;
- collects one task and explicit acceptance criteria;
- sends the analyzed candidate content hash and selected prompt-only/read-only
  agent mode with each A/B request;
- renders baseline/candidate scores, timings, token counts, session outputs,
  and a blinded judge rationale;
- passes bounded inventory metadata, task/criteria, comparison signals, and
  in-memory result outputs to assistant chat without local paths or Skill contents.

Assistant chat is not a permanent layout column. `EvaluationWorkspace` exposes
context actions beside baseline selection, A/B task setup, and the result, while
`SkillOpsAssistantDrawer` opens as an on-demand right drawer. The drawer traps
focus, closes with Escape or its scrim, restores the invoking control, and
collapses to a bottom sheet on narrow screens without shrinking the main flow.

`AiSettingsModal` follows the supplied provider-grid reference. It supports
nine providers, traps focus, restores focus on close, hides keys by default,
loads/saves settings through the local AI settings API, and exposes reasoning effort for
OpenAI-compatible transports. `EvaluationWorkspace` surfaces the GPT-5.6
Chat Completions tool-call constraint and disables incompatible agent runs.

## 8. Component map

| Component | Responsibility |
| --- | --- |
| `Sidebar` | Responsive navigation, global theme chooser, and local-mode identity |
| `ThemeChooser` | Localized 25-style catalog with miniature product previews, selection state, and accessible popover behavior |
| `KpiStrip` | Outcome-aware summary metrics |
| `Charts` | Daily runs and runtime distribution |
| `SkillTable` | Runtime-specific Skill metrics and definition details |
| `ActivityRail` | Recent/expanded terminal lifecycle list |
| `RunDetail` | Correlated evidence for one selected run |
| `RegistryPage` | Live inventory and health analysis |
| `GovernancePage` | Evidence-bound Candidate, approval, Canary, Stable, deprecation, and rollback workflow |
| `TeamPage` | Local Team initialization, Artifact directory, governance queues, entity/template-adoption summary, and sanitized backup |
| `ConnectModal` | Install command, config check, and live-activity check |
| `EvaluationWorkspace` | Candidate discovery, local match selection, A/B run, result, and contextual chat |
| `AiSettingsModal` | Multi-provider/model/endpoint configuration saved via local API |

## 9. Import/export behavior

The browser parser accepts a JSON array or JSONL. It invokes the shared event
normalizer before calling `POST /api/import`, giving the user line/index-specific
errors early. The server validates again because browser validation is not a
trust boundary.

Export is a browser-generated download of current local events. It is disabled
in demo mode. Clearing is disabled unless the local API is active.

## 10. Loading, error, and empty states

| State | Required treatment |
| --- | --- |
| Initial event request pending | Loading mode; do not assert zero data yet |
| Local API unavailable initially | Labeled demo data plus warning |
| Local API returns empty array | Genuine local zero state |
| Connection API unavailable | Unavailable status, not not-installed |
| Registry scan fails | Warning plus last successful/discovered fallback |
| Import invalid | No server append; visible failure reason |
| No evaluated outcomes | Lifecycle-only label, no percentage fabrication |

## 11. Accessibility and responsive behavior

Implemented expectations include:

- semantic buttons, tables, labels, status/alert roles, and dialog roles;
- Escape-to-close and focus restoration for the connect dialog;
- focus trapping inside the connect dialog;
- accessible names for icon-only controls;
- a keyboard-operable theme chooser with localized current and selected states;
- mobile sidebar scrim and explicit close action;
- horizontal containment for the wide Registry table.

New interactive modules must preserve keyboard navigation and avoid using color
as the only status signal.

The complete interface supports Simplified Chinese, English, French, Russian,
Spanish, and Japanese. Locale changes update translated copy, number and date
formatting, and the document `lang` attribute. All supported languages use
left-to-right document direction.

## 12. Frontend test surface

Tests should use visible outcomes through each module's interface:

- analytics functions for outcome and date semantics;
- charts for scale/empty rendering;
- connect modal for copy, status, focus, and refresh behavior;
- registry for scope/category/issue calculations;
- app tests for local/demo mode, routing, polling, import, and clearing;
- internationalization tests for catalog completeness, persistence, translated
  application copy, document language, and fallback from unsupported locales;
- theme tests for system defaults, legacy migration, manual persistence, root
  metadata, catalog selection, focus containment, responsive placement, and
  palette/sidebar contrast;
- Skill Lab tests for candidate analysis, session provider/reasoning setup,
  GPT-5.6 agent compatibility, A/B results, contextual chat, and assistant-drawer
  focus/close behavior;
- run detail for event correlation.

Avoid tests that assert private React state or implementation-only markup order.

## 13. Evaluation and governance surfaces

Implemented frontend boundaries:

- Quick Compare, Managed Suites, and History are separate views; Quick Compare
  keeps tasks and model content memory-only while loading explicitly saved AI
  settings from the local backend.
- Managed runs expose polling, cancellation, multi-case metrics, gates,
  sanitized evidence details, and JSON/HTML report actions.
- Governance shows Candidate-to-Stable provenance, exact hash bindings,
  independent approvals, stale evidence, preview/confirm installation, and
  rollback results.
- The Local Prompt Registry browses Git branch/commit metadata without
  displaying Prompt bodies, lets the user set immutable baseline/Candidate
  references, compares component hashes, applies model hints explicitly, and
  requires a separate action to create a governed Candidate.
- The Unified Artifact Registry filters the five kind-scoped asset types,
  displays immutable version metadata, compatibility, dependencies, and
  desired/observed installation state, and keeps GitHub import and version Diff
  actions preview-only. Stale asynchronous responses cannot replace a newer
  selection or preview.
- All new user-visible evaluation, governance, and connector copy is available
  in Chinese, English, French, Russian, Spanish, and Japanese.

Remaining planned frontend work:

- Saved views/filters if user evidence justifies persistence.
- Event-store retention controls.
- Large-history virtualization or server-side aggregation after JSONL scale limits are measured.
- Cursor connection UI only after a real adapter exists.
