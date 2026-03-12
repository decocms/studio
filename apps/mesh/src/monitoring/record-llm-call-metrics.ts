/**
 * Record OTel metrics for an LLM call made by Decopilot.
 *
 * Uses the same metric names (tool.execution.count / tool.execution.duration)
 * and attribute keys (connection.id / tool.name) as recordToolExecutionMetrics
 * so that the NDJSONMetricExporter stores them under connection_id = "decopilot"
 * and the existing MONITORING_STATS query (filtering by connectionIds) works.
 */

import type { MeshContext } from "@/core/mesh-context";
import { DECOPILOT_CONNECTION_ID } from "./schema";

export function recordLlmCallMetrics(params: {
  ctx: MeshContext;
  organizationId: string;
  agentId: string;
  modelId: string;
  credentialId: string;
  durationMs: number;
  isError: boolean;
  errorType?: string;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const {
    ctx,
    organizationId,
    agentId,
    modelId,
    credentialId,
    durationMs,
    isError,
    inputTokens,
    outputTokens,
  } = params;

  if (!organizationId || !modelId) return;

  // Use the attribute keys the NDJSONMetricExporter reads:
  // "connection.id" → connection_id column, "tool.name" → tool_name column.
  const attributes = {
    "connection.id": DECOPILOT_CONNECTION_ID,
    "tool.name": modelId,
    "organization.id": organizationId,
    "agent.id": agentId,
    "credential.id": credentialId,
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

  if (inputTokens != null || outputTokens != null) {
    const tokenAttributes = { ...attributes };
    ctx.meter
      .createCounter("tool.execution.tokens", {
        description: "Number of tokens used by LLM calls",
      })
      .add((inputTokens ?? 0) + (outputTokens ?? 0), tokenAttributes);
  }
}
