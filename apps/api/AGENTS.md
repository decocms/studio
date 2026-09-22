# API work

## Tools and authorization

Define MCP tools with `defineTool()` from `src/core/define-tool.ts`, with Zod
input/output schemas and `StudioContext` as the handler's second argument.
The handler must call `await ctx.access.check()`; the wrapper does not perform
that permission check for it.

Use `ctx.storage` for persistence. Tools receive dependencies through
`StudioContext`, including authentication, access control, credentials, and
telemetry. Keep HTTP objects, database drivers, and environment reads out of
tool handlers. Place each tool with its domain under `src/tools/`.

## Routes and tenant scope

New org-scoped routes use `/api/:org/...`, with the immutable organization
slug in the path. Register them in `src/api/routes/org-scoped.ts`.
`resolveOrgFromPath` checks membership and supplies the organization context.
Use these paths from clients instead of legacy unscoped routes or `x-org-id`
and `x-org-slug` headers.

Instance routes use an underscore-prefixed namespace such as `/api/_admin`.
Mount them before the `/api/:org` catch-all.

## Realtime delivery

For Studio-owned state:

1. Emit through `sseHub.emit(orgId, event)` in a named helper beside the owner
   of the change. `emitTaskBoardUpdated` in `src/tools/task-board/run-reactions.ts`
   is a reference; `NatsSSEBroadcast` carries events across pods.
2. Define a shared event constant in `packages/shared` with a dotted,
   past-tense value, such as `TASK_BOARD_ITEM_UPDATED_EVENT`.
3. Add the type to `WATCH_TYPES` and export a `filterEventTypes` view in
   `apps/web/src/hooks/watch-sse-pool.ts`. The watch route has no separate
   event allowlist.
4. Subscribe with `useSyncExternalStore`; use `use-task-board-events.ts` as
   the web reference.

For GitHub-owned state, extend `/api/_github/webhook`. A GitHub App has one
webhook URL. Consume the transition that changes the answer, such as a
completed check suite. Keep the slow fallback poll: the webhook returns 503
when `GITHUB_WEBHOOK_SECRET` is absent.

Read GitHub trees through the blob cache and `mapBounded`. Keep memoization
outside retries and use `isRateLimitError` to exclude rate-limit errors from
retries; another burst makes a 429 worse.

## Storage and runtime

Use the storage adapters under `src/storage/`. Database schema changes use
Kysely migrations; auth schema setup also needs Better Auth migrations.
Commands and local database access are documented in [README.md](README.md).

Keep synchronous I/O and large CPU-bound work off Bun's request path. Use
async filesystem APIs, stream large payloads, and bound concurrency.

When adding or reading organization flags, read
[packages/shared/AGENTS.md](../../packages/shared/AGENTS.md#organization-flags).

Before changing tool-contract generation or its compiler dependency, check
`scripts/generate-tool-contracts.ts`. It uses the `typescript5` alias because
the TypeScript 7.0 native compiler lacks the programmatic compiler API.
Remove that exception only when the installed compiler supports the API.
