/**
 * Studio Server Entry Point
 *
 * Bundled server entry point for production.
 * Start with: bun run index.js
 * Or: bun run src/index.ts
 */

import { retry, sleep } from "@decocms/shared/std";
// Side-effect-free queue names — safe to import before DBOS.setConfig (unlike
// the workflow modules, which register workflows at import time).
import {
  AUTOMATIONS_QUEUE,
  BACKGROUND_TOOLS_QUEUE,
  GITHUB_READS_QUEUE,
  HOSTED_HARNESS_QUEUE,
  HOSTED_HARNESS_SANDBOXED_QUEUE,
  THREAD_GATE_QUEUE,
} from "./dispatch-queue/queue-names";
import { buildDbosConfig } from "./dbos/config";
import { getSettings } from "./settings";
import { resolveShutdownDrainMs } from "./settings/resolve-config";
import { initObservability } from "./observability";
import { startProfiling } from "./observability/profiling";

const settings = getSettings();

// Initialize OpenTelemetry SDK BEFORE importing any app modules.
// Modules like database/index.ts and run-registry.ts create OTel instruments
// (histograms, counters) at import time via `meter.createX()`. If the SDK
// hasn't started yet, those calls hit the NoopMeter and silently discard all
// data forever. Dynamic-importing the app tree after `initObservability()`
// ensures every `meter.createX()` call hits the real MeterProvider.
initObservability();

// DBOS shares studio's Postgres database and owns the `dbos` schema. Sharing
// the DB (vs. a sibling one) is what lets future workflow-ified CRUD
// commit studio writes and DBOS step-output records in a single transaction
// via a DBOS data source. The `dbos` schema is auto-created on launch.
// setConfig must run before any module registers workflows; launch happens
// after the app graph is loaded so all DBOS.registerWorkflow calls are in.
const { DBOS, DBOSClient } = await import("@dbos-inc/dbos-sdk");
// DBOS uses its own pg client (separate from studio's pool), so the `sslmode`
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
// ── Pod dispatch role (horizontal split) ────────────────────────────────────
// `settings.dispatchRole` (from `STUDIO_DISPATCH_ROLE`, resolved in
// resolve-config) selects which DBOS queues this pod DEQUEUES (via the SDK's
// `listenQueues` filter). It lets you run two Deployments off the SAME
// image/DB/auth and scale them independently:
//   - "all"    (default) — dequeue every queue. Unchanged single-deployment
//                          behavior; safe default, no opt-in required.
//   - "worker" — dequeue only the agent/automation RUN queues, so these pods
//                execute decopilot streams + automation fires. Scale these on
//                CPU (the LLM-stream load) without touching API pods.
//   - "api"    — dequeue NOTHING (only DBOS's internal queue still runs). These
//                pods serve HTTP, enqueue runs, and tail NATS for /stream, but
//                never run the heavy agent loop.
// Scheduled (cron) workflows and enqueueing are unaffected — they run on every
// pod and stay exactly-once via DBOS's row-locked schedule, so an "api" pod can
// still fire a cron that a "worker" pod then executes. REQUIREMENT: at least
// one "worker" (or "all") pod must exist or runs never dispatch.
const RUN_QUEUES = [
  AUTOMATIONS_QUEUE,
  THREAD_GATE_QUEUE,
  HOSTED_HARNESS_QUEUE,
  HOSTED_HARNESS_SANDBOXED_QUEUE,
  // Heavy backgroundable built-ins (generate_image) are worker load, so
  // "worker"-role pods must dequeue them too — otherwise a split deployment
  // enqueues the job but never runs it.
  BACKGROUND_TOOLS_QUEUE,
  // The board's throttled GitHub reads. The review sweeper runs on every pod
  // and awaits its enqueued read, so an "api"-only deployment would block
  // forever if no worker dequeued this.
  GITHUB_READS_QUEUE,
];
const listenQueues: string[] | undefined =
  settings.dispatchRole === "worker"
    ? RUN_QUEUES
    : settings.dispatchRole === "api"
      ? []
      : undefined; // "all" → omit → DBOS listens to every queue

