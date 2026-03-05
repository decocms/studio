# Technical Debt — Local-First DX

Items to address after the core local-first DX lands.

## NATS onboarding in local mode

The agentic onboarding flow should detect whether NATS is available and, if not,
offer to install and start it (via `brew install nats-server` or Docker). NATS
enables stream recovery (switch tabs / refresh → restore in-progress AI
responses). Without it, `NoOpStreamBuffer` is used and late-join replay is
disabled.

- Relevant code: `apps/mesh/src/api/app.ts` (NATS_URL detection),
  `apps/mesh/src/api/routes/decopilot/stream-buffer.ts` (NoOpStreamBuffer fallback)

## decocms package rename

`packages/studio/` publishes as `decocms` on npm (`bunx decocms` / `deco` CLI).
It's a thin wrapper that depends on `@decocms/mesh`. Eventually the source
should move to `decocms` as the canonical package and `@decocms/mesh` becomes
the wrapper (or is deprecated).

## Playwright e2e excluded from `bun test`

The Playwright e2e test (`apps/mesh/src/**/*.e2e.test.ts`) is picked up by
`bun test` and fails because `@playwright/test` conflicts with bun's test
runner. Should be excluded via bun test config or file naming convention.

---

## Items from PR review (deferred — belong to already-merged PRs)

### PROJECT_PINNED_VIEWS_UPDATE missing org ownership check (PR #2567)

The tool calls `requireAuth(ctx)` + `ctx.access.check()` but does not call
`requireOrganization(ctx)` or validate `project.organizationId !== organization.id`.
An authenticated user from org A could update pinned views on org B's project.

- File: `apps/mesh/src/tools/projects/pinned-views-update.ts`

### N+1 query in PROJECT_CONNECTION_LIST (PR #2567)

Each connection is fetched individually via `findById` inside `Promise.all(map(...))`.
No `findByIds` batch method exists on `ConnectionStorage`.

- Fix: Add `findByIds(ids: string[])` using `WHERE id IN (...)`
- File: `apps/mesh/src/tools/projects/connection-list.ts:52-56`

### COLLECTION_CONNECTIONS_GET write side-effect in readOnly tool (PR #2567)

The GET handler (annotated `readOnlyHint: true`) backfills missing tools via
`fetchToolsFromMCP` with a 2s timeout and calls `ctx.storage.connections.update()`.
A read operation should not have write side-effects.

- Fix: Move backfill to an explicit tool or post-OAuth event trigger
- File: `apps/mesh/src/tools/connection/get.ts`

### TaskStreamManager useSyncExternalStore misuse (PR #2563)

`subscribe` is a new function reference every render, causing interval leaks.
`useSyncExternalStore` is used as a lifecycle hook rather than for external store
subscription, which is semantically incorrect under React 19.

- Fix: Stabilize `subscribe` via `useRef` or restructure
- File: `apps/mesh/src/web/components/chat/context.tsx`

### ResizeObserver memory leak in monitoring dashboard (PR #2554)

Inline ref callback creates a new `ResizeObserver` on every render without
disconnecting the old one. Use React 19 ref callback cleanup:
`return () => observer.disconnect();`

- File: monitoring dashboard component (TBD exact location)

### Monitoring fetches 2000 raw rows to browser (PR #2554)

Dashboard fetches 2000 full `MonitoringLog` rows (including `input`/`output` JSON)
to the browser for client-side bucketing. Only 5 scalar fields are needed.

- Fix: Push aggregation server-side or add field projection to `MONITORING_LOGS_LIST`
- File: `apps/mesh/src/web/components/monitoring/hooks.ts:37`

### ondownloadfile handler should validate URI scheme (PR #2571)

`window.open(item.uri, "_blank")` accepts arbitrary URIs including `javascript:`.
Validate scheme is `http:` or `https:` before calling `window.open`.

- File: `apps/mesh/src/mcp-apps/use-app-bridge.ts`

### Thread/Task naming asymmetry

UI uses "task" but backend protocol uses "thread" everywhere (`COLLECTION_THREADS_LIST`,
`thread_id`, etc.). Either rename fully or document the mapping explicitly.

### Large component files should be split

- `apps/mesh/src/web/components/settings-modal/pages/org-billing.tsx` (1,732 lines)
- `apps/mesh/src/web/routes/orgs/monitoring.tsx` (1,510 lines)
