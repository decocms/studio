/**
 * AUTOMATION_TRIGGER_ADD Tool
 *
 * Adds a trigger (cron, event, webhook, or board column transition) to an
 * automation.
 * - Cron triggers: validated with croner, minimum interval enforced
 *   (`AUTOMATION_CRON_MIN_INTERVAL_MS`) to keep one tenant from flooding the
 *   DBOS scheduler and gate queues.
 * - Event triggers: fail-atomic — if TRIGGER_CONFIGURE call fails, trigger is not inserted
 * - Webhook triggers: mint a Better Auth API key scoped to the trigger and
 *   return the plaintext token + URL. Token is shown only here.
 * - Board column transition triggers: fire when a card settles in a column
 *   of this org's board (`automations/board-column-transition.ts`).
 * - Jira transition triggers: fire when an issue of the org's Jira board
 *   settles in a status (`jira/trigger.ts`). A move answers one of them, so
 *   two on a status may not claim the same origin.
 */

import { computeNextRunAt } from "../../automations/fire";
import { syncTriggerCreated } from "../../automations/dbos-sync";
import { Cron } from "croner";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { configureTriggerOnMcp } from "./configure-trigger";
import { webhookPermissionResource, webhookUrl } from "./webhook-trigger";
import {
  BoardColumnKeySchema,
  BoardTransitionFromSchema,
} from "../../automations/board-column-transition";
import {
  JiraStatusNameSchema,
  normalizeFrom,
  RuleFromSchema,
  ruleConflict,
  ruleFromColumns,
} from "../../jira/rule-from";
import { AutomationTriggerTypeSchema } from "./trigger-schema";

// Cluster-wide floor on cron firing frequency. Tighter than the 60s floor
// the old NATS dispatcher allowed: each fire writes ~4 DBOS workflow rows
// plus org/automation gate slot acquisitions, so an every-minute trigger
// across N automations multiplies system-DB writes by 60·N per hour. 5 min
// keeps system-DB growth tractable across our 3–10 replica deploy and
// leaves headroom for legitimate every-5-min crons.
const AUTOMATION_CRON_MIN_INTERVAL_MS = 5 * 60 * 1000;

// Look at this many upcoming runs to find the smallest gap. A 2-run check
// misses irregular crons (e.g. "0,7,9 * * * *") where the tight pair isn't
// the first one.
const CRON_PROBE_RUNS = 10;