DBOS.setConfig(
  buildDbosConfig({
    systemDatabaseUrl: withSslmode(
      settings.databaseUrl,
      settings.databasePgSsl,
    ),
    // SDK default is 10. Cap lower so N replicas don't exhaust RDS slots —
    // bump via `DBOS_POOL_SIZE` if the workflow workload demands more in-flight
    // steps per pod.
    poolSize: settings.dbosPoolSize,
    executorID: settings.podName,
    // Pod-role queue filter (see RUN_QUEUES above). undefined => "all".
    listenQueues,
  }),
);

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

// Sandbox preview reverse-proxy (agent-sandbox only). The base domain is parsed at
// boot from STUDIO_SANDBOX_PREVIEW_URL_PATTERN; null disables the proxy and
// preview-host requests fall through to the normal studio routing (which 404s
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
  // getOrInitSharedRunner resolves to the cluster AgentSandboxProvider (the
  // only env-instantiable provider) or null — exactly what PreviewProxyDeps
  // wants, so no kind check or cast is needed.
  getRunner: getOrInitRunnerForPreview,
};

// Tenant warm pools need the provider BEFORE any request: its reconciler is
// what bootstraps the pool's pods, and the whole point is that they are warm
// when the first user arrives. Everything else builds the provider lazily, so
// without this a configured pool sits empty until someone happens to open a
// sandbox. Fire-and-forget — a provider that can't be built must not stop boot.
if (process.env.STUDIO_SANDBOX_TENANT_POOLS?.trim()) {
  void getOrInitRunnerForPreview().catch((err: unknown) => {
    console.warn(
      "[lifecycle] eager sandbox provider init for tenant pools failed:",
      err instanceof Error ? err.message : String(err),
    );
  });
}

// Create the Hono app (any DBOS.registerWorkflow calls happen during this
// import chain). Launch DBOS afterwards so the registry is sealed before
// the executor starts dequeueing workflows.
const app = await createApp({ clientDir });
// Conductor opt-in via env (SDK defaults conductorURL to wss://cloud.dbos.dev/...).
const conductorKey = process.env.DBOS_CONDUCTOR_KEY?.trim();
const conductorURL = process.env.DBOS_CONDUCTOR_URL?.trim();
await DBOS.launch({
  ...(conductorKey ? { conductorKey } : {}),
  ...(conductorKey && conductorURL ? { conductorURL } : {}),
});
// Surface the DBOS application version on every boot so the pin is verifiable
// from pod logs (`grep "dbos] application version"`). Expect the pinned
// DBOS_WORKFLOW_VERSION ("1"), never a 32-char hash — a hash means the pin was
// bypassed (e.g. DBOS__CLOUD / DBOS__APPVERSION env). See dbos/workflow-version.ts.
console.log(`[dbos] application version: ${DBOS.applicationVersion}`);
// Post-launch DBOS setup (queue registration, schedule reconciliation).
// Must run after launch because registerQueue / listSchedules require an
// initialized executor. Retry: registerQueue + reconcile are idempotent, so a
// transient boot-time DB connect timeout (shared RDS under connection pressure)
// retries instead of exiting the process — otherwise one blip crash-loops every
// pod at once.
const initDbosMaxAttempts = 5;
let initDbosAttempt = 0;
await retry(
  async () => {
    initDbosAttempt++;
    try {
      return await app.initDbos();
    } catch (error) {
      const outcome =
        initDbosAttempt >= initDbosMaxAttempts ? "giving up" : "retrying";
      console.warn(
        `[dbos] initDbos attempt ${initDbosAttempt}/${initDbosMaxAttempts} failed, ${outcome}`,
        error,
      );
      throw error;
    }
  },
  {
    maxAttempts: initDbosMaxAttempts,
    minTimeout: 1000,
    maxTimeout: 10_000,
    jitter: 0.5,
  },
);

// When running via CLI, the calling script handles its own banner/config output
if (!settings.isCli) {
  const { bannerLines } = await import("./cli/banner-art");
  console.log("");
  for (const line of bannerLines()) {
    console.log(line);
  }
}

