/**
 * MCP Mesh Server Entry Point
 *
 * Bundled server entry point for production.
 * Start with: bun run index.js
 * Or: bun run src/index.ts
 */

import { getSettings } from "./settings";
import { initObservability } from "./observability";

const settings = getSettings();

// Initialize OpenTelemetry SDK BEFORE importing any app modules.
// Modules like database/index.ts and run-registry.ts create OTel instruments
// (histograms, counters) at import time via `meter.createX()`. If the SDK
// hasn't started yet, those calls hit the NoopMeter and silently discard all
// data forever. Dynamic-importing the app tree after `initObservability()`
// ensures every `meter.createX()` call hits the real MeterProvider.
initObservability();

const { createApp } = await import("./api/app");
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
    if (!runner || runner.kind !== "agent-sandbox") return null;
    // The agent-sandbox runner is the only one that exposes proxyPreviewRequest /
    // resolvePreviewUpstreamUrl; cast is safe after the kind check.
    return runner as unknown as import("@decocms/sandbox/runner/agent-sandbox").AgentSandboxRunner;
  },
};

// Boot/dev wiring for local runners (docker + host). The boot sweep is
// Docker-only — host runner's rehydrate() probes /health and discards dead
// state on its own. The local ingress is shared by both runners.
const { resolveRunnerKindFromEnv } = await import("@decocms/sandbox/runner");
const sandboxRunnerKind = resolveRunnerKindFromEnv();
const ingressEligible =
  sandboxRunnerKind === "docker" || sandboxRunnerKind === "host";

if (ingressEligible) {
  const { startLocalSandboxIngress } = await import("@decocms/sandbox/runner");
  const { getSharedRunnerIfInit, getOrInitSharedRunner } = await import(
    "./sandbox/lifecycle"
  );

  // Boot sweep (best-effort). Shutdown cleanup can't cover crashes —
  // SIGTERM races with the parent killing postgres — so the boot sweep is
  // what actually keeps `docker ps` empty between sessions.
  // Host runner's rehydrate() probes /health and discards dead state on its own.
  if (sandboxRunnerKind === "docker") {
    const { sweepDockerOrphansOnBoot } = await import(
      "@decocms/sandbox/runner"
    );
    await sweepDockerOrphansOnBoot();
  }

  // Port 7070 default: macOS AirPlay Receiver owns `*:7000` on v4+v6, so a
  // Chrome Happy-Eyeballs race would hit Apple. The ingress is part of the
  // host/docker runner contract — those runners only expose user dev servers
  // through `<handle>.localhost:7070`, so the gate is the runner kind, not
  // NODE_ENV. Set `SANDBOX_INGRESS_PORT=0` to skip binding entirely.
  const ingressPort = Number(process.env.SANDBOX_INGRESS_PORT ?? 7070);
  if (ingressPort > 0) {
    ingressServers = startLocalSandboxIngress(() => {
      const r = getSharedRunnerIfInit();
      if (!r) return null;
      if (r.kind !== "docker" && r.kind !== "host") return null;
      // Both DockerSandboxRunner and HostSandboxRunner expose
      // resolveDaemonPort; the structural cast is safe after the kind check.
      return r as unknown as {
        resolveDaemonPort(handle: string): Promise<number | null>;
      };
    }, ingressPort);

    // Construct the runner up-front. The first preview-iframe request
    // typically arrives on a page reload with a warm vmMap, before either
    // VM_START or `/api/vm-events` has touched the runner — without this
    // eager init the ingress would 503 with "Sandbox Runner Not Initialized".
    await getOrInitSharedRunner();
  }
}

// Create the Hono app
const app = await createApp();

// When running via CLI, the calling script handles its own banner/config output
if (!settings.isCli) {
  const { ASCII_ART } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }
}

// REUSE_PORT is an internal coordination signal set by serve.ts when
// --num-threads > 1. It intentionally bypasses the Settings pipeline because
// it is not a user-facing config — it is set programmatically by the CLI
// layer immediately before importing this module. serve.ts owns the
// platform-eligibility decision; we trust the signal here.
const reusePort = process.env.REUSE_PORT === "true";

// DECOCMS_IS_WORKER is set by serve.ts on spawned worker processes.
// Workers skip local-mode seeding to avoid concurrent DB races.
const isWorker = process.env.DECOCMS_IS_WORKER === "1";

const server = Bun.serve({
  // This was necessary because MCP has SSE endpoints (like notification) that disconnects after 10 seconds (default bun idle timeout)
  idleTimeout: 0,
  port,
  hostname: "0.0.0.0", // Listen on all network interfaces (required for K8s)
  reusePort,
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
  // Multiplexed WebSocket handler. `ws.data.kind` discriminates which
  // upgrader stashed the payload — preview is the only producer today; new
  // upgraders should add a tagged `kind` and a branch here.
  websocket: {
    open(ws) {
      if (isPreviewWsData(ws.data)) previewWebSocketHandler.open(ws);
    },
    message(ws, message) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.message(ws, message);
      }
    },
    close(ws) {
      if (isPreviewWsData(ws.data)) previewWebSocketHandler.close(ws);
    },
  },
  development: false,
});

// Local mode: seed admin user + organization after server is listening
// This must run after Bun.serve() so that the org seed can fetch tools
// from the self MCP endpoint (http://localhost:PORT/mcp/self).
// Worker processes skip seeding — only the primary process seeds to avoid
// concurrent DB races across workers.
if (settings.localMode && !isWorker) {
  import("./auth/local-mode")
    .then(async ({ seedLocalMode, markSeedComplete }) => {
      try {
        const seeded = await seedLocalMode();
        void seeded;
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
