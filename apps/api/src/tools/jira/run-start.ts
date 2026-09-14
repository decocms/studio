/**
 * JIRA_RUN_START — run the agent on one Jira issue, now.
 *
 * How a status rule gets tried before it is switched on for every issue that
 * enters a column: name an issue, give the prompt you are about to save, watch
 * the run. No rule has to exist and the integration can be disabled, so
 * nothing has to be dragged around a real board to see what the agent does.
 *
 * The run is the real one, not a simulation — it reads and comments on the
 * actual issue. Firing it again takes over any run still working that issue,
 * the same way a card's Re-run does.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { parseIssueKey } from "@/jira/issue-key";
import { startJiraRunForIssue } from "@/jira/trigger";
import { MAX_AUTOMATION_PROMPT_LENGTH } from "@/tools/task-board/schema";

/** Generous — the input also accepts a pasted issue URL. */
const MAX_ISSUE_INPUT_LENGTH = 500;

export const JIRA_RUN_START = defineTool({
  name: "JIRA_RUN_START",
  description:
    "Run the agent on ONE Jira issue right now — how a status rule is tried " +
    "out before it runs on every issue entering that status. Needs no rule " +
    "for the issue's status and works with the integration disabled. " +
    "`prompt` is the instruction to try; omit it for the agent's own. The " +
    "issue itself is always in the run's message. This is a real run on the " +
    "real issue, and it takes over any run still working that issue.",
  inputSchema: z.object({
    issueKey: z
      .string()
      .min(1)
      .max(MAX_ISSUE_INPUT_LENGTH)
      .describe("An issue key (ABC-123) or a pasted link to the issue."),
    prompt: z
      .string()
      .max(MAX_AUTOMATION_PROMPT_LENGTH)
      .nullable()
      .optional()
      .describe("What to do with the issue; null for the agent's default."),
  }),
  outputSchema: z.object({
    issueKey: z.string(),
    issueUrl: z.string(),
    /** The hidden board item the run hangs off — its id in the monitoring
     *  history, not a card anyone sees. */
    itemId: z.string(),
    supersededThreadIds: z
      .array(z.string())
      .describe("Runs that were stopped to make room for this one."),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

    const issueKey = parseIssueKey(input.issueKey);
    if (!issueKey) {
      throw new Error(
        `"${input.issueKey}" is not a Jira issue key — expected something like ABC-123, or a link to the issue`,
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

    const { item, issue, supersededThreadIds } = await startJiraRunForIssue(
      ctx,
      integration,
      issueKey,
      {
        instruction: input.prompt?.trim() ? input.prompt.trim() : null,
        actorId: userId,
      },
    );
    return {
      issueKey: issue.key,
      issueUrl: issue.url,
      itemId: item.id,
      supersededThreadIds,
    };
  },
});