const server = Bun.serve({
  // This was necessary because MCP has SSE endpoints (like notification) that disconnects after 10 seconds (default bun idle timeout)
  idleTimeout: 0,
  port,
  hostname: "0.0.0.0", // Listen on all network interfaces (required for K8s)
  fetch: async (request, server) => {
    // Sandbox preview proxy: matched by Host header. Runs *before* assets
    // and the Hono app so a `<handle>.preview.<base>` request never hits
    // studio's static-file handler (which would 404 on the dev server's
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
  // WebSocket handler — sandbox preview connections only.
  websocket: {
    open(ws) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.open(ws);
      }
    },
    message(ws, message) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.message(ws, message);
      }
    },
    close(ws) {
      if (isPreviewWsData(ws.data)) {
        previewWebSocketHandler.close(ws);
      }
    },
  },
  development: false,
});

const stopProfiling = startProfiling();

// Local mode: seed admin user + organization after server is listening
// This must run after Bun.serve() so that the org seed can fetch tools
// from the self MCP endpoint (http://localhost:PORT/mcp/self).
if (settings.localMode) {
  import("./auth/local-mode")
    .then(async ({ seedLocalMode, markSeedComplete, healLocalJwks }) => {
      try {
        // Recover pre-fix installs whose JWKS was encrypted under a now-lost
        // random secret; runs before the seed gate opens so the auto-login
        // (/local-session) path never races a stale key. A direct get-session
        // probe can still 500 once in the brief pre-heal window, exactly as it
        // did before this fix. See healLocalJwks() for the full rationale.
        const healed = await healLocalJwks();
        if (healed > 0) {
          console.log(
            `[local-mode] cleared ${healed} undecryptable JWKS key(s); Better Auth will generate a fresh one`,
          );
        }
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

/**
 * Hand off this executor's in-flight thread-gate gates so a live pod adopts
 * them, instead of leaving them PENDING on this (dying) executor forever.
 *
 * WHY THIS EXISTS. The thread-gate queue is `concurrency=1` per thread
 * partition; a `threadGateWorkflow` holds that slot the whole time it is
 * PENDING. When a rolling deploy replaces this pod mid-run, `DBOS.shutdown()`
 * just stops the executor and walks away — the in-flight gate is left PENDING
 * on a now-dead `executor_id`. Nothing re-adopts it: self-recovery only covers
 * an executor's OWN id (new pods have new ids), and the external Conductor is
 * observed NOT to recover gracefully-deregistered executors (their orphans sit
 * PENDING indefinitely). That stranded PENDING head blocks the partition, so
 * every later message on the thread piles up ENQUEUED and never runs — the
 * thread is bricked until someone cancels the head by hand.
 *
 * The fix: on the way out, flip our own in-flight gates PENDING → ENQUEUED
 * (`resumeWorkflows`, which preserves the DBOS journal and the queue partition
 * key). A live executor's queue poller then re-dispatches each gate and it
 * REPLAYS from the journal: the already-recorded `trackMessageStarted` and
 * `dispatchRunAndWait` steps return their cached outputs, so it resumes right
 * at `consumeRunProjection` — no work redone, no double dispatch, for the
 * overwhelming common case where dispatch had already completed. (Edge: if the
 * pod died mid-`dispatchRunAndWait`, replay re-runs it; the work-item publish
 * is idempotent on the persisted `runFenceToken`, so a redelivery collapses
 * rather than opening a second daemon run.)
 *
 * Runs AFTER `DBOS.shutdown()` on purpose: once this executor's queue poller is
 * stopped, a re-enqueued gate can only be claimed by a LIVE executor, so we
 * can't re-grab (and re-orphan) our own gates in a shutdown race. Uses a
 * standalone `DBOSClient` (its own sysdb connection) because studio's DBOS
 * executor is already torn down at this point.
 *
 * Best-effort: any failure is logged and swallowed so shutdown still completes.
 * Only covers GRACEFUL termination — a hard SIGKILL (OOM, node loss) skips this
 * handler, and those orphans still need Conductor recovery or a sweep.
 *
 * `executorId` MUST be the real runtime executor id (`DBOS.executorID`),
 * captured by the caller BEFORE `DBOS.shutdown()`. Two gotchas make this
 * non-obvious: (1) when a Conductor is configured (as in prod/stg) DBOS
 * IGNORES the `executorID` we pass to `setConfig` and substitutes a random
 * UUID (`dbos.js` "Always use a generated executor ID in Conductor"), so
 * `settings.podName` never matches the `executor_id` stored on our rows; and
 * (2) `DBOS.shutdown()` resets `DBOS.executorID` back to `'local'`, so reading
 * it after shutdown would filter on the wrong id. Filtering on the wrong id
 * silently matches zero gates and the handoff no-ops (the original bug).
 */
async function handOffInFlightThreadGates(executorId: string) {
  let client: Awaited<ReturnType<typeof DBOSClient.create>> | undefined;
  try {
    client = await DBOSClient.create({
      systemDatabaseUrl: withSslmode(
        settings.databaseUrl,
        settings.databasePgSsl,
      ),
      systemDatabaseSchemaName: "dbos",
    });
    const orphaned = await client.listWorkflows({
      status: "PENDING",
      queueName: THREAD_GATE_QUEUE,
      executorId,
      loadInput: false,
      loadOutput: false,
    });
    // Always log the count (even 0) so the handoff is observable — a silent
    // early-return is exactly what hid the executor-id filter bug the first time.
    if (orphaned.length === 0) {
      console.log(
        `[shutdown] no in-flight thread-gate gates to hand off (executor ${executorId})`,
      );
      return;
    }
    const ids = orphaned.map((w) => w.workflowID);
    await client.resumeWorkflows(ids, { queueName: THREAD_GATE_QUEUE });
    console.log(
      `[shutdown] re-enqueued ${ids.length} in-flight thread-gate gate(s) for re-adoption by a live executor (from ${executorId}):`,
      ids,
    );
  } catch (err) {
    console.error("[shutdown] thread-gate handoff failed:", err);
  } finally {
    await client?.destroy().catch(() => {});
  }
}

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);

  // Single source of truth: the chart's terminationGracePeriodSeconds is
  // injected as SHUTDOWN_GRACE_SECONDS. Force-exit a few seconds before SIGKILL
  // so the process always wins the race; drain fills most of the budget.
  const graceMs = Number(process.env.SHUTDOWN_GRACE_SECONDS ?? 60) * 1_000;
  const forceExitMs = Math.max(graceMs - 5_000, 10_000);

  const forceExitTimer = setTimeout(() => {
    console.error(`[shutdown] Timed out after ${forceExitMs}ms, forcing exit.`);
    process.exit(1);
  }, forceExitMs);
  forceExitTimer.unref?.();

  let exitCode = 0;
  try {
    stopProfiling();

    // 1. Mark as shutting down — readiness returns 503 immediately
    app.markShuttingDown();

    // 2. Keep serving while the load balancer stops routing to this pod.
    //    With the AWS NLB in ip-target mode, deregistration is driven by the
    //    LB controller observing the pod enter Terminating (this SIGTERM), not
    //    by the K8s Endpoints path — and it takes far longer than the old 2s to
    //    propagate. Closing the listener early leaves the NLB forwarding new
    //    connections to a dead socket -> CF 520 during rollout. Stay under the
    //    force-exit timer (derived from terminationGracePeriodSeconds above) so
    //    it never trips before drain completes.
    const drainMs = resolveShutdownDrainMs(
      settings.dispatchRole,
      forceExitMs,
      process.env.SHUTDOWN_DRAIN_MS,
    );
    await sleep(drainMs);

    // 3. Force-close connections (SSE streams are long-lived and would block
    //    graceful drain indefinitely).
    await server.stop(true);

    // Capture the REAL executor id before DBOS.shutdown() resets it to 'local'.
    // With a Conductor configured this is a random UUID (NOT settings.podName),
    // and it's what our workflow rows are stamped with. See
    // handOffInFlightThreadGates for why this matters.
    const executorId = DBOS.executorID;
    // Drain DBOS before app.shutdown closes studio's pg pool — in-flight steps use it.
    await DBOS.shutdown();
    // Re-enqueue our own in-flight thread-gate gates so a live pod adopts them
    // instead of stranding them PENDING on this dead executor (which bricks the
    // thread). Runs after DBOS.shutdown() so our stopped poller can't re-grab
    // them. See handOffInFlightThreadGates for the full rationale.
    await handOffInFlightThreadGates(executorId);
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
// accumulate zombies still holding the listen port.
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});
