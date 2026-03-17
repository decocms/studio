/**
 * MONITORING_LOGS_LIST Tool
 *
 * Lists monitoring logs for the organization with filtering options.
 */

import { requireOrganization } from "@/core/mesh-context";
import { flushMonitoringData } from "@/observability";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

const monitoringLogSchema = z.object({
  id: z.string().optional().describe("Unique log identifier"),
  organizationId: z.string().describe("Organization ID"),
  connectionId: z.string().describe("Connection ID"),
  connectionTitle: z.string().describe("Connection display name"),
  toolName: z.string().describe("Name of the tool that was called"),
  input: z.record(z.string(), z.unknown()).describe("Redacted tool input"),
  output: z.record(z.string(), z.unknown()).describe("Redacted tool output"),
  isError: z.boolean().describe("Whether the call resulted in an error"),
  errorMessage: z.string().nullish().describe("Error message if applicable"),
  durationMs: z.number().describe("Call duration in milliseconds"),
  timestamp: z.string().describe("ISO 8601 timestamp of the call"),
  userId: z.string().nullish().describe("User who triggered the call"),
  requestId: z.string().describe("Unique request identifier"),
  userAgent: z
    .string()
    .nullish()
    .describe("Client identifier (x-mesh-client header)"),
  virtualMcpId: z
    .string()
    .nullish()
    .describe("Virtual MCP (Agent) ID if routed through an agent"),
  properties: z
    .record(z.string(), z.string())
    .nullish()
    .describe("Custom key-value metadata attached to the log"),
});

export const MONITORING_LOGS_LIST = defineTool({
  name: "MONITORING_LOGS_LIST",
  description:
    "List monitoring logs for tool calls with filtering and pagination.",
  annotations: {
    title: "List Monitoring Logs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    connectionId: z.string().optional().describe("Filter by connection ID"),
    excludeConnectionIds: z
      .array(z.string())
      .optional()
      .describe(
        "Exclude logs from these connection IDs (e.g. system connections)",
      ),
    virtualMcpId: z
      .string()
      .optional()
      .describe("Filter by Virtual MCP (Agent) ID"),
    toolName: z.string().optional().describe("Filter by tool name"),
    isError: z.boolean().optional().describe("Filter by error status"),
    startDate: z
      .string()
      .datetime()
      .optional()
      .describe("Filter by start date (ISO 8601 datetime string)"),
    endDate: z
      .string()
      .datetime()
      .optional()
      .describe("Filter by end date (ISO 8601 datetime string)"),
    limit: z.number().default(20).describe("Maximum number of results"),
    offset: z.number().default(0).describe("Offset for pagination"),
    // Property filters
    properties: z
      .record(z.string(), z.string())
      .optional()
      .describe("Filter by exact property key=value matches"),
    propertyKeys: z
      .array(z.string())
      .optional()
      .describe("Filter by logs that have these property keys"),
    propertyPatterns: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Filter by property value patterns (SQL LIKE, use % as wildcard)",
      ),
    propertyInValues: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Filter by exact match within comma-separated values (e.g., user_tags in 'Engineering')",
      ),
  }),
  outputSchema: z.object({
    logs: z.array(monitoringLogSchema).describe("Array of monitoring logs"),
    total: z.number().describe("Total number of logs matching filters"),
    offset: z.number().describe("Current offset for pagination"),
    limit: z.number().describe("Current limit for pagination"),
  }),
  handler: async (input, ctx) => {
    // Flush buffered spans so the query sees the latest data (local mode).
    await flushMonitoringData();

    const org = requireOrganization(ctx);

    // Build property filters if any are provided
    const hasPropertyFilters =
      input.properties ||
      input.propertyKeys ||
      input.propertyPatterns ||
      input.propertyInValues;
    const propertyFilters = hasPropertyFilters
      ? {
          properties: input.properties,
          propertyKeys: input.propertyKeys,
          propertyPatterns: input.propertyPatterns,
          propertyInValues: input.propertyInValues,
        }
      : undefined;

    const filters = {
      organizationId: org.id,
      connectionId: input.connectionId,
      excludeConnectionIds: input.excludeConnectionIds,
      virtualMcpId: input.virtualMcpId,
      toolName: input.toolName,
      isError: input.isError,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      limit: input.limit,
      offset: input.offset,
      propertyFilters,
    };

    const result = await ctx.storage.monitoring.query(filters);

    return {
      logs: result.logs.map((log) => {
        // Strip redundant MCP content wrapper from output to reduce payload size
        const output = log.output;
        let cleanOutput = output;
        if (
          output &&
          typeof output === "object" &&
          "structuredContent" in output
        ) {
          const { content, ...rest } = output as Record<string, unknown>;
          cleanOutput = rest;
        } else if (
          output &&
          typeof output === "object" &&
          "content" in output &&
          Array.isArray((output as Record<string, unknown>).content)
        ) {
          const { content, ...rest } = output as Record<string, unknown>;
          cleanOutput = Object.keys(rest).length > 0 ? rest : output;
        }
        return {
          ...log,
          output: cleanOutput,
          timestamp:
            log.timestamp instanceof Date
              ? log.timestamp.toISOString()
              : log.timestamp,
        };
      }),
      total: result.total,
      offset: input.offset,
      limit: input.limit,
    };
  },
});
