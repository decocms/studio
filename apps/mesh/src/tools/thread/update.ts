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
} from "../../core/mesh-context";
import { normalizeThreadForResponse } from "./helpers";
import { ThreadEntitySchema, ThreadUpdateDataSchema } from "./schema";

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

    if (data.branch === null && existing.virtual_mcp_id) {
      const vmcp = await ctx.storage.virtualMcps.findById(
        existing.virtual_mcp_id,
        requireOrganization(ctx).id,
      );
      type GithubRepoMeta = {
        githubRepo?: {
          owner: string;
          name: string;
          connectionId?: string;
        } | null;
      };
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

    const thread = await ctx.storage.threads.update(id, updateData);

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
