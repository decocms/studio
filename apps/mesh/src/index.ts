/**
 * MCP Mesh Server Entry Point
 *
 * Bundled server entry point for production.
 * Start with: bun run index.js
 * Or: bun run src/index.ts
 */

import { getSettings } from "./settings";
import { initObservability } from "./observability";
import type { WsAttachData } from "./api/app";

const settings = getSettings();

// Initialize OpenTelemetry SDK BEFORE importing any app modules.
// Modules like database/index.ts and run-registry.ts create OTel instruments
// (histograms, counters) at import time via `meter.createX()`. If the SDK
// hasn't started yet, those calls hit the NoopMeter and silently discard all
// data forever. Dynamic-importing the app tree after `initObservability()`
// ensures every `meter.createX()` call hits the real MeterProvider.
initObservability();

// DBOS shares mesh's Postgres database and owns the `dbos` schema. Sharing
// the DB (vs. a sibling one) is what lets future workflow-ified CRUD
// commit mesh writes and DBOS step-output records in a single transaction
// via a DBOS data source. The `dbos` schema is auto-created on launch.
// setConfig must run before any module registers workflows; launch happens
// after the app graph is loaded so all DBOS.registerWorkflow calls are in.
const { DBOS } = await import("@dbos-inc/dbos-sdk");
// DBOS uses its own pg client (separate from mesh's pool), so the `sslmode`
// must travel in the URL. RDS's pg_hba.conf rejects unencrypted connections
// with `no pg_hba.conf entry for host ... no encryption` when this is missing.
// Use `verify-full` explicitly: pg-connection-string v2 silently upgrades
// `require` to `verify-full`, but v3 / pg v9 will drop that upgrade and treat
// `require` as encrypt-without-verification (libpq semantics).
function withSslmode(url: string, ssl: boolean): string {
  if (!ssl) return url;
  const u = new URL(url);
  if (!u.searchParams.has("sslmode")) {
    u.searchParams.set("sslmode", "verify-full");
  }
  return u.toString();
}
DBOS.setConfig({
  name: "decocms",
  systemDatabaseUrl: withSslmode(settings.databaseUrl, settings.databasePgSsl),
  systemDatabaseSchemaName: "dbos",
  // SDK default is 10. Cap lower so N replicas don't exhaust RDS slots —
  // bump via `DBOS_POOL_SIZE` if the workflow workload demands more in-flight
  // steps per pod.
  systemDatabasePoolSize: Number(process.env.DBOS_POOL_SIZE ?? 5),
  // N workers all call DBOS.launch(); the admin server would otherwise fight
  // over port 3001. Re-enable per-process once we need workflow admin HTTP.
  runAdminServer: false,
});

const { createApp, gatewayWsHandlers } = await import("./api/app");
const { isServerPath } = await import("./api/utils/paths");
const { createAssetHandler, resolveClientDir } = await import(
  "@decocms/runtime/asset-server"
);

const port = settings.port;

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

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Closed early in gracefulShutdown so the port frees before the Hono drain.
let ingressServers: import("node:net").Server[] = [];

// Sandbox preview reverse-proxy (agent-sandbox only). The base domain is parsed at
// boot from STUDIO_SANDBOX_PREVIEW_URL_PATTERN; null disables the proxy and
// preview-host requests fall through to the normal mesh routing (which 404s
// because nothing matches). The Bun-level WS handler is registered
// unconditionally — when previewBaseDomain is null, no upgrade path runs it.
const {
  parsePreviewBaseDomain,
  tryHandlePreviewHttp,
  tryUpgradePreviewWs,
  previewWebSocketHandler,
  isPreviewWsData,
} = await import("./sandbox/preview-proxy");
const { getOrInitSharedRunner: getOrInitRunnerForPreview } = await import(
  "./sandbox/lifecycle"
);
const previewBaseDomain = parsePreviewBaseDomain(
  process.env.STUDIO_SANDBOX_PREVIEW_URL_PATTERN,
);
const previewProxyDeps = {
  baseDomain: previewBaseDomain ?? "",
  getRunner: async () => {
    const runner = await getOrInitRunnerForPreview();
    if (!runner || runner.kind !== "cluster") return null;
    // The cluster (agent-sandbox) runner is the only one that exposes proxyPreviewRequest /
    // resolvePreviewUpstreamUrl; cast is safe after the kind check.
    return runner as unknown as import("@decocms/sandbox/provider/agent-sandbox").AgentSandboxProvider;
  },
};

