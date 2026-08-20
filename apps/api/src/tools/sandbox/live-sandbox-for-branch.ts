import type { StudioContext } from "../../core/studio-context";
import { sleep } from "@decocms/shared/std";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";

/** The claim decision cannot wait on a slow control plane. */
const ALIVE_PROBE_TIMEOUT_MS = 2_000;

/**
 * What the runner says about this claim handle.
 *
 * `unknown` is its own answer on purpose: a probe that timed out or errored is
 * NOT evidence the pod is gone, and the caller writes an immutable stamp from
 * this. Collapsing it into `gone` is how a slow control-plane call could
 * permanently convert a live coding session into a CMS one.
 */
export type SandboxLiveness = "alive" | "gone" | "unknown";

/**
 * Is a sandbox actually RUNNING at this claim handle?
 *
 * Liveness, never presence: a `sandboxMap` cell records that a sandbox was
 * once started and survives long after the pod is gone (nothing removes it but
 * SANDBOX_DELETE), which is exactly how a dead 2026-07 `user-desktop` record
 * kept routing a brand-new CMS session to a daemon that cannot exist. `alive()`
 * asks the runner instead — the same probe `sandbox-events-handler` already
 * makes on this request path.
 */
export async function liveSandboxForBranch(
  ctx: StudioContext,
  claim: {
    claimName: string;
    userId: string;
    branch: string;
    virtualMcpMetadata: Record<string, unknown> | null;
  },
): Promise<SandboxLiveness> {
  try {
    const { provider } = await resolveSandboxProvider(ctx, {
      userId: claim.userId,
      branch: claim.branch,
      virtualMcpMetadata: claim.virtualMcpMetadata,
    });
    return await probeAlive(provider, claim.claimName);
  } catch {
    return "unknown";
  }
}

/**
 * `alive()` reaches a live control plane with no deadline of its own, and this
 * sits in front of every proxied request on an unstamped thread — so bound it.
 * The timer is aborted either way: `Promise.race` settles but does not cancel
 * the loser, and a pending timer per request keeps the event loop alive.
 */
async function probeAlive(
  provider: { alive: (handle: string) => Promise<boolean> },
  handle: string,
): Promise<SandboxLiveness> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      provider
        .alive(handle)
        .then((alive): SandboxLiveness => (alive ? "alive" : "gone"))
        .catch((): SandboxLiveness => "unknown"),
      sleep(ALIVE_PROBE_TIMEOUT_MS, { signal: timeout.signal }).then(
        (): SandboxLiveness => "unknown",
      ),
    ]);
  } finally {
    timeout.abort();
  }
}
