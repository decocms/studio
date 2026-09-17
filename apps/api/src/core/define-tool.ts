/**
 * Tool Definition Pattern
 *
 * Provides declarative tool creation with automatic:
 * - Type safety via Zod schemas
 * - Input/output validation
 * - Authorization checking
 * - Audit logging
 * - Distributed tracing
 */

import { SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import type { StudioContext } from "./studio-context";
import {
  isOrgBlocked,
  isToolAllowedWhileBlocked,
  OrgBlockedError,
} from "./org-notice-gate";
import {
  FeatureNotInPlanError,
  assertAiBudget,
  orgHasFeature,
  type PlanFeature,
} from "./plan-feature-gate";

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
   * _meta: { ui: { resourceUri: "ui://studio/my-widget" } }
   * ```
   */
  _meta?: Record<string, unknown>;
  /**
   * Optional summary shown to the model in place of the full result JSON.
   * Use when the UI renders the rich result and the model only needs a terse
   * confirmation. The UI still receives the full structuredContent.
   */
  modelSummary?: (result: z.infer<TOutput>) => string;
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
    ctx: StudioContext,
  ) => Promise<z.infer<TOutput>>;
  /**
   * The plan feature this tool belongs to, if any. Declaring it is the whole
   * gate — the execute wrapper below refuses the call when the org's plan does
   * not include it, so no handler has to remember a check.
   *
   * The client gates the same keys (`use-entitlements.ts`), but that only stops
   * a button. This is what stops a request.
   */
  requiresFeature?: PlanFeature;
  /**
   * Declare on a tool whose execution spends the org's AI allowance. The
   * execute wrapper refuses it once the usage bar is exhausted — the margin
   * stop the bar is otherwise only reporting.
   *
   * Orthogonal to `requiresFeature` on purpose: `cms` is in the plan and does
   * not spend, so a full bar must not touch it ("CMS keeps working, chat
   * pauses"). Inert unless STUDIO_PLANS_ENABLED, like every other gate.
   */
  requiresAiBudget?: boolean;
}

/**
 * Tool with execute wrapper
 * The execute method adds automatic validation and tracing.
 * Tool execution metrics are emitted only from connection-backed monitoring
 * paths so monitoring metrics stay aligned with monitoring logs.
 */
export interface Tool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TName extends string = string,
> extends ToolDefinition<TInput, TOutput, TName> {
  execute: (
    input: z.infer<TInput>,
    ctx: StudioContext,
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
     * - Audit logging
     * - Error handling
     */
    execute: async (
      input: z.infer<TInput>,
      ctx: StudioContext,
    ): Promise<z.infer<TOutput>> => {
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

                // A blocked org (see org-notice-gate) keeps only the tools its
                // members need to read the notice and settle it. Allowlisted
                // tools skip the lookup entirely.
                const organizationId = ctx.organization?.id;
                if (
                  organizationId &&
                  !isToolAllowedWhileBlocked(definition.name) &&
                  (await isOrgBlocked(ctx.db, organizationId))
                ) {
                  throw new OrgBlockedError(
                    `This organization is blocked: ${definition.name} is unavailable until the block is resolved`,
                  );
                }

                // A gated tool with no resolvable org runs UNGATED below, and
                // silently. Harmless today — all five declared tools call
                // `requireOrganization` in their own handler and throw there —
                // but that is a coincidence, not a guarantee: the first gated
                // tool that tolerates a missing org is silently ungated. Say
                // so, once per call, rather than leaving it invisible.
                if (
                  (definition.requiresFeature || definition.requiresAiBudget) &&
                  !organizationId
                ) {
                  console.warn(
                    `[Plans] ${definition.name} declares a plan gate but no organization is in scope — running UNGATED`,
                  );
                }

                // The org's plan has to include this tool's feature. Fails
                // OPEN when the gateway has no answer at all — see
                // plan-feature-gate.
                if (
                  definition.requiresFeature &&
                  organizationId &&
                  !(await orgHasFeature(
                    ctx,
                    organizationId,
                    definition.requiresFeature,
                  ))
                ) {
                  throw new FeatureNotInPlanError(
                    `${definition.name} needs the ${definition.requiresFeature} feature, which this organization's plan does not include`,
                    definition.requiresFeature,
                  );
                }

                // …and it has to have AI allowance left, when it spends it.
                if (definition.requiresAiBudget && organizationId) {
                  await assertAiBudget(ctx, organizationId, definition.name);
                }

                // MCP protocol already validated input against JSON Schema
                // We trust the validation and execute the handler directly
                const output = await definition.handler(input, ctx);

                // Mark span as successful
                span.setStatus({ code: SpanStatusCode.OK });

                return output;
              } catch (error) {
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
