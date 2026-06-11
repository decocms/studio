/**
 * Pull-transport cluster connection entry point (Phase D, spec §3.1).
 *
 * Instead of a persistent WebSocket, runs a long-poll work loop that pulls
 * work items from `GET /api/links/work` and dispatches each item to the
 * local sandbox via `handleLocalDispatch`, plus the proxy poll loop
 * (`runProxyPollLoop`) for sandbox control/events/vm-tools.
 *
 * This is the ONLY daemon transport — the reverse-WS (`connectToCluster`) was
 * deleted in Phase C-bis S8. `index.ts` calls this unconditionally.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 *
 * The daemon is user-scoped; there is no startup org. The org slug travels per
 * work item (`item.orgSlug`) and is used only at ingest time.
 */

import { runWorkPollLoop } from "./work-poller";
import { runControlPollLoop } from "./control-poller";
import { runProxyPollLoop } from "./proxy-poller";
import * as runAbortRegistry from "./run-abort-registry";
import * as proxyAbortRegistry from "./proxy-abort-registry";
import {
  handleLocalDispatch,
  relayWorkItemFailure,
} from "./handle-local-dispatch";
import type { ClusterConnectionHandle } from "./types";
import type { ControlHandler } from "./control-handler";
import type { DesktopSandboxProvider } from "./user-desktop-provider";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";
import type { Outbox } from "./outbox";

export interface ClusterConnectionPullInput {
  /**
   * Cluster public base URL, e.g. "https://studio.deco.cx".
   * Used as both the work-poll base URL and the ingest POST base URL.
   */
  clusterBaseUrl: string;
  /**
   * Bearer token resolver. Called before each poll and before each ingest
   * POST so a refreshed token reaches every request (mirrors the WS path's
   * per-(re)connect `getAccessToken`). Rejection with `{ fatal: true }` is
   * NOT handled here — token errors are logged and retried by the work-poll
   * backoff.
   */
  getAccessToken: () => Promise<string>;
  /**
   * Daemon capabilities to advertise on every work-poll request
   * (x-link-capabilities header). The server mints the presence claim with
   * these so resolveDispatchTarget can route pull-transport threads correctly.
   * Mirrors the `capabilities` field in the WS hello frame.
   */
  capabilities?: import("../links/protocol").Capability[];
  /**
   * Stable machine identifier forwarded as x-link-machine-id.
   * Mirrors the `machineId` field in the WS hello frame.
   */
  machineId?: string;
  /**
   * Daemon CLI version string forwarded as x-link-cli-version.
   * Mirrors the `cliVersion` field in the WS hello frame.
   */
  cliVersion?: string;
  /**
   * Local preview server port forwarded as x-link-preview-port.
   * Mirrors the `previewPort` field in the WS hello frame.
   */
  previewPort?: number;
  /**
   * Desktop sandbox provider — used to ensure the sandbox is running before
   * dispatching a work item.
   *
   * When `WorkItem.sandbox` is present (Phase D fix), `ensureSandbox` is
   * called with the full provisioning config (handle, repo clone URL, workload
   * runtime, offload allowlist) so the daemon can spawn cold. When absent
   * (back-compat: work items from before the Phase D fix, or non-CLI harnesses),
   * falls back to `ensureSandbox({ handle })` which reuses a running sandbox
   * but cannot spawn one cold.
   */
  provider: DesktopSandboxProvider;
  /**
   * In-process control handler — reverse-proxies `/_sandbox/<handle>/*` to each
   * spawned sandbox's local port. Required for the pull reverse-proxy channel
   * (Phase C-bis S2): `runProxyPollLoop` calls `controlHandler.handleStream`
   * for every cluster→daemon proxy request (vm-events SSE, control RPC,
   * vm-tools). Built once in index.ts and shared with the WS path. Optional so
   * pre-C-bis callers / tests that don't exercise the proxy loop compile; when
   * omitted the proxy loop is not started (DORMANT — the WS path still carries
   * this traffic until the S6 cutover).
   */
  controlHandler?: ControlHandler;
  /**
   * Injected fetch implementation. Defaults to global `fetch`.
   * Tests inject a stub here.
   */
  fetchImpl?: typeof fetch;
  /** Long-poll timeout in seconds. Default 29. */
  pollTimeoutSecs?: number;
  /** Called once the pull loop has started (analogous to `onConnected` in the WS path). */
  onConnected?: () => void;
  /**
   * Durable chunk-relay outbox (spec §5.1). Opened once per daemon in index.ts
   * and shared across every dispatch; forwarded to `handleLocalDispatch` so the
   * relay survives a daemon restart mid-run.
   */
  outbox: Outbox;
}

