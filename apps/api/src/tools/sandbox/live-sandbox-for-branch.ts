import type { StudioContext } from "../../core/studio-context";
import { sleep } from "@decocms/shared/std";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";

/** The claim decision cannot wait on a slow control plane. */
const ALIVE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Is a sandbox actually RUNNING at this claim handle?
 *
 * Liveness, never presence: a `sandboxMap` cell records that a sandbox was
 * once started and survives long after the pod is gone (nothing removes it but
 * SANDBOX_DELETE), which is exactly how a dead 2026-07 `user-desktop` record
 * kept routing a brand-new CMS session to a daemon that cannot exist. `alive()`
 * asks the runner instead — the same probe `sandbox-events-handler` already
 * makes on this request path.
 *
 * Answers `false` on any failure: an unreachable runner is not evidence of a
 * live session.
 */
export async function liveSandboxForBranch(
  ctx: StudioContext,
  claim: {
    claimName: string;
    userId: string;
    branch: string;
    virtualMcpMetadata: Record<string, unknown> | null;
  },
): Promise<boolean> {
  try {
    const { provider } = await resolveSandboxProvider(ctx, {
      userId: claim.userId,
      branch: claim.branch,
      virtualMcpMetadata: claim.virtualMcpMetadata,
    });
    return await probeAlive(provider, claim.claimName);
  } catch {
    return false;
  }
}

/**
 * `alive()` reaches a live control plane with no deadline of its own, and this
 * sits in front of every proxied request on an unstamped thread — so bound it.
 * A probe that does not answer in time is not evidence of a live session.
 */
async function probeAlive(
  provider: { alive: (handle: string) => Promise<boolean> },
  handle: string,
): Promise<boolean> {
  return await Promise.race([
    provider.alive(handle).catch(() => false),
    sleep(ALIVE_PROBE_TIMEOUT_MS).then(() => false),
  ]);
}
