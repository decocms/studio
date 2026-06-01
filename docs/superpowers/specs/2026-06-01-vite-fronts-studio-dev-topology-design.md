# Vite-fronts-Studio dev topology — design

**Date:** 2026-06-01
**Status:** Approved, pending implementation
**Scope:** Dev mode only (`NODE_ENV !== "production"`). Production behavior is unchanged.

## Problem

Developing Studio inside Studio (studio-in-studio via the `deco link` sandbox) renders a blank page. Root cause traced:

- The outer sandbox daemon allocates a unique port and injects it as `PORT` for the inner Studio's mesh server.
- It does **not** allocate a unique `VITE_PORT`.
- `apps/mesh/vite.config.ts` hardcodes `server.hmr.clientPort: VITE_PORT` (defaulting to `4000`), so the browser opens `ws://localhost:4000` for HMR.
- That port collides with whatever else is on the user's host `localhost:4000` (e.g., another conductor worktree's Vite), so HMR talks to the wrong dev server. React Refresh handshake fails, page never hydrates, user sees blank.

The same shape will fail for **agent-sandbox** (production K8s sandbox provider) because the browser hits Studio through mesh's preview proxy and cannot reach `localhost:<HMR_PORT>` directly.

## Goals

1. **Fix studio-in-studio rendering** for both `user-desktop` and `agent-sandbox` providers.
2. **Single user-visible origin in dev** — browser sees one host:port for HTML, assets, API, and HMR. No proxy chain has to forward WS traffic outside that origin.
3. **Minimize churn** — no app refactor, no new dependencies, no production behavior change.

## Non-goals

