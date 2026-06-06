/**
 * Pull-transport cluster connection entry point (Phase D, spec §3.1).
 *
 * Instead of a persistent WebSocket, runs a long-poll work loop that pulls
 * work items from `GET /api/:org/links/work` and dispatches each item to the
 * local sandbox via `handleLocalDispatch`, plus the proxy poll loop
 * (`runProxyPollLoop`) for sandbox control/events/vm-tools.
 *
 * This is the ONLY daemon transport — the reverse-WS (`connectToCluster`) was
 * deleted in Phase C-bis S8. `index.ts` calls this unconditionally.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 *
 * ORG DISCOVERY NOTE:
 * The daemon links a user who may span multiple orgs. The pull loop requires
 * a single org slug for the `/api/:org/links/work` endpoint. Currently `orgSlug`
 * must be supplied by the caller (sourced from `DECO_ORG_SLUG` env var or from
 * `StartLinkDaemonOptions.orgSlug`). Multi-org polling is a follow-up — for now
 * a single primary org is used.
 *
 * TODO(Phase D follow-up): multi-org polling — run one `runWorkPollLoop` per org
 * if the daemon is linked against multiple orgs.
 */

import { runWorkPollLoop } from "./work-poller";
import { runControlPollLoop } from "./control-poller";
import { runProxyPollLoop } from "./proxy-poller";
import * as runAbortRegistry from "./run-abort-registry";
import * as proxyAbortRegistry from "./proxy-abort-registry";
import { handleLocalDispatch } from "./handle-local-dispatch";
import type { ClusterConnectionHandle } from "./types";
import type { ControlHandler } from "./control-handler";
import type { DesktopSandboxProvider } from "./user-desktop-provider";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";

export interface ClusterConnectionPullInput {
  /**
   * Cluster public base URL, e.g. "https://studio.deco.cx".
   * Used as both the work-poll base URL and the ingest POST base URL.
   */
  clusterBaseUrl: string;
  /**
   * Org SLUG for the org-scoped `/api/:org/links/work` endpoint and the
   * ingest POST path. MUST be the slug, not the UUID orgId.
   *
   * NOTE: the daemon currently supports a single primary org for the pull
   * loop. Multi-org polling is a follow-up (see module header).
   */
  orgSlug: string;
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
}

/**
 * Derive the sandbox handle from the work item.
 *
 * Priority:
 *   1. `item.sandbox.handle` — the authoritative handle resolved cluster-side
 *      by `resolveRemoteCliSandboxHandle` (Phase D fix). Always prefer this.
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
  if (!input.orgSlug)
    throw new Error("connectToClusterPull: orgSlug is required");

  const ac = new AbortController();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  input.onConnected?.();
  console.log(
    `[cluster-connection-pull] starting pull-transport loop org=${input.orgSlug} cluster=${input.clusterBaseUrl}`,
  );

  const workPollDone = runWorkPollLoop({
    baseUrl: input.clusterBaseUrl,
    orgSlug: input.orgSlug,
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
        // Re-throw so the work-poll loop logs it as "onWork threw (swallowed)"
        // and continues to the next item.
        throw err;
      }

      // (b) + (c) Relay via handleLocalDispatch.
      // acquireDispatch pins the sandbox for the full duration of the relay so
      // the LRU eviction logic skips it (activeDispatchCount > 0). Released in
      // `finally` to guarantee the counter is always decremented.
      //
      // Prefer `item.orgSlug` (resolved cluster-side at pullDispatch time) over
      // the daemon's configured `input.orgSlug` — the work item's slug is
      // authoritative when present, avoiding reliance on DECO_ORG_SLUG env.
      const effectiveOrgSlug = item.orgSlug ?? input.orgSlug;
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
          orgSlug: effectiveOrgSlug,
          getClusterToken: input.getAccessToken,
          fetchImpl: input.fetchImpl,
          signal: AbortSignal.any([ac.signal, runAc.signal]),
        });
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
    orgSlug: input.orgSlug,
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
        orgSlug: input.orgSlug,
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
