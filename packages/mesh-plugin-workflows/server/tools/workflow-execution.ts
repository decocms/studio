/**
 * Workflows Plugin - Workflow Execution Tools
 *
 * 7 tools: LIST, GET, CREATE, CANCEL, RESUME, GET_STEP_RESULT, GET_WORKFLOW
 */

import { z } from "zod";
import { StepSchema } from "@decocms/bindings/workflow";
import type { ServerPluginToolDefinition } from "@decocms/bindings/server-plugin";
import { requireWorkflowContext, getPluginStorage, parseJson } from "../types";
import { getDecopilotId } from "@decocms/mesh-sdk";

// ============================================================================
// Helpers
// ============================================================================

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "string" ? parseInt(value, 10) : Number(value);
  return Number.isNaN(num) ? null : num;
}

function epochMsToIsoString(epochMs: unknown): string {
  if (epochMs === null || epochMs === undefined)
    return new Date().toISOString();
  const num =
    typeof epochMs === "string" ? parseInt(epochMs, 10) : Number(epochMs);
  return Number.isNaN(num)
    ? new Date().toISOString()
    : new Date(num).toISOString();
}

// ============================================================================
// LIST
// ============================================================================

export const WORKFLOW_EXECUTION_LIST: ServerPluginToolDefinition = {
  name: "COLLECTION_WORKFLOW_EXECUTION_LIST",
  description:
    "List workflow executions with filtering, sorting, and pagination.",
  inputSchema: z.object({
    limit: z.number().optional().default(50),
    offset: z.number().optional().default(0),
    status: z.string().optional(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const typedInput = input as {
      limit?: number;
      offset?: number;
      status?: string;
    };
    const storage = getPluginStorage();

    const result = await storage.executions.listExecutions(
      meshCtx.organization.id,
      {
        limit: typedInput.limit,
        offset: typedInput.offset,
        status: typedInput.status,
      },
    );

    return {
      items: result.items.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        virtual_mcp_id: row.virtual_mcp_id,
        created_at: epochMsToIsoString(row.created_at),
        updated_at: epochMsToIsoString(row.updated_at),
        start_at_epoch_ms: toNumberOrNull(row.start_at_epoch_ms),
        started_at_epoch_ms: toNumberOrNull(row.started_at_epoch_ms),
        completed_at_epoch_ms: toNumberOrNull(row.completed_at_epoch_ms),
        error: parseJson(row.error),
      })),
      totalCount: result.totalCount,
      hasMore: result.hasMore,
    };
  },
};

// ============================================================================
// GET
// ============================================================================

export const WORKFLOW_EXECUTION_GET: ServerPluginToolDefinition = {
  name: "COLLECTION_WORKFLOW_EXECUTION_GET",
  description:
    "Get a single workflow execution by ID with step status summary.",
  inputSchema: z.object({
    id: z.string().describe("The ID of the workflow execution to get"),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { id } = input as { id: string };
    const storage = getPluginStorage();

    const result = await storage.executions.getExecutionFull(
      id,
      meshCtx.organization.id,
    );
    if (!result) {
      throw new Error("Execution not found");
    }

    const { execution, stepResults } = result;

    const runningSteps = stepResults
      .filter(
        (r) => r.started_at_epoch_ms && !r.completed_at_epoch_ms && !r.error,
      )
      .map((r) => r.step_id);
    const successSteps = stepResults
      .filter((r) => r.completed_at_epoch_ms && !r.error)
      .map((r) => ({
        name: r.step_id,
        completed_at_epoch_ms: r.completed_at_epoch_ms,
      }));
    const errorSteps = stepResults.filter((r) => r.error).map((r) => r.step_id);

    return {
      item: {
        id: execution.id,
        status: execution.status,
        created_at: epochMsToIsoString(execution.created_at),
        updated_at: epochMsToIsoString(execution.updated_at),
        start_at_epoch_ms: toNumberOrNull(execution.start_at_epoch_ms),
        started_at_epoch_ms: toNumberOrNull(execution.started_at_epoch_ms),
        completed_at_epoch_ms: toNumberOrNull(execution.completed_at_epoch_ms),
        input: parseJson(execution.input),
        output: parseJson(execution.output),
        error: parseJson(execution.error),
        running_steps: runningSteps,
        completed_steps: {
          success: successSteps,
          error: errorSteps,
        },
      },
    };
  },
};

// ============================================================================
// CREATE
// ============================================================================

export const WORKFLOW_EXECUTION_CREATE: ServerPluginToolDefinition = {
  name: "COLLECTION_WORKFLOW_EXECUTION_CREATE",
  description:
    "Create a workflow execution from a workflow template and return the execution ID.",
  inputSchema: z.object({
    workflow_collection_id: z
      .string()
      .describe("The ID of the workflow template to execute"),
    virtual_mcp_id: z
      .string()
      .optional()
      .describe(
        "The Virtual MCP ID to use for the execution. Defaults to Decopilot (organization-wide agent).",
      ),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Input to the workflow execution. Required only if the workflow has steps that reference @input.field.",
      ),
    start_at_epoch_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Timestamp in milliseconds of when the execution should start. If not provided, starts immediately.",
      ),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const typedInput = input as {
      workflow_collection_id: string;
      virtual_mcp_id?: string;
      input?: Record<string, unknown>;
      start_at_epoch_ms?: number;
    };
    const storage = getPluginStorage();

    // Fetch the workflow template to get steps
    const workflowCollection = await storage.collections.getById(
      typedInput.workflow_collection_id,
      meshCtx.organization.id,
    );
    if (!workflowCollection) {
      throw new Error(
        `Workflow template not found: ${typedInput.workflow_collection_id}`,
      );
    }

    const virtualMcpId =
      typedInput.virtual_mcp_id ?? getDecopilotId(meshCtx.organization.id);

    const { id: executionId } = await storage.executions.createExecution({
      organizationId: meshCtx.organization.id,
      virtualMcpId,
      input: typedInput.input,
      steps:
        workflowCollection.steps as import("@decocms/bindings/workflow").Step[],
      startAtEpochMs: typedInput.start_at_epoch_ms,
      workflowCollectionId: typedInput.workflow_collection_id,
      createdBy: meshCtx.auth.user?.id,
    });

    // Publish event to start the execution via the event bus (durable, background)
    await meshCtx.eventBus.publish(
      meshCtx.organization.id,
      meshCtx.connectionId ?? "",
      {
        type: "workflow.execution.created",
        subject: executionId,
        ...(typedInput.start_at_epoch_ms != null &&
          Number.isFinite(typedInput.start_at_epoch_ms) && {
            deliverAt: new Date(typedInput.start_at_epoch_ms).toISOString(),
          }),
      },
    );

    return { item: { id: executionId } };
  },
};

