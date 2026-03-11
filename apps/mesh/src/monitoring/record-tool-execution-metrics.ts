import type { MeshContext } from "@/core/mesh-context";

export function recordToolExecutionMetrics(params: {
  ctx: MeshContext;
  organizationId: string;
  connectionId: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
  errorType?: string;
}): void {
  const { ctx, organizationId, connectionId, toolName, durationMs, isError } =
    params;

  if (!organizationId || !connectionId || !toolName) return;

  const attributes = {
    "tool.name": toolName,
    "organization.id": organizationId,
    "connection.id": connectionId,
    status: isError ? "error" : "success",
    "error.type": isError ? params.errorType || "Error" : "",
  };

  ctx.meter
    .createHistogram("tool.execution.duration", {
      description: "Duration of tool executions in milliseconds",
      unit: "ms",
    })
    .record(durationMs, attributes);

  ctx.meter
    .createCounter("tool.execution.count", {
      description: "Number of tool executions",
    })
    .add(1, attributes);
}
