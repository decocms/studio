/**
 * COLLECTION_THREADS_DELETE Tool
 *
 * Delete a thread with collection binding compliance.
 */

import {
  CollectionDeleteInputSchema,
  createCollectionDeleteOutputSchema,
} from "@decocms/bindings/collections";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { normalizeThreadForResponse } from "./helpers";
import { ThreadEntitySchema } from "./schema";

export const COLLECTION_THREADS_DELETE = defineTool({
  name: "COLLECTION_THREADS_DELETE",
  description: "Permanently delete a thread and all its messages.",
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
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    const thread = await ctx.storage.threads.get(input.id);
    if (!thread) {
      throw new Error(`Thread not found: ${input.id}`);
    }

    await ctx.storage.threads.delete(input.id);

    const userId = getUserId(ctx);
    if (userId) {
      posthog.capture({
        distinctId: userId,
        event: "chat_deleted",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          thread_id: input.id,
        },
      });
    }

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