- Renaming `apps/mesh/` → `apps/studio/` (separate PR).
- Refactoring `@decocms/runtime`'s `dev-server-proxy.ts` (other consumers may still use it).
- Vite middleware mode, SSR, or any other Vite topology (explicitly rejected during brainstorming).
- Production behavior changes.
- `STUDIO_SANDBOX_PREVIEW_URL_PATTERN`-based preview proxy in dev (production-only feature; Vite isn't in the chain in prod).

## Decision: Vite-fronts-Studio

**Vite becomes the user-facing front door in dev.** It serves HTML / assets / HMR, and proxies a fixed list of path prefixes (`/api`, `/mcp`, `/oauth-proxy`) to the Studio API on a separate internal port.

This is the standard "Vite + API" pattern in the ecosystem (TanStack Start, shadcn/ui starters, Cloudflare Workers + Vite, classic Remix, vinxi pre-middleware-mode). Vite's `server.proxy` uses `http-proxy` under the hood and handles WebSocket upgrades natively with `ws: true`.

Rejected alternatives (recorded for posterity):

| Alternative | Why rejected |
|---|---|
| Minimal `findAvailablePort(vitePort)` hotfix only | Doesn't simplify the two-port dev topology; agent-sandbox still fails because browser can't reach `localhost:<HMR_PORT>` through a K8s ingress. |
| Vite middleware mode + bridged HMR | Requires ~150–250 LOC of Bun ↔ `ws`-compat bridge. User explicitly rejected this approach. |
| Vite SSR + give-up-HMR | Requires 2–4 week refactor of every route/component. Not justified by this bug. |

## Topology

```
   browser
      │
      │  http://localhost:<PORT>            (standalone)
      │  http://<slug>.localhost            (dev:conductor via Caddy)
      │  http://<handle>.localhost:5174     (studio-in-studio via link ingress)
      ▼
   ┌─────────────────────────────────────┐
   │  Vite dev server  ─ port=PORT       │
   │   • Serves index.html, /@vite/*,    │
   │     /@fs/*, /src/*, etc.            │
   │   • Owns HMR WebSocket              │
   │   • Forwards by path:               │
   │      /api/*         ┐               │
   │      /mcp/*         ┤ → 127.0.0.1:STUDIO_API_PORT
   │      /oauth-proxy/* ┘               │
   └─────────────────────────────────────┘
                       │
                       ▼
              ┌──────────────────────┐
              │  Studio API server   │
              │  port = STUDIO_API_PORT (internal)
              │   • Hono app only    │
              │   • No asset handler │
              │     in dev           │
              └──────────────────────┘
```

In production (`NODE_ENV=production`), Vite is absent. Mesh binds `PORT` directly and serves built assets via its existing `handleAssets` prod branch.

## Port semantics

| Variable | Today | After |
|---|---|---|
| `PORT` env / `--port` flag | Mesh's bind port (user-facing) | **Vite's bind port (user-facing in dev).** Studio's bind port in prod. This is what `application.port` in the sandbox daemon's config refers to. |
| `VITE_PORT` env / `--vite-port` flag | Vite's bind port | **Removed (hard-break).** |
| (new) `STUDIO_API_PORT` env / `--studio-api-port` flag | n/a | **Studio API's internal bind port (dev only).** Auto-picked by `findAvailablePort` starting from `3001`. Set on both Vite and Studio child processes so `vite.config.ts` knows the proxy target. |

Rationale for keeping `PORT` as the user-facing name: it's what the sandbox daemon (`packages/sandbox/daemon/constants.ts:88` `buildDevEnv`) already sets, what every CI/dev script already knows, and what `--base-url` flags already point at. No retraining of upstream infra needed.

## Changes by file

### `apps/mesh/vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import deco from "@decocms/vite-plugin";
import pkg from "./package.json" with { type: "json" };

const STUDIO_API_PORT = process.env.STUDIO_API_PORT ?? "3001";
const studioApiTarget = `http://127.0.0.1:${STUDIO_API_PORT}`;

export default defineConfig({
  define: { __MESH_VERSION__: JSON.stringify(pkg.version) },
  server: {
    // No host/clientPort: HMR follows location.host, which IS this Vite server.
    hmr: { overlay: true },
    // When adding a new top-level route to the Studio API, add a proxy entry here.
    // Browser hits Vite first; only listed prefixes reach the API.
    proxy: {
      "/api":         { target: studioApiTarget, ws: true, changeOrigin: true },
      "/mcp":         { target: studioApiTarget, ws: true, changeOrigin: true },
      "/oauth-proxy": { target: studioApiTarget, changeOrigin: true },
    },
  },
  clearScreen: false,
  logLevel: "warn",
  plugins: [
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    tailwindcss(),
    tsconfigPaths({ root: "." }),
    deco({ target: "bun" }),
  ],
});
```

Changes vs today:
- Strip `host: "localhost"` and `clientPort: VITE_PORT` from `server.hmr` (HMR now follows `location.host`).
- Add `server.proxy` block targeting `STUDIO_API_PORT` for the three stable prefixes.
- Drop `process.env.VITE_PORT` reference.

`ws: true` on `/api` and `/mcp` (gateway WS at `/api/links/connect`, MCP can carry SSE/WS); HTTP-only on `/oauth-proxy`. `changeOrigin: true` is the safe default; one-line revert if mesh ever needs original Host.

### `apps/mesh/src/index.ts`

Mesh in dev becomes "API only" — `handleAssets` is no longer called.

```ts
const isDev = process.env.NODE_ENV !== "production";
const handleAssets = isDev ? null : createAssetHandler({ clientDir, isServerPath });

const server = Bun.serve({
  port,           // STUDIO_API_PORT in dev, PORT in prod (both come through process.env.PORT)
  hostname: "0.0.0.0",
  fetch: async (request, server) => {
    if (previewBaseDomain) {
      const upgradeRes = await tryUpgradePreviewWs(request, server, previewProxyDeps);
      if (upgradeRes === undefined) return;
      if (upgradeRes) return upgradeRes;
      const httpRes = await tryHandlePreviewHttp(request, previewProxyDeps);
      if (httpRes) return httpRes;
    }

    if (handleAssets) {
      const assetRes = await handleAssets(request);
      if (assetRes) return withSecurityHeaders(assetRes);
    }
    return app.fetch(request, { server });
  },
  websocket: { /* preview + gateway branches — unchanged */ },
});
```

`port` continues to come from `process.env.PORT`. The CLI is responsible for setting `PORT=STUDIO_API_PORT` on the Studio child in dev; mesh's `index.ts` itself sees a single `PORT` variable and binds.

Preview proxy block stays active in prod (still needed); in dev it short-circuits when `previewBaseDomain` is unset, as today.

### `apps/mesh/src/cli.ts` (CLI flag parser)

```ts
port:              { type: "string", short: "p", default: process.env.PORT             || "3000" },
"studio-api-port": { type: "string",             default: process.env.STUDIO_API_PORT  || "3001" },
```

- `--vite-port` removed (hard-break — `parseArgs` errors on unknown option).
- `--studio-api-port` added.

### `apps/mesh/src/cli/commands/dev.ts`

Allocate both ports, spawn `dev:client` and `dev:server` **separately** (not via `concurrently`, so each child gets its own `PORT`):

```ts
const userPort      = await findAvailablePort(Number(options.port));            // user-facing → Vite
const studioApiPort = await findAvailablePort(Number(options.studioApiPort));   // internal → Studio API

// Vite child (front door)
const viteChild = Bun.spawn(
  ["bun", "run", "--cwd=apps/mesh", "dev:client"],
  {
    env: {
      ...process.env,
      PORT: String(userPort),
      STUDIO_API_PORT: String(studioApiPort),
    },
    /* stdio, … */
  },
);

// Studio API child (internal)
const studioChild = Bun.spawn(
  ["bun", "run", "--cwd=apps/mesh", "dev:server"],
  {
    env: {
      ...process.env,
      PORT: String(studioApiPort),
      STUDIO_API_PORT: String(studioApiPort),
      DATABASE_URL: settings.databaseUrl,
      /* other env, as today */
    },
    /* stdio, … */
  },
);
```

`STUDIO_API_PORT` is set on **both** processes — Studio reads it as its own bind port (for symmetry, even though it also reads `PORT`), and Vite reads it to resolve the proxy target inside `vite.config.ts`.

TUI service tiles:
```ts
updateService({ name: "Studio",     status: "ready", port: userPort });      // user-facing
updateService({ name: "Studio API", status: "ready", port: studioApiPort }); // internal
```

### `apps/mesh/src/settings/types.ts` and `settings/index.ts`

- `CliFlags.vitePort` → **`studioApiPort`**.
- Settings reader replaces `vitePort: envVars.VITE_PORT` → `studioApiPort: envVars.STUDIO_API_PORT`.

### `apps/mesh/package.json`

Scripts themselves don't change (`dev:client`, `dev:server` still read `process.env.PORT`). The `dev:servers` concurrently wrapper is **deleted** from `package.json` — invoking it directly would cause port collision since both children would inherit the same env. The intended entry point is `bun run dev` at repo root, which goes through the CLI orchestration.

### `scripts/dev-worktree.ts`

```ts
const port = await ctx.findFreePort(3000);  // user-facing only

const child = Bun.spawn([
  "bun", "run", join(repoRoot, "apps/mesh/src/cli.ts"), "dev",
  "--port",     String(port),
  "--base-url", `http://${ctx.slug}.localhost`,
  ...process.argv.slice(2),
]);

return { port, process: child };
```

Drops the second `ctx.findFreePort(4000)` call and the `--vite-port` arg. `STUDIO_API_PORT` is auto-picked by the CLI; worktrees only care about the user-facing port (which Caddy routes to from `<slug>.localhost:80`).

### `apps/mesh/playwright.config.ts`

Verify-and-adjust during implementation: the `webServer.port` must remain the user-facing port (where Playwright navigates). Today that's already `3000` (was mesh, will be Vite); same number, same meaning. The `webServer.command` likely stays as-is unless it referenced `dev:servers`, which is being deleted — in that case, switch to `bun run dev`.

## How the three topologies map

- **Standalone dev** (`bun run dev`): browser visits `localhost:3000` (Vite). Vite proxies `/api`, `/mcp`, `/oauth-proxy` to `127.0.0.1:3001` (Studio API). HMR runs on `ws://localhost:3000/` direct to Vite.
- **Conductor worktree** (`bun run dev:conductor`): Caddy routes `<slug>.localhost:80` → `localhost:<userPort>` (Vite). HMR runs through Caddy, which passes WS upgrades natively.
- **Studio-in-studio**: outer link daemon allocates a port, injects as `PORT`. Inner Vite binds it; inner Studio API is on an auto-picked internal port. Browser visits `<handle>.localhost:5174` → outer ingress → outer sandbox daemon → inner Vite. HMR rides the same chain. One origin throughout.
- **Agent-sandbox (K8s)**: pod exposes one public port. `PORT` injected, Vite binds, internal Studio API auto-picked. Same shape as user-desktop sandbox.

## Testing strategy

**No new unit tests.** Changes are config + glue.

**Existing Playwright e2e suite is the safety net.** Any topology bug surfaces as a real-URL navigation failure within seconds.

**Manual smoke tests before merge, all three topologies:**

1. `bun run dev` — load `http://localhost:3000`, verify HTML, edit a component, confirm HMR updates without full reload.
2. `bun run dev:conductor` — load `http://<slug>.localhost`, same checks.
3. **Studio-in-studio (original bug)** — open the sandbox preview URL, verify the inner Studio renders, edit a component, confirm HMR.

Studio-in-studio is the highest-signal test; if HMR works there, it works everywhere.

## Sequencing — single PR, four commits

1. **`feat(dev): introduce STUDIO_API_PORT, retire VITE_PORT`** — `cli.ts`, `cli/commands/dev.ts`, `settings/types.ts`, `settings/index.ts`. Hard-break `--vite-port`. Dual-port allocation in place. Spawn `dev:client` and `dev:server` separately with distinct env. Delete `dev:servers` script.
2. **`feat(vite): proxy /api, /mcp, /oauth-proxy to STUDIO_API_PORT`** — `vite.config.ts`. Drop HMR clientPort hardcode. After this commit, standalone `bun run dev` works in the new topology.
3. **`refactor(mesh): drop handleAssets in dev mode`** — `apps/mesh/src/index.ts`. After this commit, all three topologies should work end-to-end.
4. **`chore(dev): drop --vite-port from dev-worktree, update playwright`** — `scripts/dev-worktree.ts`, `apps/mesh/playwright.config.ts`.

Each commit is bisect-friendly. If something breaks post-merge, `git bisect` lands on a small surface.

## Rollback story

**Single revert.** Prod path is untouched (no Vite, no `STUDIO_API_PORT`, no `handleAssets` selection change). `git revert <merge-commit>` reverses cleanly — no data migration, no env-var coordination.

The one minor risk: anyone who started using `--studio-api-port` or `STUDIO_API_PORT` between merge and a hypothetical revert would suddenly find those unknown. Negligible — power-user flag, short window.

## Open verification items (to confirm during implementation)

1. **`apps/mesh/playwright.config.ts:26`** — confirm `webServer` block shape and update `command`/`port` accordingly. First task of commit 4.
2. **`packages/vite-plugin-deco/index.ts`** — earlier exploration flagged it reads `VITE_PORT` to override `server.port` (line ~204). With `VITE_PORT` removed, that branch must either no-op gracefully or be patched to read `process.env.PORT`. Verify during commit 2. The plugin's other behaviors (build config, etc.) are out of scope.
3. **`changeOrigin: true`** — assumed safe default; if mesh's `resolveOrgFromPath` middleware uses Host for org disambiguation in dev, may need to flip it off. Cheap to verify post-merge with a smoke test on `/api/<org>/...` routes.

## Scope boundary (explicitly out of scope)

1. Renaming `apps/mesh/` → `apps/studio/`.
2. `@decocms/runtime`'s `dev-server-proxy.ts` and its tests.
3. Broader refactor of `packages/vite-plugin-deco/index.ts` (limited to the `VITE_PORT` audit above).
4. Vite middleware mode, SSR, or any other Vite topology.
5. Production behavior changes.