// Boot/dev wiring for the Docker runner. The boot sweep + local ingress
// are local-docker-only — other runners (cluster, user-desktop)
// either don't run on this machine or expose previews via their own
// publicly-reachable URLs.
const { resolveSandboxProviderKindFromEnv } = await import(
  "@decocms/sandbox/provider"
);
const sandboxProviderKind = resolveSandboxProviderKindFromEnv();
const ingressEligible = sandboxProviderKind === "local-docker";

if (ingressEligible) {
  const { startLocalSandboxIngress } = await import(
    "@decocms/sandbox/provider"
  );
  const { getSharedSandboxProviderIfInit, getOrInitSharedRunner } =
    await import("./sandbox/lifecycle");

  // Boot sweep (best-effort). Shutdown cleanup can't cover crashes —
  // SIGTERM races with the parent killing postgres — so the boot sweep is
  // what actually keeps `docker ps` empty between sessions.
  const { sweepDockerOrphansOnBoot } = await import(
    "@decocms/sandbox/provider"
  );
  await sweepDockerOrphansOnBoot();

  // Port 7070 default: macOS AirPlay Receiver owns `*:7000` on v4+v6, so a
  // Chrome Happy-Eyeballs race would hit Apple. The ingress is part of the
  // Docker runner contract — Docker exposes user dev servers through
  // `<handle>.localhost:7070`, so the gate is the runner kind, not
  // NODE_ENV. Set `SANDBOX_INGRESS_PORT=0` to skip binding entirely.
  const ingressPort = Number(process.env.SANDBOX_INGRESS_PORT ?? 7070);
  if (ingressPort > 0) {
    ingressServers = startLocalSandboxIngress(() => {
      const r = getSharedSandboxProviderIfInit();
      if (!r) return null;
      if (r.kind !== "local-docker") return null;
      // DockerSandboxProvider exposes resolveDaemonPort; the structural
      // cast is safe after the kind check.
      return r as unknown as {
        resolveDaemonPort(handle: string): Promise<number | null>;
      };
    }, ingressPort);

    // Construct the provider up-front. The first preview-iframe request
    // typically arrives on a page reload with a warm sandboxMap, before either
    // SANDBOX_START or `/api/vm-events` has touched the provider — without this
    // eager init the ingress would 503 with "Sandbox Runner Not Initialized".
    await getOrInitSharedRunner();
  }
}

// Create the Hono app (any DBOS.registerWorkflow calls happen during this
// import chain). Launch DBOS afterwards so the registry is sealed before
// the executor starts dequeueing workflows.
const app = await createApp();
// Conductor opt-in via env (SDK defaults conductorURL to wss://cloud.dbos.dev/...).
const conductorKey = process.env.DBOS_CONDUCTOR_KEY?.trim();
const conductorURL = process.env.DBOS_CONDUCTOR_URL?.trim();
await DBOS.launch({
  ...(conductorKey ? { conductorKey } : {}),
  ...(conductorKey && conductorURL ? { conductorURL } : {}),
});
// Post-launch DBOS setup (queue registration, schedule reconciliation).
// Must run after launch because registerQueue / listSchedules require an
// initialized executor.
await app.initDbos();

// When running via CLI, the calling script handles its own banner/config output
if (!settings.isCli) {
  const { ASCII_ART } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }
}

function isGatewayWsData(data: unknown): data is WsAttachData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "gateway"
  );
}

