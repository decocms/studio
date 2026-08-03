import { computeHandle, type SandboxId } from "@decocms/sandbox/provider";

/**
 * Compute the hosted agent-sandbox claim handle. Preview URLs expose this
 * handle on a public hostname, so the shared hash length must not be shortened:
 * shorter values are brute-forceable at an unrate-limited gateway.
 *
 * Single source of truth — import this everywhere a claimName must match
 * what a runner stored (vm-events, vm-exec, etc.). The matching
 * The provider's `computeHandle` is the single source of truth.
 */
export function computeClaimHandle(id: SandboxId, branch: string): string {
  return computeHandle(id, branch);
}
