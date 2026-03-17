/**
 * Workflows Plugin - Workflow Collection Tools
 *
 * CRUD tools for workflow templates (workflow_collection table).
 * 5 tools: LIST, GET, CREATE, UPDATE, DELETE
 */

import { z } from "zod";
import { StepSchema } from "@decocms/bindings/workflow";
import type { ServerPluginToolDefinition } from "@decocms/bindings/server-plugin";
import { getDecopilotId } from "@decocms/mesh-sdk";
import { requireWorkflowContext, getPluginStorage } from "../types";

// ============================================================================
// LIST
// ============================================================================

export const WORKFLOW_LIST: ServerPluginToolDefinition = {
  name: "WORKFLOW_LIST",
  description:
    "List workflows with pagination. Does not include steps -- use GET for full details.",
  inputSchema: z.object({
    limit: z.number().optional().default(50),
    offset: z.number().optional().default(0),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        virtual_mcp_id: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    totalCount: z.number(),
    hasMore: z.boolean(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const typedInput = input as { limit?: number; offset?: number };
    const storage = getPluginStorage();

    const { items, totalCount } = await storage.collections.list(
      meshCtx.organization.id,
      { limit: typedInput.limit, offset: typedInput.offset },
    );

    return {
      items: items.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        virtual_mcp_id: row.virtual_mcp_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      totalCount,
      hasMore: (typedInput.offset ?? 0) + items.length < totalCount,
    };
  },
};

// ============================================================================
// GET
// ============================================================================

export const WORKFLOW_GET: ServerPluginToolDefinition = {
  name: "WORKFLOW_GET",
  description: "Get a single workflow by ID, including its steps.",
  inputSchema: z.object({
    id: z.string(),
  }),
  outputSchema: z.object({
    item: z
      .object({
        id: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        virtual_mcp_id: z.string(),
        steps: z.array(StepSchema),
        created_at: z.string(),
        updated_at: z.string(),
      })
      .nullable(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { id } = input as { id: string };
    const storage = getPluginStorage();

    const row = await storage.collections.getById(id, meshCtx.organization.id);
    if (!row) {
      return { item: null };
    }

    return {
      item: {
        id: row.id,
        title: row.title,
        description: row.description,
        virtual_mcp_id: row.virtual_mcp_id,
        steps: row.steps,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    };
  },
};

// ============================================================================
// CREATE
// ============================================================================

export const WORKFLOW_CREATE: ServerPluginToolDefinition = {
  name: "WORKFLOW_CREATE",
  description: `Create a workflow template. This is a reusable definition, not an execution.

Key concepts:
- Steps without references run immediately (in parallel).
- Steps with references run as soon as all referenced steps have completed.
- Use @ref syntax to wire data:
    - @input.field - From the execution input
    - @stepName - From the output of a step
    - @stepName.field - From a specific field of a step's output
    - @item - From the current item in a forEach loop
    - @item.field - From a specific field of the current item
- You can interpolate multiple refs in a single string: "Hello @input.name, your order @input.order_id is ready"
- Execution order is auto-determined from @ref dependencies

Example workflow with 2 parallel steps:
{ "title": "Fetch users and orders", "virtual_mcp_id": "vmcp_xyz", "steps": [
  { "name": "fetch_users", "action": { "toolName": "GET_USERS" } },
  { "name": "fetch_orders", "action": { "toolName": "GET_ORDERS" } },
]}

Example workflow with a step that references the output of another step:
{ "title": "Fetch a user by email and then fetch orders", "virtual_mcp_id": "vmcp_xyz", "steps": [
  { "name": "fetch_user", "action": { "toolName": "GET_USER" }, "input": { "email": "@input.user_email" } },
  { "name": "fetch_orders", "action": { "toolName": "GET_USER_ORDERS" }, "input": { "user_id": "@fetch_user.user.id" } },
]}`,
  inputSchema: z.object({
    data: z.object({
      id: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      virtual_mcp_id: z
        .string()
        .optional()
        .describe(
          "The Virtual MCP ID to use for workflow execution. Defaults to Decopilot (organization-wide agent). The execution will only be able to use tools from this Virtual MCP.",
        ),
      steps: z.array(StepSchema).optional().default([]),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      created_by: z.string().optional(),
      updated_by: z.string().optional(),
    }),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { data } = input as {
      data: {
        id?: string;
        title: string;
        description?: string;
        virtual_mcp_id?: string;
        steps?: unknown[];
      };
    };
    const storage = getPluginStorage();

    // Default to Decopilot (organization-wide agent) if no virtual_mcp_id provided
    const virtualMcpId =
      data.virtual_mcp_id ?? getDecopilotId(meshCtx.organization.id);

    const row = await storage.collections.create({
      id: data.id ?? crypto.randomUUID(),
      organization_id: meshCtx.organization.id,
      title: data.title,
      description: data.description ?? null,
      virtual_mcp_id: virtualMcpId,
      steps: JSON.stringify(
        (data.steps ?? []).map((s: unknown) => {
          const step = s as Record<string, unknown>;
          return {
            ...step,
            name:
              typeof step.name === "string"
                ? step.name.trim().replaceAll(/\s+/g, "_")
                : step.name,
          };
        }),
      ),
      created_by: meshCtx.auth.user?.id ?? null,
      updated_by: meshCtx.auth.user?.id ?? null,
    });

    return {
      item: {
        id: row.id,
        title: row.title,
        description: row.description,
        virtual_mcp_id: row.virtual_mcp_id,
        steps: row.steps,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    };
  },
};

// ============================================================================
// UPDATE
// ============================================================================

export const WORKFLOW_UPDATE: ServerPluginToolDefinition = {
  name: "WORKFLOW_UPDATE",
  description: "Update an existing workflow template.",
  inputSchema: z.object({
    id: z.string(),
    data: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      virtual_mcp_id: z.string().optional(),
      steps: z.array(StepSchema).optional(),
    }),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { id, data } = input as {
      id: string;
      data: {
        title?: string;
        description?: string;
        virtual_mcp_id?: string;
        steps?: unknown[];
      };
    };
    const storage = getPluginStorage();

    const updateData: Record<string, unknown> = {
      updated_by: meshCtx.auth.user?.id ?? null,
    };
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.virtual_mcp_id !== undefined)
      updateData.virtual_mcp_id = data.virtual_mcp_id;
    if (data.steps !== undefined)
      updateData.steps = JSON.stringify(
        data.steps.map((s: unknown) => {
          const step = s as Record<string, unknown>;
          return {
            ...step,
            name:
              typeof step.name === "string"
                ? step.name.trim().replaceAll(/\s+/g, "_")
                : step.name,
          };
        }),
      );

    try {
      await storage.collections.update(
        id,
        meshCtx.organization.id,
        updateData as {
          title?: string;
          description?: string | null;
          virtual_mcp_id?: string;
          steps?: string;
          updated_by?: string | null;
        },
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
};

// ============================================================================
// DELETE
// ============================================================================

export const WORKFLOW_DELETE: ServerPluginToolDefinition = {
  name: "WORKFLOW_DELETE",
  description: "Delete a workflow template by ID.",
  inputSchema: z.object({
    id: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),

  handler: async (input, ctx) => {
    const meshCtx = requireWorkflowContext(ctx);
    await meshCtx.access.check();
    const { id } = input as { id: string };
    const storage = getPluginStorage();

    try {
      await storage.collections.delete(id, meshCtx.organization.id);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
};
