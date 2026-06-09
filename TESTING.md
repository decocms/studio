# Testing

This document is the source of truth for how we test in this repo. Read it before adding a test. AI agents: this overrides any default testing instinct.

## The one rule: don't mock your own code

Every other rule here is a consequence of this one. A test earns its place when it is likely to catch a real bug at a price worth paying. Mocking a dependency you own destroys the first half of that trade: you stop testing the contract and start testing a fiction you typed yourself. The test then stays green precisely when the real code breaks — the worst possible outcome, because it costs maintenance while catching nothing.

So the enemy is **not** infrastructure. Postgres, NATS, and Better Auth are real dependencies; testing against them is good. The enemy is the *mock of your own contract* — a stubbed `StudioContext`, a fake `storage` adapter, a hand-written `fetch` that returns a response shape you invented. If your test asserts against something you made up, delete it and test the real thing.

Concretely: a test that mocks all of `storage` and then asserts "the handler called `storage.claimRunStart`" is asserting that the code calls the function the code calls. It is tautological. It will not catch the broken SQL inside `claimRunStart`, which is the only bug that handler can actually have.

## Categorize by what's under test, and whether its dependencies are real

There is no "unit vs. integration vs. e2e" taste call. The category falls out of two mechanical questions: *what is the unit under test*, and *are its dependencies real or mocked*.

| Under test | Dependencies | Tier | Catches |
| --- | --- | --- | --- |
| A pure function | none | **Unit** (`bun test`) | logic bugs |
| One layer (e.g. a storage adapter) | **real** (real Postgres) | **Storage-integration** (`bun test`, real DB) | SQL / contract / serialization bugs |
| The whole system, through the front door | real, via HTTP/UI | **E2E** (Playwright) | flow / wiring bugs |
| One layer | **mocked** | ⛔ the bad zone | nothing real — tautologies |

The bottom row is the only forbidden one. If you find yourself mocking the dependencies of a single layer, you are in the bad zone: either drop the mocks and test that layer against its real dependency (move up a row), or test the behavior through the front door (move to e2e). Never ship the mocked middle.

### Unit (`bun test`) — pure logic only

- **No mocks. No I/O.** No DB, no network, no filesystem (beyond reading test fixtures).
- **What belongs here:** schema validators, encryption, JWT/HMAC, PKCE, parsers, sanitizers, code generators, pure utility functions, migration SQL *string* correctness, pure state-transition functions.
- **Where:** co-located `*.test.ts` next to the source file.

If you reach for a mock to make a "unit" test compile, you picked the wrong tier. Move up the table.

#### Narrow exception: state-machine unit tests with one boundary mock

Some modules are pure-ish state machines whose contract is *what error class do we throw and how fast*, not what HTTP status comes out the other end. Forcing those into Playwright loses precision (the proxy translates errors, the assertions weaken to "some 5xx") without buying realism.

A unit test may mock **exactly one module function** at the boundary if all of these hold:

