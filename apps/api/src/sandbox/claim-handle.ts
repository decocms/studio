import { computeHandle, type SandboxId } from "@decocms/sandbox/provider";

/**
 * Compute the claim handle for a sandbox. Preview URLs expose the handle as a
 * public hostname (`<handle>.cluster.host`), so hashLen=16 — shorter hashes are
 * brute-forceable at an unrate-limited gateway.
 *
 * Single source of truth — import this everywhere a claimName must match what a
 * runner stored (vm-events, vm-exec, etc.). It agrees with the runner by
 * construction: both call `computeHandle`, which derives the whole handle from
 * `projectRef`. There is deliberately no branch parameter — passing one that
 * disagreed with the ref is what produced duplicate claims.
 */
export function computeClaimHandle(id: SandboxId): string {
  return computeHandle(id);
}
