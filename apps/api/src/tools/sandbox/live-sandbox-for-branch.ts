import type { StudioContext } from "../../core/studio-context";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";

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
    return await provider.alive(claim.claimName).catch(() => false);
  } catch {
    return false;
  }
}
