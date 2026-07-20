# Frontend architecture: SkillOps dashboard

> Version: v0.3.1
> Status: implemented, with an explicitly marked Evaluations preview

## 1. Frontend goals

The frontend turns normalized local evidence into an honest operational view.
Its primary responsibilities are:

- separate inventory from execution;
- separate runtime workspaces before category totals;
- distinguish lifecycle completion from evaluated success;
- make local/demo/unavailable state obvious;
- provide usable import, export, clear, and connection workflows;
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
| Theming | Root semantic CSS tokens; system-default light/dark mode with a browser-local override |
| Charts | Lightweight React/SVG/CSS modules |
| Tests | Vitest + Testing Library + jsdom |

There is no remote client SDK, authentication state, router package, or global
state library in v0.3.1.

## 3. Routes and page intent

| Path | Page | Data source |
| --- | --- | --- |
| `/` | Overview | Events + connections |
| `/skills` | Skills | Terminal events + discovery metadata |
| `/runs` | Runs | Terminal and correlated lifecycle events |
| `/evaluations` | Evaluation preview | Hard-coded illustrative sample only |
| `/registry` | Registry | Live scan, falling back to discovery events on failure |
| `/settings` | Settings | Connections + local events |

`popstate` restores the matching page. Navigation updates browser history. The
production server falls back to `index.html` for extensionless SPA paths.

## 4. Application state

### Source state

- `events`: current event array;
- `connections`: runtime configuration/activity results;
- `mode`: `loading`, `local`, or `demo`;
- `eventEtag`: last event-store version;
- selected page, runtime, time range, menu, modal, and requested run.
- selected UI locale, persisted under the versioned browser key
  `skillops.locale.v1`.
- selected light or dark appearance after a manual choice, persisted under
  `skillops.theme.v1`; before a manual choice, the dashboard follows
  `prefers-color-scheme`.

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
- attention issue: duplicate, version conflict, disabled, or missing metadata.

Combined view inserts runtime group rows and marks Skill names present in more
than one runtime as shared.

### Settings

Connection rows show config truth separately from activity. Export serializes
the current local event array as JSONL. Clear requires a confirmation dialog and
uses the server's backup-first operation.

## 8. Component map

| Component | Responsibility |
| --- | --- |
| `Sidebar` | Responsive navigation, root theme control, and local-mode identity |
| `KpiStrip` | Outcome-aware summary metrics |
| `Charts` | Daily runs and runtime distribution |
| `SkillTable` | Runtime-specific Skill metrics and definition details |
| `ActivityRail` | Recent/expanded terminal lifecycle list |
| `RunDetail` | Correlated evidence for one selected run |
| `RegistryPage` | Live inventory and health analysis |
| `ConnectModal` | Install command, config check, and live-activity check |

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
- a keyboard-operable theme toggle with localized current and target states;
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
- theme tests for system defaults, manual persistence, root metadata, and
  light/dark switching;
- run detail for event correlation.

Avoid tests that assert private React state or implementation-only markup order.

## 13. Planned frontend work

- Real evaluation runner results and promotion workflow.
- Saved views/filters if user evidence justifies persistence.
- Event-store retention controls.
- Large-history virtualization or server-side aggregation after JSONL scale limits are measured.
- Cursor connection UI only after a real adapter exists.
