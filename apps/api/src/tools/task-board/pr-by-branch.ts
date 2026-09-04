/**
 * Find a Super Agent run's pull request by the BRANCH it was given, rather than
 * asking the run to report it.
 *
 * The board used to learn a `claude-code` run's PR two ways, both of them the
 * model's word for it: a regex over the run's closing message (which linked
 * nothing whenever it wrote "PR #269 opened" instead of a URL), and then
 * `TASK_BOARD_ITEM_PR_LINK`, a tool the run had to remember to call. Both share
 * a failure mode no prompt fixes — a run that opens the PR and then dies, runs
 * out of budget, or simply doesn't call the tool strands its card, and reviewers
 * are only dispatched for a card with a linked PR.
 *
 * Studio already knows everything needed to look it up: the repository is bound
 * to the thread (`metadata.githubRepo`, written at dispatch or by
 * `TASK_ADD_REPO`) and the branch is derived, not chosen — the daemon checks out
 * `syntheticBranchToGitRef(<sandbox key>)`, and a live daemon's actual HEAD is
 * recorded on `metadata.headRef`. So one `list_pull_requests?head=owner:ref`
 * answers it, from GitHub, with no model in the loop.
 *
 * This is a FLOOR, not the fast path: the MCP `create_pull_request` hook
 * (`capturePrForRun`) still links instantly when the run opens its PR that way.
 * This runs from the review sweeper, for a card that reached its review cycle
 * with nothing linked — which before this was the definition of a stranded card.
 */

import type { StudioContext } from "@/core/studio-context";
import { clientFromConnection } from "@/mcp-clients";
import type { TaskBoardItem } from "@/storage/types";
import {
  getThreadGithubRepo,
  getThreadHeadRef,
  resolveSandboxBranchForThread,
  syntheticBranchToGitRef,
} from "@/tools/sandbox/thread-repo";
import { extractPrFromText, type ExtractedPr } from "./pr-extract";
import { invalidatePrCards, resolveGithubConnection } from "./prs-get";

/** Cap one lookup, so a slow GitHub can't hold up the sweep tick. */
const LIST_TIMEOUT_MS = 8000;

/**
 * The refs a run's PR could be open on, most-likely first.
 *
 * Two, because the daemon's checkout and the thread's record can legitimately
 * disagree: `headRef` is what a live daemon last reported (so it survives a
 * re-run that landed on a real PR branch), while the derived ref is what a
 * synthetic sandbox key clones onto. Deduped, and a non-synthetic key is
 * already a git ref — `syntheticBranchToGitRef` would mangle it, so it is used
 * as-is. Pure, so the derivation is unit-tested.
 */
export function candidateHeadRefs(
  branch: string,
  recordedHeadRef: string | null,
): string[] {
  const derived = branch.startsWith("thread:")
    ? syntheticBranchToGitRef(branch)
    : branch;
  return [
    ...new Set([recordedHeadRef, derived].filter((r): r is string => !!r)),
  ];
}

/**
 * The first pull request in a `list_pull_requests` result, as a PR identity.
 *
 * Shapes vary by MCP server version (a bare array, or one wrapped in
 * `pull_requests`/`items`/`data`), and the URL field varies with it
 * (`html_url` on the REST shape, `url` on the minimal one). Everything is run
 * through `extractPrFromText`, so a non-PR URL — an API url, an issue — is
 * rejected here rather than linked as a PR. Pure, so the shapes are
 * unit-tested. Null when the result holds no pull request.
 */
export function firstPrFromListResult(json: unknown): ExtractedPr | null {
  const rows = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? (["pull_requests", "items", "data"]
          .map((k) => (json as Record<string, unknown>)[k])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const key of ["html_url", "url"]) {
      const value = r[key];
      const pr = typeof value === "string" ? extractPrFromText(value) : null;
      if (pr) return pr;
    }
  }
  return null;
}

