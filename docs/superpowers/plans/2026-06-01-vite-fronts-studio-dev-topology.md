# Vite-fronts-Studio Dev Topology — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vite the user-facing front door in dev (binding `PORT`), with the Studio API on an internal `STUDIO_API_PORT`. Fixes studio-in-studio HMR breakage for both user-desktop and agent-sandbox topologies. Production behavior unchanged.

**Architecture:** Two processes in dev, one user-visible port. Vite owns HTML/assets/HMR on `PORT` and proxies `/api`, `/mcp`, `/oauth-proxy` to Studio API on auto-picked `STUDIO_API_PORT`. The CLI (`apps/mesh/src/cli/commands/dev.ts`) is the only place that knows the dual-port story — each child sees `PORT` meaning "my bind port." `VITE_PORT` is retired.

**Tech Stack:** Bun (runtime), Vite 7 (dev server + `server.proxy`), Hono (API), TypeScript, Bun's built-in `parseArgs`, `concurrently` (kept for direct dev:client/dev:server, removed from the CLI path), Caddy (worktree-devservers), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-06-01-vite-fronts-studio-dev-topology-design.md` (commit `85549d7`).

---

## File Structure

**Modified:**

- `apps/mesh/src/cli.ts` — replace `--vite-port` flag with `--studio-api-port`; update help text and dev-options assembly.
- `apps/mesh/src/cli/commands/dev.ts` — allocate two ports, spawn `dev:client` and `dev:server` as separate `Bun.spawn` children with distinct `PORT` env. Update TUI labels.
- `apps/mesh/src/settings/types.ts` — rename `vitePort` field to `studioApiPort`.
- `apps/mesh/src/settings/index.ts` — read `STUDIO_API_PORT` env instead of `VITE_PORT`.
- `apps/mesh/package.json` — delete `dev:servers` script.
- `apps/mesh/vite.config.ts` — drop `server.hmr.host`/`clientPort`; add `server.port` (reads `process.env.PORT`); add `server.proxy` for the three prefixes.
- `apps/mesh/src/index.ts` — make `handleAssets` prod-only (skipped in dev).
- `scripts/dev-worktree.ts` — drop the second `ctx.findFreePort(4000)` call and `--vite-port` arg.
- `apps/mesh/playwright.config.ts` — update `webServer.command` (no more `dev:servers`).
- `packages/vite-plugin-deco/index.ts` — fall back to `PORT` when `VITE_PORT` is unset (audit fix).

**Created:** none.

**Deleted:** none (file-level). The `dev:servers` script-entry is deleted from `apps/mesh/package.json` but the file stays.

---

## Pre-flight: explore the repo

- [ ] **Pre-flight 1: Read the relevant files**

  These are the files the plan touches. Re-read them in your worktree to make sure the line numbers and surrounding code match what the plan assumes — the codebase may have drifted since this plan was written.

  ```bash
  cat apps/mesh/src/cli.ts | head -80
  cat apps/mesh/src/cli/commands/dev.ts | head -175
  cat apps/mesh/src/settings/types.ts
  cat apps/mesh/src/settings/index.ts
  cat apps/mesh/vite.config.ts
  cat apps/mesh/src/index.ts | head -100
  cat apps/mesh/package.json | head -45
  cat scripts/dev-worktree.ts
  cat apps/mesh/playwright.config.ts
  sed -n '195,212p' packages/vite-plugin-deco/index.ts
  ```

  If anything substantially differs from the snippets shown in the tasks below, pause and update the plan or coordinate with the planner before proceeding.

- [ ] **Pre-flight 2: Verify dev currently works**

  Run `bun run dev` and confirm the existing (pre-refactor) flow works: load `http://localhost:3000`, page renders, edit a component, HMR triggers. This gives you a baseline. If dev is already broken before you start, fix that first or abort — you can't tell what your changes broke if dev was already broken.

  Stop the dev server before moving on.

---

## Task 1: CLI plumbing — retire VITE_PORT, introduce STUDIO_API_PORT

**Files:**
- Modify: `apps/mesh/src/cli.ts:23-31, 332`
- Modify: `apps/mesh/src/settings/types.ts:71`
- Modify: `apps/mesh/src/settings/index.ts:48`
- Modify: `apps/mesh/src/cli/commands/dev.ts:21-33, 98-171`
- Modify: `apps/mesh/package.json:22-25`

