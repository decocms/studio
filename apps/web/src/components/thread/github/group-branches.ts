import type { SandboxMap } from "@/sdk";
import type { Branch } from "./use-branches";

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupBranchesArgs {
  sandboxMap: SandboxMap | undefined;
  /** Current user id — used to derive "your branches". */
  userId: string;
  /** Branch names from github-mcp-server's list_branches (+ optional author). */
  rawBranches: { name: string; author?: string | null }[];
  /** Epoch ms "now" — injected so the 7-day cutoff is testable/deterministic. */
  now: number;
}

export interface GroupedBranches {
  recent: Branch[];
  yours: Branch[];
  others: Branch[];
}

/**
 * Splits branches into three groups for the picker:
 * - `recent`: any branch with sandbox activity in the last 7 days (across ALL
 *   users), most-recent-first, carrying `contributors` + `lastActiveAt`.
 * - `yours`: the current user's sandbox branches, minus recent ones.
 * - `others`: github branches, minus your-sandbox and recent ones.
 *
 * Precedence is recent > yours > others, so a branch appears in exactly one
 * group. Pure/deterministic given `now`; the hook injects `Date.now()`.
 */
export function groupBranches({
  sandboxMap,
  userId,
  rawBranches,
  now,
}: GroupBranchesArgs): GroupedBranches {
  // Aggregate sandbox activity across ALL users: who is on each branch and when
  // it was last started. sandboxMap shape: sandboxMap[userId][branch][kind].
  const activityByBranch = new Map<
    string,
    { userIds: Set<string>; lastActiveAt: number }
  >();
  for (const [uid, branches] of Object.entries(sandboxMap ?? {})) {
    for (const [branch, kinds] of Object.entries(branches ?? {})) {
      let entry = activityByBranch.get(branch);
      if (!entry) {
        entry = { userIds: new Set(), lastActiveAt: 0 };
        activityByBranch.set(branch, entry);
      }
      entry.userIds.add(uid);
      for (const record of Object.values(kinds ?? {})) {
        const createdAt = record?.createdAt ?? 0;
        if (createdAt > entry.lastActiveAt) entry.lastActiveAt = createdAt;
      }
    }
  }

  const recentCutoff = now - RECENT_WINDOW_MS;
  const recent: Branch[] = [...activityByBranch.entries()]
    .filter(([, activity]) => activity.lastActiveAt >= recentCutoff)
    .sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt)
    .map(([name, activity]) => ({
      name,
      source: "recent" as const,
      contributors: [...activity.userIds],
      lastActiveAt: activity.lastActiveAt,
    }));
  const recentNames = new Set(recent.map((b) => b.name));

  const yourBranchNames = new Set(Object.keys(sandboxMap?.[userId] ?? {}));
  const yours: Branch[] = [...yourBranchNames]
    .filter((name) => !recentNames.has(name))
    .sort()
    .map((name) => ({ name, source: "yours" as const }));

  const others: Branch[] = rawBranches
    .filter((b) => !yourBranchNames.has(b.name) && !recentNames.has(b.name))
    .map((b) => ({
      name: b.name,
      source: "other" as const,
      author: b.author ?? null,
    }));

  return { recent, yours, others };
}
