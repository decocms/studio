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
import { pullRequestFromLinks } from "@/jira/pr-link";
import { startJiraRunForIssue } from "@/jira/trigger";
import { MAX_ISSUE_INPUT_LENGTH, MAX_ISSUES_PER_CALL } from "./run-start";

/**
 * What happened to one issue's pull request.
 *
 * `resolving` is the only outcome that costs a run, and it is not a failure —
 * it is the conflict being handed to an agent, which will rebase and push the
 * SAME pull request. Merging it afterwards is a second call to this tool, on
 * purpose: the run is asynchronous, and a tool that waited on it would hold a
 * request open for minutes.
 */
const OutcomeSchema = z.object({
  issueKey: z.string(),
  status: z.enum(["merged", "resolving", "blocked", "no_pr", "error"]),
  prUrl: z.string().optional(),
  detail: z.string().optional(),
});

export const JIRA_PR_MERGE = defineTool({
  name: "JIRA_PR_MERGE",
  description:
    "Merge the pull request each Jira issue carries as a web link. Green " +
    "merges immediately and costs no agent run. A merge conflict — the one " +
    "refusal with an automatic answer — starts a run that rebases and pushes " +
    "the same pull request; call again once it finishes. Any other refusal (a " +
    "failing check, branch protection) is reported and left for a person. " +
    "Takes several issues: keys or links, one per line or comma-separated.",
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
        const pr = pullRequestFromLinks(await jira.listRemoteLinks(issueKey));
        if (!pr) {
          results.push({ issueKey, status: "no_pr" });
          continue;
        }
        const client = await changeRequestClientForOrigin(
          ctx,
          organization.id,
          {
            repo: pr.repo,
          },
        );
        if (!client) {
          results.push({
            issueKey,
            status: "error",
            prUrl: pr.url,
            detail: `No credential for ${pr.repo.path} in this organization`,
          });
          continue;
        }
        const outcome = await client.merge(pr.number);
        if (outcome.merged) {
          results.push({ issueKey, status: "merged", prUrl: pr.url });
          continue;
        }
        if (outcome.reason !== "conflict") {
          results.push({
            issueKey,
            status: "blocked",
            prUrl: pr.url,
            detail: outcome.detail,
          });
          continue;
        }
        await startJiraRunForIssue(ctx, integration, issueKey, {
          instruction: null,
          actorId: userId,
          pr: { number: pr.number, url: pr.url },
          resolveConflict: true,
        });
        results.push({
          issueKey,
          status: "resolving",
          prUrl: pr.url,
          detail: outcome.detail,
        });
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