/** Normalize a CallToolResult to its JSON payload. Null on an upstream error. */
function toolJson(result: unknown): unknown {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (r.isError) return null;
  if (r.structuredContent && typeof r.structuredContent === "object") {
    return r.structuredContent;
  }
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Link the PR a task's run opened, found by the run's branch. Returns true when
 * something was linked.
 *
 * Best-effort throughout: every failure is a `false`, never a throw — the
 * caller is the sweeper, and a card that can't be resolved this tick is simply
 * retried on the next one (or handed to a human when its no-PR grace expires).
 *
 * ponytail: at most two GitHub calls, and only for a card with NO linked PR.
 * That is bounded by `claimSweep` (one visit per card per sweep interval) and
 * self-limiting (a card that links stops qualifying), so it stays outside the
 * throttled read queue. If unlinked cards ever become common enough to show up
 * in the rate-limit budget, move it behind `GITHUB_READS_QUEUE` like
 * `readPrStateThrottled`.
 */
export async function linkPrFromRunBranch(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<boolean> {
  const orgId = item.organizationId;
  try {
    const threadIds = await ctx.storage.taskBoard.linkedThreadIds(
      item.id,
      orgId,
    );
    for (const threadId of threadIds) {
      const repo = await getThreadGithubRepo(ctx, threadId);
      if (!repo?.owner || !repo?.name) continue;

      const thread = await ctx.storage.threads.get(threadId);
      const branch = await resolveSandboxBranchForThread(ctx, {
        threadId,
        runBranch: thread?.branch,
      });
      const refs = candidateHeadRefs(
        branch,
        await getThreadHeadRef(ctx, threadId),
      );
      const conn = await resolveGithubConnection(
        ctx,
        orgId,
        repo.connectionId ?? null,
        { owner: repo.owner, name: repo.name },
      );
      if (!conn) {
        console.warn(
          `[task-board] no GitHub connection for ${repo.owner}/${repo.name} — ` +
            `cannot look up ${item.id}'s pull request by branch`,
        );
        continue;
      }

      const client = await clientFromConnection(conn, ctx, true);
      try {
        for (const ref of refs) {
          const result = await client.callTool(
            {
              name: "list_pull_requests",
              arguments: {
                owner: repo.owner,
                repo: repo.name,
                // `state: all`, not `open`: a PR the agent opened and a human
                // closed is still the answer to "what did this run produce",
                // and linking it is what lets the card leave In Review.
                state: "all",
                head: `${repo.owner}:${ref}`,
                perPage: 5,
              },
            },
            undefined,
            { timeout: LIST_TIMEOUT_MS },
          );
          const pr = firstPrFromListResult(toolJson(result));
          if (!pr) continue;
          await ctx.storage.taskBoard.linkPr({
            taskBoardItemId: item.id,
            organizationId: orgId,
            url: pr.url,
            prNumber: pr.number,
            repoOwner: pr.owner,
            repoName: pr.repo,
            connectionId: conn.id,
          });
          // The one piece of bookkeeping the deleted `TASK_BOARD_ITEM_PR_LINK`
          // did alongside its link that nothing else on this path does.
          // Idempotent, and a no-op for the case this file exists for — a run
          // that opened its PR and then died is already In Review by the time
          // we get here, and keeps a null cycle. It matters for a run still
          // going: without the stamp, `reviewCycleStart` and the reviewer fence
          // fall back to scanning activity, and a re-dispatch cannot tell one
          // cycle from the next.
          //
          // ponytail: no `clearSweepBudget` here. The only caller is the sweeper
          // itself, which continues straight into the reviewer dispatch in this
          // same pass — clearing the interval it just claimed would buy nothing
          // but an extra tick. Add it if a non-sweeper caller appears.
          await ctx.storage.taskBoard.openReviewCycleIfInProgress(
            item.id,
            orgId,
          );
          await invalidatePrCards(orgId).catch(() => {});
          console.log(
            `[task-board] ${item.id}: linked ${pr.url} found on branch ${ref}`,
          );
          return true;
        }
      } finally {
        await client.close().catch(() => {});
      }
    }
  } catch (err) {
    console.error("[task-board] PR lookup by branch failed", err);
  }
  return false;
}
