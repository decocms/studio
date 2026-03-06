/**
 * Monitoring Transport
 *
 * Records OpenTelemetry spans/metrics for tool calls.
 * Uses shared emitMonitoringSpan utility to create monitoring spans.
 * The ParquetSpanExporter picks these up and writes Parquet files.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { Span } from "@opentelemetry/api";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  CallToolRequest,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { WrapperTransport } from "./compose";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  extractCallToolErrorMessage,
  formatMonitoringOutput,
  extractMetaProperties,
  mergeProperties,
} from "@/api/routes/proxy-monitoring";
import { emitMonitoringSpan } from "@/monitoring/emit-monitoring-span";

interface MonitoringTransportOptions {
  ctx: MeshContext;
  connectionId: string;
  connectionTitle: string;
  virtualMcpId?: string;
}

interface InflightRequest {
  startTime: number;
  method: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  span?: Span;
}

export class MonitoringTransport extends WrapperTransport {
  private inflightRequests = new Map<string | number, InflightRequest>();

  constructor(
    innerTransport: Transport,
    private options: MonitoringTransportOptions,
  ) {
    super(innerTransport);
  }

  protected override async handleOutgoingMessage(
    message: JSONRPCMessage,
  ): Promise<void> {
    if (this.isRequest(message)) {
      const request = message as JSONRPCRequest;
      this.onRequestStart(request);
    }

    return this.innerTransport.send(message);
  }

  protected override handleIncomingMessage(message: JSONRPCMessage): void {
    if (this.isResponse(message)) {
      const response = message as JSONRPCResponse;
      this.onResponseEnd(response);
    }

    // Forward to client
    this.onmessage?.(message);
  }

  private onRequestStart(request: JSONRPCRequest): void {
    const { ctx, connectionId } = this.options;

    // Extract tool name and arguments for tools/call
    let toolName: string | undefined;
    let toolArguments: Record<string, unknown> | undefined;
    if (request.method === "tools/call" && request.params) {
      const params = request.params as CallToolRequest["params"];
      toolName = params.name;
      toolArguments = params.arguments as Record<string, unknown> | undefined;
    }

    // Start OpenTelemetry span for tool calls
    let span: Span | undefined;
    if (request.method === "tools/call" && toolName) {
      span = ctx.tracer.startSpan("mcp.proxy.callTool", {
        attributes: {
          "connection.id": connectionId,
          "tool.name": toolName,
          "request.id": ctx.metadata.requestId,
          "jsonrpc.id": request.id,
          "jsonrpc.method": request.method,
        },
      });
    }

    // Only track if request has an ID
    if (request.id !== null && request.id !== undefined) {
      this.inflightRequests.set(request.id, {
        startTime: Date.now(),
        method: request.method,
        toolName,
        toolArguments,
        span,
      });
    }
  }

  private onResponseEnd(response: JSONRPCResponse): void {
    // Skip if response has no ID
    if (response.id === null || response.id === undefined) return;

    const requestInfo = this.inflightRequests.get(response.id);
    if (!requestInfo) return;

    const { ctx, connectionId } = this.options;
    const { startTime, method, toolName, toolArguments, span } = requestInfo;
    const duration = Date.now() - startTime;

    // Clean up
    this.inflightRequests.delete(response.id);

    // Only record metrics/logging for tool calls
    if (method !== "tools/call" || !toolName) {
      return;
    }

    const isError = "error" in response;
    const result = isError ? response.error : response.result;

    // Convert to CallToolResult format for logging
    const callToolResult: CallToolResult = isError
      ? {
          content: [
            {
              type: "text",
              text: response.error?.message || "Unknown error",
            },
          ],
          isError: true,
        }
      : (result as CallToolResult);

    // Record OpenTelemetry metrics (unchanged)
    ctx.meter.createHistogram("connection.proxy.duration").record(duration, {
      "connection.id": connectionId,
      "tool.name": toolName,
      status: isError ? "error" : "success",
    });

    if (isError) {
      ctx.meter.createCounter("connection.proxy.errors").add(1, {
        "connection.id": connectionId,
        "tool.name": toolName,
        error: response.error?.message,
      });
    } else {
      ctx.meter.createCounter("connection.proxy.requests").add(1, {
        "connection.id": connectionId,
        "tool.name": toolName,
        status: "success",
      });
    }

    // End OpenTelemetry span
    if (span) {
      if (isError && response.error) {
        span.recordException(new Error(response.error.message));
        span.setAttributes({
          error: true,
          "error.code": response.error.code,
          "error.message": response.error.message,
        });
      }
      span.end();
    }

    // Emit monitoring span (replaces logToDatabase)
    const organizationId = ctx.organization?.id;
    if (!organizationId) return; // Skip if no organization context

    const errorMessage = extractCallToolErrorMessage(callToolResult);
    const output = formatMonitoringOutput(callToolResult);
    const metaProps = extractMetaProperties(toolArguments);
    const properties = mergeProperties(ctx.metadata.properties, metaProps);

    emitMonitoringSpan({
      tracer: ctx.tracer,
      organizationId,
      connectionId,
      connectionTitle: this.options.connectionTitle,
      toolName,
      input: (toolArguments ?? {}) as Record<string, unknown>,
      output,
      isError: Boolean(isError),
      errorMessage,
      durationMs: duration,
      userId: ctx.auth.user?.id || ctx.auth.apiKey?.userId || null,
      requestId: ctx.metadata.requestId,
      userAgent: ctx.metadata.userAgent,
      virtualMcpId: this.options.virtualMcpId,
      properties,
    });
  }

  // Clean up any dangling spans on close
  override async close(): Promise<void> {
    // End all in-flight spans
    for (const info of this.inflightRequests.values()) {
      if (info.span) {
        info.span.setAttributes({ "transport.closed": true });
        info.span.end();
      }
    }
    this.inflightRequests.clear();

    return super.close();
  }
}
