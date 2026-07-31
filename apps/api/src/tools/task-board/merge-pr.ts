import type { StudioContext } from "@/core/studio-context";
import { clientFromConnection } from "@/mcp-clients";
import { fetchPrChecksStatus, resolveGithubConnection } from "./prs-get";

/** Cap the merge round-trip so a slow GitHub can't hang the caller. */
const MERGE_TIMEOUT_MS = 15000;

/**
 * Merge the task's open PR via the GitHub MCP `merge_pull_request` tool. Shared
 * by the reviewer decision (auto-merge on all-approved) and the manual "promote
 * to production" action. Best-effort: returns false on any failure (no
 * connection, PR gone, merge conflict) so the caller can leave the PR for a
 * human. Merges the newest linked PR — the one under review.
 */
export async function mergeLinkedPr(
  ctx: StudioContext,
  orgId: string,
  taskBoardItemId: string,
): Promise<boolean> {
  const prs = await ctx.storage.taskBoard.listPrs(taskBoardItemId, orgId);
  const pr = prs[0];
  if (!pr) return false;
  // Never ship on red or in-flight CI — the ship button hides in this case, but
  // guard the server path too (auto-merge, a stale client). Only a definite
  // failing/pending blocks; an unknown (null) does not.
  const checks = await fetchPrChecksStatus(ctx, orgId, pr);
  if (checks === "failing" || checks === "pending") {
    console.warn(
      `[task-board] merge blocked — checks ${checks} on PR #${pr.number}`,
    );
    return false;
  }
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return false;
  const client = await clientFromConnection(conn, ctx, true);
  try {
    const result = await client.callTool(
      {
        name: "merge_pull_request",
        arguments: {
          owner: pr.repoOwner,
          repo: pr.repoName,
          pullNumber: pr.number,
        },
      },
      undefined,
      { timeout: MERGE_TIMEOUT_MS },
    );
    return !(result as { isError?: boolean })?.isError;
  } catch (err) {
    console.error("[task-board] merge PR failed", err);
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}