/**
 * Derive the sandbox handle from the work item.
 *
 * Priority:
 *   1. `item.sandbox.handle` — the authoritative handle resolved cluster-side
 *      by `computeDesktopSandboxHandle` (the pure handle derivation in
 *      `pullDispatch`). Always prefer this.
 *   2. Fallback derivation from `harnessInput.agent.id` + `harnessInput.branch`
 *      (legacy behavior for work items published before the `sandbox` field
 *      was added, or when sandbox config resolution failed).
 *
 * Mirrors the cluster's `computeHandle` pattern: `agent-<agentId>[-<branch>]`.
 */
function deriveHandle(item: WorkItem): string {
  if (item.sandbox?.handle) return item.sandbox.handle;
  const input = item.harnessInput as Record<string, unknown>;
  const agent = input.agent as Record<string, unknown> | undefined;
  const agentId =
    typeof agent?.id === "string" && agent.id.length > 0 ? agent.id : "unknown";
  const branch =
    typeof input.branch === "string" && input.branch.length > 0
      ? input.branch
      : null;
  return branch ? `agent-${agentId}-${branch}` : `agent-${agentId}`;
}

async function relayClaimedWorkItemFailure(
  input: ClusterConnectionPullInput,
  signal: AbortSignal,
  item: WorkItem,
  code: string,
  message: string,
): Promise<void> {
  await relayWorkItemFailure(
    item,
    {
      clusterBaseUrl: input.clusterBaseUrl,
      getClusterToken: input.getAccessToken,
      fetchImpl: input.fetchImpl,
      signal,
    },
    code,
    message,
  );
}

