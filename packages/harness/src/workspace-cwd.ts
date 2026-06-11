/**
 * Symbolic workspace cwd contract (spec: "Harness Input Contract").
 *
 * `workspace.cwd` on the wire is LOGICALLY resolved, never host-absolute:
 *   - "/repo"   — repo checkout inside the sandbox; the daemon rebases it
 *                 onto its own sandbox root on receipt.
 *   - "default" — no on-disk checkout; the harness uses its SDK default
 *                 (process.cwd()) and NEVER fails the run on cwd.
 */
export const WORKSPACE_CWD_DEFAULT = "default";

/** Repo checkout location inside any sandbox (desktop or hosted container). */
export const WORKSPACE_CWD_REPO = "/repo";

/** Harness-side: translate the wire value into an SDK cwd option. */
export function effectiveCwd(cwd: string): string | undefined {
  return cwd === WORKSPACE_CWD_DEFAULT ? undefined : cwd;
}