// ============================================================================
// CANCEL
// ============================================================================

export const WORKFLOW_EXECUTION_CANCEL: ServerPluginToolDefinition = {
  name: "CANCEL_EXECUTION",
  description:
    "Cancel a running or pending workflow execution. Currently executing steps will complete, but no new steps will start. The execution can be resumed later using RESUME_EXECUTION.",
  inputSchema: z.object({
    executionId: z.string().describe("The execution ID to cancel"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { executionId } = input as { executionId: string };
    const storage = getPluginStorage();

    const success = await storage.executions.cancelExecution(
      executionId,
      meshCtx.organization.id,
    );
    return { success };
  },
};

// ============================================================================
// RESUME
// ============================================================================

export const WORKFLOW_EXECUTION_RESUME: ServerPluginToolDefinition = {
  name: "RESUME_EXECUTION",
  description:
    "Resume a cancelled or failed workflow execution. Already-succeeded steps are preserved and their outputs reused; only failed steps are retried.",
  inputSchema: z.object({
    executionId: z.string().describe("The execution ID to resume"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { executionId } = input as { executionId: string };
    const storage = getPluginStorage();

    const success = await storage.executions.resumeExecution(
      executionId,
      meshCtx.organization.id,
    );
    if (!success) {
      return { success: false };
    }

    // Re-publish event to restart the execution via the event bus (durable, background)
    await meshCtx.eventBus.publish(
      meshCtx.organization.id,
      meshCtx.connectionId ?? "",
      {
        type: "workflow.execution.created",
        subject: executionId,
      },
    );

    return { success: true };
  },
};

// ============================================================================
// GET STEP RESULT
// ============================================================================

export const WORKFLOW_EXECUTION_GET_STEP_RESULT: ServerPluginToolDefinition = {
  name: "COLLECTION_WORKFLOW_EXECUTION_GET_STEP_RESULT",
  description: "Get a single step result by execution ID and step ID.",
  inputSchema: z.object({
    executionId: z
      .string()
      .describe("The execution ID to get the step result from"),
    stepId: z.string().describe("The step ID to get the step result for"),
  }),
  outputSchema: z.object({
    output: z.unknown().optional(),
    error: z.string().nullable().optional(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { executionId, stepId } = input as {
      executionId: string;
      stepId: string;
    };
    const storage = getPluginStorage();

    // Verify the execution belongs to the caller's organization
    const execution = await storage.executions.getExecution(
      executionId,
      meshCtx.organization.id,
    );
    if (!execution) {
      throw new Error("Execution not found");
    }

    const result = await storage.executions.getStepResult(executionId, stepId);
    if (!result) {
      throw new Error("Step result not found");
    }

    return {
      output: result.output,
      error:
        typeof result.error === "string"
          ? result.error
          : result.error != null && typeof result.error === "object"
            ? JSON.stringify(result.error)
            : undefined,
    };
  },
};

// ============================================================================
// GET EXECUTION WORKFLOW
// ============================================================================

export const WORKFLOW_EXECUTION_GET_WORKFLOW: ServerPluginToolDefinition = {
  name: "WORKFLOW_EXECUTION_GET_WORKFLOW",
  description:
    "Get the immutable workflow snapshot associated with a workflow execution.",
  inputSchema: z.object({
    executionId: z
      .string()
      .describe("The ID of the workflow execution to get the workflow for"),
  }),
  outputSchema: z.object({
    id: z.string(),
    workflow_collection_id: z.string().nullish(),
    steps: z.array(StepSchema.omit({ outputSchema: true })),
    input: z.record(z.string(), z.unknown()).nullish(),
    virtual_mcp_id: z.string(),
    created_at_epoch_ms: z.number(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { executionId } = input as { executionId: string };
    const storage = getPluginStorage();

    const execution = await storage.executions.getExecution(
      executionId,
      meshCtx.organization.id,
    );
    if (!execution) {
      throw new Error("Execution not found");
    }

    const workflow = await storage.executions.getWorkflow(
      execution.workflow_id,
    );
    if (!workflow) {
      throw new Error("Workflow not found");
    }

    return {
      id: workflow.id,
      workflow_collection_id: workflow.workflow_collection_id,
      steps: workflow.steps.map((step) => ({
        ...step,
        outputSchema: undefined,
      })),
      input: workflow.input,
      virtual_mcp_id: workflow.virtual_mcp_id,
      created_at_epoch_ms: workflow.created_at_epoch_ms,
    };
  },
};
