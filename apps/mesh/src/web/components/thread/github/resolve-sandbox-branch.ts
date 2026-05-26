import type { SandboxMap } from "@decocms/mesh-sdk/types";

/** First branch with a sandbox record for this user (prefers `prefer` when set). */
export function resolveSandboxBranchFromMap(
  sandboxMap: SandboxMap | undefined,
  userId: string | undefined,
  prefer?: string | null,
): string | null {
  if (!userId) return prefer ?? null;
  const userMap = sandboxMap?.[userId];
  if (!userMap) return prefer ?? null;

  if (prefer && userMap[prefer]) return prefer;

  for (const [branch, kinds] of Object.entries(userMap)) {
    if (kinds && Object.keys(kinds).length > 0) return branch;
  }

  return prefer ?? null;
}

export function resolveEffectiveBranch(args: {
  chatBranch: string | null;
  sandboxBranch: string | null;
  sandboxMapBranch: string | null;
  gitCurrentBranch: string | null | undefined;
}): string | null {
  return (
    args.chatBranch ??
    args.sandboxBranch ??
    args.sandboxMapBranch ??
    args.gitCurrentBranch ??
    null
  );
}
