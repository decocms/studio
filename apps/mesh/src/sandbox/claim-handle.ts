import { computeHandle, type SandboxId } from "@decocms/sandbox/provider";

/**
 * Compute the claim handle for a sandbox. Both live runner kinds (cluster's
 * agent-sandbox and desktop) expose preview URLs as public hostnames
 * (`<handle>.cluster.host` and `<handle>.localhost` respectively), so both
 * use hashLen=16 — shorter hashes are brute-forceable at an unrate-limited
 * gateway.
 *
 * Single source of truth — import this everywhere a claimName must match
 * what a runner stored (vm-events, vm-exec, etc.). The matching
 * `hashLen=16` lives in `desktop/runner.ts` so both sides agree by
 * construction.
 */
export function computeClaimHandle(id: SandboxId, branch: string): string {
  return computeHandle(id, branch, { hashLen: 16 });
}
