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

## OpenRouter auto-auth flow

The auto-auth flow (install OpenRouter → OAuth popup → chat ready) lives on
`feat/local-first-dx` branch (commit `bacda6781`) and is not yet in
`feat/local-first-dx-core`. Needs to be cherry-picked or merged.

- Key files: `apps/mesh/src/web/lib/authenticate-connection.ts`,
  `apps/mesh/src/web/components/chat/no-llm-binding-empty-state.tsx`

## decocms package rename

`packages/studio/` publishes as `decocms` on npm (`npx decocms` / `deco` CLI).
It's a thin wrapper that depends on `@decocms/mesh`. Eventually the source
should move to `decocms` as the canonical package and `@decocms/mesh` becomes
the wrapper (or is deprecated).

## Password migration for local admin

The local admin password (`admin@mesh`) is hardcoded. The loopback-only check on
`/local-session` is the real security boundary, so this is low-risk. If we ever
want per-install passwords, derive from `BETTER_AUTH_SECRET` and add a migration
path that updates the stored hash on boot.

## Playwright e2e excluded from `bun test`

The Playwright e2e test (`apps/mesh/src/**/*.e2e.test.ts`) is picked up by
`bun test` and fails because `@playwright/test` conflicts with bun's test
runner. Should be excluded via bun test config or file naming convention.

## internalUrl in public config

`/api/config` exposes `internalUrl` (e.g. `http://localhost:3000`) to support
OAuth redirect URIs behind proxies. In production, this should either be omitted
or set to the actual public URL. Currently always returns `localhost:PORT`.
