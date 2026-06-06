/**
 * Pull-transport cluster connection entry point (Phase D, spec §3.1).
 *
 * Instead of a persistent WebSocket, runs a long-poll work loop that pulls
 * work items from `GET /api/:org/links/work` and dispatches each item to the
 * local sandbox via `handleLocalDispatch`.
 *
 * The WS `connectToCluster` in `cluster-connection.ts` is untouched — it
 * remains active for WS threads. This function is the parallel entry point
 * gated on `LINK_TRANSPORT_MODE=pull` in `index.ts`.
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
import { handleLocalDispatch } from "./handle-local-dispatch";
import type { ClusterConnectionHandle } from "./cluster-connection";
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
   * ⚠️ SANDBOX CONFIG NOTE: `WorkItem.harnessInput` carries `agent.id` and
   * `branch` but NOT the full sandbox config (repo clone URL, workload runtime,
   * etc.). The WS path resolves this cluster-side via
   * `resolveRemoteCliSandboxHandle`; the pull path currently calls
   * `ensureSandbox` with only `handle` (derived from agent/branch) and no
   * `repo`/`workload`. This means `ensureSandbox` will reuse an existing
   * sandbox if one is already running, but cannot spawn a fresh sandbox from
   * scratch without the repo config.
   *
   * TODO(Phase D / Phase B follow-up): include repo + workload in the work
   * item payload so the pull path can spawn sandboxes end-to-end without a
   * prior WS-path ensure. Track in the Phase B work-item schema extension.
   */
  provider: DesktopSandboxProvider;
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
 * Mirrors the cluster's `computeHandle` pattern: `agent-<agentId>[-<branch>]`.
 * Falls back gracefully when agent/branch fields are absent.
 */
function deriveHandle(item: WorkItem): string {
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
      // ⚠️ SANDBOX CONFIG NOTE: we can only pass `handle` here — repo/workload
      // are not in the work item yet (see module header TODO). If a sandbox is
      // already running for this handle, ensureSandbox returns immediately.
      // If no sandbox exists, ensureSandbox will attempt to spawn without repo
      // config, which may fail for fresh sandboxes. This is a known limitation
      // flagged as a Phase B/D follow-up.
      let sandboxApiUrl: string;
      let sandboxDaemonToken: string;
      try {
        const sandbox = await input.provider.ensureSandbox({ handle });
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
      const releaseDispatch = input.provider.acquireDispatch(handle);
      try {
        await handleLocalDispatch(item, {
          sandboxDispatchUrl: sandboxApiUrl,
          sandboxDaemonToken,
          clusterBaseUrl: input.clusterBaseUrl,
          orgSlug: input.orgSlug,
          getClusterToken: input.getAccessToken,
          fetchImpl: input.fetchImpl,
          signal: ac.signal,
        });
      } finally {
        releaseDispatch();
      }

      console.log(
        `[cluster-connection-pull] dispatch complete runId=${item.runId}`,
      );
    },
  });

  // Resolve `closed` when the poll loop exits (either via abort or fatal error).
  void workPollDone.then(resolveClosed, (err) => {
    console.error(
      "[cluster-connection-pull] work poll loop exited with error:",
      err,
    );
    resolveClosed();
  });

  // TODO(Phase C): add holdControlPollLoop() here for cancel/HITL frames.
  // Example (Phase C stub):
  //   const controlPollDone = holdControlPollLoop({ ... });
  //   void controlPollDone.then(resolveClosed, resolveClosed);

  return {
    async close() {
      console.log("[cluster-connection-pull] closing (aborting poll loop)");
      ac.abort();
      await closed;
    },
    closed,
  };
}
