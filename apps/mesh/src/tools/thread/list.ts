/**
 * COLLECTION_THREADS_LIST Tool
 *
 * List all threads in the organization with collection binding compliance.
 * Supports filtering, sorting, and pagination.
 */

import {
  CollectionListInputSchema,
  createCollectionListOutputSchema,
} from "@decocms/bindings/collections";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { normalizeThreadForResponse } from "./helpers";
import { ThreadEntitySchema } from "./schema";
import { z } from "zod";

const ThreadListInputSchema = CollectionListInputSchema.extend({
  where: z
    .object({
      created_by: z.string().optional(),
      trigger_ids: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Output schema using the ThreadEntitySchema
 */
const ThreadListOutputSchema =
  createCollectionListOutputSchema(ThreadEntitySchema);

export const COLLECTION_THREADS_LIST = defineTool({
  name: "COLLECTION_THREADS_LIST",
  description:
    "List all threads in the organization with filtering, sorting, and pagination",
  annotations: {
    title: "List Threads",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ThreadListInputSchema,
  outputSchema: ThreadListOutputSchema,

  handler: async (input, ctx) => {
    await ctx.access.check();
    const userId = ctx.auth.user?.id;
    if (!userId) {
      throw new Error("User ID required to list threads");
    }
    requireOrganization(ctx);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;

    const triggerIds = input.where?.trigger_ids;
    const createdBy = input.where?.created_by;

    const { threads, total } = triggerIds?.length
      ? await ctx.storage.threads.listByTriggerIds(triggerIds, {
          limit,
          offset,
        })
      : await ctx.storage.threads.list(createdBy, {
          limit,
          offset,
        });

    const hasMore = offset + limit < total;

    const now = Date.now();

    return {
      items: threads.map((thread) => normalizeThreadForResponse(thread, now)),
      totalCount: total,
      hasMore,
    };
  },
});
