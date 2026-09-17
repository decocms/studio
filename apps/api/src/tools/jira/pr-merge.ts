/**
 * JIRA_PR_MERGE — land the pull request an issue carries.
 *
 * Deliberately NOT the board's merge (`task-board/merge-pr.ts`). That one is
 * built around a card: it reads linked pull requests out of board storage,
 * consults review cycles and lanes, and writes its refusals to a card
 * timeline. A Jira issue has none of those — the pull request lives on the
 * issue as a web link, and "approved" is a column, not a review cycle. Sharing
 * would mean threading two interfaces through a file whose shape is the board,
 * to reuse about seventy lines. So this goes straight at the provider.
 *
 * What it does reuse is the layer that is already provider-shaped and
 * board-free: `changeRequestClientForOrigin` and `ChangeRequestClient.merge`,
 * which never throws for a refusal — every outcome is a value, classified
 * inside the implementation that knows its own provider's prose.
 *
 * The one refusal with an automatic answer is `conflict`: the branch no longer
 * applies, and an agent can rebase it. Every other refusal (a failing check,
 * branch protection, a missing review) needs a person, so it is reported and
 * left alone. That split is why merging does not cost an agent in the ordinary
 * case — the happy path is three API calls and no run at all.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { changeRequestClientForOrigin } from "@/git-providers";
import { JiraClient } from "@/jira/client";
import { parseIssueKeys } from "@decocms/shared/jira/issue-key";
import { pullRequestsFromLinks } from "@/jira/pr-link";
import { startJiraRunForIssue } from "@/jira/trigger";
import { MAX_ISSUE_INPUT_LENGTH, MAX_ISSUES_PER_CALL } from "./run-start";

/**
 * What happened to ONE pull request — not one issue.
 *
 * An issue can carry a pull request per repository (a reciprocal change spans
 * both storefronts), and the two halves genuinely differ: one side merges
 * while the other conflicts. Reporting per issue would have to call that
 * "merged" or "resolving" and be wrong either way, so the row is the pull
 * request and the issue repeats.
 *
 * `resolving` is the only outcome that costs a run, and it is not a failure —
 * it is the conflict being handed to an agent, which will rebase and push the
 * SAME pull requests. Merging afterwards is a second call to this tool, on
 * purpose: the run is asynchronous, and a tool that waited on it would hold a
 * request open for minutes.
 */
const OutcomeSchema = z.object({
  issueKey: z.string(),
  /** `owner/name` — which half of a multi-repo issue this row is. */
  repo: z.string().optional(),
  prUrl: z.string().optional(),
  status: z.enum([
    "merged",
    "resolving",
    "blocked",
    "not_open",
    "no_pr",
    "error",
  ]),
  detail: z.string().optional(),
});

export const JIRA_PR_MERGE = defineTool({
  name: "JIRA_PR_MERGE",
  description:
    "Merge the pull requests each Jira issue carries as web links — one per " +
    "repository, since a change can span two storefronts and both halves are " +
    "the delivery. Green merges immediately and costs no agent run. A merge " +
    "conflict — the one refusal with an automatic answer — starts ONE run " +
    "that rebases every conflicting pull request on that issue; call again " +
    "once it finishes. Any other refusal (a failing check, branch protection) " +
    "is reported and left for a person. Takes several issues: keys or links, " +
    "one per line or comma-separated.",
  inputSchema: z.object({
    issueKey: z
      .string()
      .min(1)
      .max(MAX_ISSUE_INPUT_LENGTH)
      .describe(
        "One or more issue keys (ABC-123) or pasted links, separated by " +
          "newlines or commas.",
      ),
  }),
  outputSchema: z.object({ results: z.array(OutcomeSchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

    const { keys } = parseIssueKeys(input.issueKey);
    if (keys.length === 0) {
      throw new Error(
        `Found no Jira issue key in "${input.issueKey.slice(0, 120)}" — expected something like ABC-123, or a link to the issue`,
      );
    }
    if (keys.length > MAX_ISSUES_PER_CALL) {
      throw new Error(
        `${keys.length} issues named, and ${MAX_ISSUES_PER_CALL} is the most one call takes`,
      );
    }
    const integration = await ctx.storage.jiraIntegrations.getByOrg(
      organization.id,
    );
    if (!integration) {
      throw new Error(
        "Jira is not connected — save credentials with JIRA_INTEGRATION_UPSERT first",
      );
    }
    const jira = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );

    const results: Array<z.infer<typeof OutcomeSchema>> = [];
    // Sequential, and that is the point rather than a concession: merging one
    // moves the base under the next, so a batch of pull requests that touch a
    // file in common resolves in order instead of all conflicting at once.
    for (const issueKey of keys) {
      try {
        const prs = pullRequestsFromLinks(await jira.listRemoteLinks(issueKey));
        if (prs.length === 0) {
          results.push({ issueKey, status: "no_pr" });
          continue;
        }
        const conflicted: Array<{ number: number; url: string }> = [];
        for (const pr of prs) {
          const repo = pr.repo.path;
          const client = await changeRequestClientForOrigin(
            ctx,
            organization.id,
            { repo: pr.repo },
          );
          if (!client) {
            results.push({
              issueKey,
              repo,
              prUrl: pr.url,
              status: "error",
              detail: `No credential for ${repo} in this organization`,
            });
            continue;
          }
          // A superseded attempt is never revived: if the newest pull request
          // for a repository is closed, that is a decision a person made.
          const current = await client.read(pr.number);
          if (current && current.state !== "open") {
            results.push({
              issueKey,
              repo,
              prUrl: pr.url,
              status: current.state === "merged" ? "merged" : "not_open",
            });
            continue;
          }
          const outcome = await client.merge(pr.number);
          if (outcome.merged) {
            results.push({ issueKey, repo, prUrl: pr.url, status: "merged" });
            continue;
          }
          if (outcome.reason === "conflict") {
            conflicted.push({ number: pr.number, url: pr.url });
            results.push({
              issueKey,
              repo,
              prUrl: pr.url,
              status: "resolving",
              detail: outcome.detail,
            });
            continue;
          }
          results.push({
            issueKey,
            repo,
            prUrl: pr.url,
            status: "blocked",
            detail: outcome.detail,
          });
        }
        // ONE run for the issue, however many of its pull requests conflict: a
        // run accumulates checkouts (`TASK_ADD_REPO`), so the same agent can
        // rebase both halves, and two runs on one issue would supersede each
        // other anyway. The instruction names every one, because the built-in
        // conflict lead only knows about the single `pr` it is handed.
        if (conflicted.length > 0) {
          await startJiraRunForIssue(ctx, integration, issueKey, {
            instruction:
              conflicted.length === 1
                ? null
                : `These pull requests on this issue no longer merge cleanly: ${conflicted
                    .map((c) => c.url)
                    .join(
                      ", ",
                    )}. Rebase EACH onto its base branch and push it, updating the same pull request. They are halves of one change — leaving either behind ships it broken.`,
            actorId: userId,
            pr: conflicted[0],
            resolveConflict: true,
          });
        }
      } catch (err) {
        results.push({
          issueKey,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  },
});
