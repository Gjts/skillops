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
| `/` | Command Center | `/api/command-center` + connections |
| `/agents` | Agents | bounded `/api/agents` projection |
| `/activity` | Activity | paged terminal runs + on-demand correlation |
| `/assets` | Assets | live scan + Artifact/conflict APIs |
| `/benchmarks` | Benchmarks | Quick Compare + Managed Suite APIs |
| `/releases` | Releases | Capability/evidence/approval/release APIs |
| `/settings` | Settings | connections + bounded event summary/settings |
| `/settings?section=advanced-team` | Advanced Team | existing Team, policy, template, Prompt, and audit APIs |

Legacy `/skills`, `/runs`, `/evaluations`, `/registry`, and `/governance` paths
map to the corresponding canonical product page. Legacy `/team` is replaced
with `/settings?section=advanced-team` so refresh/history use one canonical
location.

`popstate` restores the matching page. Navigation updates browser history. The
production server falls back to `index.html` for extensionless SPA paths.

## 4. Application state

### Source state

- canonical page plus page-owned filter/tab/page state restored from the URL;
- `connections`: runtime configuration/activity results;
- Command Center and Runs `loading`, `local`, or `demo` transport state;
- deterministic sample events only while the explicit Activity Demo fallback is active;
- responsive menu/modal state and requested run ID;
- selected UI locale, persisted under the versioned browser key
  `skillops.locale.v1`;
- appearance follows the OS until the user selects stable Light/Dark or an
  experimental catalog theme. Manual choices persist under
  `skillops.theme.v2`; choosing System removes that key. A small in-document
  change event keeps the Sidebar and Settings chooser instances synchronized.
  The pre-paint bootstrap and React hook both migrate the legacy
  `skillops.theme.v1` light/dark preference to DevTools/Synapse;
- candidate URL/selection, local baseline, A/B inputs/results, and chat messages
  held only while the Benchmark page is mounted;
- AI provider settings loaded from `/api/ai-settings`; credentials are never
  written to browser storage or rendered in full by the settings modal;
- Team count/adoption summary plus independently paged Artifact catalog,
  Approval Inbox, and Release Queue loaded only on `/team`.

Evaluation request/result and Artifact types come from the shared Evaluation
Schema declaration. The frontend does not define parallel Candidate/result
interfaces or import backend implementations.

`src/lib/themeCatalog.ts` is the authoritative source for theme IDs, color
schemes, browser theme colors, storage keys, legacy mappings, and system
defaults. A Vite HTML transform serializes its bootstrap subset into the inline
head script so the initial paint and the React runtime cannot drift.

### Derived state

Each primary page consumes one backend-owned bounded projection or page.
Command Center and Agents do not receive the complete event array. Activity
filtering, ordering, pagination, and detail correlation come from `/api/runs`;
Assets owns only its current live scan result. Derived UI state is not persisted.

## 5. Data refresh behavior

### Command Center

- requests `/api/command-center` with runtime and Today/7/14/30-day scope;
- treats Today as the server-projected local calendar day;
- refreshes the bounded snapshot every 3 seconds;
- marks data receipt and primary-content readiness for browser performance
  acceptance;
- keeps deterministic Demo data visibly separate through later failed refreshes
  and keeps its readiness facts consistent with its suggested actions;
- localizes action reason/impact, readiness reason-code labels, and metric
  definitions through stable IDs instead of rendering server-authored English;
- distinguishes an unavailable event source from a factual zero: partial
  sources retain known metrics, while unavailable metrics/recent runs use an
  explicit unavailable state and cannot trigger empty onboarding;
- requires complete connection facts before empty arrays can mean that no
  Runtime is connected;
- opens every recent row through the canonical Activity Run Detail route.

### Activity

- requests only the selected 20/50/100-row `/api/runs` page;
- checks for new matching runs with a newest-first bounded 20-row poll, never
  `/api/events`, and compares timestamp/ID identity rather than totals alone;
- preserves the loaded page and browser-history position until a replacement
  page succeeds, restoring its full filter/URL state if a request fails;
- moves to the last valid page if polling observes deleted matching runs;
- requests canonical `/api/runs/~:id` detail only after a run opens and renders
  loaded/total counts when its bounded 200-event window is truncated;
- retries the bounded Runs API in Demo mode without loading the full event feed.

### Agents

- requests one 50-row `/api/agents` page for the selected tab, runtime, time
  window, query, and page;
- requests one bounded detail record only after the drawer opens;
- resets pagination when a filter or tab changes.

### Connections and Settings

- the connection dialog requests sanitized `/api/setup/preflight` prerequisites
  before install and never receives runtime config paths or credentials;
- unavailable and negative data-directory probes both disable review
  confirmation without conflating unavailable with read-only, and the install
  command is rendered only after the user confirms the redacted dry-run review;
- **Check installation** refreshes both connection facts and sanitized preflight
  facts, so a repaired adapter cannot retain a stale unhealthy reference result;
- one bounded `GET /api/connections` page on mount and every 5 seconds;
- connection failure maps Codex/Claude Code to `unavailable` while Cursor stays
  `preview`;
