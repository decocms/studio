# Repository Guidelines

This file provides guidance when working with code in this repository, including for Claude Code (claude.ai/code) and other AI coding assistants.

## Documentation Philosophy

**IMPORTANT**: The documentation in `apps/docs/` describes the **intended system design and behavior**, not necessarily the current implementation state. Documentation represents the target architecture and how the system should work, serving as both specification and aspiration. When implementation and documentation differ, the documentation defines the goal, not a bug to be "fixed" in the docs.

## Overview

Studio is an open-source control plane for Model Context Protocol (MCP) traffic. It provides a unified layer for authentication, routing, and observability between MCP clients (Cursor, Claude, VS Code) and MCP servers. The system is built as a monorepo using Bun workspaces with TypeScript, Hono (API), and React 19 (UI).

## Commands

### Development
```bash
# Start full dev environment (migrations + client + server)
bun run dev

# Start Studio client only (Vite dev server on port 4000)
bun run --cwd=apps/web dev

# Start Studio server only (Hono with hot reload)
bun run --cwd=apps/api dev:server

# Run documentation site locally
bun run docs:dev

# Native desktop app (Tauri) dev loop — HMR via Vite on port 4420
bun run --cwd=apps/native dev
```

**One-time macOS setup for `apps/native` devs**: run
`bun run --cwd=apps/native dev:signing:setup` once. It creates or reuses the
local self-signed `decocms-dev` code-signing identity; no Apple Developer
account is required. It also builds, signs, and installs one fixed
`decocms-keychain-helper` under the user's Application Support directory.
Debug app rebuilds talk to that unchanged helper over JSON stdin/stdout, so
Keychain sees one stable executable; tokens never use argv, logs, or a
filesystem fallback. The native dev runner still signs the app itself and
fails closed if signing drifts, but the fixed helper—not the app's self-signed
designated requirement—is what makes debug Keychain access stable. Debug
sessions stay in the Keychain-only `com.decocms.studio.dev` namespace; release
sessions stay in `com.decocms.studio`.

### Testing & Quality
```bash
# Run all tests (Bun test runner)
bun test

# Run tests for specific file/pattern
bun test path/to/file.test.ts

# TypeScript type checking (all workspaces)
bun run check

# Lint with oxlint and custom plugins
bun run lint

# Format code with Biome (ALWAYS run before committing)
bun run fmt

# Check formatting without modifying
bun run fmt:check
```

### Resilience Tests (Docker required)
```bash
# Run full resilience suite (builds containers, runs tests, tears down)
./tests/resilience/run.sh

# Or step by step:
docker compose -f tests/resilience/docker-compose.yml up -d --build --wait
bun test tests/resilience/scenarios/ --serial --timeout 900000
docker compose -f tests/resilience/docker-compose.yml down -v
```

Resilience tests use Docker Compose with Toxiproxy to simulate infrastructure failures (DB outages, NATS disconnections, high-latency MCP servers). See `tests/resilience/` for scenario files and configuration.

**IMPORTANT**: Always run `bun run fmt` after making code changes to ensure consistent formatting. A lefthook pre-commit hook is configured to run this automatically. Install with `npx lefthook install`.

### Database
```bash
# Run Kysely migrations (from apps/api/)
bun run --cwd=apps/api migrate

# Run Better Auth schema migrations
bun run --cwd=apps/api better-auth:migrate
```

#### Querying local postgres during development
The dev server uses embedded postgres on a **dynamic port**. To query it while `bun run dev` is running:

1. Find the port:
```bash
ps aux | grep "postgres -D" | grep -v grep
# Look for -p <PORT> at the end of the command
```

2. Run queries via a bun inline script (uses the `pg` package from apps/api):
```bash
cat << 'EOF' | bun run --cwd apps/api -
import pg from "pg";
const client = new pg.Client("postgresql://postgres:postgres@localhost:<PORT>/postgres");
await client.connect();
const { rows } = await client.query("SELECT * FROM <table> LIMIT 5");
console.log(JSON.stringify(rows, null, 2));
await client.end();
EOF
```