- The SUT is internal logic (no HTTP route exists that exercises it cleanly).
- The "downstream" used in the success path is real, just in-process (e.g. the MCP SDK's bridge transport — a real client and server connected without going over the network).
- The assertion is on a JS class, timing, or in-memory state — not on a wire response.

Example: `apps/mesh/src/mcp-clients/lazy-client.test.ts` mocks `./client.clientFromConnection` to inject failures, uses a real MCP server via in-process bridge transport for the success path, and asserts `CircuitOpenError` + fail-fast timing. Migrating it to Playwright would mean: hit `/api/:org/mcp/:connectionId` repeatedly while toggling a test MCP server's failure injection, observing the proxy's HTTP status code (no `CircuitOpenError` class), losing timing precision under workers-in-parallel, and risking cross-test pollution of the module-global circuit map.

This is a genuine exception, not a loophole. It is for one boundary mock guarding a class/timing assertion — *not* for "I didn't want to set up a real fixture." Mocking your whole `storage` interface never qualifies.

### Storage-integration (`bun test` against real Postgres) — one layer, real DB

This tier exists because some contracts can only be tested against a real SQL engine, and routing them through the full stack would make the test assert the wrong thing.

- **Real Postgres. Zero mocks.** Exercise the storage adapter directly: call `SqlThreadStorage.saveMessages(...)`, then assert the rows.
- **What belongs here:** `ON CONFLICT` / upsert semantics, `RETURNING`, FK constraints, JSON column (de)serialization, pagination edges, advisory locks, `LISTEN`/`NOTIFY`, CAS update logic, migration *behavior*. Anything whose correctness lives in the SQL the adapter emits.
- **No HTTP, no auth, no browser, no NATS.** If the test needs those, it's e2e. This tier is the storage layer and its database, nothing else.
- **Where:** co-located `*.integration.test.ts` next to the source. The filename convention auto-routes it to the `storage-integration` CI workflow (real `postgres:16`), separate from the fast unit job.

Why not just make these e2e? Because to test "`saveMessages` dedupes on message id" through Playwright you'd boot the server, sign up via Better Auth, find an HTTP route that happens to trigger a duplicate-id upsert, drive it, and then fish in the DB to assert. The assertion drifts three layers from the thing under test, and a route may not even exist for every storage behavior (FK violation, null `parts`, pagination off-by-one). Direct + real Postgres is the *most* honest test of SQL, not a compromise. (It's also faster — no browser — but that's a bonus, not the reason.)

This is **not** a license to test route handlers with a mocked DB. Real DB, single layer, no mocks. The moment you mock `storage`, you've left this tier for the bad zone.

### E2E (Playwright) — the whole system, through the front door

- **Real Postgres, real NATS, real Better Auth, real HTTP, real browser.**
- The only acceptable "mock" is at the *infrastructure edge* — e.g., a flaky test MCP server you bring up as a real process, not a mocked client inside the app.
- **What belongs here:** anything that crosses the auth, HTTP-route, MCP, NATS, event-bus, or UI boundary; any flow whose bugs are wiring bugs (a handler orchestrating real storage + SSE under real concurrency); anything that would otherwise force you to mock your own code to test it.
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

- **Mocking your own code to make a test green.** The headline rule. Stubbing `storage`, `StudioContext`, `auth.api.getSession`, `SandboxProvider`, `clientFromConnection`, or `global.fetch` means the test belongs in storage-integration (drop the mocks, use real Postgres) or e2e (go through the front door). (An *inert* collaborator a code path never invokes — e.g. the unused `storage` a pure in-memory state-machine test must hand to a constructor — is not this: nothing the assertion depends on is faked. Keep it plain and unexercised, not a `mock()` with canned return values.)
- **Asserting "the handler called the function."** If the assertion is `expect(storage.foo).toHaveBeenCalled()` against a mocked `storage.foo`, the test is tautological. Test the *effect* against the real dependency instead.
- **A route/handler test with a mocked DB.** The bad-zone middle. Move to e2e.
- **A CLI/client test with a hand-written `fetch` mock** that returns an invented server-response shape. You're asserting against your own fiction; it won't break when the real server changes. Stand the real server up as a fixture and round-trip against it.
- **Direct SQL inserts in a Playwright spec** when an API path exists. Go through the same code paths a real client would. (Seeding state that has *no* API is fine via `connectDevDb()`.)
- **Shared global state across tests.** No `beforeAll` that seeds rows other tests depend on.
- **Hard-coded slugs/emails.** They collide under parallel workers. Use randomized values.
- **`test.afterAll` SQL cleanup as the default.** Rely on per-test unique orgs/users so cleanup isn't needed.

## When developing a feature

Decision tree:

1. Is the feature **pure logic** (parser, hash, Zod schema, pure transform, pure state transition)? → Co-located **unit** test, no mocks.
2. Is the unit under test **a storage adapter**, and does its correctness live in the SQL it emits? → Co-located **`*.integration.test.ts`**, real Postgres, no mocks.
3. Does the feature **cross auth, an HTTP route, the MCP boundary, NATS, the event bus, or the UI** — or would testing it otherwise force you to mock your own code? → **Playwright** spec.
4. Did you just reach for a mock of something you own to make a test compile? → You're in the bad zone. Go back to 2 or 3.

## Specialized suites (don't write these casually)

- **Resilience tests** — `tests/resilience/scenarios/`. Docker Compose + Toxiproxy chaos. For testing behavior under infrastructure failure (DB outage, NATS disconnect, MCP latency).
- **Multi-pod tests** — `tests/multi-pod/scenarios/`. 3-pod Mesh cluster, shared Postgres + NATS. For testing cross-pod behavior (session rehoming, API key sharing, DBOS replay).

These are not part of the default test loop. They run on dedicated CI workflows. Only add a scenario here if the behavior cannot be expressed in a single-pod Playwright spec.

## Running tests

```bash
# Unit (pure logic) + storage-integration both run under bun test locally.
bun test                                         # everything bun-test can run
bun test apps/mesh/src/encryption                # subset

# A single storage-integration file needs a real DATABASE_URL pointing at Postgres
# (CI provisions postgres:16; locally point it at your dev DB).
bun test apps/mesh/src/storage/threads.integration.test.ts

# E2E
bun run --cwd=apps/mesh test:e2e                 # all e2e
bun run --cwd=apps/mesh test:e2e:ui              # interactive UI
bun run --cwd=apps/mesh test:e2e some-spec       # filter by name

# Resilience / multi-pod (requires Docker)
./tests/resilience/run.sh
```

CI splits the three tiers by filename convention:

- `*.test.ts` → unit job (`.github/workflows/test.yml`), must stay fast.
- `*.integration.test.ts` → storage-integration job (`.github/workflows/storage-integration.yml`), real Postgres.
- `*.e2e.test.ts` → reserved for the sandbox-daemon workflow.

Adding a test is just choosing the right filename — it auto-routes.

## CI expectations

- **`unit` job** must stay fast (target < 2 min). If a "unit" test starts needing infra, it's the wrong tier — move it.
- **`storage-integration` job** runs each `*.integration.test.ts` against real `postgres:16`. No HTTP/auth/browser here; those belong in e2e.
- **`e2e` job** runs parallel against real services. Target < 10 min wall time; shard if it grows.
- **Resilience / multi-pod** run on dedicated workflows (`resilience.yml`, multi-pod equivalent). Not required on every PR.

## Examples

- Good unit test: [`apps/mesh/src/encryption/credential-vault.test.ts`](apps/mesh/src/encryption/credential-vault.test.ts)
- Good storage-integration test: [`apps/mesh/src/storage/threads.integration.test.ts`](apps/mesh/src/storage/threads.integration.test.ts)
- Good e2e spec: [`apps/mesh/e2e/tests/connection-create.spec.ts`](apps/mesh/e2e/tests/connection-create.spec.ts)
</content>
</invoke>