/**
 * Pull-transport cluster connection.
 *
 * Runs `runWorkPollLoop` with an `onWork` handler that per work item:
 *   (a) calls `provider.ensureSandbox(...)` to get/start the local sandbox,
 *   (b) retrieves the daemon token for the sandbox,
 *   (c) calls `handleLocalDispatch` to relay the SSE to the cluster ingest.
 *
 * Per-item errors are caught and logged without killing the loop (the work
 * poll loop itself also swallows `onWork` throws — double-guarded).
 *
 * Returns a `ClusterConnectionHandle` whose `.close()` aborts the loop and
 * whose `.closed` resolves when the loop exits.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
export async function connectToClusterPull(
  input: ClusterConnectionPullInput,
): Promise<ClusterConnectionHandle> {
  const ac = new AbortController();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  input.onConnected?.();
  console.log(
    `[cluster-connection-pull] starting pull-transport loop cluster=${input.clusterBaseUrl}`,
  );

  const workPollDone = runWorkPollLoop({
    baseUrl: input.clusterBaseUrl,
    getAccessToken: input.getAccessToken,
    signal: ac.signal,
    fetchImpl: input.fetchImpl,
    pollTimeoutSecs: input.pollTimeoutSecs,
    capabilities: input.capabilities,
    machineId: input.machineId,
    cliVersion: input.cliVersion,
    previewPort: input.previewPort,
    onWork: async (item: WorkItem) => {
      const handle = deriveHandle(item);
      console.log(
        `[cluster-connection-pull] work item runId=${item.runId} threadId=${item.threadId} handle=${handle}`,
      );

      // Claim-time credential-expiry check (spec §Hard-Break-Mechanics / Q20).
      // Work items carry a 1h MCP bearer; if the item sat in the queue too long
      // and the bearer expired before we claimed it, fail the run cleanly via
      // the relay channel rather than letting the sandbox attempt auth with a
      // stale token.
      // The item is already ACKed server-side (ACK-on-delivery at the HTTP
      // layer) — we only decide whether to dispatch or relay a terminal failure.
      // If relayWorkItemFailure itself throws (cluster unreachable), we re-throw
      // so the work-poll loop logs it as "onWork threw (swallowed)" and continues
      // to the next item. The max_age TTL on the JetStream stream (1h) is the
      // backstop that evicts undelivered stale items before a daemon ever sees
      // them; this check guards items that were claimed just at the boundary.
      const mcp = (item.harnessInput as { mcp?: { expiresAt?: number } }).mcp;
      if (typeof mcp?.expiresAt === "number" && mcp.expiresAt <= Date.now()) {
        console.warn(
          `[cluster-connection-pull] work item expired at claim time — relaying failure runId=${item.runId}`,
        );
        await relayWorkItemFailure(
          item,
          {
            clusterBaseUrl: input.clusterBaseUrl,
            getClusterToken: input.getAccessToken,
            fetchImpl: input.fetchImpl,
            signal: ac.signal,
          },
          "work_item_expired",
          "work item credentials expired before the daemon claimed it — send the message again",
        );
        return;
      }

      // (a) Ensure the sandbox is running.
      // Use the full sandbox config from the work item when available so the
      // daemon can spawn cold (repo clone + workload runtime configured).
      // Falls back to `{ handle }` only for back-compat with work items
      // published before the `sandbox` field was added.
      const ensureInput = item.sandbox
        ? {
            handle,
            ...(item.sandbox.repo ? { repo: item.sandbox.repo } : {}),
            ...(item.sandbox.workload
              ? { workload: item.sandbox.workload }
              : {}),
            ...(item.sandbox.offloadAllowedHosts !== undefined
              ? { offloadAllowedHosts: item.sandbox.offloadAllowedHosts }
              : {}),
            ...(item.sandbox.offloadAllowSameHostDev !== undefined
              ? {
                  offloadAllowSameHostDev: item.sandbox.offloadAllowSameHostDev,
                }
              : {}),
            ...(item.sandbox.orgFsConfigJson !== undefined
              ? { orgFsConfigJson: item.sandbox.orgFsConfigJson }
              : {}),
          }
        : { handle };
      let sandboxApiUrl: string;
      let sandboxDaemonToken: string;
      try {
        const sandbox = await input.provider.ensureSandbox(ensureInput);
        sandboxApiUrl = sandbox.sandboxApiUrl;
        // Get the daemon token from the provider (ensureSandbox return type
        // does not include daemonToken — we retrieve it separately).
        sandboxDaemonToken =
          input.provider.getDaemonToken(handle) ??
          (() => {
            throw new Error(
              `[cluster-connection-pull] no daemon token for handle=${handle}`,
            );
          })();
      } catch (err) {
        console.error(
          `[cluster-connection-pull] ensureSandbox failed handle=${handle} runId=${item.runId}:`,
          err,
        );
        await relayClaimedWorkItemFailure(
          input,
          ac.signal,
          item,
          "sandbox_start_failed",
          "desktop sandbox failed to start for this run; send the message again",
        );
        return;
      }

      // (b) + (c) Relay via handleLocalDispatch.
      // acquireDispatch pins the sandbox for the full duration of the relay so
      // the LRU eviction logic skips it (activeDispatchCount > 0). Released in
      // `finally` to guarantee the counter is always decremented.
      // Note: an old-shape (pre-v2) work item that passes this point will fail
      // the sandbox-daemon's `harnessStreamInputSchema` parse → `bad_input` SSE
      // error → relay forwards it → kernel marks the run failed. No special
      // handling needed here; the relay is the clean-failure path for stale-shape
      // items too.
      const releaseDispatch = input.provider.acquireDispatch(handle);
      // Phase C: register a per-run AbortController so the control-poll loop
      // can abort this specific dispatch when the cluster sends a cancel frame.
      // AbortSignal.any([ac.signal, runAc.signal]) fires when EITHER the
      // loop-wide signal (close()) OR the per-run cancel signal fires.
      // AbortSignal.any is available in Bun 1.0+ (verified: Bun 1.3.14).
      const runAc = runAbortRegistry.register(item.runId);
      try {
        await handleLocalDispatch(item, {
          sandboxDispatchUrl: sandboxApiUrl,
          sandboxDaemonToken,
          clusterBaseUrl: input.clusterBaseUrl,
          getClusterToken: input.getAccessToken,
          fetchImpl: input.fetchImpl,
          signal: AbortSignal.any([ac.signal, runAc.signal]),
          outbox: input.outbox,
        });
      } catch (err) {
        console.error(
          `[cluster-connection-pull] local dispatch failed handle=${handle} runId=${item.runId}:`,
          err,
        );
        await relayClaimedWorkItemFailure(
          input,
          ac.signal,
          item,
          "local_dispatch_failed",
          "desktop harness dispatch failed before producing a terminal result; send the message again",
        );
        return;
      } finally {
        runAbortRegistry.unregister(item.runId);
        releaseDispatch();
      }

      console.log(
        `[cluster-connection-pull] dispatch complete runId=${item.runId}`,
      );
    },
  });

  // Phase C: start the control-poll loop concurrently under the same loop-wide
  // AbortController so it is torn down by close() together with the work loop.
  // onCancel aborts the per-run AbortController registered in runAbortRegistry,
  // which in turn fires AbortSignal.any([ac.signal, runAc.signal]) inside onWork.
  const controlPollDone = runControlPollLoop({
    baseUrl: input.clusterBaseUrl,
    getAccessToken: input.getAccessToken,
    signal: ac.signal,
    fetchImpl: input.fetchImpl,
    pollTimeoutSecs: input.pollTimeoutSecs,
    onCancel: (runId) => {
      runAbortRegistry.abort(runId);
    },
    // Phase C-bis S2: a `cancel_req` control frame aborts an in-flight pull
    // reverse-proxy REQUEST (vm-events SSE / vm-tool) by reqId. Aborting frees
    // the daemon SSE slot via handleStream's release (landmine #3). The daemon
    // is outbound-only, so this control channel is the only inbound cancel path.
    onCancelReq: (reqId) => {
      proxyAbortRegistry.abort(reqId);
    },
  });

  // Phase C-bis S2: the pull reverse-proxy loop (continuous-overlap GETs +
  // detached per-reqId duplex replies). Only started when a controlHandler is
  // supplied (index.ts builds it; pre-C-bis callers / pure tests may omit it,
  // leaving the proxy traffic on the WS path until the S6 cutover).
  const proxyPollDone = input.controlHandler
    ? runProxyPollLoop({
        baseUrl: input.clusterBaseUrl,
        getAccessToken: input.getAccessToken,
        controlHandler: input.controlHandler,
        signal: ac.signal,
        fetchImpl: input.fetchImpl,
      })
    : Promise.resolve();

  // Resolve `closed` when ALL active loops have exited. We use a latch so that
  // whichever loop finishes last (or first) drives the final resolution. All
  // loops are aborted by ac.abort() inside close(), so they settle promptly.
  // (proxyPollDone is an already-resolved Promise when no controlHandler was
  // supplied, so the count still works.)
  const loopCount = 3;
  let settled = 0;
  const settleOnce = (err?: unknown) => {
    if (err) {
      console.error(
        "[cluster-connection-pull] poll loop exited with error:",
        err,
      );
    }
    settled++;
    if (settled >= loopCount) resolveClosed();
  };
  void workPollDone.then(() => settleOnce(), settleOnce);
  void controlPollDone.then(() => settleOnce(), settleOnce);
  void proxyPollDone.then(() => settleOnce(), settleOnce);

  return {
    async close() {
      console.log("[cluster-connection-pull] closing (aborting poll loops)");
      ac.abort();
      await closed;
    },
    closed,
  };
}
