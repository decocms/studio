/**
 * JIRA_RUN_START — fire an automation on Jira issues, now.
 *
 * How a Jira automation gets tried before it is switched on for every issue
 * that enters a column, and how one is run by hand on issues no move picked:
 * name the automation and the issues, watch the runs. The integration and the
 * automation can both be off. Each run is the automation's real run, through the automation fire
 * workflow (`automations/jira-run.ts`): it reads and comments on the actual
 * issue, continues the pull request the issue links, and takes over any run
 * still working that issue.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fireAutomationDirect } from "@/automations/dbos-sync";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { parseIssueKeys } from "@decocms/shared/jira/issue-key";
import { JiraClient } from "@/jira/client";
import { issueUrl } from "@/jira/issue-prompt";

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
    "Fire an automation on Jira issues right now — how a Jira automation is " +
    "tried out before it runs on every issue entering its status, or run on " +
    "issues no move picked. Works with the integration disabled and the " +
    "automation off. The " +
    "automation's message is the instruction and the issue itself is always " +
    "in the run's message. One run per issue, or one run for all of them " +
    "with `together`. These are real runs on the real issues: a per-issue " +
    "run continues the pull request the issue links and takes over any run " +
    "still working that issue.",
  inputSchema: z.object({
    automationId: z
      .string()
      .min(1)
      .describe(
        "The automation to fire — see JIRA_AUTOMATION_LIST or AUTOMATION_LIST.",
      ),
    issueKey: z
      .string()
      .min(1)
      .max(MAX_ISSUE_INPUT_LENGTH)
      .describe(
        "One or more issue keys (ABC-123) or pasted links, separated by " +
          "newlines or commas. One run is started per issue.",
      ),
    together: z
      .boolean()
      .optional()
      .describe(
        "Start ONE run that works every issue named, instead of one run per " +
          "issue — for work that spans them, like landing an epic's pull " +
          "requests in order. Its Jira tools take `issueKey` to say which " +
          "issue they act on, and it starts fresh rather than continuing a " +
          "pull request.",
      ),
  }),
  outputSchema: z.object({
    /** One entry per issue, in the order given. A batch reports per issue
     *  rather than failing whole: one unreachable issue must not cost the
     *  others their runs, and the caller needs to know WHICH one it was. */
    started: z.array(z.object({ issueKey: z.string(), issueUrl: z.string() })),
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
    const automation = await ctx.storage.automations.findById(
      input.automationId,
      organization.id,
    );
    if (!automation) throw new Error("Automation not found");
    if (automation.system_key) {
      throw new Error(
        "A built-in automation runs on the board's cards and can't be run on Jira issues by hand.",
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

    // Read up front so a bad key is reported here, not as a fire that skips.
    // Sequential on purpose: a paste of twenty must not become a burst.
    const client = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );
    const readable: string[] = [];
    const failed: Array<{ issueKey: string; error: string }> = [];
    for (const key of keys) {
      try {
        readable.push((await client.getIssue(key)).key);
      } catch (err) {
        failed.push({
          issueKey: key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // A manual fire is listed under the automation's Jira trigger when it has one.
    const triggerId =
      (await ctx.storage.automations.listTriggers(automation.id)).find(
        (trigger) => trigger.type === "jira_transition",
      )?.id ?? null;
    const runs = input.together ? [readable] : readable.map((key) => [key]);
    const started: Array<{ issueKey: string; issueUrl: string }> = [];
    // Run off the queue and waited on, like a card's Run: a refusal (the
    // paywall included) has to reach the person who asked.
    for (const issues of runs) {
      if (issues.length === 0) continue;
      const outcome = await fireAutomationDirect(
        {
          automationId: automation.id,
          organizationId: organization.id,
          triggerId,
          target: {
            kind: "jira",
            issues,
            eventKey: `manual:${randomUUID()}`,
            manual: { requestedBy: userId },
          },
        },
        { idempotencyKey: `jira-manual:${randomUUID()}` },
      ).catch((err: unknown) => ({
        skipped: "rejected" as const,
        error: { message: err instanceof Error ? err.message : String(err) },
      }));
      if ("skipped" in outcome) {
        const error = outcome.error?.message ?? `skipped: ${outcome.skipped}`;
        failed.push(...issues.map((issueKey) => ({ issueKey, error })));
        continue;
      }
      started.push(
        ...issues.map((key) => ({
          issueKey: key,
          issueUrl: issueUrl(integration.siteUrl, key),
        })),
      );
    }
    return { started, failed, unreadable: invalid };
  },
});
