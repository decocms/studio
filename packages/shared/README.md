# @decocms/shared

Shares isomorphic Studio contracts and pure helpers across workspace boundaries
without coupling the API and web applications.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/shared` (`packages/shared`) |
| Kind | Private isomorphic shared-code package |
| Runtime | Node.js 24+, Bun, and browser |
| Distribution | Private workspace package |

## Overview

`@decocms/shared` is the internal home for code that both Studio applications or
multiple packages must interpret identically. It contains portable TypeScript
types, Zod schemas, constants, deterministic helpers, SDK data contracts, and the
canonical asynchronous primitives used throughout the repository.

The package deliberately has no root export. Consumers import the narrow subpath
that owns a contract, which makes dependencies visible and prevents an
ever-growing shared barrel.

## Responsibilities

- Define cross-application wire and data contracts.
- Hold pure, deterministic helpers shared by API, web, and package code.
- Provide browser-safe SDK types, constants, model defaults, and usage helpers.
- Provide zero-dependency delay, retry, and backoff primitives.
- Keep generated shared schemas, such as tool input/output types, in one place.
- Prevent duplicated definitions from drifting between workspaces.

## Usage

Import a domain module directly:

```ts
import type { StudioChatMessage } from "@decocms/shared/chat-message";
import { isReservedOrganizationSlug } from "@decocms/shared/organization-slugs";
```

Use the canonical asynchronous primitives from `./std`:

```ts
import { retry, sleep } from "@decocms/shared/std";

const response = await retry(async () => {
  const response = await fetch("https://example.com/health");
  if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
  return response;
}, {
  maxAttempts: 3,
  minTimeout: 250,
});

await sleep(100);
```

Import SDK contracts from `./sdk` or one of its explicit child paths:

```ts
import { WellKnownOrgMCPId } from "@decocms/shared/sdk/lib/constants";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
```

There is no supported `import ... from "@decocms/shared"` form.

## Architecture

The source tree is organized by ownership:

- Top-level and domain directories contain portable Studio contracts and helpers,
  such as chat messages, organizations, registry metadata, reports, threads, and
  tool schemas.
- `src/sdk` contains the browser-safe, non-React portion of the Studio SDK:
  protocol types, well-known identifiers, model defaults, and usage calculations.
- `src/std` contains zero-dependency asynchronous primitives that work in Node.js,
  Bun, and browsers.
- `src/tools/tool-io.ts` contains generated tool input/output contracts consumed
  across application boundaries.

The package export map exposes `./std`, `./std/*`, `./sdk`, `./sdk/types`,
`./sdk/types/*`, `./sdk/lib/*`, and explicit domain modules through `./*`. Source
layout is part of the internal workspace contract, so a moved module requires its
consumers to move with it.

## Development

Run package checks from the repository root:

```bash
bun run --cwd=packages/shared check
bun run --cwd=packages/shared test
```

Run a focused test while iterating:

```bash
bun test packages/shared/src/std/retry.test.ts
```

Format and lint repository changes before committing:

```bash
bun run fmt
bun run lint
```

## Boundaries

- This package is private and internal. It is not a public npm API or a
  compatibility layer for third-party consumers.
- Code must remain isomorphic unless it lives behind a clearly environment-specific
  subpath. Do not read process environment, access a database, depend on HTTP
  framework context, or use filesystem APIs in a cross-runtime module.
- Do not import from `apps/api` or `apps/web`. Dependency flow must point from
  applications to shared contracts, never back into an application.
- Keep React components, hooks, query state, and translation lookup in `apps/web`
  or `packages/ui`. `./sdk` is intentionally browser-safe and React-free.
- Add code here only when at least two workspaces need the same representation or
  behavior. API-only business logic stays in `apps/api`; browser-only behavior
  stays in `apps/web`.
- `./std` is the canonical home for `sleep`, `delay`, `retry`, and exponential
  backoff. Do not hand-roll equivalent timers, retry loops, or jitter formulas in
  consumers.
- Prefer explicit domain imports. Do not create a root barrel or broad re-export
  that hides which shared contract a consumer owns.
- Keep schemas and types free of secrets and request-specific state. A shared type
  describes a boundary; it does not grant access across that boundary.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/shared/std` | Canonical delay, sleep, retry, retry error, and exponential backoff |
| `@decocms/shared/std/*` | Individual asynchronous primitive modules |
| `@decocms/shared/sdk` | Browser-safe SDK types, constants, defaults, and usage helpers |
| `@decocms/shared/sdk/types` | SDK type barrel |
| `@decocms/shared/sdk/types/*` | Individual SDK type modules |
| `@decocms/shared/sdk/lib/*` | Individual SDK constant and pure-helper modules |
| `@decocms/shared/<domain>` | Explicit top-level or nested domain module under `src` |

The wildcard domain export is for intentional module-level imports, not for
filesystem discovery or private implementation access.

## Related documentation

- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
