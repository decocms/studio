/**
 * The branch a task's sessions share.
 *
 * A task owns one branch; its sessions are conversations on it. Without this,
 * every new session gets whatever branch `COLLECTION_THREADS_CREATE` picks
 * (the warmest sandbox, or a fresh generated name), so two sessions on one
 * card drift onto two branches, open two PRs, and the card stops telling the
 * truth about what shipped.
 */

export interface SessionBranchRef {
  threadId: string;
  createdAt: string;
  branch?: string | null;
}

/**
 * The newest session that actually has a branch, or null when none do (a task
 * whose runs never reached a sandbox — the caller then lets the server pick).
 * Newest-first so a task that changed branch mid-life keeps its current one.
 */
export function resolveTaskBranch(sessions: SessionBranchRef[]): string | null {
  for (const session of newestFirst(sessions)) {
    const branch = session.branch?.trim();
    if (branch) return branch;
  }
  return null;
}

/** The task's most recent session, or null when it has none. */
export function resolveNewestSession<T extends { createdAt: string }>(
  sessions: T[],
): T | null {
  return newestFirst(sessions)[0] ?? null;
}

function newestFirst<T extends { createdAt: string }>(sessions: T[]): T[] {
  return [...sessions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}
