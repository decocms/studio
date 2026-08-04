# @decocms/e2e

Exercises Studio as a black-box contract across real HTTP, browser, database,
and messaging boundaries.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/e2e` (`packages/e2e`) |
| Kind | Playwright end-to-end suite |
| Runtime | Bun, Playwright, and Chromium |
| Distribution | Private workspace package |

## Overview

This suite starts the Studio API and web applications as separate processes,
uses their public interfaces, and asserts on observable behavior. It does not
import application implementation code, so the same contract can survive an
internal rewrite.

Tests cover browser flows, raw HTTP APIs, Postgres state, NATS-backed streaming,
MCP servers, native authentication, and optional S3-backed object storage.

## Responsibilities

- Verify user-visible flows in Chromium.
- Verify HTTP, authentication, authorization, and MCP wire contracts.
- Assert persisted state against the same Postgres used by the API.
- Exercise NATS-backed behavior through public HTTP and database contracts.
- Protect tenant isolation and concurrency behavior under parallel execution.

## Usage

This package is private and has no import surface.

Install dependencies and the browser from the repository root:

```bash
bun install
bun run --cwd=packages/e2e playwright install chromium
```

Ensure Postgres and NATS are available, then run:

```bash
bun run --cwd=packages/e2e test:e2e
```

The Playwright configuration starts the commerce mock, API, and web app. Set
`DATABASE_URL` and `NATS_URL` when they are not discoverable through the local
Studio services. Tests that require production-style object storage also need
the `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
`S3_SECRET_ACCESS_KEY` variables; they skip when S3 is unavailable.

## Architecture

`playwright.config.ts` runs the commerce-upgrade mock, `apps/api`, and
`apps/web` as three `webServer` processes. The applications stay behind process
and HTTP boundaries.

`tests/` owns wire-level and browser contracts. `fixtures/` provides standalone
HTTP, authentication, Postgres, NATS, MCP, and relay drivers. `pages/` contains
small page objects for repeated browser interactions.

Playwright's `APIRequestContext` covers HTTP, Chromium covers UI behavior, and
`pg` handles real database assertions. A single runner can therefore test SSE,
NATS-assisted flows, browser state, and persistence together.

## Development

Run commands from the repository root:

```bash
bun run --cwd=packages/e2e check
bun run --cwd=packages/e2e test:e2e
bun run --cwd=packages/e2e test:e2e:ui
```

Run one specification with:

```bash
bun run --cwd=packages/e2e test:e2e -- tests/org-scoped-routing.spec.ts
```

Playwright writes the HTML report under `packages/e2e/playwright-report/`.

## Boundaries

Imports are denied by default. Test files may use relative imports, `node:*`
built-ins, and dependencies explicitly allowed by both `package.json` and
`plugins/ban-e2e-app-imports.js`.

The suite must not import an `@/` alias, any `apps/*/src` module, or an
unapproved `@decocms/*` workspace. `tsconfig.json` sets `paths: {}` so app
aliases also fail at type-check time.

Do not silence the import rule. If a test needs a wire value, inline the
expected contract. If a new package dependency is genuinely necessary, add it
to both this package's manifest and the plugin allowlist with a justification.

Every database assertion must be tenant-scoped. Tests own unique users,
organizations, threads, and runs; they do not rely on global counts or shared
singletons.

## Parallelism and infrastructure

The suite uses `fullyParallel`. CI caps Playwright at four workers because each
worker opens a Postgres client alongside the application pool. Treat the worker
count as part of the database connection budget.

Email domain is the one shared namespace used by auto-domain-join behavior, so
those tests generate a unique domain for every run.

CI supplies PostgreSQL, NATS with JetStream, and MinIO. Local runs can use
Studio's service tooling; S3-specific specifications skip unless their four S3
variables are present.

## Why Playwright

Playwright provides browser automation, raw HTTP requests, retries, traces, and
one test lifecycle around external Postgres and NATS clients. A command-only
HTTP runner cannot cover the database, SSE, messaging, and browser contracts
that this suite owns.

## Related documentation

- [Testing policy](../../TESTING.md)
- [Repository guidelines](../../AGENTS.md)
- [E2E workflow](../../.github/workflows/e2e.yml)
