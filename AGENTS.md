# Repository Guidelines

This file provides guidance when working with code in this repository, including for Claude Code (claude.ai/code) and other AI coding assistants.

## Documentation Philosophy

**IMPORTANT**: The documentation in `apps/docs/` describes the **intended system design and behavior**, not necessarily the current implementation state. Documentation represents the target architecture and how the system should work, serving as both specification and aspiration. When implementation and documentation differ, the documentation defines the goal, not a bug to be "fixed" in the docs.

## Overview

MCP Mesh is an open-source control plane for Model Context Protocol (MCP) traffic. It provides a unified layer for authentication, routing, and observability between MCP clients (Cursor, Claude, VS Code) and MCP servers. The system is built as a monorepo using Bun workspaces with TypeScript, Hono (API), and React 19 (UI).

## Commands

### Development
```bash
# Start full dev environment (migrations + client + server)
bun run dev

# Start mesh client only (Vite dev server on port 4000)
bun run --cwd=apps/mesh dev:client

# Start mesh server only (Hono with hot reload)
bun run --cwd=apps/mesh dev:server

# Run documentation site locally
bun run docs:dev
```

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

**IMPORTANT**: Always run `bun run fmt` after making code changes to ensure consistent formatting. A lefthook pre-commit hook is configured to run this automatically. Install with `npx lefthook install`.

### Database
```bash
# Run Kysely migrations (from apps/mesh/)
bun run --cwd=apps/mesh migrate

# Run Better Auth schema migrations
bun run --cwd=apps/mesh better-auth:migrate
```

### Build & Deploy
```bash
# Build runtime package
bun run build:runtime

# Build mesh client (production)
bun run --cwd=apps/mesh build:client

# Build mesh server (bundle for deployment)
bun run --cwd=apps/mesh build:server

# Run production build
bun run --cwd=apps/mesh start
```

## Architecture

### Core Abstractions

**MeshContext** (`apps/mesh/src/core/mesh-context.ts`)
The central runtime interface injected into all tools. Provides:
- `auth`: Authentication state (user, session, organization)
- `access`: Access control layer (RBAC checks)
- `storage`: Database operations (Kysely-based)
- `vault`: Credential vault for secure token storage
- `tracer`: OpenTelemetry distributed tracing
- `meter`: OpenTelemetry metrics collection

Tools NEVER access HTTP objects, database drivers, or environment variables directly—all dependencies flow through MeshContext.

**defineTool()** (`apps/mesh/src/core/define-tool.ts`)
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

The workspace is managed via Bun workspaces. The main application lives in `apps/mesh/` and contains the full-stack MCP Mesh implementation (Hono API server + Vite/React client). Documentation site lives in `apps/docs/` (Astro-based).

