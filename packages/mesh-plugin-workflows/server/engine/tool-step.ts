/**
 * Tool Step Executor
 *
 * Executes MCP tool calls via the mesh gateway proxy.
 * Supports optional transformCode for post-processing results.
 *
 * When a transform is configured, the raw tool output is checkpointed to the
 * database before the transform runs. This guarantees the raw result is never
 * lost even if the transform code fails.
 */

import { ToolCallActionSchema, type Step } from "@decocms/bindings/workflow";
import type { WorkflowExecutionStorage } from "../storage/workflow-execution";
import type { MCPProxy } from "../types";
import { executeCode } from "./code-step";

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Step execution result
 */
export interface StepResult {
  stepId: string;
  startedAt: number;
  completedAt?: number;
  output?: unknown;
  error?: string;
}

/**
 * Context needed by the tool step executor
 */
export interface ToolStepContext {
  virtualMcpId: string;
  createMCPProxy: (connectionId: string) => Promise<MCPProxy>;
  /** Storage for checkpointing raw tool output before transforms */
  storage: WorkflowExecutionStorage;
  /** Execution ID (needed for checkpoint writes) */
  executionId: string;
}

/**
 * Execute a tool step: call the MCP tool, optionally transform the result.
 */
export async function executeToolStep(
  ctx: ToolStepContext,
  step: Step,
  input: Record<string, unknown>,
): Promise<StepResult> {
  const startedAt = Date.now();

  // Validate step action
  const parsed = ToolCallActionSchema.safeParse(step.action);
  if (!parsed.success) {
    return {
      stepId: step.name,
      startedAt,
      completedAt: Date.now(),
      error: `Invalid tool step configuration: ${parsed.error.message}`,
    };
  }

  const { toolName, transformCode } = parsed.data;
  const timeoutMs = step.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Create MCP proxy and call the tool
  let proxy: MCPProxy | undefined;
  let result: unknown;

  try {
    proxy = await ctx.createMCPProxy(ctx.virtualMcpId);
    const { content, structuredContent, isError } = await proxy.callTool(
      { name: toolName, arguments: input },
      undefined,
      { timeout: timeoutMs },
    );

    result = structuredContent ?? content;

    if (isError) {
      const errorMessage =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return {
        stepId: step.name,
        startedAt,
        completedAt: Date.now(),
        error: `Tool "${toolName}" returned an error: ${errorMessage}`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      stepId: step.name,
      startedAt,
      completedAt: Date.now(),
      error: errorMessage,
    };
  } finally {
    proxy?.close().catch(() => {});
  }

  // Post-processing: checkpoint raw output then run transformCode
  if (transformCode) {
    const checkpointResult = await ctx.storage.checkpointAndTransform(
      ctx.executionId,
      step.name,
      result,
      async (raw) => {
        const transformResult = await executeCode(
          transformCode,
          raw as Record<string, unknown>,
          step.name,
        );
        return { output: transformResult.output, error: transformResult.error };
      },
    );

    return {
      stepId: step.name,
      startedAt,
      completedAt: Date.now(),
      output: checkpointResult?.output,
      error: checkpointResult?.error
        ? String(checkpointResult.error)
        : undefined,
    };
  }

  // Filter output by outputSchema if present
  if (step.outputSchema?.properties && typeof result === "object" && result) {
    const allowedKeys = new Set(
      Object.keys(step.outputSchema.properties as Record<string, unknown>),
    );
    result = Object.fromEntries(
      Object.entries(result as Record<string, unknown>).filter(([key]) =>
        allowedKeys.has(key),
      ),
    );
  }

  return {
    stepId: step.name,
    startedAt,
    completedAt: Date.now(),
    output: result,
  };
}
