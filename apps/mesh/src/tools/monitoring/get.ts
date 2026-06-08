/**
 * MONITORING_LOG_GET Tool
 *
 * Fetches a single monitoring log by ID with full input/output data.
 */

import { requireOrganization } from "@/core/studio-context";
import { flushMonitoringData } from "@/observability";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

export const MONITORING_LOG_GET = defineTool({
  name: "MONITORING_LOG_GET",
  description:
    "Get a single monitoring log by ID with full input and output data.",
  annotations: {
    title: "Get Monitoring Log",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("Log ID to fetch"),
  }),
  outputSchema: z.object({
    log: z
      .object({
        id: z.string().optional(),
        organizationId: z.string(),
        connectionId: z.string(),
        toolName: z.string(),
        input: z.record(z.string(), z.unknown()),
        output: z.record(z.string(), z.unknown()),
        isError: z.boolean(),
        errorMessage: z.string().nullish(),
        durationMs: z.number(),
        timestamp: z.string(),
        userId: z.string().nullish(),
        requestId: z.string(),
        userAgent: z.string().nullish(),
        virtualMcpId: z.string().nullish(),
        properties: z.record(z.string(), z.string()).nullish(),
      })
      .nullable()
      .describe("The monitoring log, or null if not found"),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    await flushMonitoringData();

    const org = requireOrganization(ctx);
    const log = await ctx.storage.monitoring.getById(org.id, input.id);

    if (!log) {
      return { log: null };
    }

    return {
      log: {
        ...log,
        timestamp:
          log.timestamp instanceof Date
            ? log.timestamp.toISOString()
            : log.timestamp,
      },
    };
  },
});
