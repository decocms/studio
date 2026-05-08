import {
  computeHandle,
  resolveRunnerKindFromEnv,
  type SandboxId,
} from "@decocms/sandbox/runner";

/**
 * Compute the claim handle for a sandbox using the correct hashLen for the
 * current runner kind. agent-sandbox uses hashLen=16 (preview URLs are
 * public hostnames; shorter hashes are brute-forceable). All other runners
 * use the default hashLen=5.
 *
 * Single source of truth — import this everywhere a claimName must match
 * what a runner stored (vm-events, vm-exec, etc.).
 */
export function computeClaimHandle(id: SandboxId, branch: string): string {
  const runnerKind = resolveRunnerKindFromEnv();
  return computeHandle(
    id,
    branch,
    runnerKind === "agent-sandbox" ? { hashLen: 16 } : {},
  );
}
