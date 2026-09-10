/**
 * JIRA_AUTOMATION_* — which Jira statuses start an agent run, and with what
 * instruction. Keyed by the status NAME: a Jira column is a bucket of statuses
 * and the webhook reports the status, so that is the thing a rule can be on.
 * Row existence is the switch, like the board's own column rules.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { MAX_AUTOMATION_PROMPT_LENGTH } from "@/tools/task-board/schema";

const MAX_STATUS_NAME_LENGTH = 200;

const AutomationSchema = z.object({
  jiraStatus: z.string(),
  prompt: z.string().nullable(),
});

export const JIRA_AUTOMATION_LIST = defineTool({
  name: "JIRA_AUTOMATION_LIST",
  description:
    "List the Jira statuses that start an agent run when an issue enters " +
    "them. A status with no rule is uneventful.",
  inputSchema: z.object({}),
  outputSchema: z.object({ automations: z.array(AutomationSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    return {
      automations: await ctx.storage.jiraIntegrations.listAutomations(
        organization.id,
      ),
    };
  },
});

export const JIRA_AUTOMATION_UPSERT = defineTool({
  name: "JIRA_AUTOMATION_UPSERT",
  description:
    "Run the agent on every issue that enters a Jira status. Replaces the " +
    "rule already on that status, if any. Omit `prompt` for the agent's own " +
    "instruction; give one to say what it should do there. The issue itself " +
    "is always in the run's message, so the prompt is the instruction, not " +
    "the whole message.",
  inputSchema: z.object({
    jiraStatus: z
      .string()
      .min(1)
      .max(MAX_STATUS_NAME_LENGTH)
      .describe("A status name of the board — see JIRA_BOARD_COLUMNS_LIST."),
    prompt: z
      .string()
      .max(MAX_AUTOMATION_PROMPT_LENGTH)
      .nullable()
      .optional()
      .describe("What to do with an issue landing here; null for the default."),
  }),
  outputSchema: z.object({ automation: AutomationSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const prompt = input.prompt?.trim() ? input.prompt.trim() : null;
    return {
      automation: await ctx.storage.jiraIntegrations.upsertAutomation(
        organization.id,
        input.jiraStatus.trim(),
        prompt,
      ),
    };
  },
});

export const JIRA_AUTOMATION_DELETE = defineTool({
  name: "JIRA_AUTOMATION_DELETE",
  description:
    "Stop running the agent on issues entering a Jira status. Removing the " +
    "rule IS the off switch.",
  inputSchema: z.object({ jiraStatus: z.string().min(1) }),
  outputSchema: z.object({ removed: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    return {
      removed: await ctx.storage.jiraIntegrations.removeAutomation(
        organization.id,
        input.jiraStatus,
      ),
    };
  },
});