export const AUTOMATION_TRIGGER_ADD = defineTool({
  name: "AUTOMATION_TRIGGER_ADD",
  description:
    "Add a cron, event, webhook, board column transition or Jira transition " +
    "trigger to an automation. For webhook triggers the response includes a " +
    "one-time URL + secret token. A board_column_transition trigger runs the " +
    "automation on each card that enters `column_key` (after it stays there " +
    "a few seconds), with the card as the run's task. A jira_transition " +
    "trigger runs it on each issue of the org's Jira board that enters " +
    "`jira_status`, with the issue in the run's message.",
  annotations: {
    title: "Add Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    automation_id: z.string(),
    type: AutomationTriggerTypeSchema,
    cron_expression: z.string().optional(),
    connection_id: z.string().optional(),
    event_type: z.string().optional(),
    params: z.record(z.string(), z.string()).optional(),
    column_key: BoardColumnKeySchema.optional().describe(
      "For board_column_transition: the board column a card enters.",
    ),
    jira_status: JiraStatusNameSchema.optional().describe(
      "For jira_transition: the Jira status an issue enters — a status " +
        "name from JIRA_BOARD_COLUMNS_LIST, not a column name.",
    ),
    from: RuleFromSchema.optional().describe(
      "For board_column_transition and jira_transition: which moves count, " +
        "by where the card came from (board column keys, or Jira status " +
        "names). Defaults to any.",
    ),
  }),
  outputSchema: z.object({
    id: z.string(),
    automation_id: z.string(),
    type: AutomationTriggerTypeSchema,
    created_at: z.string(),
    // Only set for `type: "webhook"`. The token is plaintext and is
    // shown only here — rotate via AUTOMATION_TRIGGER_ROTATE_TOKEN.
    webhook: z
      .object({
        url: z.string(),
        token: z.string(),
      })
      .nullable()
      .optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Validate automation exists and belongs to org
    const automation = await ctx.storage.automations.findById(
      input.automation_id,
      organization.id,
    );
    if (!automation) {
      throw new Error("Automation not found");
    }
    if (automation.system_key) {
      throw new Error("A built-in automation's starters can't be changed.");
    }

    if (input.type === "board_pr_ready") {
      throw new Error(
        "The pull-request-ready starter belongs to the built-in Reviewer for now.",
      );
    }

    if (input.type === "cron") {
      if (!input.cron_expression) {
        throw new Error("cron_expression is required for cron triggers");
      }

      // Validate cron expression
      const cron = new Cron(input.cron_expression, { timezone: "UTC" });
      const runs = cron.nextRuns(CRON_PROBE_RUNS);

      // Validate the expression has future runs
      if (runs.length === 0) {
        throw new Error("Cron expression has no future runs");
      }

      // Take the smallest gap across the probe window — `0,7,9 * * * *`
      // looks fine at runs[0..1] but has a 2-min gap at runs[1..2].
      let minGapMs = Infinity;
      for (let i = 1; i < runs.length; i++) {
        const gap = runs[i]!.getTime() - runs[i - 1]!.getTime();
        if (gap < minGapMs) minGapMs = gap;
      }
      if (
        runs.length >= 2 &&
        Number.isFinite(minGapMs) &&
        minGapMs < AUTOMATION_CRON_MIN_INTERVAL_MS
      ) {
        const minSeconds = AUTOMATION_CRON_MIN_INTERVAL_MS / 1000;
        throw new Error(
          `Cron fires too frequently — minimum interval is ${minSeconds}s between runs (observed ${minGapMs / 1000}s)`,
        );
      }
    }

    if (input.type === "event") {
      if (!input.connection_id) {
        throw new Error("connection_id is required for event triggers");
      }
      if (!input.event_type) {
        throw new Error("event_type is required for event triggers");
      }

      // Validate connection belongs to this organization
      const connection = await ctx.storage.connections.findById(
        input.connection_id,
        organization.id,
      );
      if (!connection) {
        throw new Error("Connection not found");
      }

      // Build a temporary trigger object for configureTriggerOnMcp
      const tempTrigger = {
        id: "",
        automation_id: input.automation_id,
        type: "event" as const,
        cron_expression: null,
        connection_id: input.connection_id,
        event_type: input.event_type,
        params: input.params ? JSON.stringify(input.params) : null,
        last_run_at: null,
        next_run_at: null,
        api_key_id: null,
        column_key: null,
        from_kind: null,
        from_statuses: [],
        created_at: "",
      };

      // Fail-atomic: if TRIGGER_CONFIGURE fails, do NOT insert trigger
      const result = await configureTriggerOnMcp(
        ctx,
        tempTrigger,
        true,
        ctx.storage.triggerCallbackTokens,
      );
      if (!result.success) {
        throw new Error(
          `Failed to configure trigger on connection: ${result.error}`,
        );
      }
    }

    if (input.type === "board_column_transition" && !input.column_key) {
      throw new Error(
        "column_key is required for board_column_transition triggers",
      );
    }
    if (input.type === "board_column_transition" && input.from) {
      BoardTransitionFromSchema.parse(input.from);
    }
    if (input.type === "jira_transition" && !input.jira_status) {
      throw new Error("jira_status is required for jira_transition triggers");
    }
    const from =
      input.type === "board_column_transition" ||
      input.type === "jira_transition"
        ? normalizeFrom(input.from ?? { kind: "any" })
        : null;
    if (input.type === "jira_transition" && input.jira_status && from) {
      const conflict = ruleConflict(
        input.jira_status,
        from,
        (
          await ctx.storage.automations.listJiraTransitionTriggers(
            organization.id,
            { jiraStatus: input.jira_status },
          )
        ).map(ruleFromColumns),
      );
      if (conflict) throw new Error(conflict);
    }

    const nextRunAt =
      input.type === "cron" && input.cron_expression
        ? computeNextRunAt(input.cron_expression, new Date())
        : null;

    const trigger = await ctx.storage.automations.addTrigger({
      automation_id: input.automation_id,
      type: input.type,
      cron_expression: input.type === "cron" ? input.cron_expression : null,
      connection_id: input.type === "event" ? input.connection_id : null,
      event_type: input.type === "event" ? input.event_type : null,
      params: input.params ? JSON.stringify(input.params) : null,
      next_run_at: nextRunAt?.toISOString() ?? null,
      column_key:
        input.type === "board_column_transition"
          ? input.column_key
          : input.type === "jira_transition"
            ? input.jira_status
            : null,
      from_kind: from?.kind ?? null,
      from_statuses: from?.kind === "statuses" ? from.statuses : [],
    });

    // For webhook triggers, mint a Better Auth API key now that we know
    // the trigger id (so the permission can be scoped to it). If the key
    // creation fails, roll the trigger insert back so the user doesn't
    // end up with an unfireable webhook trigger.
    let webhook: { url: string; token: string } | null = null;
    if (input.type === "webhook") {
      try {
        const created = await ctx.boundAuth.apiKey.create({
          name: `webhook:${automation.name}:${trigger.id.slice(0, 8)}`,
          permissions: { [webhookPermissionResource(trigger.id)]: ["FIRE"] },
          metadata: {
            kind: "webhook_trigger",
            automation_id: automation.id,
            trigger_id: trigger.id,
          },
        });
        await ctx.storage.automations.setTriggerApiKeyId(
          trigger.id,
          created.id,
        );
        webhook = {
          url: webhookUrl(ctx.baseUrl, organization.slug, trigger.id),
          token: created.key,
        };
      } catch (err) {
        await ctx.storage.automations.removeTrigger(
          trigger.id,
          trigger.automation_id,
        );
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to mint webhook token: ${msg}`);
      }
    }

    // Register the DBOS schedule for cron triggers so it fires without
    // waiting for the boot-time reconciler. Event triggers don't have
    // schedules (they fire on AutomationEventDispatcher.dispatchForEvents).
    // Webhook triggers also have no schedule — they fire on HTTP POST.
    await syncTriggerCreated(trigger, automation);

    return {
      id: trigger.id,
      automation_id: trigger.automation_id,
      type: trigger.type,
      created_at: trigger.created_at,
      webhook,
    };
  },
});
