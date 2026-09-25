import type { StudioContext } from "@/core/studio-context";

/**
 * Latency for an in-process Studio tool call (apps/api/src/tools/**),
 * every one of which runs inside `defineTool`'s execute wrapper. Keyed by
 * tool name and org, never by connectionId — these tools talk to storage
 * directly rather than proxying to a downstream MCP server, so there is no
 * connection to key on.
 *
 * Deliberately a separate metric from `tool.execution.duration`
 * (record-tool-execution-metrics.ts), which stays connection-scoped so it
 * lines up with monitoring logs. This is the generic-tool signal for
 * pinpointing where DB latency amplifies across a chain of tool calls (#2995).
 */
export function recordGenericToolExecutionMetrics(params: {
  ctx: StudioContext;
  toolName: string;
  organizationId: string;
  durationMs: number;
  isError: boolean;
}): void {
  const { ctx, toolName, organizationId, durationMs, isError } = params;

  const attributes = {
    "tool.name": toolName,
    "organization.id": organizationId,
    status: isError ? "error" : "success",
  };

  ctx.meter
    .createHistogram("studio_tool.execution.duration", {
      description:
        "Duration of in-process Studio tool executions in milliseconds",
      unit: "ms",
    })
    .record(durationMs, attributes);

  ctx.meter
    .createCounter("studio_tool.execution.count", {
      description: "Number of in-process Studio tool executions",
    })
    .add(1, attributes);
}
