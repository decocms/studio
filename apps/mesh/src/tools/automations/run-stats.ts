/**
 * AUTOMATION_RUN_STATS Tool
 *
 * Aggregate stats for a single automation's runs: run counts by lifecycle
 * status (total / completed / failed / in-progress) plus LLM token + USD cost
 * totals across the automation's run threads. Backs the per-automation Runs
 * stat cards on the automation detail page and the Monitoring → Automations tab.
 *
 * Token/cost is aggregated over the most-recent run threads (capped at
 * USAGE_SAMPLE_LIMIT); `usage.truncated` flags when more runs existed than were
 * sampled, so the UI can label the figure as a partial total.
 */

import { z } from "zod";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { flushMonitoringData } from "@/observability";
import { defineTool } from "../../core/define-tool";

// Token/cost aggregation joins per-run threads to llm_call logs; bound the
// thread-id set to keep the monitoring query cheap (matches the cap on
// MONITORING_THREAD_USAGE).
const USAGE_SAMPLE_LIMIT = 500;

export const AUTOMATION_RUN_STATS = defineTool({
  name: "AUTOMATION_RUN_STATS",
  description:
    "Aggregate run counts (by status) and LLM token/cost totals for a single automation.",
  annotations: {
    title: "Automation Run Stats",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    automation_id: z.string(),
    startDate: z
      .string()
      .datetime()
      .optional()
      .describe("Filter runs at or after this ISO timestamp"),
    endDate: z
      .string()
      .datetime()
      .optional()
      .describe("Filter runs at or before this ISO timestamp"),
  }),
  outputSchema: z.object({
    runs: z.object({
      total: z.number(),
      completed: z.number(),
      failed: z.number(),
      inProgress: z.number(),
    }),
    usage: z.object({
      calls: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
      costUsd: z.number(),
      /** Number of run threads the token/cost totals were aggregated over. */
      sampledRuns: z.number(),
      /** True when more runs existed than were sampled for token/cost. */
      truncated: z.boolean(),
    }),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    await flushMonitoringData();

    const automation = await ctx.storage.automations.findById(
      input.automation_id,
      organization.id,
    );
    if (!automation) {
      throw new Error("Automation not found");
    }

    const runs = await ctx.storage.automations.getRunStats(
      input.automation_id,
      organization.id,
      { startDate: input.startDate, endDate: input.endDate },
    );

    const threadIds = await ctx.storage.automations.listRunThreadIds(
      input.automation_id,
      organization.id,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        limit: USAGE_SAMPLE_LIMIT,
      },
    );

    const usage = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      sampledRuns: threadIds.length,
      truncated: runs.total > threadIds.length,
    };

    if (threadIds.length > 0) {
      const items = await ctx.storage.monitoring.queryThreadUsage({
        organizationId: organization.id,
        connectionId: "decopilot",
        threadIds,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
      });
      for (const item of items) {
        usage.calls += item.calls;
        usage.inputTokens += item.inputTokens;
        usage.outputTokens += item.outputTokens;
        usage.totalTokens += item.totalTokens;
        usage.costUsd += item.costUsd;
      }
    }

    return { runs, usage };
  },
});
