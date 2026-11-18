import { z } from "zod";
import { ORDER_MONITOR_ALERT_SOURCE } from "@decocms/shared/alerts";
import {
  ORDER_MONITOR_DEFAULT_THRESHOLDS,
  ORDER_MONITOR_RULES,
} from "@decocms/shared/order-monitor";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { loadThresholds } from "@/monitoring/order-alerts";

const ThresholdSchema = z.object({
  threshold: z.number(),
  minVolume: z.number(),
});

export const ALERT_RULES_LIST = defineTool({
  name: "ALERT_RULES_LIST",
  description:
    "List the alert rules and the thresholds the organization alerts at. orders_drop: alerts when an hour brings less than `threshold` % of the expected orders, once at least `minVolume` orders were expected. cancel_spike / denied_spike: alerts at `threshold` times the expected cancellations or payment denials in an hour, and at least `minVolume` of them.",
  annotations: {
    title: "List Alert Rules",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    rules: z.array(
      ThresholdSchema.extend({
        source: z.string(),
        rule: z.enum(ORDER_MONITOR_RULES),
        defaults: ThresholdSchema,
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    const thresholds = await loadThresholds(ctx.storage.alerts, org.id);
    return {
      rules: ORDER_MONITOR_RULES.map((rule) => ({
        source: ORDER_MONITOR_ALERT_SOURCE,
        rule,
        ...thresholds[rule],
        defaults: ORDER_MONITOR_DEFAULT_THRESHOLDS[rule],
      })),
    };
  },
});

export const ALERT_RULE_UPDATE = defineTool({
  name: "ALERT_RULE_UPDATE",
  description:
    "Set the thresholds an alert rule alerts at for the organization (see ALERT_RULES_LIST for what each means). orders_drop's `threshold` is a percentage of expected (1–99); the spikes' is a multiple of expected (above 1). The monitor applies them from its next check, every 5 minutes.",
  annotations: {
    title: "Update Alert Rule",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z
    .object({
      rule: z.enum(ORDER_MONITOR_RULES),
      threshold: z.number().positive().max(1000),
      minVolume: z.number().min(0).max(100_000),
    })
    .refine(
      (r) =>
        r.rule === "orders_drop"
          ? r.threshold >= 1 && r.threshold <= 99
          : r.threshold > 1,
      {
        message:
          "orders_drop's threshold is a percentage from 1 to 99; a spike's is a multiple above 1",
        path: ["threshold"],
      },
    ),
  outputSchema: z.object({ rule: z.enum(ORDER_MONITOR_RULES) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    await ctx.storage.alerts.setRuleSetting(
      org.id,
      {
        source: ORDER_MONITOR_ALERT_SOURCE,
        rule: input.rule,
        threshold: input.threshold,
        minVolume: input.minVolume,
      },
      getUserId(ctx)!,
    );
    return { rule: input.rule };
  },
});