const server = Bun.serve({
  // This was necessary because MCP has SSE endpoints (like notification) that disconnects after 10 seconds (default bun idle timeout)
  idleTimeout: 0,
  port,
  hostname: "0.0.0.0", // Listen on all network interfaces (required for K8s)
  fetch: async (request, server) => {
    // Sandbox preview proxy: matched by Host header. Runs *before* assets
    // and the Hono app so a `<handle>.preview.<base>` request never hits
    // mesh's static-file handler (which would 404 on the dev server's
    // bundle paths). WS upgrades short-circuit Bun.serve's fetch by
    // returning undefined; HTTP returns a Response.
    if (previewBaseDomain) {
      // Bun's Server type defaults T=undefined for upgrade<T>(); cast widens
      // to our PreviewWsData carrier so the WS handler can stash it. Bun
      // doesn't enforce data-type consistency at runtime, only via generics.
      const upgradeRes = await tryUpgradePreviewWs(
        request,
        server as unknown as Parameters<typeof tryUpgradePreviewWs>[1],
        previewProxyDeps,
      );
      if (upgradeRes === undefined) return; // upgraded
      if (upgradeRes) return upgradeRes; // pre-upgrade error
      const httpRes = await tryHandlePreviewHttp(request, previewProxyDeps);
      if (httpRes) return httpRes;
    }

    // Try assets first (static files or dev proxy), then API
    // Pass server as env so Hono's getConnInfo can access requestIP
    const assetRes = await handleAssets(request);
    if (assetRes) return withSecurityHeaders(assetRes);
    return app.fetch(request, { server });
  },
  // Multiplexed WebSocket handler. `ws.data.kind` discriminates preview
  // connections; `ws.data.userSub` discriminates gateway link connections.
  // New upgraders should add a tagged field and a branch here.
  websocket: {
    open(ws) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.open(ws);
      } else if (isGatewayWsData(ws.data)) {
        gatewayWsHandlers.open(
          ws as unknown as Parameters<typeof gatewayWsHandlers.open>[0],
        );
      }
    },
    message(ws, message) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.message(ws, message);
      } else if (isGatewayWsData(ws.data)) {
        void gatewayWsHandlers.message(
          ws as unknown as Parameters<typeof gatewayWsHandlers.message>[0],
          message,
        );
      }
    },
    close(ws, code, reason) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.close(ws);
      } else if (isGatewayWsData(ws.data)) {
        gatewayWsHandlers.close(
          ws as unknown as Parameters<typeof gatewayWsHandlers.close>[0],
          code,
          reason,
        );
      }
    },
  },
  development: false,
});

// Local mode: seed admin user + organization after server is listening
// This must run after Bun.serve() so that the org seed can fetch tools
// from the self MCP endpoint (http://localhost:PORT/mcp/self).
if (settings.localMode) {
  import("./auth/local-mode")
    .then(async ({ seedLocalMode, markSeedComplete }) => {
      try {
        const seeded = await seedLocalMode();
        void seeded;
        // When the cluster is in dev mode (MESH_ALLOW_LOCALHOST_LINKS=1
        // set by `bun run dev`), bootstrap an API-key-backed session for
        // the desktop-side link binary that `bun run dev` auto-spawns.
        // The link reads it from `<DATA_DIR>/dev-link/session.json` and
        // presents the API key as a Bearer token to POST /api/links.
        if (process.env.MESH_ALLOW_LOCALHOST_LINKS === "1") {
          try {
            const { bootstrapDevLinkSession } = await import(
              "./auth/dev-link-session"
            );
            const clusterBaseUrl =
              settings.baseUrl ?? `http://localhost:${settings.port}`;
            const result = await bootstrapDevLinkSession(
              settings.dataDir,
              clusterBaseUrl,
            );
            if (result) {
              console.log(
                `[dev-link] session ready at ${result.path} (userSub=${result.userSub})`,
              );
            } else {
              console.warn(
                "[dev-link] no admin user yet — skipping session bootstrap. The auto-spawned link will refuse to start until an admin exists.",
              );
            }
          } catch (err) {
            console.error("[dev-link] bootstrap failed:", err);
          }
        }
      } catch (error) {
        console.error("Failed to seed local mode:", error);
      } finally {
        markSeedComplete();
      }
    })
    .catch(async (error) => {
      console.error("Failed to load local-mode module:", error);
      // Still release the seed gate so /local-session doesn't hang forever
      try {
        const { markSeedComplete } = await import("./auth/local-mode");
        markSeedComplete();
      } catch {
        // Module itself failed to load — gate was never armed (isLocalMode()
        // would have resolved it immediately in the Promise constructor)
      }
    });
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let shuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error("[shutdown] Timed out after 55s, forcing exit.");
    process.exit(1);
  }, 55_000);
  forceExitTimer.unref?.();

  let exitCode = 0;
  try {
    // 1. Mark as shutting down — readiness returns 503 immediately
    app.markShuttingDown();

    // 2. Close ingress first so port 7070 frees immediately — next `bun dev`
    //    shouldn't have to wait out our drain.
    for (const s of ingressServers) s.close();

    // 3. Let K8s notice the 503 before we close connections.
    await new Promise((r) => setTimeout(r, 2_000));

    // 4. Force-close connections (SSE streams are long-lived and would block
    //    graceful drain indefinitely).
    await server.stop(true);

    // Drain DBOS before app.shutdown closes mesh's pg pool — in-flight steps use it.
    await DBOS.shutdown();
    await app.shutdown();
  } catch (err) {
    console.error("[shutdown] Error during shutdown:", err);
    exitCode = 1;
  }

  clearTimeout(forceExitTimer);
  process.exit(exitCode);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Bun keeps the process alive after terminal close — without SIGHUP we
// accumulate zombies still holding port 7070.
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});
