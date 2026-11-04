import type { Release } from "@decocms/shared/sdk/types";

/**
 * Pure edits to the `metadata.releases` array. Kept separate from
 * {@link ./use-releases.ts} so they're unit-testable without React/SDK, and so
 * the read-modify-write serialization there composes over well-defined steps.
 *
 * Add is idempotent by branch: a double-fire (two tabs, or the shell's
 * auto-name effect re-running) can't duplicate a draft.
 */
export function addRelease(current: Release[], release: Release): Release[] {
  return current.some((r) => r.branch === release.branch)
    ? current
    : [...current, release];
}

export function removeRelease(current: Release[], branch: string): Release[] {
  return current.filter((r) => r.branch !== branch);
}

/** One-way: a branch that had a coding session may hold code, whatever runtime
 *  it was named in. Returns `current` when nothing changes. */
export function markReleaseSandbox(
  current: Release[],
  branch: string,
): Release[] {
  const target = current.find((r) => r.branch === branch);
  if (!target || target.runtime === "sandbox") return current;
  return current.map((r) =>
    r === target ? { ...r, runtime: "sandbox" as const } : r,
  );
}

export function renameReleaseIn(
  current: Release[],
  branch: string,
  name: string,
): Release[] {
  return current.map((r) => (r.branch === branch ? { ...r, name } : r));
}
