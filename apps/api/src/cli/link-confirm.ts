/** Pending-delete confirmation state and its prompt text. */

export interface PendingConfirm {
  handle: string;
  branch: string | null;
  dirtyCount: number;
  merged: boolean | null;
}

export function formatConfirm(c: PendingConfirm): string {
  const label = c.branch ?? c.handle;
  const warns: string[] = [];
  if (c.dirtyCount > 0) {
    warns.push(
      `${c.dirtyCount} uncommitted file${c.dirtyCount === 1 ? "" : "s"}`,
    );
  }
  if (c.merged === false) warns.push("branch not merged");
  return warns.length > 0
    ? `⚠ ${warns.join(", ")} — delete ${label}? (y/n)`
    : `Delete ${label}? (y/n)`;
}
