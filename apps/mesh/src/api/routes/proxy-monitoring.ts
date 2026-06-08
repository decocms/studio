import type {
  CallToolRequest,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import { trace, context } from "@opentelemetry/api";
import type { StudioContext } from "../../core/studio-context";
import { emitMonitoringLog } from "../../monitoring/emit";
import { recordToolExecutionMetrics } from "../../monitoring/record-tool-execution-metrics";
import { MONITORING_SPAN_NAME } from "@/monitoring/schema";

type CallToolMiddleware = (
  request: CallToolRequest,
  next: () => Promise<CallToolResult>,
) => Promise<CallToolResult>;

export function extractCallToolErrorMessage(
  result: CallToolResult,
): string | undefined {
  if (!result.isError) return undefined;
  const content = (result as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      (item as { type?: unknown }).type === "text" &&
      "text" in item &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text;
    }
  }

  return undefined;
}

/**
 * Extract custom properties from tool call arguments (_meta.properties).
 * Only string values are accepted to match the properties schema.
 */
export function extractMetaProperties(
  args: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!args) return undefined;

  const meta = args._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    return undefined;

  const properties = (meta as Record<string, unknown>).properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge properties from header (ctx.metadata.properties) and _meta.properties.
 * Header properties take precedence over _meta properties.
 */
export function mergeProperties(
  headerProps: Record<string, string> | undefined,
  metaProps: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headerProps && !metaProps) return undefined;
  if (!headerProps) return metaProps;
  if (!metaProps) return headerProps;

  // Header takes precedence
  return { ...metaProps, ...headerProps };
}

/**
 * Normalize tool output for monitoring logs.
 *
 * If the tool result includes a `structuredContent` payload, store ONLY that to
 * avoid duplicating both structured + text output in the database.
 */
function formatMonitoringOutput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const structured = record.structuredContent;
    if (
      structured &&
      typeof structured === "object" &&
      !Array.isArray(structured)
    ) {
      return structured as Record<string, unknown>;
    }
    return record;
  }
  return { value };
}

async function emitMonitoringSpan(args: {
  ctx: StudioContext;
  enabled: boolean;
  organizationId?: string;
  connectionId: string;
  virtualMcpId?: string;
  request: CallToolRequest;
  output: Record<string, unknown>;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
}): Promise<void> {
  const { ctx, enabled } = args;
  const organizationId = args.organizationId ?? ctx.organization?.id;
  if (!enabled || !organizationId) return;

  // Skip monitoring for decopilot connections (they don't exist in the database)
  if (isDecopilot(args.connectionId)) return;

  // Extract properties from _meta.properties in tool arguments
  const metaProperties = extractMetaProperties(
    args.request.params.arguments as Record<string, unknown> | undefined,
  );

  // Merge with header properties (header takes precedence)
  let properties = mergeProperties(ctx.metadata.properties, metaProperties);

  // Inject user tags into properties
  const userId = ctx.auth.user?.id || ctx.auth.apiKey?.userId;
  if (userId) {
    try {
      const userTags = await ctx.storage.tags.getUserTagsInOrg(
        userId,
        organizationId,
      );
      if (userTags.length > 0) {
        const tagNames = userTags.map((t) => t.name).join(",");
        properties = { ...properties, user_tags: tagNames };
      }
    } catch {
      // Silently ignore tag fetch errors - don't fail monitoring
    }
  }

  // Create a short-lived span for trace correlation
  const span = ctx.tracer.startSpan(MONITORING_SPAN_NAME);
  const spanCtx = trace.setSpan(context.active(), span);

  emitMonitoringLog(
    {
      organizationId,
      connectionId: args.connectionId,
      toolName: args.request.params.name,
      toolArguments: (args.request.params.arguments ?? {}) as Record<
        string,
        unknown
      >,
      result: args.output,
      duration: args.durationMs,
      isError: args.isError,
      errorMessage: args.errorMessage || null,
      userId: ctx.auth.user?.id || ctx.auth.apiKey?.userId || null,
      requestId: ctx.metadata.requestId,
      userAgent: ctx.metadata.userAgent || null,
      virtualMcpId: args.virtualMcpId || null,
      properties: properties || null,
    },
    spanCtx,
  );

  span.end();
}

export interface ProxyMonitoringMiddlewareParams {
  ctx: StudioContext;
  enabled: boolean;
  connectionId: string;
  virtualMcpId?: string; // Virtual MCP (Agent) ID if routed through an agent
}

export function createProxyMonitoringMiddleware(
  params: ProxyMonitoringMiddlewareParams,
): CallToolMiddleware {
  const { ctx, enabled, connectionId, virtualMcpId } = params;

  return async (request, next) => {
    const startTime = Date.now();

    const organizationId = ctx.organization?.id;

    try {
      const result = await next();
      const duration = Date.now() - startTime;

      if (enabled && organizationId && !isDecopilot(connectionId)) {
        recordToolExecutionMetrics({
          ctx,
          organizationId,
          connectionId,
          toolName: request.params.name,
          durationMs: duration,
          isError: Boolean(result.isError),
          errorType: result.isError ? "Error" : "",
        });
      }

      await emitMonitoringSpan({
        ctx,
        enabled,
        connectionId,
        virtualMcpId,
        request,
        output: formatMonitoringOutput(result),
        isError: Boolean(result.isError),
        errorMessage: extractCallToolErrorMessage(result),
        durationMs: duration,
      });

      return result;
    } catch (error) {
      const err = error as Error;
      const duration = Date.now() - startTime;

      if (enabled && organizationId && !isDecopilot(connectionId)) {
        recordToolExecutionMetrics({
          ctx,
          organizationId,
          connectionId,
          toolName: request.params.name,
          durationMs: duration,
          isError: true,
          errorType: "Error",
        });
      }

      await emitMonitoringSpan({
        ctx,
        enabled,
        connectionId,
        virtualMcpId,
        request,
        output: {},
        isError: true,
        errorMessage: err.message,
        durationMs: duration,
      });

      throw error;
    }
  };
}
