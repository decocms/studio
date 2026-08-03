/**
 * Symbolic workspace cwd contract (spec: "Harness Input Contract").
 *
 * `workspace.cwd` on the wire is LOGICALLY resolved, never host-absolute:
 *   - "/repo"   — repo checkout inside the sandbox; the daemon rebases it
 *                 onto its own sandbox root on receipt.
 *   - null      — no SDK cwd override; the harness uses its SDK default.
 */
export type HarnessCwd = "/repo" | null;

/** Repo checkout location inside any sandbox (desktop or hosted container). */
export const WORKSPACE_CWD_REPO = "/repo" as const;

/** Harness-side: translate the wire value into an SDK cwd option. */
export function effectiveCwd(cwd: HarnessCwd): string | undefined {
  return cwd ?? undefined;
}
