/**
 * Tool Definition Pattern
 *
 * Provides declarative tool creation with automatic:
 * - Type safety via Zod schemas
 * - Input/output validation
 * - Authorization checking
 * - Audit logging
 * - Metrics collection
 * - Distributed tracing
 */

import { SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import type { MeshContext } from "./mesh-context";

// ============================================================================
// Tool Definition Types
// ============================================================================

/**
 * MCP Tool Annotations (from MCP spec 2025-11-25)
 *
 * Additional properties describing a Tool to clients.
 * NOTE: all properties are **hints** — they are not guaranteed to provide
 * a faithful description of tool behavior.
 */
export interface ToolAnnotations {
  /** A human-readable title for the tool. */
  title?: string;
  /** If true, the tool does not modify its environment. Default: false */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates. Default: true */
  destructiveHint?: boolean;
  /** If true, calling repeatedly with the same args has no additional effect. Default: false */
  idempotentHint?: boolean;
  /** If true, the tool may interact with an "open world" of external entities. Default: true */
  openWorldHint?: boolean;
}

export interface ToolBinder<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TName extends string = string,
> {
  name: TName;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  annotations?: ToolAnnotations;
  /**
   * Static `_meta` to inject into every tool response.
   * Merged with any `_meta` already present in the handler's return value.
   * Use this to associate a UI resource URI without polluting the outputSchema.
   *
   * @example
   * ```typescript
   * _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/my-widget" }
   * ```
   */
  _meta?: Record<string, unknown>;
}
/**
 * Tool definition structure
 */
export interface ToolDefinition<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TName extends string = string,
> extends ToolBinder<TInput, TOutput, TName> {
  handler: (
    input: z.infer<TInput>,
    ctx: MeshContext,
  ) => Promise<z.infer<TOutput>>;
}

/**
 * Tool with execute wrapper
 * The execute method adds automatic validation, logging, and metrics
 */
export interface Tool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TName extends string = string,
> extends ToolDefinition<TInput, TOutput, TName> {
  execute: (
    input: z.infer<TInput>,
    ctx: MeshContext,
  ) => Promise<z.infer<TOutput>>;
}

// ============================================================================
// defineTool Function
// ============================================================================

/**
 * Define a tool with automatic validation, authorization, and logging
 *
 * @example
 * ```typescript
 * export const MY_TOOL = defineTool({
 *   name: 'MY_TOOL',
 *   description: 'Does something useful',
 *   inputSchema: z.object({
 *     param: z.string(),
 *   }),
 *   outputSchema: z.object({
 *     result: z.string(),
 *   }),
 *   handler: async (input, ctx) => {
 *     await ctx.access.check();
 *     return { result: 'done' };
 *   },
 * });
 * ```
 */
export function defineTool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TName extends string = string,
>(
  definition: ToolDefinition<TInput, TOutput, TName>,
): Tool<TInput, TOutput, TName> {
  return {
    ...definition,

    /**
     * Execute the tool with automatic:
     * - Context setup (tool name)
     * - Validation (via MCP protocol - already handled)
     * - Tracing (OpenTelemetry)
     * - Metrics collection
     * - Audit logging
     * - Error handling
     */
    execute: async (
      input: z.infer<TInput>,
      ctx: MeshContext,
    ): Promise<z.infer<TOutput>> => {
      const startTime = Date.now();

      return await ctx.timings.measure(
        `tool.${definition.name}`,
        // Start OpenTelemetry span
        async () =>
          ctx.tracer.startActiveSpan(
            `tool.${definition.name}`,
            {
              attributes: {
                "tool.name": definition.name,
                "organization.id": ctx.organization?.id ?? "system",
                "user.id":
                  ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? "anonymous",
              },
            },
            async (span) => {
              try {
                // Set tool name for audit logging and access control
                ctx.toolName = definition.name;
                ctx.access.setToolName?.(definition.name);

                // MCP protocol already validated input against JSON Schema
                // We trust the validation and execute the handler directly
                const output = await definition.handler(input, ctx);

                // Calculate duration
                const duration = Date.now() - startTime;

                // Record success metrics
                const histogram = ctx.meter.createHistogram(
                  "tool.execution.duration",
                  {
                    description: "Duration of tool executions in milliseconds",
                    unit: "ms",
                  },
                );
                histogram.record(duration, {
                  "tool.name": definition.name,
                  "organization.id": ctx.organization?.id ?? "system",
                  status: "success",
                });

                const counter = ctx.meter.createCounter(
                  "tool.execution.count",
                  {
                    description: "Number of tool executions",
                  },
                );
                counter.add(1, {
                  "tool.name": definition.name,
                  status: "success",
                });

                // Mark span as successful
                span.setStatus({ code: SpanStatusCode.OK });

                return output;
              } catch (error) {
                // Record error metrics
                const errorCounter = ctx.meter.createCounter(
                  "tool.execution.errors",
                  {
                    description: "Number of tool execution errors",
                  },
                );
                errorCounter.add(1, {
                  "tool.name": definition.name,
                  "error.type": (error as Error).constructor.name,
                });

                // Mark span as error
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: (error as Error).message,
                });
                span.recordException(error as Error);

                throw error;
              } finally {
                span.end();
              }
            },
          ),
      );
    },
  };
}
