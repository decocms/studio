/**
 * JIRA_PR_MERGE — land the pull requests a batch of Jira issues carries.
 *
 * The tool only starts the work: a batch is eight issues, up to two
 * repositories each, three remote calls per repository, and a request holding
 * ~40 sequential calls open is a request that can die after merging half of
 * them with no record of which. The merging itself is a durable workflow
 * (`jira/dbos-pr-merge.ts`), which survives that and writes its outcome where
 * the rest of the integration writes: a comment on the issue.
 *
 * Deliberately NOT the board's merge (`task-board/merge-pr.ts`). That one is
 * built around a card: it reads linked pull requests out of board storage,
 * consults review cycles and lanes, and writes refusals to a card timeline. A
 * Jira issue has none of those — the pull request lives on the issue as a web
 * link, and "approved" is a column, not a review cycle. Sharing would have
 * meant threading two interfaces through a file whose shape is the board, to
 * reuse about seventy lines.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { parseIssueKeys } from "@decocms/shared/jira/issue-key";
import { enqueueJiraPrMerge } from "@/jira/dbos-pr-merge";
import { MAX_ISSUE_INPUT_LENGTH, MAX_ISSUES_PER_CALL } from "./run-start";

export const JIRA_PR_MERGE = defineTool({
  name: "JIRA_PR_MERGE",
  description:
    "Merge the pull requests each Jira issue carries as web links — one per " +
    "repository, since a change can span two storefronts and both halves are " +
    "the delivery. Starts a durable batch and returns immediately; the " +
    "outcome of each issue is posted as a comment on that issue. A green pull " +
    "request merges with no agent run at all. A merge conflict — the one " +
    "refusal with an automatic answer — starts ONE run that rebases every " +
    "conflicting pull request on that issue; merge again once it finishes. " +
    "Any other refusal (a failing check, branch protection) is reported and " +
    "left for a person. Takes several issues: keys or links, one per line or " +
    "comma-separated.",
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
  outputSchema: z.object({
    issueKeys: z
      .array(z.string())
      .describe("The issues this batch will work, in order."),
    workflowId: z
      .string()
      .describe("The durable batch, for finding it in monitoring."),
    unreadable: z
      .array(z.string())
      .describe("Pieces of the input that are not an issue key or link."),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

    const { keys, invalid } = parseIssueKeys(input.issueKey);
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
    // Checked here rather than inside the workflow so a misconfigured org
    // fails the click instead of starting a batch that can only fail.
    const integration = await ctx.storage.jiraIntegrations.getByOrg(
      organization.id,
    );
    if (!integration) {
      throw new Error(
        "Jira is not connected — save credentials with JIRA_INTEGRATION_UPSERT first",
      );
    }

    const workflowId = await enqueueJiraPrMerge({
      organizationId: organization.id,
      issueKeys: keys,
      actorId: userId,
    });
    return { issueKeys: keys, workflowId, unreadable: invalid };
  },
});