- Settings requests `/api/events?summary=1` and `/api/ai-settings`, never the
  full event array, warns when the event source is partial, and exports through a direct
  `/api/events?download=1` navigation.

### Assets

- `POST /api/scan` on page mount and manual rescan;
- retains the last successful scan on a later failure;
- does not substitute stale discovery events before a successful scan.

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

### Command Center

`CommandCenter` renders seven readiness facts, deterministic issues, and at most
three Next Actions from one bounded aggregate. Each action has priority, reason,
evidence references, impact, and one CTA. Six metric cards expose backend
definitions and ratio numerators/denominators; unavailable success/cost remains
unavailable rather than becoming zero. At most eight terminal Recent Runs are
full-row Run Detail links.

A true empty snapshot (`terminalRuns === 0` and `observedAssets === 0`) replaces
the KPI cards with a privacy explanation and three-step quick start. Five Quick
Actions cover scan, connection verification, a Managed Suite, Candidate review,
and export. Demo mode keeps a persistent label and never merges demo and local
records.

### Agents

`AgentsPage` keeps Definitions and Observed Activity distinct, paginates both,
and opens one bounded evidence timeline. Runtime-aware keys prevent same-name
Agents in different runtimes from being merged.

### Activity

`RunsPage` requests one 20, 50, or 100-row page from `/api/runs`, validates page
metadata and every returned run, and replaces rather than appends pages. Search,
runtime, project, outcome, date, cost provenance, sort, page, and page size stay
in the URL. Stale responses cannot replace newer navigation state. `RunDetail`
requests correlation only when opened.

### Assets

`RegistryPage` requests one server-filtered 50-row page from the latest live
scan snapshot. Runtime is the primary workspace filter; source, provider,
enabled state, definition kind, and duplicate/conflict/disabled/missing
classifications follow that scope. Counts are computed from the complete
backend snapshot, while row issues and shared-name keys are returned only for
the current page. `ArtifactRegistry` independently requests one filtered
Artifact page and receives versions and installations only for those rows. Both
tables keep their filter/page state in the URL and reuse cached metadata until
an explicit refresh; neither receives definition bodies or a complete list.

### Settings

`SettingsPage` owns five bounded sections: Runtime connections, AI Providers,
Appearance, Data & Privacy, and Advanced links. Connection rows show
configuration truth, activity, stage, and last verified evidence separately.
Provider status returns model/endpoint configuration without credential echo.
The page uses a bounded summary for local-data status, navigates directly to the
backend JSONL download, names retention/encryption limitations, and requires a
focus-trapped confirmation before backup-first clear.

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
nine providers, traps focus, restores focus on close, and replaces every saved
key with a fixed mask before rendering; the reveal control never receives the
stored value. An unchanged mask preserves the saved key, while an explicit
replacement or clear is sent through the local AI settings API. The modal also
exposes reasoning effort for OpenAI-compatible transports.
`EvaluationWorkspace` surfaces the GPT-5.6 Chat Completions tool-call constraint
and disables incompatible agent runs.

## 8. Component map

| Component | Responsibility |
| --- | --- |
| `Sidebar` | Responsive navigation, global theme chooser, and local-mode identity |
| `CommandCenter` | Readiness, evidence-backed actions, honest metrics, true empty state, Recent Runs, and Quick Actions |
| `ThemeChooser` | System/Light/Dark stable choices plus the localized 25-style catalog (remaining choices experimental), synchronized selection, miniature previews, and accessible popover behavior |
| `SettingsPage` | Connection evidence, provider status/configuration, appearance, bounded data controls, and Advanced links |
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
| Command Center has no terminal runs or observed assets | Privacy/setup guidance; do not render zero KPI cards |
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
- setup preflight and Command Center for prerequisite truth, action bounds,
  metric denominators, empty/demo separation, Quick Actions, and Recent Run
  routing;
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
  sanitized evidence details, JSON/HTML report actions, and one final
  `create-candidate`, `keep-baseline`, `reject-candidate`, or
  `collect-more-evidence` Decision per completed run. Same-value retries reuse
  the Decision; changing it requires a new run. History consumes the stable
  backend cursor and exposes previous/next pages instead of hiding records
  after the first 50; navigation remains disabled while a cursor request is in
  flight so rapid input cannot duplicate the cursor stack.
- Governance shows Candidate-to-Stable provenance, exact hash bindings,
  independent authenticated approvals, stale evidence, preview/confirm
  installation, and rollback results. Candidate recovery matches the immutable
  `originEvaluationRunId`; later evidence updates do not create or rebind a
  second Release Candidate from the same run. Capability audit is explicitly
  unlocked with a transient Bearer token; a rejected read is never rendered as
  an empty audit. Candidate recovery uses a run-filtered Capability page, while
  release deep links and previous-Stable metadata use detail reads when the
  referenced Capability is outside the current page.
- The Local Prompt Registry browses Git branch/commit metadata without
  displaying Prompt bodies, lets the user set immutable baseline/Candidate
  references, pages through bounded server results, compares component hashes,
  applies model hints explicitly, and requires a separate action to create a
  governed Candidate.
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