Replace `<PORT>` with the port found in step 1. The `--cwd apps/api` is required so bun resolves the `pg` dependency from the API workspace.

### Build & Deploy
```bash
# Build runtime package
bun run build:runtime

# Build Studio client (production)
bun run --cwd=apps/web build

# Build Studio server (bundle for deployment)
bun run --cwd=apps/api build:server

# Run production build
bun run --cwd=apps/api start
```

## Architecture

### Core Abstractions

**StudioContext** (`apps/api/src/core/studio-context.ts`)
The central runtime interface injected into all tools. Provides:
- `auth`: Authentication state (user, session, organization)
- `access`: Access control layer (RBAC checks)
- `storage`: Database operations (Kysely-based)
- `vault`: Credential vault for secure token storage
- `tracer`: OpenTelemetry distributed tracing
- `meter`: OpenTelemetry metrics collection

Tools NEVER access HTTP objects, database drivers, or environment variables directly—all dependencies flow through StudioContext.

**defineTool()** (`apps/api/src/core/define-tool.ts`)
Declarative API for creating type-safe, auditable MCP tools. Automatically provides:
- Input/output validation (Zod schemas)
- Authorization checking (`ctx.access.check()`)
- Audit logging
- OpenTelemetry tracing and metrics
- Structured error handling

Example tool structure:
```typescript
export const EXAMPLE_TOOL = defineTool({
  name: "EXAMPLE_TOOL",
  description: "...",
  inputSchema: z.object({ ... }),
  outputSchema: z.object({ ... }),
  handler: async (input, ctx) => {
    await ctx.access.check(); // Authorization
    const result = await ctx.storage.someTable.create(...);
    return result;
  },
});
```

### Project Structure & Module Organization

The workspace is managed via Bun workspaces. Studio is split into an independent
Hono backend and Vite/React frontend. Documentation lives in `apps/docs/`
(Astro-based).