Each child still spawns through the new orchestration shape at the end of this task. Before commit, `bun run dev` won't necessarily work yet — Vite hasn't been reconfigured, so it will still try to bind 4000-style HMR. That's fine; the next task fixes Vite.

### Step 1: Update `apps/mesh/src/settings/types.ts`

- [ ] Rename `vitePort` to `studioApiPort` in the `CliFlags` interface.

Find:
```ts
  vitePort?: string;
```

Replace with:
```ts
  studioApiPort?: string;
```

### Step 2: Update `apps/mesh/src/settings/index.ts`

- [ ] Replace the `VITE_PORT` env read with `STUDIO_API_PORT`.

Find (line ~48):
```ts
      vitePort: envVars.VITE_PORT,
```

Replace with:
```ts
      studioApiPort: envVars.STUDIO_API_PORT,
```

Also check for any other reference to `envVars.VITE_PORT` or `settings.vitePort` in this file and rename them.

### Step 3: Update `apps/mesh/src/cli.ts` — drop `--vite-port`, add `--studio-api-port`

- [ ] Find the flag definitions at lines 23-31:

```ts
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT || "3000",
    },
    "vite-port": {
      type: "string",
      default: process.env.VITE_PORT || "4000",
    },
```

Replace with:
```ts
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT || "3000",
    },
    "studio-api-port": {
      type: "string",
      default: process.env.STUDIO_API_PORT || "3001",
    },
```

- [ ] Find the dev-options assembly (around line 332):

```ts
    vitePort: values["vite-port"]!,
```

Replace with:
```ts
    studioApiPort: values["studio-api-port"]!,
```

- [ ] Update the help text (around lines 101-103) to remove the `--vite-port` line:

Find:
```
Dev Options:
  --vite-port <port>            Vite dev server port (default: 4000)
  --base-url <url>              Base URL for the server
```

Replace with:
```
Dev Options:
  --studio-api-port <port>      Internal Studio API port (default: 3001)
  --base-url <url>              Base URL for the server
```

Also remove the `VITE_PORT` row from the "Environment Variables" help block if present:
```
  VITE_PORT             ...
```
(scan lines ~121-128).

### Step 4: Update `apps/mesh/src/cli/commands/dev.ts` — DevOptions interface

- [ ] Find the `DevOptions` interface (lines 21-33):

```ts
export interface DevOptions {
  port: string;
  vitePort: string;
  home: string;
  ...
}
```

Replace `vitePort: string;` with `studioApiPort: string;`.

### Step 5: Update `dev.ts` — rename destructured option

- [ ] Find (around line 98):

```ts
  const { vitePort, baseUrl, noTui } = options;
```

Replace with:
```ts
  const { studioApiPort, baseUrl, noTui } = options;
```

### Step 6: Update `dev.ts` — allocate both ports

- [ ] Find (around line 100):

```ts
  const port = await findAvailablePort(Number(options.port));
```

Replace with:
```ts
  const userPort = await findAvailablePort(Number(options.port));
  const studioApiPortResolved = await findAvailablePort(Number(studioApiPort));
```

### Step 7: Update `dev.ts` — buildSettings call

- [ ] Find (around lines 102-110):

```ts
  const { settings, services, managedServiceNames } = await buildSettings({
    port: String(port),
    home: options.home,
    baseUrl: options.baseUrl,
    localMode: options.localMode,
    skipMigrations: options.skipMigrations,
    noTui: options.noTui,
    vitePort: options.vitePort,
  });
```

Replace with:
```ts
  const { settings, services, managedServiceNames } = await buildSettings({
    port: String(userPort),
    home: options.home,
    baseUrl: options.baseUrl,
    localMode: options.localMode,
    skipMigrations: options.skipMigrations,
    noTui: options.noTui,
    studioApiPort: String(studioApiPortResolved),
  });
```

### Step 8: Update `dev.ts` — replace the single `dev:servers` spawn with two children

- [ ] Find the spawn around lines 135-162 (the `Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], …)` call) and the `pipeToLogStore` wiring that follows.

