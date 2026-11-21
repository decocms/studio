# Plan: Real-Time Support & Debug Feed

**Source:** `org/home/pages/internal/discussion/instant-support-agentic-loop.html` —
"Instant Support & The Agentic Self-Heal Loop" (2026-06-30, @Baby + @Guilherme
Rodrigues, SRE input from @Nicácio Oliveira + @Hugo Cavalcanti Cabral).

**Ask:** one screen in Studio where developers/support can see every chat
thread going on across the product in near-real-time, spot anomalies, and
intervene — a debug/support mode. This is the "real-time admin feed" from the
doc's Solution section, item #3 of "What's next" ("Spec the real-time admin
feed: all active threads, anomaly flags, direct intervention, P0–P3 alert
routing, automatic MTT clock advancement").

This plan follows the doc's own Build framework (`How to Build: Fix to
Catalog`): **Tier 1 (in-org virtual, prove it fast) → Tier 2 (worker, if it
needs to scale) → Tier 3 (native Studio, once proven core)**. It also inventories
what already exists in `decocms/studio` so we don't rebuild primitives that
are already there — the doc's own diagnosis was "the orchestration is missing,
not the infrastructure," and that holds here too.

---

## 1. What already exists (reuse, don't rebuild)

Confirmed in this repo:

- **Per-org thread monitoring screen** — `apps/web/src/routes/orgs/monitoring/threads.tsx`.
  Already lists an org's threads in a table (agent, status, tokens, cost),
  opens a `ThreadSheetBody` conversation viewer on row click, paginates via
  `useInfiniteQuery`. This is the single best template for the new screen's
  UI and data-fetching shape — it is *not* real-time and it is *scoped to one
  org*, which are exactly the two gaps to close.
- **Real-time event bus, already wired to threads** — `apps/api/src/event-bus`
  emits `decopilot.thread.status` (see
  `apps/api/src/api/routes/decopilot/thread-status-events.ts`) on every
  terminal run transition (completed / errored / cancelled), scoped
  per-org (`sseHub.emit(orgId, event)`). The web side already consumes this:
  `apps/web/src/hooks/use-decopilot-events.ts`,
  `apps/web/src/hooks/decopilot-sse-pool.ts`, and the shared subscription
  primitive `apps/web/src/hooks/create-sse-subscription.ts` (ref-counted
  `EventSource` per tab, cross-tab leader election via a Web Lock +
  `BroadcastChannel` so we stay under the browser's ~6-connections cap, plus
  exponential-backoff reconnect). **This is the real-time transport the doc's
  "Solution" section assumes doesn't exist yet — it already does, per-org.**
  What's missing is only: (a) an event that fires on *every* message/tool-call,
  not just terminal status, and (b) a way to subscribe across orgs.
- **Failure taxonomy, already built** —
  `apps/api/src/api/routes/decopilot/classify-run-failure.ts`. Turns a failed
  run's raw error text into a stable `failure_kind` (`credits`,
  `sandbox_unreachable`, `overloaded`, `context_length`, `model_error`, ...)
  via ordered regex patterns, falling back to `GENERIC_RUN_FAILURE`. This is
  exactly the "classify by root cause" step the doc defers to "after
  diagnostics" — it shipped already, just scoped to task-board runs. The new
  feed reuses this classifier as-is for its anomaly/error column instead of
  inventing a second taxonomy.
- **Cross-org admin read pattern, already built for the Task Board** —
  `apps/api/src/core/task-board-admin.ts`. `STUDIO_ADMIN_ORG_IDS` (env-configured)
  names the org(s) whose members may read every tenant's board;
  `isAdminOrgId`, `isTaskBoardAdminUser`, `isTaskBoardAdminCtx` gate it, and
  `auditTaskBoardAdminAction` writes one audit row per cross-org read. The
  `TASK_BOARD_ADMIN_ORG_LIST` / `TASK_BOARD_*(org: "all")` tools in this very
  agent are the product surface of that pattern. **This is the permission
  model the new feed needs and should copy verbatim** (new
  `isSupportFeedAdminCtx`-style predicate, same env var or a sibling one),
  instead of inventing a new cross-org auth story.
- **Workspace-level (cross-org-shaped) route precedent** —
  `apps/web/src/routes/workspace/taskboard-analytics.tsx` shows how a screen
  above the single-org routing tree is wired into `apps/web/src/router.tsx`.
  New top-level admin screens are TanStack Router routes registered there,
  same as `orgs/monitoring/*`.

**Net:** the "wire, don't build" diagnosis holds. Per-org real-time transport,
a failure classifier, and a cross-org admin-read pattern already exist
independently for three different features. Nobody has connected the three
for chat threads yet.

## 2. What's genuinely missing (the real gaps)

1. **A per-message/per-tool-call event**, not just per-terminal-status. The
   feed needs to show a thread "thinking...", "tool call failed", "user
   waiting 8m", not only "run finished." Today's `decopilot.thread.status`
   only fires on completion.
2. **Cross-org subscription.** `sseHub.emit(orgId, event)` and the SSE pool
   are keyed by one org (mirrors browser cookies/session). An admin watching
   every org needs either (a) a fan-in on the server that re-emits into an
   admin-scoped channel, or (b) the admin client opening one EventSource per
   org it's allowed to see (bounded by `STUDIO_ADMIN_ORG_IDS`'s member orgs,
   which in practice is small — support only needs orgs with support
   contracts, not literally every tenant on day one).
3. **A P0–P3 severity/triage field and an "intervene" action** — sending a
   message into someone else's org's thread as a support identity. This
   needs a clear audit trail (who intervened, when, as what identity) and a
   product decision on how that shows up to the end customer (system message?
   silently as the agent? labeled "Deco Support joined")?
4. **MTTD/MTTI/MTTM instrumentation** is explicitly still unsolved per the
   doc itself (`callout callout-warn`: "The event store that ties SLO breach
   timestamps to Discord markers to PagerDuty MTTs doesn't exist yet"). Out of
   scope for the screen's first version; the screen should emit the raw
   timestamps (first anomaly seen, first ack, first fix message sent) so that
   store can be built on top later without re-instrumenting.

## 3. Proposed build — Tier 1 first

Per the doc's own decision framework ("Is it proven? If no → Tier 1."), ship
this as a Tier 1 in-org virtual tool + a minimal Studio-native read surface,
not a new service:

### Step 1 — Tier 1 spike (days, no deploy): prove the shape with data that exists today
- New read-only tool, `SUPPORT_FEED_LIST` (or fold into `TASK_BOARD_*`-style
  connection), built the same way `TASK_BOARD_TENANTS`/`TASK_BOARD_ERRORS`
  are: reuse `isAdminOrgId`/`isTaskBoardAdminCtx`-equivalent gating, query
  threads across the admin's visible orgs, run each failed one through
  `classifyRunFailure`, and return a flat list: org, agent, thread, status,
  failure_kind, last_message_at, participant.
- Ship this as a Virtual MCP tool first (Tier 1) so support/eng can point an
  existing agent (or a new lightweight one) at it and validate the triage
  columns (P0–P3 mapping) with one real support session before touching
  Studio's codebase at all.

### Step 2 — Native screen (Tier 3, once the shape is validated)
This *is* a core-UX, broadly-useful, every-org-benefits feature — it
qualifies for Tier 3 per the doc's own framework ("Right for: admin feed,
thread viewer, core agent management"). Concretely:
- New route: `apps/web/src/routes/workspace/support-feed.tsx` (workspace-level,
  like `taskboard-analytics.tsx`), registered in `apps/web/src/router.tsx`,
  gated behind the same admin-org predicate as (1).
- UI: fork `orgs/monitoring/threads.tsx`'s table + `ThreadSheetBody` sheet
  pattern, but the list spans every admin-visible org (columns add an Org
  chip) and adds a severity/status dot (reuse `feed-dot-ok/warn/err` visual
  language from the doc's mock) plus a `failure_kind` column driven by
  `classifyRunFailure`.
- Real-time: extend `decopilot.thread.status` (or add a sibling
  `decopilot.thread.activity` event) to fire on tool-call start/error and
  first-token, not just terminal status; subscribe via
  `create-sse-subscription.ts`'s existing pool, one connection per
  admin-visible org (small N in practice).
- Intervene action: reuses the existing chat send-message path scoped to the
  target org/thread, behind an explicit "Support intervened" system message
  and an audit row (mirror `auditTaskBoardAdminAction`).
- P0–P3 triage: a simple client-side rule first (P0 = run status `error` /
  `cancelled` from `classifyRunFailure`'s hard failures, P1 = stuck >N min on
  same tool call, P2/P3 = manual tag) — not a new ML classifier. Refine after
  a week of real usage.

### Step 3 — Tier 2 only if warranted
If support volume or the polling/fan-out cost outgrows what Studio's own
request path can carry (e.g. cross-org SSE fan-in becomes its own scaling
problem, or a customer wants this outside Studio entirely), promote the
`SUPPORT_FEED_LIST` tool + event fan-in into a standalone Worker MCP, listed
in the Store — same "Tier 1 → Tier 2 promotion path" the doc flags as the
still-missing piece worth building generally. Not needed for v1.

## 4. Open questions (carried from the source doc, still unresolved)

- Who is allowed in `STUDIO_ADMIN_ORG_IDS`/the support-feed admin org —
  same allowlist as Task Board admin, or a separate one? (Support staff vs.
  eng-with-task-board-access are not necessarily the same set.)
- What exactly triggers a P0 vs P1 vs P2 — needs a support/eng-owned rubric,
  not just "run failed."
- Does "intervene" post as a labeled support identity or take over the
  agent's voice invisibly? Product decision, not an engineering one.
- MTT event store (doc's own open item) — out of scope for v1 but the feed's
  event log is exactly the input that store will need, so timestamps should
  be captured from day one even before anything consumes them.

## 5. Suggested first milestone (2 weeks)

1. Ship `SUPPORT_FEED_LIST` Tier 1 tool, gated by the existing
   `STUDIO_ADMIN_ORG_IDS` pattern (or a new `SUPPORT_FEED_ADMIN_ORG_IDS`).
   Validate columns/severity with one live support session.
2. Ship the read-only native screen (Step 2's UI, without "intervene" yet) —
   list + sheet viewer, polling every 5-10s is an acceptable v0 if the SSE
   extension slips.
3. Add the `decopilot.thread.activity` event + live subscription.
4. Add "intervene" with audit trail.
5. Revisit MTTD/MTTI/MTTM instrumentation once the feed has been used for a
   week and the team has opinions on what "detected" should mean in practice.
