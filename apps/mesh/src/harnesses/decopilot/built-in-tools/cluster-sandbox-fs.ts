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

import { createSandboxFsHooks } from "@decocms/sandbox/provider";
import type { StudioContext } from "@/core/studio-context";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { ensureSandbox } from "@/tools/sandbox/start";
import { removeSandboxMapEntry } from "@/tools/sandbox/sandbox-map";
import type { SandboxFsHooks } from "./vm-tools/sandbox-fs-hooks-types";

/**
 * Build the cluster flat fs hooks for a (virtualMcp, branch, user) tuple.
 *
 * Behavior-identical to the block formerly inline in `buildAllTools`: the
 * provider is resolved eagerly (it short-circuits on `ctx.sandboxPreference` /
 * `ctx.linkForCurrentRun` populated by dispatch-run, so no DB hit), while the
 * sandbox PROVISIONING stays lazy behind the memoized `ensureHandle` closure —
 * `ensureSandbox` only runs on the first VM-tool invocation. The
 * handle-resolution + auto-restart retry layer lives inside
 * `createSandboxFsHooks`, so the VM tools never touch `SandboxProvider`.
 */
export async function buildClusterSandboxFs(
  ctx: StudioContext,
  vm: { virtualMcpId: string; branch: string; userId: string },
): Promise<SandboxFsHooks> {
  // `dispatch-run` already populated `ctx.sandboxPreference` /
  // `ctx.linkForCurrentRun` from the resolved `DispatchTarget`, so the resolver
  // short-circuits on those ctx hints without reading sandboxMap — no DB hit on
  // the decopilot hot path. The same `kind` flows into `ensureSandbox` below so
  // `runner` and the provisioned handle come from the same provider.
  const { provider: runner, kind: providerKind } = await resolveSandboxProvider(
    ctx,
    {
      userId: vm.userId,
      branch: vm.branch,
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
  const invalidateHandle = async () => {
    // Capture before clearing — we need the dead handle to flush the captured
    // runner's cache below.
    const lastHandlePromise = cached;
    cached = null;
    if (!canAutoRestart) return;
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
