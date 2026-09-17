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
import { parseIssueKeys } from "@decocms/shared/jira/issue-key";
import { startJiraRunForIssue } from "@/jira/trigger";
import { MAX_AUTOMATION_PROMPT_LENGTH } from "@/tools/task-board/schema";

/** Generous — the input accepts a pasted column of issue URLs. */
const MAX_ISSUE_INPUT_LENGTH = 8_000;

/**
 * How many issues one call may start. Each is a paid sandbox run, so a
 * fat-fingered paste of a whole board should be refused up front rather than
 * discovered as a bill. Well above any real batch.
 */
const MAX_ISSUES_PER_CALL = 25;

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
      .describe(
        "One or more issue keys (ABC-123) or pasted links, separated by " +
          "newlines or commas. One run is started per issue.",
      ),
    prompt: z
      .string()
      .max(MAX_AUTOMATION_PROMPT_LENGTH)
      .nullable()
      .optional()
      .describe("What to do with the issue; null for the agent's default."),
  }),
  outputSchema: z.object({
    /**
     * One entry per issue, in the order given. A batch reports per issue
     * rather than failing whole: one unreachable issue must not cost the
     * other nine their runs, and the caller needs to know WHICH one it was.
     */
    started: z.array(
      z.object({
        issueKey: z.string(),
        issueUrl: z.string(),
        /** The hidden board item the run hangs off — its id in the monitoring
         *  history, not a card anyone sees. */
        itemId: z.string(),
        supersededThreadIds: z
          .array(z.string())
          .describe("Runs that were stopped to make room for this one."),
      }),
    ),
    failed: z
      .array(z.object({ issueKey: z.string(), error: z.string() }))
      .describe("Issues whose run could not be started, and why."),
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
        `${keys.length} issues named, and ${MAX_ISSUES_PER_CALL} is the most one call starts — each is a real run`,
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
    const instruction = input.prompt?.trim() ? input.prompt.trim() : null;

    // Sequential on purpose. Each start reads the issue from Jira and claims a
    // run slot, and firing a paste of twenty at once turns one fat finger into
    // a burst against both. The loop is also what lets one bad issue report
    // itself while the rest still go.
    const started: Array<{
      issueKey: string;
      issueUrl: string;
      itemId: string;
      supersededThreadIds: string[];
    }> = [];
    const failed: Array<{ issueKey: string; error: string }> = [];
    for (const key of keys) {
      try {
        const { item, issue, supersededThreadIds } = await startJiraRunForIssue(
          ctx,
          integration,
          key,
          { instruction, actorId: userId },
        );
        started.push({
          issueKey: issue.key,
          issueUrl: issue.url,
          itemId: item.id,
          supersededThreadIds,
        });
      } catch (err) {
        failed.push({
          issueKey: key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { started, failed, unreadable: invalid };
  },
});