Replace the single spawn:
```ts
  const useInherit = noTui === true;
  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(settings.port),
      VITE_PORT: String(vitePort),
      DATABASE_URL: settings.databaseUrl,
      NATS_URL: settings.natsUrls.join(","),
      NODE_ENV: settings.nodeEnv,
      DECOCMS_LOCAL_MODE: String(settings.localMode),
      DECOCMS_HOME: settings.dataDir,
      DATA_DIR: settings.dataDir,
      DECO_CLI: "1",
      ...(options.localSandboxProvider
        ? { DEV_LINK_SESSION_PATH: join(linkDataDir, "session.json") }
        : {}),
      ...(settings.baseUrl ? { BASE_URL: settings.baseUrl } : {}),
    },
    stdio: [
      "inherit",
      useInherit ? "inherit" : "pipe",
      useInherit ? "inherit" : "pipe",
    ],
  });

  if (!useInherit) {
    pipeToLogStore(child.stdout as ReadableStream<Uint8Array>);
    pipeToLogStore(child.stderr as ReadableStream<Uint8Array>);
  }
```

With:
```ts
  const useInherit = noTui === true;

  // Shared env for both children — each gets a distinct PORT.
  // STUDIO_API_PORT is set on BOTH so vite.config.ts can read it as the
  // proxy target.
  const sharedEnv = {
    ...process.env,
    STUDIO_API_PORT: String(studioApiPortResolved),
    DATABASE_URL: settings.databaseUrl,
    NATS_URL: settings.natsUrls.join(","),
    NODE_ENV: settings.nodeEnv,
    DECOCMS_LOCAL_MODE: String(settings.localMode),
    DECOCMS_HOME: settings.dataDir,
    DATA_DIR: settings.dataDir,
    DECO_CLI: "1",
    ...(options.localSandboxProvider
      ? { DEV_LINK_SESSION_PATH: join(linkDataDir, "session.json") }
      : {}),
    ...(settings.baseUrl ? { BASE_URL: settings.baseUrl } : {}),
  };

  const stdioConfig: Parameters<typeof Bun.spawn>[1]["stdio"] = [
    "inherit",
    useInherit ? "inherit" : "pipe",
    useInherit ? "inherit" : "pipe",
  ];

  // Vite child — user-facing. Binds PORT (userPort). Vite reads
  // process.env.PORT natively for its bind port.
  const viteChild = Bun.spawn(
    ["bun", "run", "--cwd=apps/mesh", "dev:client"],
    {
      cwd: repoRoot,
      env: { ...sharedEnv, PORT: String(userPort) },
      stdio: stdioConfig,
    },
  );

  // Studio API child — internal. Binds STUDIO_API_PORT. mesh's
  // src/index.ts reads process.env.PORT for its bind port.
  const studioChild = Bun.spawn(
    ["bun", "run", "--cwd=apps/mesh", "dev:server"],
    {
      cwd: repoRoot,
      env: { ...sharedEnv, PORT: String(studioApiPortResolved) },
      stdio: stdioConfig,
    },
  );

  // Treat the studio API child as the "main" child for shutdown/exit tracking.
  // If Vite dies, we want shutdown semantics to match today's behavior.
  const child = studioChild;

  if (!useInherit) {
    pipeToLogStore(viteChild.stdout as ReadableStream<Uint8Array>);
    pipeToLogStore(viteChild.stderr as ReadableStream<Uint8Array>);
    pipeToLogStore(studioChild.stdout as ReadableStream<Uint8Array>);
    pipeToLogStore(studioChild.stderr as ReadableStream<Uint8Array>);
  }
```

- [ ] Update the shutdown handler later in the same function so it kills both children. Find the `shutdown` function (around line 259):

```ts
  const shutdown = async (signal: NodeJS.Signals) => {
    await linkChild.catch(() => null);
    if (options.localSandboxProvider) {
      const { stopLink } = await import("../../services/ensure-services");
      try {
        await stopLink(settings.dataDir);
      } catch {
        /* best-effort */
      }
    }
    child.kill(signal);
    await child.exited;
    ...
  };
```

