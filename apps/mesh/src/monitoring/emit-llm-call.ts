/**
 * Emit a monitoring OTel log record for an LLM call.
 *
 * Follows the same pattern as emitMonitoringLog (tool calls) but targeted at
 * LLM completions made by Decopilot. The log uses connection_id = "decopilot"
 * so it is distinguishable from MCP tool-call logs in storage queries.
 *
 * Fail-safe: errors are silently swallowed so monitoring never breaks the
 * request handler.
 */

import { context, trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import type { MeshContext } from "@/core/mesh-context";
import { emitMonitoringLog } from "./emit";
import {
  DECOPILOT_CONNECTION_ID,
  MONITORING_LOG_TYPE_LLM_CALL,
  MONITORING_SPAN_NAME,
} from "./schema";

const DECOPILOT_CONNECTION_TITLE = "Decopilot";

export interface LlmCallUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EmitLlmCallLogParams {
  tracer: Tracer;
  organizationId: string;
  /** Virtual MCP (Agent) ID that triggered the call. */
  agentId: string;
  modelId: string;
  modelTitle: string;
  credentialId: string;
  threadId: string;
  durationMs: number;
  isError: boolean;
  errorMessage?: string | null;
  finishReason?: string;
  usage?: LlmCallUsage;
  /** Aggregated usage across all steps (multi-step generations). */
  totalUsage?: LlmCallUsage;
  /** Raw request body sent to the provider. */
  request?: { body?: unknown };
  /** Response metadata + messages returned by the provider. */
  response?: {
    id: string;
    timestamp: Date;
    modelId: string;
    headers?: Record<string, string>;
    messages: unknown[];
    body?: unknown;
  };
  userId: string | null;
  requestId: string;
  userAgent?: string | null;
}

/**
 * Emit a monitoring log for an LLM call.
 * Callers are responsible for recording execution metrics separately via
 * recordLlmCallMetrics so that metrics reflect the actual LLM outcome.
 */
export function monitorLlmCall(
  params: Omit<EmitLlmCallLogParams, "tracer"> & { ctx: MeshContext },
): void {
  emitLlmCallLog({ ...params, tracer: params.ctx.tracer });
}

/**
 * Emit an OTel log record for an LLM call made by Decopilot.
 * Associates the log with a short-lived trace span for correlation.
 */
function emitLlmCallLog(params: EmitLlmCallLogParams): void {
  try {
    if (!params.organizationId) return;

    const span = params.tracer.startSpan(MONITORING_SPAN_NAME);
    const spanCtx = trace.setSpan(context.active(), span);

    emitMonitoringLog(
      {
        type: MONITORING_LOG_TYPE_LLM_CALL,
        organizationId: params.organizationId,
        connectionId: DECOPILOT_CONNECTION_ID,
        connectionTitle: DECOPILOT_CONNECTION_TITLE,
        toolName: params.modelId,
        toolArguments: {
          model: params.modelId,
          credentialId: params.credentialId,
          threadId: params.threadId,
          ...(params.request?.body !== undefined
            ? { requestBody: params.request.body }
            : {}),
        },
        result: {
          ...(params.usage ?? {}),
          ...(params.totalUsage ? { totalUsage: params.totalUsage } : {}),
          ...(params.finishReason ? { finishReason: params.finishReason } : {}),
          ...(params.response
            ? {
                responseId: params.response.id,
                responseModelId: params.response.modelId,
                responseTimestamp: params.response.timestamp,
                messages: params.response.messages,
              }
            : {}),
          logType: MONITORING_LOG_TYPE_LLM_CALL,
        },
        duration: params.durationMs,
        isError: params.isError,
        errorMessage: params.errorMessage ?? null,
        userId: params.userId,
        requestId: params.requestId,
        userAgent: params.userAgent ?? null,
        virtualMcpId: params.agentId ?? null,
        properties: {
          model_title: params.modelTitle,
          credential_id: params.credentialId,
          thread_id: params.threadId,
          log_type: MONITORING_LOG_TYPE_LLM_CALL,
          ...(params.response ? { response_id: params.response.id } : {}),
        },
      },
      spanCtx,
    );

    span.end();
  } catch {
    // Monitoring emission must be fail-safe
  }
}
