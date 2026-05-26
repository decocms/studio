/**
 * Synthetic branches (`"ephemeral"`, `"thread:<id>"`) are sandbox routing keys,
 * not real git refs. The daemon accepts them as sandboxMap entries but never
 * checks them out. UI surfaces that show branch names to users should hide
 * synthetic values — they have no meaning outside the sandbox layer.
 *
 * Source of truth: `packages/sandbox/daemon/constants.ts`. Mirrored here
 * because that file lives behind a server-only package boundary and we don't
 * want to pull daemon code into the web bundle for a two-line check.
 */
export function isSyntheticBranch(branch: string): boolean {
  return branch === "ephemeral" || branch.startsWith("thread:");
}