**apps/mesh/** - Main full-stack application
- `src/api/` - Hono HTTP routes + MCP proxy routes
- `src/auth/` - Better Auth (OAuth 2.1 + SSO + API keys)
- `src/core/` - MeshContext, AccessControl, defineTool
- `src/tools/` - Built-in MCP management tools (organized by domain)
- `src/storage/` - Kysely database adapters and operations
- `src/event-bus/` - Pub/sub event delivery system (CloudEvents v1.0)
- `src/encryption/` - Token vault & credential management
- `src/observability/` - OpenTelemetry tracing & metrics
- `src/web/` - React 19 admin UI (Vite + TanStack Router)
- `migrations/` - Kysely database migrations

**packages/** - Shared logic
- `packages/bindings/` - Core MCP bindings and connection abstractions (defines standardized interfaces)
- `packages/runtime/` - Runtime utilities for MCP proxy, OAuth, and tools
- `packages/ui/` - Shared React components (shadcn-based design system)
- `packages/cli/` - CLI tooling (deco commands)
- `packages/vite-plugin-deco/` - Vite plugin for Deco projects
- `packages/create-deco/` - Project scaffolding tool (npm init)

Database migrations live in `apps/mesh/migrations/`, code quality plugins in `plugins/`, and infrastructure/deploy configs in `deploy/`.

### Key Architectural Patterns

**Virtual MCPs** (`apps/mesh/src/tools/virtual/`)
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

**Event Bus** (`apps/mesh/src/event-bus/`)
Pub/sub system between connections following CloudEvents v1.0 spec:
- At-least-once delivery with exponential backoff (1s to 1hr, max 20 attempts)
- Scheduled delivery (`deliverAt`) and recurring events (`cron`)
- Per-event results (subscribers can return individual results per event)
- NotifyStrategy: NATS notify (immediate wake-up) + PollingStrategy (safety net for scheduled/cron delivery)

#### Event Bus Files
- `packages/bindings/src/well-known/event-bus.ts` - EVENT_BUS_BINDING (PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CANCEL, ACK)
- `packages/bindings/src/well-known/event-subscriber.ts` - EVENT_SUBSCRIBER_BINDING (ON_EVENTS)
- `apps/mesh/src/event-bus/` - EventBus implementation and worker
- `apps/mesh/src/event-bus/polling.ts` - Timer-based PollingStrategy (safety net for scheduled/cron delivery)
- `apps/mesh/src/event-bus/nats-notify.ts` - NatsNotifyStrategy (immediate wake-up via NATS)
- `apps/mesh/src/storage/event-bus.ts` - Database operations
- `apps/mesh/src/tools/eventbus/` - MCP tools (publish, subscribe, unsubscribe, list, cancel, ack)
- `apps/mesh/migrations/008-event-bus.ts` - Database schema

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
- Schema types: `apps/mesh/src/storage/types.ts`
- Operations organized by domain: `apps/mesh/src/storage/`
- Multi-tenancy: Workspace/project isolation for config, credentials, policies, audit logs
- Migrations use Kysely's migration system combined with Better Auth migrations

Database schema key concepts:
- Organizations managed by Better Auth organization plugin
- Connections are organization-scoped (workspace or project level)
- Permissions follow Better Auth format: `{ [resource]: [actions...] }`

### Authentication & Authorization

**Better Auth** for authentication:
- OAuth 2.1, SSO, API keys
- Config: `apps/mesh/auth-config.json` (example: `auth-config.example.json`)

**AccessControl** (`apps/mesh/src/core/access-control.ts`) for authorization:
- Organization/project-level RBAC
- Fine-grained permissions per workspace/project
- Connection-specific permissions (e.g., `{ "conn_<UUID>": ["SEND_MESSAGE"] }`)

### Observability

**OpenTelemetry** (`apps/mesh/src/observability/`)
- Full tracing for tools, workflows, and UI interactions
- Metrics collection (Prometheus exporter)
- Logging with OTLP exporter
- Every tool call automatically traced

## Coding Style & Naming Conventions

### Style & Formatting
- **Biome** enforces two-space indentation and double quotes
- **ALWAYS** run `bun run fmt` after making code changes (pre-commit hook via lefthook)
- Components and classes: PascalCase
- Hooks and utilities: camelCase
- Files in shared packages: kebab-case (enforced by `plugins/enforce-kebab-case-file-names.ts`)

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

### TypeScript
- Favor explicit types over `any`
- Use Zod for runtime validation and schema definitions
- TypeScript 5.9+ with strict mode enabled

## Testing Guidelines

- **Bun test runner** for all tests
- Co-locate test files: `*.test.ts` or `*.test.tsx` next to source
- Run `bun test` before submitting PRs
- Add integration tests for API endpoints and database operations
- Test files use Bun's built-in test framework
- Document any intentional coverage gaps in PR descriptions

## Working with Tools

When creating new MCP tools:
1. Use `defineTool()` from `apps/mesh/src/core/define-tool.ts`
2. Place tools in appropriate domain folder under `apps/mesh/src/tools/`
3. Always inject `MeshContext` as second parameter
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

## Common Gotchas

1. **Never access environment variables directly in tools**—use MeshContext
2. **Never access HTTP context in tools**—use MeshContext for all state
3. **Database migrations**: Remember to run both Kysely migrations (`bun run migrate`) and Better Auth migrations (`bun run better-auth:migrate`)
4. **Event bus**: The worker doesn't poll internally—it relies on NotifyStrategy to trigger processing
5. **Formatting**: The pre-commit hook will reject commits if code isn't formatted with Biome
6. **Never modify knip configuration** (`knip.json`, `knip.config.ts`, etc.) to silence warnings. Knip warnings indicate dead code, unused exports, or unused dependencies—these are code smells that should be fixed by removing the unused code/export/dependency, not by adding exclusions to the knip config.
7. **CI errors are always on your branch**. The `main` branch CI always passes. When CI fails, the problem is in the code you changed—do not assume it's a pre-existing issue or a flaky test. Investigate and fix your code.

## License

Sustainable Use License (SUL):
- ✅ Free to self-host for internal use
- ✅ Free for client projects (agencies, SIs)
- ⚠️ Commercial license required for SaaS or revenue-generating production systems

See LICENSE.md for details. Questions: contact@decocms.com
