/**
 * Agent-sandbox filesystem glue.
 *
 * Isolates the `@decocms/sandbox` builder + the hosted sandbox-provisioning
 * `@/` imports that the portable built-in tools must NOT carry. The harness VM
 * tools consume the flat `SandboxFsHooks` returned here and never see the
 * hosted provider (spec §4.3).
 *
 * ASSEMBLER-GLUE: this module stays `@/`- and `@decocms/sandbox`-coupled and is
 * slated to relocate into the hosted assembler (`harness-deps.ts`) in the
 * package-move phase (spec Phase 5). The portable consumer
 * (`built-in-tools/index.ts`) imports only this relative module — no
 * `@decocms/sandbox`.
 */

import { createSandboxFsHooks } from "@decocms/sandbox/provider";
import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import type { StudioContext } from "@/core/studio-context";
import { mintMcpEndpoint } from "@/mcp-clients/virtual-mcp/mint-endpoint";
import { getAgentSandboxProvider } from "@/sandbox/lifecycle";
import { removeAgentSandboxRecords } from "@/tools/sandbox/agent-sandbox-record";
import { resolveSandboxUserId } from "@/tools/sandbox/thread-repo";
import { ensureSandbox } from "@/tools/sandbox/start";
import type { SandboxFsHooks } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/sandbox-fs-hooks-types";

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
  runner: AgentSandboxProvider,
  handle: string,
  vm: { virtualMcpId: string },
): Promise<void> {
  try {
    const organization = ctx.organization;
    if (!organization) return;
    const mcp = await mintMcpEndpoint(
      ctx,
      vm.virtualMcpId,
      organization,
      "tool-scripting",
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
        "[agent-sandbox-fs] tools/sync failed",
        res.status,
        await res.text().catch(() => ""),
      );
    }
  } catch (err) {
    console.warn("[agent-sandbox-fs] tools/sync failed", err);
  }
}

/**
 * Build the hosted agent-sandbox flat fs hooks for a
 * (virtualMcp, branch, user) tuple.
 *
 * The single hosted provider is resolved eagerly, while sandbox provisioning
 * stays lazy behind the memoized `ensureHandle` closure — `ensureSandbox` only
 * runs on the first VM-tool invocation. The handle-resolution + auto-restart
 * retry layer lives inside `createSandboxFsHooks`, so the VM tools never touch
 * the hosted provider.
 */
export async function buildAgentSandboxFs(
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
  const runner = await getAgentSandboxProvider(ctx);
  let cached: Promise<string> | null = null;
  const ensureHandle = () => {
    if (!cached) {
      cached = ensureSandbox(
        {
          virtualMcpId: vm.virtualMcpId,
          branch: vm.branch,
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
            }),
          )
          .catch(() => {});
      }
    }
    return cached;
  };
  // Ephemeral agents have no restart button, so the call layer auto-restarts on
  // proxy failure.
  const canAutoRestart = vm.branch === "ephemeral";
  const invalidateHandle = async (opts?: { force?: boolean }) => {
    cached = null;
    // `force` (set by the retry layer when the daemon reported the sandbox is
    // provably GONE — 404) reaps + respawns even for non-auto-restart branches:
    // a reaped sandbox has no working tree left to preserve, so recovering an
    // in-flight run beats surfacing a sticky failure after infra dropped it.
    if (!canAutoRestart && !opts?.force) return;
    // Reap the canonical record so the next `ensureSandbox` provisions fresh
    // rather than returning the dead handle from the fast path. Thread-scoped
    // sandboxes are owned by the thread creator, not necessarily the caller.
    try {
      const sandboxUserId = await resolveSandboxUserId(
        ctx,
        vm.branch,
        vm.userId,
        vm.virtualMcpId,
      );
      if (!sandboxUserId) throw new Error("Thread not found for Virtual MCP");
      await removeAgentSandboxRecords({
        ctx,
        virtualMcpId: vm.virtualMcpId,
        actingUserId: vm.userId,
        sandboxUserId,
        branch: vm.branch,
      });
    } catch (err) {
      console.warn("[agent-sandbox-fs] failed to reap sandbox record", err);
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
 * reuses `buildAgentSandboxFs`, so the sandbox `ensureSandbox` resolution is
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
    const fs = await buildAgentSandboxFs(ctx, vm);
    const { stdout } = await fs.onBash("test -d .deco && echo __DECO_SITE__");
    return stdout.includes("__DECO_SITE__");
  } catch (err) {
    console.warn(
      "[agent-sandbox-fs] .deco probe failed; assuming deco site",
      err,
    );
    return true;
  }
}
