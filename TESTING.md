# Testing

This document is the source of truth for how we test in this repo. Read it before adding a test. AI agents: this overrides any default testing instinct.

## Two tiers, one rule

We run two kinds of tests. Pick the right one — the choice is mechanical, not a matter of taste.

### Unit (`bun test`) — pure logic only

- **No mocks.** No `vi.mock`, no `mock.module`, no fake `fetch`, no stubbed `MeshContext`.
- **No I/O.** No database, no network, no filesystem (beyond reading test fixtures).
- **What belongs here:** schema validators, encryption, JWT/HMAC, PKCE, parsers, sanitizers, code generators, pure utility functions, migration SQL correctness.
- **Where:** co-located `*.test.ts` next to the source file.

If you reach for a mock, you are writing the wrong kind of test. Stop and write an e2e instead.

### E2E (Playwright) — everything else

- **Real Postgres, real NATS, real Better Auth, real HTTP.**
- The only acceptable "mock" is at the *infrastructure edge* — e.g., a flaky test MCP server you bring up as a real process, not a mocked client inside the app.
- **What belongs here:** anything that touches the DB, auth, MCP boundary, NATS, an HTTP route, the React UI, the event bus, or that crosses a process boundary.
- **Where:** `apps/mesh/e2e/tests/*.spec.ts`.

## Writing an e2e spec

```ts
import { test, expect } from "../fixtures/test";

test("creates a connection for the authed user", async ({ authedPage }) => {
  const { page, orgSlug } = authedPage;
  await page.goto(`/${orgSlug}/settings/connections`);
  // ...
});
```

- Use `import { test } from "../fixtures/test"` — that's the extended Playwright `test` with shared fixtures.
- Default to the **`authedPage`** fixture. It signs up a fresh user via the Better Auth API, sets cookies on the browser context, and gives you `{ page, user, orgSlug }`. Each test gets a unique user + org.
- Use **API factories** from `apps/mesh/e2e/fixtures/factories.ts` for setup state (create org, create connection, invite member). Don't `INSERT` directly when an API path exists.
- Use **`connectDevDb()`** (from `apps/mesh/e2e/fixtures/db.ts`) for **assertions** about DB state, or for seeding state that has no API (e.g., `organization_domains` rows).
- Use **page objects** from `apps/mesh/e2e/pages/` for recurring screens. Promote an inline helper to a page object on the *second* use, not the first.

### Exception: signup and onboarding specs

Tests that *are* the signup/onboarding flow (e.g., `org-access-gate.spec.ts`, `auto-domain-join-multi-org.spec.ts`, future signup-flow specs) MUST drive the real UI via the `signUp()` helper in `fixtures/auth.ts`. Don't shortcut the very flow you're testing.

Everything else uses `authedPage`.

## Anti-patterns

Don't do any of these:

- **Adding `vi.mock` to a unit test "just to get it green"** — that's the signal to move it to e2e.
- **Direct SQL inserts in a Playwright spec** when an API path exists. Go through the same code paths a real client would.
- **Shared global state across tests.** No `beforeAll` that seeds rows other tests depend on.
- **Hard-coded slugs/emails.** They collide under parallel workers. Use randomized values.
- **`test.afterAll` SQL cleanup as the default.** Rely on per-test unique orgs/users so cleanup isn't needed.
- **Stubbing `MeshContext`, `auth.api.getSession`, `SandboxProvider`, `clientFromConnection`, or `global.fetch`.** If you're tempted to do any of these, the test belongs in e2e.

## When developing a feature

Decision tree:

1. Is the feature **pure logic** (parser, hash, Zod schema, pure transform)? → Co-located unit test.
2. Does the feature **touch the DB, auth, MCP boundary, NATS, an HTTP route, or the UI**? → Playwright spec.
3. Would the unit test require **any mocking** to compile? → Playwright spec.

There is no third tier. Resist the urge to invent one.

## Specialized suites (don't write these casually)

- **Resilience tests** — `tests/resilience/scenarios/`. Docker Compose + Toxiproxy chaos. For testing behavior under infrastructure failure (DB outage, NATS disconnect, MCP latency).
- **Multi-pod tests** — `tests/multi-pod/scenarios/`. 3-pod Mesh cluster, shared Postgres + NATS. For testing cross-pod behavior (session rehoming, API key sharing, DBOS replay).

These are not part of the default test loop. They run on dedicated CI workflows. Only add a scenario here if the behavior cannot be expressed in a single-pod Playwright spec.

## Running tests

```bash
# Unit
bun test                                         # all units
bun test apps/mesh/src/encryption                # subset

# E2E
bun run --cwd=apps/mesh test:e2e                 # all e2e
bun run --cwd=apps/mesh test:e2e:ui              # interactive UI
bun run --cwd=apps/mesh test:e2e some-spec       # filter by name

# Resilience / multi-pod (requires Docker)
./tests/resilience/run.sh
```

## CI expectations

- **`unit` job** must stay fast (target < 2 min). If a "unit" test starts needing infra, it's an e2e.
- **`e2e` job** runs parallel against real services. Target < 10 min wall time; shard if it grows.
- **Resilience / multi-pod** run on dedicated workflows (`resilience.yml`, multi-pod equivalent). Not required on every PR.

## Examples

- Good unit test: [`apps/mesh/src/encryption/credential-vault.test.ts`](apps/mesh/src/encryption/credential-vault.test.ts)
- Good e2e spec: [`apps/mesh/e2e/tests/connection-create.spec.ts`](apps/mesh/e2e/tests/connection-create.spec.ts)
