import type { TenantConfig } from "../types";
import type { Transition } from "./types";

/**
 * Pure: derive the single highest-impact transition between two configs.
 * Identity rules are enforced as `identity-conflict` outcomes — the store
 * uses that to reject the apply before persisting anything.
 *
 * Precedence (highest first):
 *   identity-conflict > bootstrap > branch-change >
 *   runtime-change > pm-change > port-change > no-op
 */
export function classify(
  before: TenantConfig | null,
  after: TenantConfig,
): Transition {
  // 1. Identity invariants (write-once repo path; credentials are excluded).
  // The cloneUrl embeds an OAuth token (e.g. x-access-token:TOKEN@github.com/…)
  // that is refreshed on each VM_START. Comparing raw URLs would flag a refreshed
  // token as an identity conflict even though the repo hasn't changed. Strip
  // username/password before comparing so only the actual repo path is guarded.
  const beforeUrl = before?.git?.repository?.cloneUrl;
  const afterUrl = after.git?.repository?.cloneUrl;
  if (
    beforeUrl !== undefined &&
    afterUrl !== undefined &&
    stripCredentials(beforeUrl) !== stripCredentials(afterUrl)
  ) {
    return { kind: "identity-conflict", field: "cloneUrl" };
  }

  // 2. Bootstrap: no prior config, but new one carries enough to drive setup
  //    (cloneUrl OR application). Pure null → null is no-op.
  const isMeaningful =
    after.git?.repository?.cloneUrl !== undefined ||
    after.application !== undefined;
  if (before === null && isMeaningful) {
    return { kind: "bootstrap", config: after };
  }
  if (before === null) {
    return { kind: "no-op" };
  }

  // 3. Branch change.
  const beforeBranch = before.git?.repository?.branch;
  const afterBranch = after.git?.repository?.branch;
  if (afterBranch !== undefined && beforeBranch !== afterBranch) {
    return { kind: "branch-change", from: beforeBranch, to: afterBranch };
  }

  // 4. Runtime change (independent of pm).
  const beforeRuntime = before.application?.runtime;
  const afterRuntime = after.application?.runtime;
  if (afterRuntime !== undefined && beforeRuntime !== afterRuntime) {
    return { kind: "runtime-change", from: beforeRuntime, to: afterRuntime };
  }

  // 5. Package-manager change (name or path).
  const beforePm = before.application?.packageManager;
  const afterPm = after.application?.packageManager;
  if (
    afterPm !== undefined &&
    (beforePm?.name !== afterPm.name || beforePm?.path !== afterPm.path)
  ) {
    return { kind: "pm-change", from: beforePm, to: afterPm };
  }

  // 6. PORT change.
  const beforePort = before.application?.port;
  const afterPort = after.application?.port;
  if (beforePort !== afterPort) {
    return {
      kind: "port-change",
      from: beforePort,
      to: afterPort,
    };
  }

  return { kind: "no-op" };
}

function stripCredentials(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}
