/**
 * COLLECTION_THREADS_DELETE Tool
 *
 * Delete a thread with collection binding compliance.
 */

import {
  CollectionDeleteInputSchema,
  createCollectionDeleteOutputSchema,
} from "@decocms/bindings/collections";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { normalizeThreadForResponse } from "./helpers";
import { ThreadEntitySchema } from "./schema";

export const COLLECTION_THREADS_DELETE = defineTool({
  name: "COLLECTION_THREADS_DELETE",
  description: "Delete a thread",
  annotations: {
    title: "Delete Thread",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CollectionDeleteInputSchema,
  outputSchema: createCollectionDeleteOutputSchema(ThreadEntitySchema),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);

    await ctx.access.check();

    const thread = await ctx.storage.threads.get(input.id);
    if (!thread) {
      throw new Error(`Thread not found: ${input.id}`);
    }

    await ctx.storage.threads.delete(input.id);

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
