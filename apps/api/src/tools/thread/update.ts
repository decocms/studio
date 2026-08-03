/**
 * COLLECTION_THREADS_UPDATE Tool
 *
 * Update an existing thread (organization-scoped) with collection binding compliance.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { normalizeThreadForResponse, type GithubRepoMeta } from "./helpers";
import {
  ThreadEntitySchema,
  ThreadUpdateDataSchema,
} from "@decocms/shared/thread/schema";
import {
  assertThreadRoutingUpdateAllowed,
  changesThreadRouting,
} from "./runtime-lock";

/**
 * Input schema for updating threads
 */
const UpdateInputSchema = z.object({
  id: z.string().describe("ID of the thread to update"),
  data: ThreadUpdateDataSchema.describe("Partial thread data to update"),
});

/**
 * Output schema for updated thread
 */
const UpdateOutputSchema = z.object({
  item: ThreadEntitySchema.describe("The updated thread entity"),
});

export const COLLECTION_THREADS_UPDATE = defineTool({
  name: "COLLECTION_THREADS_UPDATE",
  description: "Update a thread's title, description, or visibility.",
  annotations: {
    title: "Update Thread",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateInputSchema,
  outputSchema: UpdateOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to update thread");
    }

    const { id, data } = input;

    const existing = await ctx.storage.threads.get(id);
    if (!existing) {
      throw new Error("Thread not found in organization");
    }
    if (existing.created_by !== userId) {
      throw new Error("Only the chat owner can update this thread");
    }

    assertThreadRoutingUpdateAllowed(existing, data);

    if (data.virtual_mcp_id !== undefined) {
      const targetVmcp = await ctx.storage.virtualMcps.findById(
        data.virtual_mcp_id,
        organization.id,
      );
      // Keep the explicit entity check as defense in depth for synthesized
      // well-known agents; normal rows are scoped in SQL by findById.
      if (!targetVmcp || targetVmcp.organization_id !== organization.id) {
        throw new Error(`Virtual MCP not found: ${data.virtual_mcp_id}`);
      }
    }

    if (data.branch === null && existing.virtual_mcp_id) {
      const vmcp = await ctx.storage.virtualMcps.findById(
        existing.virtual_mcp_id,
        organization.id,
      );
      const githubRepo = (vmcp?.metadata as GithubRepoMeta | null | undefined)
        ?.githubRepo;
      if (githubRepo) {
        throw new Error(
          "Cannot set branch=null on a github-linked thread (vMCP has githubRepo)",
        );
      }
    }

    const updateData: Parameters<typeof ctx.storage.threads.update>[1] = {
      title: data.title,
      description: data.description,
      hidden: data.hidden,
      updated_by: userId,
    };

    if (data.status) {
      updateData.status = data.status;
    }

    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata;
    }

    if (data.branch !== undefined) {
      updateData.branch = data.branch;
    }

    if (data.virtual_mcp_id !== undefined) {
      updateData.virtual_mcp_id = data.virtual_mcp_id;
    }

    const routingChanged = changesThreadRouting(existing, data);
    const thread = routingChanged
      ? await ctx.storage.threads.updateRoutingIfRuntimeUnlocked(id, updateData)
      : await ctx.storage.threads.update(id, updateData);
    if (!thread) {
      throw new Error(
        "Cannot change the agent or branch after this chat has started",
      );
    }

    // Fire chat_archived / chat_unarchived when the hidden flag flips. Only
    // fires on the specific transition, not on title/description edits that
    // happen to include `hidden` unchanged.
    if (data.hidden !== undefined && data.hidden !== existing.hidden) {
      posthog.capture({
        distinctId: userId,
        event: data.hidden ? "chat_archived" : "chat_unarchived",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          thread_id: id,
        },
      });
    }

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
