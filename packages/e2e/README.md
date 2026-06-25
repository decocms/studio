# @decocms/e2e

Black-box end-to-end suite. Spin the server, hit it over **real HTTP** (and, for
the app, assert against the **real Postgres**), and check responses. The suite is
a **contract**, not a unit of the app: it must run identically against any
implementation of that contract, so the app could be rewritten — even in another
language — and these tests still hold.

Run it with `bun run --cwd=packages/e2e test:e2e`. The Playwright config spawns
the app's dev server from `apps/mesh` (`webServer.cwd`) — the suite's only tie to
the app, and it's a process boundary (spawn + HTTP), not a code import. Locally
you need Postgres + NATS up; in CI those are provided as services and the DB is
addressed via `DATABASE_URL` (see `.github/workflows/e2e.yml`).

## Isolation rule (enforced)

Files here may import **only**:

- relative specifiers (intra-package fixtures/pages/specs),
- `node:*` builtins,
- the explicit dependency allowlist:
  `@playwright/test`, `pg`, `zod`, `@modelcontextprotocol/sdk`,
  `@nats-io/jetstream`, `@nats-io/transport-node`, `@nats-io/nats-core`,
  `@decocms/std`, `@decocms/tunnel`, `@decocms/sandbox`, `@decocms/harness`.

Everything else is **denied by default** — in particular the `@/` mesh alias, any
reach-in to an app's `src` tree, and any workspace package **not** on the list
(so app code migrating into `packages/` over time cannot silently widen the
test's surface).

Two enforcement layers:

1. **`plugins/ban-e2e-app-imports.js`** (oxlint, `error`) — the import wall.
2. **`tsconfig.json`** here overrides `paths: {}`, so the aliases don't resolve at
   the type level either.

**Do not silence the lint.** If a black-box test genuinely needs a value, either
**inline the expected shape** (a test owning its contract is correct, not
duplication — a divergence from the app is a wire-contract regression *signal*) or
add the dependency to **both** this `package.json` and the plugin allowlist, with
justification.

## Parallelism rule

`fullyParallel` is safe because every test owns its tenant: assert only on the
per-test org / user / thread / run. **Never** assert on a value shared across runs
(global counts, singletons). The one global namespace is **email domain**
(`auto-domain-join` specs) — use a unique domain per run. The Playwright worker
count is effectively the **Postgres connection budget** (each worker opens a `pg`
client alongside the app's pool); raising it requires re-checking `max_connections`.

## Why TypeScript + Playwright (not Hurl)

One suite, one runner: Playwright's `APIRequestContext` covers raw HTTP, the
browser covers UI specs, and `pg` covers DB assertions. Hurl was evaluated and
rejected — it can't query a database, consume SSE streams, or speak NATS, which
the suite needs.
