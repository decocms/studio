import type {
  CallToolRequest,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import type { MeshContext } from "../../core/mesh-context";
import { emitMonitoringSpan } from "@/monitoring/emit-monitoring-span";

type CallToolMiddleware = (
  request: CallToolRequest,
  next: () => Promise<CallToolResult>,
) => Promise<CallToolResult>;

type CallStreamableToolMiddleware = (
  request: CallToolRequest,
  next: () => Promise<Response>,
) => Promise<Response>;

const MAX_STREAMABLE_LOG_BYTES = 256 * 1024; // 256KB (avoid unbounded memory on long streams)

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
export function formatMonitoringOutput(
  value: unknown,
): Record<string, unknown> {
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

async function readBodyTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false };

  const reader = body.getReader();
  const decoder = new TextDecoder();

  let truncated = false;
  let bytesRead = 0;
  const parts: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (value) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          truncated = true;
          const allowed = maxBytes - (bytesRead - value.byteLength);
          if (allowed > 0) {
            parts.push(
              decoder.decode(value.slice(0, allowed), { stream: true }),
            );
          }
          break;
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock();
  }

  parts.push(decoder.decode());

  return { text: parts.join(""), truncated };
}

/**
 * Extract usage/token metadata from NDJSON stream text.
 *
 * Streaming LLM responses are newline-delimited JSON where the last event
 * is a `{ type: "finish", usage: { ... } }` object. This function scans
 * the trailing lines for that event and returns the usage payload so it
 * can be stored as a top-level key for easy aggregation.
 */
function extractStreamUsage(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;

  // Walk backwards through the non-empty lines (finish event is at/near the end)
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.type === "finish") {
        const result: Record<string, unknown> = {};
        if (parsed.usage) result.usage = parsed.usage;
        if (parsed.providerMetadata)
          result.providerMetadata = parsed.providerMetadata;
        if (parsed.finishReason) result.finishReason = parsed.finishReason;
        return Object.keys(result).length > 0 ? result : undefined;
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  return undefined;
}

async function logProxyMonitoringEvent(args: {
  ctx: MeshContext;
  enabled: boolean;
  organizationId?: string;
  connectionId: string;
  connectionTitle: string;
  virtualMcpId?: string;
  request: CallToolRequest;
  output: Record<string, unknown>;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
}): Promise<void> {
  const { ctx } = args;
  const organizationId = args.organizationId ?? ctx.organization?.id;
  if (!organizationId) return;

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

  emitMonitoringSpan({
    tracer: ctx.tracer,
    organizationId,
    connectionId: args.connectionId,
    connectionTitle: args.connectionTitle,
    toolName: args.request.params.name,
    input: (args.request.params.arguments ?? {}) as Record<string, unknown>,
    output: args.output,
    isError: args.isError,
    errorMessage: args.errorMessage,
    durationMs: args.durationMs,
    userId: ctx.auth.user?.id || ctx.auth.apiKey?.userId || null,
    requestId: ctx.metadata.requestId,
    userAgent: ctx.metadata.userAgent,
    virtualMcpId: args.virtualMcpId,
    properties,
  });
}

export interface ProxyMonitoringMiddlewareParams {
  ctx: MeshContext;
  enabled: boolean;
  connectionId: string;
  connectionTitle: string;
  virtualMcpId?: string; // Virtual MCP (Agent) ID if routed through an agent
}

export function createProxyMonitoringMiddleware(
  params: ProxyMonitoringMiddlewareParams,
): CallToolMiddleware {
  const { ctx, enabled, connectionId, connectionTitle, virtualMcpId } = params;

  return async (request, next) => {
    const startTime = Date.now();

    try {
      const result = await next();
      const duration = Date.now() - startTime;

      await logProxyMonitoringEvent({
        ctx,
        enabled,
        connectionId,
        connectionTitle,
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

      await logProxyMonitoringEvent({
        ctx,
        enabled,
        connectionId,
        connectionTitle,
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

export function createProxyStreamableMonitoringMiddleware(
  params: ProxyMonitoringMiddlewareParams,
): CallStreamableToolMiddleware {
  const { ctx, enabled, connectionId, connectionTitle, virtualMcpId } = params;

  return async (request, next) => {
    const startTime = Date.now();

    try {
      const response = await next();

      const organizationId = ctx.organization?.id;
      if (enabled && organizationId) {
        // Read a clone to capture output without blocking the stream to the caller.
        const cloned = response.clone();
        void (async () => {
          try {
            const { text, truncated } = await readBodyTextWithLimit(
              cloned,
              MAX_STREAMABLE_LOG_BYTES,
            );
            const duration = Date.now() - startTime;

            const contentType = cloned.headers.get("content-type") ?? "";
            let body: unknown = text;
            if (contentType.includes("application/json")) {
              try {
                body = text.length ? JSON.parse(text) : null;
              } catch {
                body = text;
              }
            }

            const isError = response.status >= 400;
            const derivedErrorMessage =
              isError && body && typeof body === "object" && "error" in body
                ? (body as { error?: unknown }).error
                : undefined;
            const errorMessage =
              typeof derivedErrorMessage === "string" && derivedErrorMessage
                ? derivedErrorMessage
                : isError && typeof body === "string" && body.trim()
                  ? body.slice(0, 500)
                  : isError
                    ? `HTTP ${response.status} ${response.statusText}`.trim()
                    : truncated
                      ? `Response body truncated to ${MAX_STREAMABLE_LOG_BYTES} bytes`
                      : undefined;

            const output = formatMonitoringOutput(body);
            // For NDJSON streams, extract usage from the last "finish" event
            // so it's available as a top-level key for aggregation.
            const streamUsage = extractStreamUsage(text);

            if (streamUsage) {
              Object.assign(output, streamUsage);
            }

            await logProxyMonitoringEvent({
              ctx,
              enabled,
              organizationId,
              connectionId,
              connectionTitle,
              virtualMcpId,
              request,
              output,
              isError,
              errorMessage,
              durationMs: duration,
            });
          } catch (err) {
            const duration = Date.now() - startTime;
            await logProxyMonitoringEvent({
              ctx,
              enabled,
              organizationId,
              connectionId,
              connectionTitle,
              virtualMcpId,
              request,
              output: {},
              isError: true,
              errorMessage: `Failed to read streamable response body: ${
                (err as Error).message
              }`,
              durationMs: duration,
            });
          }
        })();
      }

      return response;
    } catch (error) {
      const err = error as Error;
      const duration = Date.now() - startTime;

      await logProxyMonitoringEvent({
        ctx,
        enabled,
        connectionId,
        connectionTitle,
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
