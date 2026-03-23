/**
 * COLLECTION_THREADS_UPDATE Tool
 *
 * Update an existing thread (organization-scoped) with collection binding compliance.
 */

import { z } from "zod";
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
    requireOrganization(ctx);

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

    const thread = await ctx.storage.threads.update(id, {
      title: data.title,
      description: data.description,
      hidden: data.hidden,
      status: data.status as
        | import("../../storage/types").ThreadStatus
        | undefined,
      updated_by: userId,
    });

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