**apps/api/** - Hono backend
- `src/api/` - Hono HTTP routes + MCP proxy routes
- `src/auth/` - Better Auth (OAuth 2.1 + SSO + API keys)
- `src/core/` - StudioContext, AccessControl, defineTool
- `src/tools/` - Built-in MCP management tools (organized by domain)
- `src/storage/` - Kysely database adapters and operations
- `src/event-bus/` - Pub/sub event delivery system (CloudEvents v1.0)
- `src/encryption/` - Token vault & credential management
- `src/observability/` - OpenTelemetry tracing & metrics
- `migrations/` - Kysely database migrations

**apps/web/** - React 19 admin UI (Vite + TanStack Router)

**packages/** - Shared logic
- `packages/shared/` - Private isomorphic contracts, browser-safe SDK utilities, and async primitives shared through explicit `@decocms/shared/*` subpaths
- `packages/bindings/` - Core MCP bindings and connection abstractions (defines standardized interfaces)
- `packages/runtime/` - Runtime utilities for MCP proxy, OAuth, and tools
- `packages/ui/` - Shared React components (shadcn-based design system)
- `packages/create-deco/` - Project scaffolding tool (npm init)

Database migrations live in `apps/api/migrations/`, code quality plugins in
`plugins/`, and infrastructure/deploy configs in `deploy/`.

### Key Architectural Patterns

**Virtual MCPs** (`apps/api/src/tools/virtual/`)
Runtime strategies modeled as Virtual MCPs—different ways of exposing tools through one endpoint:
- Full-context: expose all tools (simple, deterministic)
- Smart selection: narrow toolset before execution
- Code execution: load tools on demand in sandbox

Virtual MCPs are configurable and extensible.

**Bindings System** (`packages/bindings/`)
Standardized interfaces that MCPs can implement (similar to TypeScript interfaces but with runtime validation):
- Define contracts with Zod schemas
- Tools check if connections implement specific bindings
- Well-known bindings: collections (CRUD), models (AI providers), event bus, event subscriber
- Uses `createBindingChecker()` for runtime verification

**Event Bus** (`apps/api/src/event-bus/`)
Pub/sub system between connections following CloudEvents v1.0 spec:
- At-least-once delivery with exponential backoff (1s to 1hr, max 20 attempts)
- Scheduled delivery (`deliverAt`) and recurring events (`cron`)
- Per-event results (subscribers can return individual results per event)
- NotifyStrategy: NATS notify (immediate wake-up) + PollingStrategy (safety net for scheduled/cron delivery)

#### Event Bus Files
- `packages/bindings/src/well-known/event-bus.ts` - EVENT_BUS_BINDING (PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CANCEL, ACK)
- `packages/bindings/src/well-known/event-subscriber.ts` - EVENT_SUBSCRIBER_BINDING (ON_EVENTS)
- `apps/api/src/event-bus/` - EventBus implementation and worker
- `apps/api/src/event-bus/polling.ts` - Timer-based PollingStrategy (safety net for scheduled/cron delivery)
- `apps/api/src/event-bus/nats-notify.ts` - NatsNotifyStrategy (immediate wake-up via NATS)
- `apps/api/src/storage/event-bus.ts` - Database operations
- `apps/api/src/tools/eventbus/` - MCP tools (publish, subscribe, unsubscribe, list, cancel, ack)
- `apps/api/migrations/008-event-bus.ts` - Database schema

#### Event Bus MCP Tools
- `EVENT_PUBLISH` - Publish events (supports `deliverAt` for scheduled, `cron` for recurring)
- `EVENT_SUBSCRIBE` - Subscribe to event types
- `EVENT_UNSUBSCRIBE` - Remove subscriptions
- `EVENT_SUBSCRIPTION_LIST` - List subscriptions
- `EVENT_CANCEL` - Cancel a recurring cron event (only publisher can cancel)
- `EVENT_ACK` - Acknowledge event delivery (used with `retryAfter` flow)

#### Event Bus Bindings
- `EVENT_BUS_BINDING` - For connections using the event bus (PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CANCEL, ACK)
- `EVENT_SUBSCRIBER_BINDING` - For connections receiving events (implements `ON_EVENTS`)

#### ON_EVENTS Response
Subscribers can return batch or per-event results:
```typescript
// Batch mode
{ success: true }

// Per-event mode
{
  results: {
    "event-1": { success: true },
    "event-2": { success: false, error: "Validation failed" },
    "event-3": { retryAfter: 60000 }  // Retry in 1 minute, use EVENT_ACK to confirm
  }
}
```

#### NotifyStrategy Architecture
The worker doesn't poll internally - it relies on a NotifyStrategy to trigger processing:
- `NatsNotifyStrategy` - Primary: immediate wake-up via NATS pub/sub
- `PollingStrategy(intervalMs)` - Safety net: picks up scheduled/cron deliveries
- Both are composed together via `compose()` so the worker responds to either signal

#### Event Bus Configuration (EventBusConfig)
```typescript
{
  pollIntervalMs: 5000,    // Poll interval for PollingStrategy (default 5s)
  batchSize: 100,          // Max events per batch
  maxAttempts: 20,         // Delivery attempts before failure
  retryDelayMs: 1000,      // Base delay (1s)
  maxDelayMs: 3600000,     // Max delay cap (1hr)
}
```

### Database & Storage

Uses **Kysely ORM** with embedded PostgreSQL (via `embedded-postgres` package) for local development and standard PostgreSQL for production.
- Database URL: `DATABASE_URL` environment variable (defaults to `postgresql://postgres:postgres@localhost:5432/postgres`)
- Local data directory: `~/deco/services/postgres/data`
- Schema types: `apps/api/src/storage/types.ts`
- Operations organized by domain: `apps/api/src/storage/`
- Multi-tenancy: Workspace/project isolation for config, credentials, policies, audit logs
- Migrations use Kysely's migration system combined with Better Auth migrations

Database schema key concepts:
- Organizations managed by Better Auth organization plugin
- Connections are organization-scoped (workspace or project level)
- Permissions follow Better Auth format: `{ [resource]: [actions...] }`

### Authentication & Authorization

**Better Auth** for authentication:
- OAuth 2.1, SSO, API keys
- Config: `AUTH_*` environment variables (`apps/api/src/auth/auth-env.ts`)

**AccessControl** (`apps/api/src/core/access-control.ts`) for authorization:
- Organization/project-level RBAC
- Fine-grained permissions per workspace/project
- Connection-specific permissions (e.g., `{ "conn_<UUID>": ["SEND_MESSAGE"] }`)

### Observability

**OpenTelemetry** (`apps/api/src/observability/`)
- Full tracing for tools, workflows, and UI interactions
- Metrics collection (Prometheus exporter)
- Logging with OTLP exporter
- Every tool call automatically traced

## Coding Style & Naming Conventions

### Async primitives — use `@decocms/shared/std`, never hand-roll

`@decocms/shared/std` is the ONE canonical home for these — a small,
zero-dependency, isomorphic (Node / Bun / browser) module ported from Deno std.
It was consolidated from ~9 ad-hoc backoff copies and ~9 ad-hoc `sleep` copies.
Do NOT write another `Math.min(base * 2 ** attempt, cap)` formula, jitter
expression, `for`/`while` retry loop, `new Promise(r => setTimeout(r, ms))`, or
`Bun.sleep` (Bun-only — defeats portability).

- **`sleep(ms, { signal? })`** / **`delay(...)`** (same function) — wait `ms`,
  optionally cancellable via `AbortSignal` (rejects with the signal's reason on
  abort; `.catch(() => {})` if you want resolve-on-abort).
- **`retry(fn, opts)`** — call a possibly-async function until it succeeds.
  Supports `maxAttempts`, `minTimeout`/`maxTimeout`, `multiplier`, `jitter`
  (0–1), an `isRetriable(err)` predicate (e.g. retry only 5xx), and an
  `AbortSignal`. Throws `RetryError` (with `.cause`) on exhaustion.
- **`exponentialBackoffWithJitter(cap, base, attempt, multiplier, jitter)`** —
  the pure delay calculator, for stateful loops that can't be a single function
  (WebSocket/SSE reconnect, durable event delivery). `jitter`: `0` = none,
  `0.5` = equal `[exp/2, exp]`, `1` = full `[0, exp]`.

All consumers (`apps/api`, `apps/web`, and packages) import via
`@decocms/shared/std`. If you think you need a new retry/sleep mechanism, you
don't — extend the options or ask. The circuit breaker
(`mcp-clients/circuit-breaker.ts`) is a different pattern (fault isolation) and
is intentionally separate.

### Org-level flags

Org boolean toggles live in the `organization_settings.flags` jsonb bag — never
a new column. Adding one = one line in **`OrgFlagsSchema`**
(`packages/shared/src/organization/schema.ts`, the single source of truth) +
its consumer, then `bun run --cwd=apps/api generate:tool-contracts`. Read via
`useOrgFlag("<flag>")` (web) or `settings?.flags?.<flag>` (api); set via
`ORGANIZATION_SETTINGS_UPDATE { flags: { <flag>: true } }`. Updates
shallow-merge (explicit `false` persists, omitted keys survive); unset reads as
off. Flags are product gating, not access control. Anything non-boolean or ever
needing an index/constraint gets its own column instead.

### Style & Formatting
- **Biome** enforces two-space indentation and double quotes
- **ALWAYS** run `bun run fmt` after making code changes (pre-commit hook via lefthook)
- Components and classes: PascalCase
- Hooks and utilities: camelCase
- Files in shared packages: kebab-case (enforced by `plugins/enforce-kebab-case-file-names.ts`)
- A comment that takes a paragraph to justify a workaround is a signal the code is wrong, not the comment—fix the code, don't explain it away

### "Thread" vs "Chat" naming
The domain concept is a **thread** — that's the name on the backend and in all code: DB columns/tables, storage, tools, API routes, wire payloads, query keys, types, hooks, variables, functions. Do NOT rename any of these to "chat".

User-facing copy calls it a **chat** — anything a person reads in the UI: JSX text, button/menu labels, placeholders, tooltips, `aria-label`s, headings, empty states, toasts/error messages. Write these as "chat".

So a `thread`-named identifier can render "New chat" in a label; keep the code identifier as `thread` and only the displayed string as "chat". When in doubt: if it crosses the wire or lives in code, it's "thread"; if a user reads it, it's "chat".

### Internationalization (i18n)

The web UI (`apps/web/src`) is internationalized by a zero-dependency module at
`apps/web/src/i18n/` — plain TS dictionaries, no library.

- **Never hardcode user-facing strings** in `apps/web/src` — JSX text, toasts,
  placeholders, `aria-label`s, tooltips, empty states all go through `t()`.
- **Usage**: `const t = useT()` (`@/i18n/use-t.ts`) inside a component/hook, then
  `t("settings.title")` or `t("some.key", { name })` — `{name}` placeholders are interpolated.
- **Dictionaries**: one file per feature domain in `i18n/en/` (e.g. `en/settings.ts`), flat
  keys namespaced by domain (`"settings.preferences.theme"`). English is the source of truth:
  `en/index.ts` spreads every domain `as const` and derives `TranslationKey` from it.
- **Translations**: `i18n/pt-br/<domain>.ts` mirrors its en counterpart and must
  `satisfies Record<keyof typeof <enDomain>, string>` — a missing or extra key is a compile
  error, so `bun run check` proves translation completeness. New domain: create the en file,
  spread it in `en/index.ts`, mirror in `pt-br/` and spread in `pt-br/index.ts`.
- **Preference**: `language` lives in `usePreferences()` (localStorage), defaulting from
  `navigator.language`. `useT` is reactive to it (TanStack Query) — no provider, no reload.
- The "thread vs chat" rule applies to dictionary *values*; keys are code and may say `thread.*`.
- Language option labels ("English", "Português (Brasil)") stay in their own language — never translated.
- **Deliberately out of scope**: server-originated strings (API `error.message` shown in
  toasts), transactional emails, and seeded/user data stay English — do not thread the locale
  through to the server.
- Strings interleaved with JSX elements (links/bold mid-sentence) that can't be expressed as a
  single template: mark with `// TODO(i18n): rich text` and leave hardcoded for a manual pass.
- `packages/ui` stays i18n-free: its few built-in English defaults are overridable via props;
  pass translated strings from the app.

### React 19 Patterns
- Uses React 19 with React Compiler (babel-plugin-react-compiler)
- **DO NOT** use `useEffect` (banned by `plugins/ban-use-effect.ts`)—prefer alternatives
- **DO NOT** use `useMemo`/`useCallback`/`memo` (banned by `plugins/ban-memoization.ts`)—React 19 compiler handles optimization
- Tailwind v4 design system with tokens enforced by `plugins/ensure-tailwind-design-system-tokens.ts`

### Custom Oxlint Plugins
Located in `plugins/`:
- `enforce-kebab-case-file-names.ts` - kebab-case for shared package files
- `enforce-query-key-constants.ts` - query keys must use constants
- `ban-use-effect.ts` - ban useEffect
- `ban-memoization.ts` - ban useMemo/useCallback/memo
- `ensure-tailwind-design-system-tokens.ts` - enforce Tailwind consistency
- `ban-cross-tree-imports.js` - prevent packages from reaching into app source
- `ban-web-server-imports.js` - enforce the `apps/web` ↛ `apps/api/src` boundary
- `ban-e2e-app-imports.js` - deny-by-default import allowlist for the `packages/e2e` suite (see E2E isolation below)

### TypeScript
- Favor explicit types over `any`
- Use Zod for runtime validation and schema definitions
- TypeScript 7 (native compiler) with strict mode enabled. The programmatic
  compiler API is absent from TS 7.0 (returns in 7.1) — consumers of it are
  pinned to 5.9: `apps/api/scripts/generate-tool-contracts.ts` (via the
  `typescript5` alias) and `packages/typegen` (its tsup dts build). Drop both
  pins when 7.1 lands.

## Testing

See [`TESTING.md`](./TESTING.md) for the testing philosophy and rules.

**Short version:** two tiers, no third.
- **Unit (`bun test`)** — pure logic only. No mocks, no DB, no network. Co-located `*.test.ts` next to source.
- **E2E (Playwright)** — everything else. Real Postgres + NATS + Better Auth. Lives in `packages/e2e/tests/` (the isolated `@decocms/e2e` workspace).

If a test needs `vi.mock`, `mock.module`, a stubbed `StudioContext`, or a fake `fetch` — it's not a unit test. Move it to e2e.

### E2E isolation (black-box contract)

The e2e suite is a **black-box contract** over HTTP + DB: spin the server, hit it over the wire,
assert on responses. It must stay decoupled from the implementation so a component can be rewritten
— even in another language — and the same suite still holds. The in-sandbox daemon's suite
(`packages/sandbox/daemon-e2e/daemon.*.e2e.test.ts`) already works this way: it spawns the built binary
(swap it via the `DAEMON_E2E_CMD` env) and asserts only over HTTP. The Studio suite lives in the
dedicated `packages/e2e` (`@decocms/e2e`) workspace behind the same wall — its Playwright config
spawns `apps/api` and `apps/web` as separate processes via `webServer.cwd`
(process boundaries, not imports).

Rules:
- **No imports from `apps/*/src/**` and no `@/` app alias** in `packages/e2e`. Enforced by
  `plugins/ban-e2e-app-imports.js` (oxlint, `error`, deny-by-default) + a `paths: {}` override in
  `packages/e2e/tsconfig.json`. Only a small explicit allowlist of workspace packages is permitted
  (any unlisted `@decocms/*` is denied too, so app code creeping into `packages/` can't silently
  widen the test surface).
- **Do not silence this lint.** If a test needs a value, either **inline the expected shape** (a
  black-box test owning its contract is correct, not duplication — a divergence from the app is a
  wire-contract regression *signal*) or add the dep to **both** `packages/e2e/package.json` and the
  plugin allowlist, with justification.
- **Tenant-scope every DB assertion** (per-test org/user/thread/run) — that's what makes
  `fullyParallel` safe. Never assert on values shared across runs; the one global namespace is email
  domain (use a unique domain per run). Playwright's worker count is effectively the Postgres
  connection budget.

## Working with Tools

When creating new MCP tools:
1. Use `defineTool()` from `apps/api/src/core/define-tool.ts`
2. Place tools in appropriate domain folder under `apps/api/src/tools/`
3. Always inject `StudioContext` as second parameter
4. Call `await ctx.access.check()` for authorization
5. Use `ctx.storage` for database operations (never access Kysely directly)
6. Define Zod schemas for input/output validation
7. Tools are automatically traced, logged, and metrified

## Working with Bindings

When defining or checking bindings:
1. Import from `@decocms/bindings` or well-known subpaths (e.g., `/collections`, `/models`)
2. Use `createBindingChecker()` to verify if tools implement a binding
3. Collection bindings require base entity fields: `id`, `title`, `created_at`, `updated_at`, `created_by`, `updated_by`
4. Use `{ readOnly: true }` for collections that shouldn't be modified
5. Bindings define contracts—tools implement the actual logic

## Commit & Pull Request Guidelines

Follow Conventional Commit format: `type(scope): message`
- Wrap type in brackets for chores: `[chore]: update deps`
- Reference issues: `(#1234)`
- Examples:
  - `feat(roles): add granular model permissions`
  - `fix(event-bus): handle retry after flow correctly`
  - `[release]: bump to 2.72.0`

### Pre-commit Hook
Lefthook runs `bun run fmt` automatically. Install with:
```bash
npx lefthook install
```

### Pull Requests
PRs should include:
- Succinct summary of changes
- Testing notes and affected areas
- Screenshots for UI changes
- Confirm `bun run fmt` and `bun run lint` pass
- Run `bun test` before requesting review
- Flag follow-up work with TODOs linked to issues

## Ship it review-ready — the first-pass checklist

Auditing ~300 merged PRs shows a consistent shape: a first draft ships the **happy
path**, then a **hardening pass** (frequently a second person — the author who
vibecoded it opens, an engineer takes over the branch, adds commits, and merges)
adds the *same categories of change* every time. Those categories are below. Do
them in the **first** PR — they are the difference between "works in the demo" and
"survives production." Each item cites a real PR.

1. **Handle the variants, not just the happy path.** Cover empty / null /
   whitespace / duplicate / oversized inputs and every schema shape, not the one
   in front of you. *(sections-editor #4008 added `@hide`, Lazy-wrapped, and
   blank-title cases the first pass skipped; storage #4426 had to measure payload
   size **before** `JSON.stringify`, not after; sandbox #4445 added pagination +
   filename-collision disambiguation + stale-file pruning to a catalog writer.)*

2. **Scope by tenant and permission.** Reads/writes are scoped to the current
   user/org; other people's data is **read-only unless owned**. A validation or
   dedup gate must inspect the **complete** payload, not one representative slice.
   Never reuse a cache/list/React key across two shapes, and never conflate ids.
   *(#4230 fix: teammates' threads must be read-only in the "All" view; #4416: the
   publish gate had to union the committed **and** working-tree diffs; #4373: list
   keys collided across skill/prompt of the same name.)*

3. **Get concurrency right — no silent data loss.** For any "start B while A is in
   flight" path, trace what happens to A's output and B's input under
   concurrency-1 / a latch / a retry. Make side-effecting steps **non-retriable
   unless idempotent**, claim fences/slots at **dispatch**, not at request time,
   and coalesce fire-and-forget writes that share a path. *(#4365: a fence claimed
   at POST time silently dropped an in-flight run's reply; #4409: a retriable
   agent-loop step re-ran 3× and spliced generations; #4445: per-run catalog
   re-sync raced itself.)*

4. **Test each behavior you touch — in the right tier** (see [Testing](#testing)).
   Add a test *per fix*. When you fix a bug, find the test that encodes the **old**
   behavior and **invert** it — don't just append a new one. `grep` **all** tiers
   (unit **and** `packages/e2e`) for any string or wire/storage contract you
   changed. Storage changes need a real-Postgres test (in-memory fakes accept
   columns the `update()` whitelist silently drops). E2E must not depend on a model
   tier/provider absent in the test org. *(#4008 shipped a test with each fix;
   #4446/#4430 had to invert tests that asserted the bug; #4350's e2e still
   asserted pre-redesign copy; #4355 needed real-PG; #4365's e2e depended on a
   provider tier.)*

5. **Leave no dead code.** After you change who calls a symbol, narrow its export
   to module-private and delete the newly-orphaned helpers/components/branches in
   the **same** PR. Run `knip` before declaring done (see Gotcha #6). *(#4230
   deleted 297 lines of components the refactor orphaned; #4449, #4350, #4373 each
   shipped a follow-up un-exporting a now-internal symbol knip flagged.)*

6. **Complete the lifecycle and reset state.** New persisted state ships
   **create + update + delete together**; make the writer idempotent (clear-then-write
   for index/slug-named files); clean it up when the parent is deleted. A
   "start/reset" transition must clear the previous cycle's terminal columns.
   *(#4449 implemented create only — update ignored the field, delete orphaned the
   subtree; #4355 left a stale `failure_reason` because `RUN_STARTED` didn't null
   it.)*

7. **Make risky and infra changes reversible and bounded.** Any change on a
   boot/install/dispatch hot path gets its **own** default-off flag — never
   piggyback on a neighbor's flag, and never let "deployed" mean "enabled." New
   caches/artifacts need eviction (TTL + cap), bad-entry invalidation (publish only
   **after** a health signal), and `.git/info/exclude` so they don't leak onto user
   branches. Prefer the idle reaper to a fixed wall-clock timeout; emit heartbeats
   during silent phases. *(#4357: golden cache shipped dormant behind
   `GOLDEN_CACHE_ENABLED`, with GC and health-gated publish; #4445 git-excluded its
   artifact; #4355 dropped a fixed timeout for progress-based reaping; #4409 added
   heartbeats.)* Overstating a safety property in a comment/doc is itself a bug
   (#4357, #4363).

8. **Validate external input; don't over-engineer.** Validate URLs and user input.
   Prefer schema-driven behavior to clever runtime inference — an engineer reverted
   exactly that "infer from runtime data" cleverness in #4008. Use design-system
   tokens, not raw palette (#4350: `text-emerald-600` → `text-success`), and run
   `bun run fmt` before the first push (#4461 was a pure-format follow-up).

9. **Keep type-safety at compile time.** Don't `as`-cast to read a field off a
   union — narrow with an `in` / discriminant check so a rename is a **compile**
   error, not a runtime regression only e2e catches (#4365). Respect
   `noUncheckedIndexedAccess`.

## Common Gotchas

> The [first-pass checklist](#ship-it-review-ready--the-first-pass-checklist) above
> captures the review-driven gotchas mined from PR history. The list below is the
> always-load-bearing set.

1. **Never access environment variables directly in tools**—use StudioContext
2. **Never access HTTP context in tools**—use StudioContext for all state
3. **Database migrations**: Remember to run both Kysely migrations (`bun run migrate`) and Better Auth migrations (`bun run better-auth:migrate`)
4. **Event bus**: The worker doesn't poll internally—it relies on NotifyStrategy to trigger processing
5. **Formatting**: The pre-commit hook will reject commits if code isn't formatted with Biome
6. **Never modify knip configuration** (`knip.json`, `knip.config.ts`, etc.) to silence warnings. Knip warnings indicate dead code, unused exports, or unused dependencies—these are code smells that should be fixed by removing the unused code/export/dependency, not by adding exclusions to the knip config.
7. **CI errors are always on your branch**. The `main` branch CI always passes. When CI fails, the problem is in the code you changed—do not assume it's a pre-existing issue or a flaky test. Investigate and fix your code.
8. **The sandbox daemon is Go** (`packages/sandbox/daemon-go/**`) — one static binary per sandbox pod, the only daemon there is (the TypeScript one is deleted). Write Go there, not TypeScript. Its health probe is unforgiving: Studio polls it and marks the sandbox **dead** on a single miss, tearing the pod down mid-session, so never hold a lock across slow I/O on that path. The daemon's contract is asserted black-box in `packages/sandbox/daemon-e2e/` (swap the binary under test with `DAEMON_E2E_CMD`). Blocking work is still banned in Studio's own Bun processes — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## API Path Convention

All org-scoped API routes use the canonical shape `/api/:org/...` where `:org` is the
organization slug. The `resolveOrgFromPath` middleware (`apps/api/src/api/middleware/resolve-org-from-path.ts`)
looks up the org by slug, verifies the authenticated principal is a member, and sets
`ctx.organization`. Returns 404 for unknown slugs, 403 for non-members.

The legacy unscoped routes (e.g., `/api/connections/:id/oauth-token`, `/mcp/:connectionId`,
`/oauth-proxy/:connectionId/*`) are still mounted with a `logDeprecatedRoute` middleware
that emits `console.log("deprecated route", { route, method, org, user, ua })`. They will
be removed in a follow-up PR after the deprecation window. **New code MUST use the
org-scoped paths**; new frontend code MUST NOT send `x-org-id` or `x-org-slug` headers
for migrated routes (the org slug is in the URL path).

The aggregator that mounts every org-scoped sub-router lives at
`apps/api/src/api/routes/org-scoped.ts`. Add new org-scoped routes there.

Org slugs are **immutable** — `ORGANIZATION_UPDATE` rejects slug changes — so URLs remain
stable.

Instance-level routes (no org context, e.g. the deployment-admin surface) use an
underscore-prefixed namespace like `/api/_admin/...`, mounted before the `/api/:org`
catch-all so the static segment wins over the slug param.

## License

MIT License — see LICENSE.md for details.
