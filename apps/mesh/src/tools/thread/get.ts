/**
 * COLLECTION_THREADS_GET Tool
 *
 * Get thread details by ID with collection binding compliance.
 */

import {
  CollectionGetInputSchema,
  createCollectionGetOutputSchema,
} from "@decocms/bindings/collections";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { normalizeThreadForResponse } from "./helpers";
import { ThreadEntitySchema } from "./schema";

/**
 * Output schema using the ThreadEntitySchema
 */
const ThreadGetOutputSchema =
  createCollectionGetOutputSchema(ThreadEntitySchema);

export const COLLECTION_THREADS_GET = defineTool({
  name: "COLLECTION_THREADS_GET",
  description: "Get thread details by ID",
  annotations: {
    title: "Get Thread",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CollectionGetInputSchema,
  outputSchema: ThreadGetOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);

    await ctx.access.check();

    const thread = await ctx.storage.threads.get(input.id);

    if (!thread) {
      return { item: null };
    }

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
