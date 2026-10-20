/**
 * JIRA_AUTOMATION_* — which Jira statuses fire an automation when an issue
 * enters them, and with what instruction. A rule here is an automation on the
 * Super Agent with one `jira_transition` trigger: these tools are the Jira
 * settings page's view of those, keyed by status and origin
 * (`jira/rule-from.ts`) the way the page edits them.
 */

import { getDecopilotId } from "@decocms/shared/sdk";
import { z } from "zod";
import { automationInstruction } from "@/automations/board-column-transition";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import {
  fromKey,
  JiraStatusNameSchema,
  normalizeFrom,
  type RuleFrom,
  RuleFromSchema,
  ruleConflict,
  ruleFromColumns,
} from "@/jira/rule-from";
import { normalizeMessages } from "@/tools/automations/normalize-messages";
import { MAX_AUTOMATION_PROMPT_LENGTH } from "@/tools/task-board/schema";

const AutomationSchema = z.object({
  automationId: z.string(),
  jiraStatus: z.string(),
  from: RuleFromSchema,
  prompt: z.string().nullable(),
  active: z.boolean(),
});

type JiraRule = z.infer<typeof AutomationSchema>;

async function listRules(
  ctx: StudioContext,
  organizationId: string,
  jiraStatus?: string,
): Promise<(JiraRule & { triggerId: string })[]> {
  const triggers = await ctx.storage.automations.listJiraTransitionTriggers(
    organizationId,
    jiraStatus === undefined ? undefined : { jiraStatus },
  );
  return triggers
    .map((trigger) => ({
      automationId: trigger.automation_id,
      triggerId: trigger.id,
      jiraStatus: trigger.column_key ?? "",
      from: ruleFromColumns(trigger),
      prompt: automationInstruction(trigger.automation.messages) || null,
      active: trigger.automation.active,
    }))
    .sort(
      (a, b) =>
        a.jiraStatus.localeCompare(b.jiraStatus) ||
        fromKey(a.from).localeCompare(fromKey(b.from)),
    );
}

function ruleName(jiraStatus: string, from: RuleFrom): string {
  const origin =
    from.kind === "earlier"
      ? " (from an earlier column)"
      : from.kind === "later"
        ? " (from a later column)"
        : from.kind === "statuses"
          ? ` (from ${from.statuses.join(", ")})`
          : "";
  return `Jira: ${jiraStatus}${origin}`;
}

function promptMessages(prompt: string | null): string {
  return JSON.stringify(
    prompt
      ? normalizeMessages([
          { role: "user", parts: [{ type: "text", text: prompt }] },
        ])
      : [],
  );
}

const withoutTrigger = ({
  triggerId: _,
  ...rule
}: JiraRule & { triggerId: string }) => rule;

export const JIRA_AUTOMATION_LIST = defineTool({
  name: "JIRA_AUTOMATION_LIST",
  description:
    "List the automations that fire when a Jira issue enters a status, with " +
    "the status, the origin each answers and its instruction. A status with " +
    "none is uneventful.",
  inputSchema: z.object({}),
  outputSchema: z.object({ automations: z.array(AutomationSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    return {
      automations: (await listRules(ctx, organization.id)).map(withoutTrigger),
    };
  },
});

export const JIRA_AUTOMATION_UPSERT = defineTool({
  name: "JIRA_AUTOMATION_UPSERT",
  description:
    "Run the Super Agent on every issue that enters a Jira status from an " +
    "origin (`from`, default any): creates an automation with a " +
    "jira_transition trigger, or sets the instruction of the one already on " +
    "that status for the same origin. Omit `prompt` for the agent's own " +
    "instruction. The issue itself is always in the run's message, so the " +
    "prompt is the instruction, not the whole message. A run on an issue that " +
    "links an open pull request continues it.",
  inputSchema: z.object({
    jiraStatus: JiraStatusNameSchema.describe(
      "A status name of the board — see JIRA_BOARD_COLUMNS_LIST.",
    ),
    from: RuleFromSchema.optional(),
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
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");
    const prompt = input.prompt?.trim() ? input.prompt.trim() : null;
    const { jiraStatus } = input;
    const from = normalizeFrom(input.from ?? { kind: "any" });
    const rules = await listRules(ctx, organization.id, jiraStatus);
    const same = rules.find((rule) => fromKey(rule.from) === fromKey(from));
    const conflict = ruleConflict(
      jiraStatus,
      from,
      rules.filter((rule) => rule !== same).map((rule) => rule.from),
    );
    if (conflict) throw new Error(conflict);

    if (same) {
      const updated = await ctx.storage.automations.update(
        same.automationId,
        organization.id,
        { messages: promptMessages(prompt) },
      );
      return {
        automation: { ...withoutTrigger(same), prompt, active: updated.active },
      };
    }
    const automation = await ctx.storage.automations.create({
      organization_id: organization.id,
      name: ruleName(jiraStatus, from),
      active: true,
      created_by: userId,
      messages: promptMessages(prompt),
      models: JSON.stringify({ tier: "smart" }),
      virtual_mcp_id: getDecopilotId(organization.id),
    });
    await ctx.storage.automations.addTrigger({
      automation_id: automation.id,
      type: "jira_transition",
      column_key: jiraStatus,
      from_kind: from.kind,
      from_statuses: from.kind === "statuses" ? from.statuses : [],
    });
    return {
      automation: {
        automationId: automation.id,
        jiraStatus,
        from,
        prompt,
        active: true,
      },
    };
  },
});
