import {
  computeHandle,
  resolveSandboxProviderKindFromEnv,
  type SandboxId,
} from "@decocms/sandbox/provider";

/**
 * Compute the claim handle for a sandbox using the correct hashLen for the
 * current runner kind. agent-sandbox and remote-user both expose preview
 * URLs as public hostnames (`<handle>.cluster.host` and `<handle>.deco.host`
 * respectively), so both use hashLen=16 — shorter hashes are brute-forceable
 * at an unrate-limited gateway. Other runners (docker, host) keep their
 * handles local, so the default hashLen=5 is fine there.
 *
 * Single source of truth — import this everywhere a claimName must match
 * what a runner stored (vm-events, vm-exec, etc.). The matching
 * `hashLen=16` lives in `remote-user/runner.ts` so both sides agree by
 * construction.
 */
export function computeClaimHandle(id: SandboxId, branch: string): string {
  const providerKind = resolveSandboxProviderKindFromEnv();
  const useLongHash =
    providerKind === "agent-sandbox" || providerKind === "remote-user";
  return computeHandle(id, branch, useLongHash ? { hashLen: 16 } : {});
}
