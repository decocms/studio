/**
 * Find a Super Agent run's pull request by the BRANCH it was given, rather than
 * asking the run to report it.
 *
 * The board used to learn a `claude-code` run's PR two ways, both of them the
 * model's word for it: a regex over the run's closing message (which linked
 * nothing whenever it wrote "PR #269 opened" instead of a URL), and a link tool
 * the run had to remember to call. Both share a failure mode no prompt fixes —
 * a run that opens the PR and then dies, runs out of budget, or simply doesn't
 * call the tool strands its card, and reviewers
 * are only dispatched for a card with a linked PR.
 *
 * Studio already knows everything needed to look it up: the repository is bound
 * to the thread (`metadata.githubRepo`, written at dispatch or by
 * `TASK_ADD_REPO`) and the branch is derived, not chosen — the daemon checks out
 * `syntheticBranchToGitRef(<sandbox key>)`, and a live daemon's actual HEAD is
 * recorded on `metadata.headRef`. So one `readForBranch` answers it, from the
 * repository's own provider, with no model in the loop.
 *
 * This is a FLOOR, not the fast path: the provider tool hook
 * (`capturePrForRun`) still links instantly when the run opens it that way.
 * This runs from the review sweeper, for a card that reached its review cycle
 * with nothing linked — which before this was the definition of a stranded card.
 *
 * It reads through `ChangeRequestClient`, so a GitLab project is looked up the
 * same way: the shape-sniffing this used to need (a bare array, or one wrapped
 * in `pull_requests`/`items`/`data`, with the URL on `html_url` or `url`
 * depending on the MCP server's version) is gone with the MCP call it existed
 * to parse.
 */

import {
  parseRepoUrl,
  repoRefFromOwnerName,
} from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { changeRequestClientForOrigin } from "@/git-providers/change-requests";
import type { TaskBoardItem } from "@/storage/types";
import {
  getThreadGithubRepo,
  getThreadHeadRef,
  resolveSandboxBranchForThread,
  syntheticBranchToGitRef,
} from "@/tools/sandbox/thread-repo";
import { invalidatePrCards } from "./prs-get";

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
      /**
       * The URL is preferred over the `owner`/`name` pair because it carries
       * the host, and therefore the provider; the pair is the fallback for a
       * binding written before that was true, which is github.com by
       * construction.
       */
      const client = await changeRequestClientForOrigin(ctx, orgId, {
        repo:
          parseRepoUrl(repo.url) ?? repoRefFromOwnerName(repo.owner, repo.name),
        repositoryId: repo.repositoryId,
        connectionId: repo.connectionId,
      }).catch(() => null);
      if (!client) {
        console.warn(
          `[task-board] no credential for ${repo.owner}/${repo.name} — ` +
            `cannot look up ${item.id}'s change request by branch`,
        );
        continue;
      }

      for (const ref of refs) {
        /**
         * Newest regardless of state, not just open: one the agent opened and
         * a human closed is still the answer to "what did this run produce",
         * and linking it is what lets the card leave In Review. Both
         * implementations of `readForBranch` answer that way.
         */
        const found = await client.readForBranch(ref).catch(() => null);
        if (!found) continue;
        await ctx.storage.taskBoard.linkPr({
          taskBoardItemId: item.id,
          organizationId: orgId,
          url: found.url,
          prNumber: found.number,
          repo: client.repo,
        });
        // The one piece of bookkeeping the deleted PR-link tool did
        // alongside its link that nothing else on this path does.
        // Idempotent, and a no-op for the case this file exists for — a run
        // that opened its change request and then died is already In Review by
        // the time we get here, and keeps a null cycle. It matters for a run
        // still going: without the stamp, `reviewCycleStart` and the reviewer
        // fence fall back to scanning activity, and a re-dispatch cannot tell
        // one cycle from the next.
        //
        // ponytail: no `clearSweepBudget` here. The only caller is the sweeper
        // itself, which continues straight into the reviewer dispatch in this
        // same pass — clearing the interval it just claimed would buy nothing
        // but an extra tick. Add it if a non-sweeper caller appears.
        await ctx.storage.taskBoard.openReviewCycleIfInProgress(item.id, orgId);
        await invalidatePrCards(orgId).catch(() => {});
        console.log(
          `[task-board] ${item.id}: linked ${found.url} found on branch ${ref}`,
        );
        return true;
      }
    }
  } catch (err) {
    console.error("[task-board] PR lookup by branch failed", err);
  }
  return false;
}
