/**
 * CLUSTER sandbox-fs glue (option-b sandbox decoupling).
 *
 * Isolates the `@decocms/sandbox` builder + the cluster sandbox-provisioning
 * `@/` imports that the portable built-in tools must NOT carry. The harness VM
 * tools consume the flat `SandboxFsHooks` returned here and never see
 * `SandboxProvider` (spec §4.3).
 *
 * ASSEMBLER-GLUE: this module stays `@/`- and `@decocms/sandbox`-coupled and is
 * slated to relocate into the cluster assembler (`harness-deps.ts`) in the
 * package-move phase (spec Phase 5). The portable consumer
 * (`built-in-tools/index.ts`) imports only this relative module — no
 * `@decocms/sandbox`.
 */

import {
  createSandboxFsHooks,
  type SandboxProvider,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";
import type { StudioContext } from "@/core/studio-context";
import { mintMcpEndpoint } from "@/mcp-clients/virtual-mcp/mint-endpoint";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { ensureSandbox } from "@/tools/sandbox/start";
import { removeSandboxMapEntry } from "@/tools/sandbox/sandbox-map";
import type { SandboxFsHooks } from "@decocms/harness/decopilot/built-in-tools/vm-tools/sandbox-fs-hooks-types";

/**
 * Fire-and-forget: mint the run's virtual-MCP endpoint and have the daemon
 * materialize the tool catalog + endpoint file under `<repo>/.deco/tools/` so
 * agents can script tool calls (see the tool-scripting skill). Hosted
 * harnesses drive the daemon via fs/exec routes without a /dispatch envelope,
 * so the daemon's own onDispatchMcp hook never fires on this path — this call
 * is its cloud-side counterpart. Minted here (not passed in) because
 * decopilot's stream input carries the in-process sentinel `mcp.url === ""`,
 * and minting lazily keys the endpoint's TTL to the actual provisioning.
 * Failures only warn: the run must never depend on it.
 */
async function syncToolsCatalog(
  ctx: StudioContext,
  runner: SandboxProvider,
  handle: string,
  vm: { virtualMcpId: string; providerKind: SandboxProviderKind },
): Promise<void> {
  // A tool-scripting endpoint is a user-bound API key. Persisting it inside a
  // shared workspace would let another collaborator act as the user who
  // happened to sync last. Shared hosted sandboxes therefore keep tool calls
  // in the outer harness and do not materialize user credentials on disk.
  if (vm.providerKind === "agent-sandbox") {
    return;
  }
  try {
    const organization = ctx.organization;
    if (!organization) return;
    const mcp = await mintMcpEndpoint(
      ctx,
      vm.virtualMcpId,
      organization,
      "tool-scripting",
      vm.providerKind,
    );
    const res = await runner.proxyDaemonRequest(
      handle,
      "/_sandbox/tools/sync",
      {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify(mcp),
      },
    );
    if (!res.ok) {
      console.warn(
        "[cluster-sandbox-fs] tools/sync failed",
        res.status,
        await res.text().catch(() => ""),
      );
    }
  } catch (err) {
    console.warn("[cluster-sandbox-fs] tools/sync failed", err);
  }
}

/**
 * Build the cluster flat fs hooks for a (virtualMcp, branch, user) tuple.
 *
 * Behavior-identical to the block formerly inline in `buildAllTools`: the
 * provider is resolved eagerly (it short-circuits on `ctx.sandboxPreference`
 * populated by dispatch-run, so no DB hit), while the
 * sandbox PROVISIONING stays lazy behind the memoized `ensureHandle` closure —
 * `ensureSandbox` only runs on the first VM-tool invocation. The
 * handle-resolution + auto-restart retry layer lives inside
 * `createSandboxFsHooks`, so the VM tools never touch `SandboxProvider`.
 */
export async function buildClusterSandboxFs(
  ctx: StudioContext,
  vm: {
    virtualMcpId: string;
    branch: string;
    userId: string;
    /** When true, tools/sync fires after each (re)provisioning — see
     *  `syncToolsCatalog`. */
    syncTools?: boolean;
  },
): Promise<SandboxFsHooks> {
  // `dispatch-run` already populated `ctx.sandboxPreference` from the resolved
  // `DispatchTarget`, so the resolver short-circuits on that ctx hint without
  // reading sandboxMap — no DB hit on the decopilot hot path. The same `kind`
  // flows into `ensureSandbox` below so `runner` and the provisioned handle come
  // from the same provider.
  const { provider: runner, kind: providerKind } = await resolveSandboxProvider(
    ctx,
    {
      userId: vm.userId,
      branch: vm.branch,
      virtualMcpId: vm.virtualMcpId,
      virtualMcpMetadata: null,
    },
  );
  let cached: Promise<string> | null = null;
  const ensureHandle = () => {
    if (!cached) {
      cached = ensureSandbox(
        {
          virtualMcpId: vm.virtualMcpId,
          branch: vm.branch,
          sandboxProviderKind: providerKind,
        },
        ctx,
      ).then((entry) => entry.sandboxHandle);
      // Reset on failure so the next tool call retries instead of
      // permanently caching a rejected promise.
      cached.catch(() => {
        cached = null;
      });
      // Attached to every fresh `cached` (not once per build) so an
      // auto-restarted sandbox — whose new workspace lost the catalog —
      // gets re-synced too. Provisioning stays lazy: this only fires when
      // a VM tool actually ensures the sandbox.
      if (vm.syncTools) {
        void cached
          .then((handle) =>
            syncToolsCatalog(ctx, runner, handle, {
              virtualMcpId: vm.virtualMcpId,
              providerKind,
            }),
          )
          .catch(() => {});
      }
    }
    return cached;
  };
  // Ephemeral agents have no restart button, so the call layer auto-restarts on
  // proxy failure. user-desktop sandboxes also auto-restart: the local daemon
  // can drop/relink under the user at any time, and the iframe + ingress
  // already render the reconnecting state, so a dead-daemon proxy error should
  // reap + respawn rather than surface a sticky failure.
  const canAutoRestart =
    vm.branch === "ephemeral" || providerKind === "user-desktop";
  const invalidateHandle = async (opts?: { force?: boolean }) => {
    // Capture before clearing — we need the dead handle to flush the captured
    // runner's cache below.
    const lastHandlePromise = cached;
    cached = null;
    // `force` (set by the retry layer when the daemon reported the sandbox is
    // provably GONE — 404) reaps + respawns even for non-auto-restart branches:
    // a reaped sandbox has no working tree left to preserve, so recovering an
    // in-flight run beats surfacing a sticky failure after infra dropped it.
    if (!canAutoRestart && !opts?.force) return;
    // Reap the vmMap entry so the next `ensureSandbox` provisions fresh rather
    // than returning the dead vmId from the fast path.
    try {
      await removeSandboxMapEntry(
        ctx.storage.virtualMcps,
        vm.virtualMcpId,
        vm.userId,
        vm.userId,
        vm.branch,
        providerKind,
      );
    } catch (err) {
      console.warn("[cluster-sandbox-fs] failed to reap vmMap entry", err);
    }
    // Flush the captured runner's in-process cache + state-store row.
    // `ensureSandbox` constructs its own provider instance for the respawn, so
    // without this the captured `runner` (used for proxy calls) would keep
    // serving the dead URL out of its records map on the retry.
    if (lastHandlePromise && typeof runner.forgetHandle === "function") {
      try {
        const lastHandle = await lastHandlePromise;
        if (providerKind === "agent-sandbox") {
          const virtualMcp = await ctx.storage.virtualMcps.findById(
            vm.virtualMcpId,
          );
          if (virtualMcp) {
            const locator = {
              organizationId: virtualMcp.organization_id,
              virtualMcpId: vm.virtualMcpId,
              branch: vm.branch,
            };
            const reaping = await ctx.storage.agentSandboxSessions.withLock(
              locator,
              (sessions) => sessions.beginReap(locator, lastHandle),
            );
            if (!reaping) return;
            try {
              await runner.forgetHandle(lastHandle);
            } finally {
              await ctx.storage.agentSandboxSessions.withLock(
                locator,
                (sessions) =>
                  sessions.completeReap(
                    locator,
                    reaping.generation,
                    lastHandle,
                  ),
              );
            }
            return;
          }
        }
        await runner.forgetHandle(lastHandle);
      } catch (err) {
        console.warn("[cluster-sandbox-fs] forgetHandle failed", err);
      }
    }
  };
  return createSandboxFsHooks(runner, {
    ensureHandle,
    invalidateHandle,
    canAutoRestart,
  });
}

/**
 * Probe whether the attached sandbox is a Deco CMS site — i.e. its repo
 * checkout contains a `.deco/` directory. Gates the CMS-content rules block in
 * the coding-workspace prompt (see `DECO_CMS_CONTENT_RULES`) so non-deco repos
 * don't carry it as dead weight.
 *
 * Runs `test -d .deco` from the daemon's default bash cwd (the repo root). It
 * reuses `buildClusterSandboxFs`, so the sandbox `ensureSandbox` resolution is
 * memoized: on an already-running sandbox (the common case for an active coding
 * thread) this is a cheap proxied bash call; on the first turn it provisions
 * the same sandbox the VM file tools will use moments later.
 *
 * Fails OPEN (returns `true`) on any error: an indeterminate probe must not
 * strip the guardrails from a genuine deco site, whose whole failure mode is
 * silent data loss (editing `*.gen.*` instead of `.deco/blocks/`).
 */
export async function sandboxIsDecoSite(
  ctx: StudioContext,
  vm: { virtualMcpId: string; branch: string; userId: string },
): Promise<boolean> {
  try {
    const fs = await buildClusterSandboxFs(ctx, vm);
    const { stdout } = await fs.onBash("test -d .deco && echo __DECO_SITE__");
    return stdout.includes("__DECO_SITE__");
  } catch (err) {
    console.warn(
      "[cluster-sandbox-fs] .deco probe failed; assuming deco site",
      err,
    );
    return true;
  }
}