Replace the `child.kill(signal); await child.exited;` lines with:
```ts
    viteChild.kill(signal);
    studioChild.kill(signal);
    await Promise.all([viteChild.exited, studioChild.exited]);
```

### Step 9: Update `dev.ts` — `serverUrl` and TUI labels

- [ ] Find (around line 169):

```ts
  const serverUrl = baseUrl || `http://localhost:${settings.port}`;
  setServerUrl(serverUrl);
  updateService({ name: "Vite", status: "ready", port: Number(vitePort) });
```

Replace with:
```ts
  const serverUrl = baseUrl || `http://localhost:${userPort}`;
  setServerUrl(serverUrl);
  updateService({ name: "Studio", status: "ready", port: userPort });
  updateService({ name: "Studio API", status: "ready", port: studioApiPortResolved });
```

- [ ] In the earlier loop that sets initial service status (around lines 112-114), check if there's a Mesh tile being set. If so, leave it — the explicit `updateService` calls above will overwrite the labels.

### Step 10: Update `dev.ts` — the `linkChild`'s `beforeSpawn` wait

- [ ] Find (around line 211):

```ts
              await waitForPort(Number(settings.port), { intervalMs: 500 });
```

Replace with:
```ts
              await waitForPort(userPort, { intervalMs: 500 });
```

(This wait is for the cluster's HTTP port — now Vite — before spawning the link daemon. We wait on `userPort` because that's the public surface.)

- [ ] Find (around line 292):

```ts
  return { port: Number(settings.port), process: child };
```

Replace with:
```ts
  return { port: userPort, process: child };
```

### Step 11: Delete `dev:servers` from `apps/mesh/package.json`

- [ ] Open `apps/mesh/package.json` and find the scripts block (around line 22):

```json
    "dev": "bun run migrate && concurrently \"bun run dev:client\" \"bun run dev:server\"",
    "dev:servers": "concurrently \"bun run dev:client\" \"bun run dev:server\"",
    "dev:client": "bun --bun vite dev",
    "dev:server": "bun run --cwd=../../packages/sandbox build && NODE_ENV=development bun --env-file=.env --hot run src/index.ts",
```

Delete the `dev:servers` line:
```json
    "dev": "bun run migrate && concurrently \"bun run dev:client\" \"bun run dev:server\"",
    "dev:client": "bun --bun vite dev",
    "dev:server": "bun run --cwd=../../packages/sandbox build && NODE_ENV=development bun --env-file=.env --hot run src/index.ts",
```

### Step 12: Typecheck

- [ ] Run TypeScript check across the workspace:

```bash
bun run check
```

Expected: no errors. If there are errors about `vitePort` / `VITE_PORT` leftovers, grep for them and rename:

```bash
grep -rn "vitePort\|VITE_PORT" apps/mesh/src scripts apps/mesh/playwright.config.ts 2>&1 | grep -v node_modules
```

Any remaining references in the modified files should be renamed; references in files this task doesn't touch (e.g., `scripts/dev-worktree.ts`, `playwright.config.ts`, `packages/vite-plugin-deco`) are addressed in Task 4.

### Step 13: Format and commit

- [ ] Format the changes:

```bash
bun run fmt
```

- [ ] Stage and commit:

```bash
git add apps/mesh/src/cli.ts apps/mesh/src/cli/commands/dev.ts apps/mesh/src/settings/types.ts apps/mesh/src/settings/index.ts apps/mesh/package.json
git commit -m "$(cat <<'EOF'
feat(dev): introduce STUDIO_API_PORT, retire VITE_PORT

- Replace --vite-port flag with --studio-api-port.
- Rename settings.vitePort → settings.studioApiPort.
- Allocate two ports in the dev CLI; spawn dev:client and dev:server
  separately with distinct PORT env so each child binds its own port.
- TUI now shows "Studio" (user-facing) + "Studio API" (internal) tiles.
- Delete the dev:servers package.json script (replaced by separate spawns
  in the CLI; the concurrently wrapper would have given both children
  the same PORT).

Tree is mid-flight: vite.config.ts still uses old proxy/HMR config. Next
commit completes the topology flip.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Vite proxy + HMR — `apps/mesh/vite.config.ts`

**Files:**
- Modify: `apps/mesh/vite.config.ts:8-29`

