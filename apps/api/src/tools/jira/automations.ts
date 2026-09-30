/**
 * JIRA_AUTOMATION_* — which Jira statuses start an agent run, and with what
 * instruction. Keyed by the status NAME: a Jira column is a bucket of statuses
 * and the webhook reports the status, so that is the thing a rule can be on.
 * A status can carry one rule per origin (`jira/rule-from.ts`). Row existence
 * is the switch, like the board's own column rules.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { fromKey, normalizeFrom, sharedStatuses } from "@/jira/rule-from";
import { MAX_AUTOMATION_PROMPT_LENGTH } from "@/tools/task-board/schema";

const MAX_STATUS_NAME_LENGTH = 200;
const MAX_FROM_STATUSES = 50;

const FromSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("any") }),
    z.object({ kind: z.literal("earlier") }),
    z.object({ kind: z.literal("later") }),
    z.object({
      kind: z.literal("statuses"),
      statuses: z
        .array(z.string().trim().min(1).max(MAX_STATUS_NAME_LENGTH))
        .min(1)
        .max(MAX_FROM_STATUSES),
    }),
  ])
  .describe(
    "Which moves into the status the rule answers, by where the card last " +
      "rested: `any`; `earlier` (a column left of this one on the board — " +
      "the normal flow); `later` (a column right of it — sent back); or " +
      "`statuses`, named outright. A move answers ONE rule: a list naming " +
      "its origin, else the rule for its direction, else `any`.",
  );

const AutomationSchema = z.object({
  jiraStatus: z.string(),
  from: FromSchema,
  prompt: z.string().nullable(),
  continuePr: z.boolean(),
});

export const JIRA_AUTOMATION_LIST = defineTool({
  name: "JIRA_AUTOMATION_LIST",
  description:
    "List the Jira statuses that start an agent run when an issue enters " +
    "them, with the origin each rule answers. A status with no rule is " +
    "uneventful.",
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
    "Run the agent on every issue that enters a Jira status from an origin " +
    "(`from`, default any). Replaces the rule already on that status for the " +
    "same origin, if any. Omit `prompt` for the agent's own instruction; give " +
    "one to say what it should do there. The issue itself is always in the " +
    "run's message, so the prompt is the instruction, not the whole message.",
  inputSchema: z.object({
    jiraStatus: z
      .string()
      .min(1)
      .max(MAX_STATUS_NAME_LENGTH)
      .describe("A status name of the board — see JIRA_BOARD_COLUMNS_LIST."),
    from: FromSchema.optional(),
    prompt: z
      .string()
      .max(MAX_AUTOMATION_PROMPT_LENGTH)
      .nullable()
      .optional()
      .describe("What to do with an issue landing here; null for the default."),
    continuePr: z
      .boolean()
      .optional()
      .describe(
        "Runs this rule starts continue the pull request the issue already " +
          "carries as a web link, instead of opening a new one — for a card " +
          "a reviewer or the client sent back. An issue with no open pull " +
          "request still starts fresh. Leave off on a review column, or its " +
          "run is pinned to the pull request it is meant to judge.",
      ),
  }),
  outputSchema: z.object({ automation: AutomationSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const prompt = input.prompt?.trim() ? input.prompt.trim() : null;
    const jiraStatus = input.jiraStatus.trim();
    const from = normalizeFrom(input.from ?? { kind: "any" });
    const key = fromKey(from);
    for (const other of await ctx.storage.jiraIntegrations.listAutomationsFor(
      organization.id,
      jiraStatus,
    )) {
      if (fromKey(other.from) === key) continue;
      const shared = sharedStatuses(from, other.from);
      if (shared.length > 0) {
        throw new Error(
          `Another rule on "${jiraStatus}" already answers moves from ` +
            `${shared.map((name) => `"${name}"`).join(", ")}. A move answers ` +
            "one rule: take the status out of one of the lists.",
        );
      }
    }
    return {
      automation: await ctx.storage.jiraIntegrations.upsertAutomation(
        organization.id,
        { jiraStatus, from, prompt, continuePr: input.continuePr ?? false },
      ),
    };
  },
});

export const JIRA_AUTOMATION_DELETE = defineTool({
  name: "JIRA_AUTOMATION_DELETE",
  description:
    "Stop running the agent on issues entering a Jira status from an origin " +
    "(`from`, default any). Removing the rule IS the off switch.",
  inputSchema: z.object({
    jiraStatus: z.string().min(1),
    from: FromSchema.optional(),
  }),
  outputSchema: z.object({ removed: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    return {
      removed: await ctx.storage.jiraIntegrations.removeAutomation(
        organization.id,
        input.jiraStatus,
        input.from,
      ),
    };
  },
});
