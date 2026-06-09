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
import type { StudioContext } from "@/core/studio-context";
import { emitMonitoringLog } from "./emit";
import {
  DECOPILOT_CONNECTION_ID,
  MONITORING_LOG_TYPE_LLM_CALL,
  MONITORING_SPAN_NAME,
} from "./schema";

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
  taskId: string;
  durationMs: number;
  isError: boolean;
  errorMessage?: string | null;
  finishReason?: string;
  usage?: LlmCallUsage;
  /** Aggregated usage across all steps (multi-step generations). */
  totalUsage?: LlmCallUsage;
  /**
   * Aggregated USD cost for the generation. Only available when the provider
   * reports it (deco ai-gateway / OpenRouter via providerMetadata.openrouter.usage.cost);
   * 0 / undefined for providers that don't return cost.
   */
  cost?: number;
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
  params: Omit<EmitLlmCallLogParams, "tracer"> & { ctx: StudioContext },
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

    const usageForProps = params.totalUsage ?? params.usage;

    emitMonitoringLog(
      {
        type: MONITORING_LOG_TYPE_LLM_CALL,
        organizationId: params.organizationId,
        connectionId: DECOPILOT_CONNECTION_ID,
        toolName: params.modelId,
        toolArguments: {
          model: params.modelId,
          credentialId: params.credentialId,
          threadId: params.taskId,
          ...(params.request?.body !== undefined
            ? { requestBody: params.request.body }
            : {}),
        },
        result: {
          ...(params.usage ?? {}),
          ...(params.totalUsage ? { totalUsage: params.totalUsage } : {}),
          ...(params.cost !== undefined ? { cost: params.cost } : {}),
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
          thread_id: params.taskId,
          log_type: MONITORING_LOG_TYPE_LLM_CALL,
          ...(params.response ? { response_id: params.response.id } : {}),
          // Usage/cost mirrored here as strings: `properties` is never truncated
          // (unlike `output`, which is capped at 64KB and breaks JSON parsing on
          // large responses), so aggregation queries read tokens/cost from here.
          ...(usageForProps
            ? {
                input_tokens: String(usageForProps.inputTokens),
                output_tokens: String(usageForProps.outputTokens),
                total_tokens: String(usageForProps.totalTokens),
              }
            : {}),
          ...(params.cost !== undefined ? { cost: String(params.cost) } : {}),
        },
      },
      spanCtx,
    );

    span.end();
  } catch {
    // Monitoring emission must be fail-safe
  }
}
