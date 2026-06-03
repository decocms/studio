/**
 * AUTOMATION_TRIGGER_ADD Tool
 *
 * Adds a trigger (cron, event, or webhook) to an automation.
 * - Cron triggers: validated with croner, minimum interval enforced
 *   (`AUTOMATION_CRON_MIN_INTERVAL_MS`) to keep one tenant from flooding the
 *   DBOS scheduler and gate queues.
 * - Event triggers: fail-atomic — if TRIGGER_CONFIGURE call fails, trigger is not inserted
 * - Webhook triggers: mint a Better Auth API key scoped to the trigger and
 *   return the plaintext token + URL. Token is shown only here.
 */

import { computeNextRunAt } from "../../automations/fire";
import { syncTriggerCreated } from "../../automations/dbos-sync";
import { Cron } from "croner";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { configureTriggerOnMcp } from "./configure-trigger";
import { webhookPermissionResource, webhookUrl } from "./webhook-trigger";

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
    "Add a cron, event, or webhook trigger to an automation. For webhook triggers the response includes a one-time URL + secret token.",
  annotations: {
    title: "Add Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    automation_id: z.string(),
    type: z.enum(["cron", "event", "webhook"]),
    cron_expression: z.string().optional(),
    connection_id: z.string().optional(),
    event_type: z.string().optional(),
    params: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    automation_id: z.string(),
    type: z.enum(["cron", "event", "webhook"]),
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