After this task, standalone `bun run dev` should work end-to-end: Vite serves HTML at `http://localhost:3000`, proxies API to the internal Studio port, HMR follows page origin.

### Step 1: Replace the entire `vite.config.ts`

- [ ] Open `apps/mesh/vite.config.ts` and replace the whole file with:

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
  define: {
    __MESH_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Vite binds PORT (the user-facing port). The CLI sets PORT=userPort
    // for the Vite child. Setting this explicitly overrides any default
    // that @decocms/vite-plugin might inject via baseDecoPlugin.
    port: Number(process.env.PORT ?? "3000"),
    // No host/clientPort: HMR follows location.host, which IS this Vite
    // server. Works in standalone, conductor (Caddy-fronted), and inside
    // any sandbox proxy chain that delivers the page.
    hmr: { overlay: true },
    // When adding a new top-level route to the Studio API, add a proxy
    // entry here. Browser hits Vite first; only listed prefixes reach
    // the API.
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

### Step 2: Manual smoke test — standalone dev

- [ ] Open a fresh terminal at the repo root and run:

```bash
bun run dev
```

- [ ] Wait for both children to come up. The TUI should show `Studio @ 3000` and `Studio API @ 3001` (or the auto-picked ports if 3000/3001 are taken).

- [ ] In another terminal, verify HTTP works:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/@vite/client
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health  # or any known API route
```

Expected: all `200`. The `/api/health` call confirms the proxy forwards to the Studio API.

- [ ] In a browser, open `http://localhost:3000/`. The page should render. Open DevTools → Network → WS and confirm a WebSocket connection to `ws://localhost:3000/` (Vite HMR). The WS should reach state `101 Switching Protocols`, not `502`/`failed`.

- [ ] Edit `apps/mesh/src/web/index.tsx` (or any rendered component file) — change something visible like a string. Save. Verify HMR updates the browser **without** a full page reload (component state should survive).

- [ ] Stop the dev server (`Ctrl-C` in the TUI).

If any of the above fails, **STOP** — do not commit. Debug:
- HTTP 502 on `/api/*` → Studio API didn't bind, or proxy target is wrong (check `STUDIO_API_PORT` env).
- HMR WS fails → check `server.hmr` config didn't accidentally retain old `clientPort`.
- Vite binds wrong port → see Task 4 step about `@decocms/vite-plugin` audit. May need to land Task 4's plugin patch before this commit can be tested.

### Step 3: Format and commit

- [ ] Format and commit:

```bash
bun run fmt
git add apps/mesh/vite.config.ts
git commit -m "$(cat <<'EOF'
feat(vite): front the Studio API via server.proxy

Vite now binds the user-facing PORT and proxies /api, /mcp, /oauth-proxy
to STUDIO_API_PORT. HMR config dropped server.hmr.host/clientPort so
the client connects WS to location.host (the page's own origin), which
makes HMR work through any proxy chain that delivers the HTML.

After this commit, standalone `bun run dev` works in the new topology:
Vite serves HTML/assets/HMR, Studio API serves /api/*.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drop `handleAssets` in dev mode — `apps/mesh/src/index.ts`

**Files:**
- Modify: `apps/mesh/src/index.ts:65-93, 154-185`

In dev, the Studio API is behind Vite and never receives asset requests. The `handleAssets` call becomes dead code in dev. This task makes that explicit by skipping the call.

### Step 1: Guard `handleAssets` construction with `isDev`

- [ ] Open `apps/mesh/src/index.ts`. Find the asset-handler construction (around lines 65-76):

```ts
// Create asset handler - handles both dev proxy and production static files
// When running from source (src/index.ts), the "../client" relative path
// doesn't resolve to dist/client/. Fall back to dist/client/ relative to CWD.
import { existsSync } from "fs";
const resolvedClientDir = resolveClientDir(import.meta.url, "../client");
const clientDir = existsSync(resolvedClientDir)
  ? resolvedClientDir
  : resolveClientDir(import.meta.url, "../dist/client");
const handleAssets = createAssetHandler({
  clientDir,
  isServerPath,
});
```

Replace with:
```ts
// Create asset handler - handles production static files only.
// In dev, Vite is the front door (see apps/mesh/vite.config.ts) and
// the Studio API never receives asset requests, so we skip the handler
// entirely to avoid construction work and a dead code path.
import { existsSync } from "fs";
const isDev = process.env.NODE_ENV !== "production";
const resolvedClientDir = resolveClientDir(import.meta.url, "../client");
const clientDir = existsSync(resolvedClientDir)
  ? resolvedClientDir
  : resolveClientDir(import.meta.url, "../dist/client");
const handleAssets = isDev
  ? null
  : createAssetHandler({ clientDir, isServerPath });
```

### Step 2: Guard the call site in the fetch handler

- [ ] Find the `Bun.serve` fetch handler. The current asset-handler call is around lines 180-184:

```ts
    // Try assets first (static files or dev proxy), then API
    // Pass server as env so Hono's getConnInfo can access requestIP
    const assetRes = await handleAssets(request);
    if (assetRes) return withSecurityHeaders(assetRes);
    return app.fetch(request, { server });
```

Replace with:
```ts
    // Try assets in prod (serve built files from disk). In dev, handleAssets
    // is null because Vite fronts the asset surface — see vite.config.ts.
    if (handleAssets) {
      const assetRes = await handleAssets(request);
      if (assetRes) return withSecurityHeaders(assetRes);
    }
    return app.fetch(request, { server });
```

### Step 3: Typecheck

- [ ] Run:

```bash
bun run check
```

Expected: no errors. The `null` union on `handleAssets` is handled by the `if (handleAssets)` guard.

### Step 4: Manual smoke test

- [ ] Run `bun run dev`. Verify the dev flow still works (HTML at `localhost:3000`, HMR triggers on edit). Behavior should be identical to Task 2's smoke test — this commit doesn't change observable behavior in dev, only removes dead code.

- [ ] Stop the dev server.

### Step 5: Format and commit

- [ ] Format and commit:

```bash
bun run fmt
git add apps/mesh/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(mesh): make handleAssets prod-only

In dev, Vite is the front door — the Studio API never receives asset
requests. Skip handleAssets construction and invocation in dev to
eliminate the dead code path.

Production behavior unchanged: handleAssets still serves built files
from disk via createAssetHandler.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Cleanup — dev-worktree, playwright, vite-plugin-deco audit

**Files:**
- Modify: `scripts/dev-worktree.ts:28-48`
- Modify: `apps/mesh/playwright.config.ts:25-32`
- Modify: `packages/vite-plugin-deco/index.ts:200-206`

### Step 1: Update `scripts/dev-worktree.ts`

- [ ] Open `scripts/dev-worktree.ts`. Find the `startWorktree` callback (lines 28-49):

```ts
startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(3000);
  const vitePort = await ctx.findFreePort(4000);

  const child = Bun.spawn(
    [
      "bun",
      "run",
      join(repoRoot, "apps/mesh/src/cli.ts"),
      "dev",
      "--port",
      String(port),
      "--vite-port",
      String(vitePort),
      "--base-url",
      `http://${ctx.slug}.localhost`,
      ...process.argv.slice(2),
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );

  return { port, process: child };
})
```

Replace with:
```ts
startWorktree(slug, async (ctx) => {
  // Only the user-facing port needs pre-allocation. The CLI auto-picks
  // STUDIO_API_PORT internally via findAvailablePort.
  const port = await ctx.findFreePort(3000);

  const child = Bun.spawn(
    [
      "bun",
      "run",
      join(repoRoot, "apps/mesh/src/cli.ts"),
      "dev",
      "--port",
      String(port),
      "--base-url",
      `http://${ctx.slug}.localhost`,
      ...process.argv.slice(2),
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );

  return { port, process: child };
})
```

### Step 2: Update `apps/mesh/playwright.config.ts`

- [ ] Open `apps/mesh/playwright.config.ts`. Find the `webServer` block (lines 25-32):

```ts
  webServer: {
    command: "bun run dev:servers",
    url: `http://localhost:${process.env.PORT || "3000"}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
```

Replace with:
```ts
  webServer: {
    // dev:servers was removed (it gave both Vite and Studio the same env,
    // including PORT). Invoke the CLI directly to get the orchestrated
    // dual-port spawn. The CLI listens on PORT (user-facing) and
    // auto-picks STUDIO_API_PORT internally.
    command: "bun src/cli.ts dev",
    url: `http://localhost:${process.env.PORT || "3000"}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
```

The `baseURL` at line 15 already uses `process.env.PORT || "3000"` — that's still correct (user-facing, now Vite).

### Step 3: Patch `packages/vite-plugin-deco/index.ts` for PORT fallback

- [ ] Open `packages/vite-plugin-deco/index.ts`. Find the `baseDecoPlugin` server-port logic (lines 200-206):

```ts
    config: () => ({
      server: {
        port:
          decoConfig.port ||
          parseInt(process.env.VITE_PORT || "", 10) ||
          DEFAULT_PORT,
        strictPort: true,
      },
```

Replace with:
```ts
    config: () => ({
      server: {
        port:
          decoConfig.port ||
          parseInt(process.env.PORT || "", 10) ||
          parseInt(process.env.VITE_PORT || "", 10) ||
          DEFAULT_PORT,
        strictPort: true,
      },
```

We now prefer `PORT` (the new contract) but keep `VITE_PORT` as a fallback so any external consumer of `@decocms/vite-plugin` that still sets `VITE_PORT` continues to work.

### Step 4: Typecheck

- [ ] Run:

```bash
bun run check
```

Expected: no errors.

- [ ] Grep for any remaining `VITE_PORT` / `vitePort` references in the workspace to confirm cleanup:

```bash
grep -rn "VITE_PORT\|vitePort\|--vite-port" apps/mesh scripts packages/vite-plugin-deco 2>&1 | grep -v node_modules | grep -v ".test."
```

Expected output: only the fallback in `packages/vite-plugin-deco/index.ts` you just edited. Anything else is leftover — rename or remove.

### Step 5: Manual smoke test — all three topologies

This is the critical verification. Run each scenario in a clean shell.

**Topology 1: Standalone dev**

- [ ] In one terminal: `bun run dev`
- [ ] Open `http://localhost:3000` in a browser. Verify the page renders.
- [ ] Edit `apps/mesh/src/web/index.tsx`, save. Verify HMR updates without full reload.
- [ ] Stop dev (`Ctrl-C`).

**Topology 2: Conductor worktree**

- [ ] In one terminal: `WORKTREE_SLUG=test-vite-fronts bun run dev:worktree`
  (Or use `bun run dev:conductor` if `CONDUCTOR_WORKSPACE_NAME` is set in your shell.)
- [ ] Wait for Caddy to register the route. Then open `http://test-vite-fronts.localhost/` in a browser.
- [ ] Verify the page renders and HMR works on edit.
- [ ] Stop the worktree dev session.

**Topology 3: Studio-in-studio (the original bug)**

- [ ] Re-spawn the sandbox so it picks up the new code:
  ```bash
  # Find your sandbox handle in your link daemon's TUI or via Studio UI.
  # If you previously had a stale sandbox, delete it from the link daemon
  # before respawning so the new ports are clean.
  ```
- [ ] Once the link daemon spawns the sandbox, open `http://<handle>.localhost:5174/` in a browser. Verify the inner Studio renders.
- [ ] Open DevTools → Network → WS. Confirm the HMR WebSocket connects to `ws://<handle>.localhost:5174/` (the same origin as the page), reaches `101 Switching Protocols`.
- [ ] Edit a component file inside the sandboxed repo. Save. Verify HMR updates the browser without a full reload. **This is the smoke test that validates the entire refactor.**

If any topology fails, debug before committing this task. Common issues:

- **Vite binds the wrong port** → check the vite-plugin-deco patch landed (Task 4 step 3). Open DevTools → page source → confirm `import.meta.env` or page URL shows the expected port.
- **`bun src/cli.ts dev` from Playwright errors** → confirm the path is right relative to apps/mesh cwd. Try running it manually from that directory.
- **Conductor worktree shows wrong host** → confirm Caddy is running and the route registration completed. `curl -v http://test-vite-fronts.localhost/` should land on a Vite response.

### Step 6: Run Playwright suite

- [ ] Run the e2e suite to confirm Playwright's new `webServer.command` works:

```bash
cd apps/mesh
bunx playwright test --reporter=line  # or however the suite is conventionally invoked
```

Expected: tests pass (or fail with the same pre-existing failures as before this PR — your refactor shouldn't introduce new failures).

If the suite hangs at startup, the `webServer.command` change is wrong. Diagnose by running `bun src/cli.ts dev` directly from `apps/mesh/` and confirming it boots.

### Step 7: Format and commit

- [ ] Format and commit:

```bash
bun run fmt
git add scripts/dev-worktree.ts apps/mesh/playwright.config.ts packages/vite-plugin-deco/index.ts
git commit -m "$(cat <<'EOF'
chore(dev): drop --vite-port from dev-worktree, repoint playwright, audit deco plugin

- scripts/dev-worktree.ts: drop the second findFreePort(4000) call and
  the --vite-port arg (the CLI auto-picks STUDIO_API_PORT internally).
- apps/mesh/playwright.config.ts: dev:servers was removed in commit 1, so
  webServer.command now invokes the CLI directly to get the orchestrated
  dual-port spawn.
- packages/vite-plugin-deco/index.ts: prefer process.env.PORT over
  VITE_PORT for the server.port default. VITE_PORT stays as a fallback
  for external consumers that still set it.

After this commit, all three dev topologies (standalone, conductor, and
studio-in-studio) work in the new Vite-fronts-Studio shape.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation verification

After all four tasks land, run these checks:

- [ ] **Full typecheck:** `bun run check` — zero errors.
- [ ] **Full unit tests:** `bun test apps/mesh/src packages` — same pass rate as main (no new failures).
- [ ] **Lint:** `bun run lint` — zero new violations.
- [ ] **Format:** `bun run fmt:check` — clean.
- [ ] **Grep for stragglers:**
  ```bash
  grep -rn "VITE_PORT\|--vite-port\|dev:servers" apps scripts packages 2>&1 | grep -v node_modules | grep -v dist
  ```
  Expected: only the intentional fallback reference in `packages/vite-plugin-deco/index.ts`.

- [ ] **PR description:** include the spec link (`docs/superpowers/specs/2026-06-01-vite-fronts-studio-dev-topology-design.md`) and call out:
  - The hard-break of `--vite-port` and `VITE_PORT` (CI scripts / dev setups outside this repo that set these may need updating).
  - The deletion of `dev:servers`.
  - The new `STUDIO_API_PORT` env var.

---

## Self-review (planner's notes)

**Spec coverage check** — every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| Topology / port semantics | Task 1 (CLI wiring) + Task 2 (Vite config) |
| `vite.config.ts` changes | Task 2 |
| `apps/mesh/src/index.ts` changes | Task 3 |
| CLI & settings pipeline | Task 1 |
| Dev scripts (package.json, dev-worktree, playwright) | Task 1 (package.json) + Task 4 (dev-worktree, playwright) |
| Testing strategy | Task 2 smoke + Task 3 smoke + Task 4 smoke (three topologies) + Post-impl Playwright |
| Sequencing (4 commits) | Tasks 1–4 each end with one commit |
| Rollback story | Implicit — single PR, four commits; revert command in PR description |
| Open verification items | Pre-flight 1 (read files), Task 4 (playwright + vite-plugin-deco audit) |
| Scope boundary | Honored — no changes outside listed files |

**Placeholder scan:** No TBD/TODO/"add appropriate X". Every step has either exact code or a concrete command with expected output.

**Type / name consistency:**
- `userPort` and `studioApiPortResolved` used consistently within `dev.ts` (the latter disambiguates from the destructured `studioApiPort` arg).
- `studioApiPort` is the settings field name; `STUDIO_API_PORT` is the env var. Used consistently.
- `Studio` and `Studio API` are the TUI labels. Consistent.
- `VITE_PORT` retained ONLY as a fallback in `packages/vite-plugin-deco/index.ts` for external compatibility; explicitly mentioned.

**One known fragility:** between commit 1 and commit 4, `scripts/dev-worktree.ts` is broken (it passes `--vite-port` which is now an unknown flag). The spec accepts this — bisect-friendly ≠ green-at-every-commit. The PR description should call this out so reviewers don't try `dev:conductor` against the WIP branch mid-stack.
