/**
 * THREAD_MESSAGES_LIST Tool
 *
 * List all messages for a specific thread.
 */

import {
  CollectionListInputSchema,
  createCollectionListOutputSchema,
  type WhereExpression,
} from "@decocms/bindings/collections";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { ThreadMessageEntitySchema } from "./schema";

/**
 * Extract threadId from where clause
 */
function extractThreadIdFromWhere(
  where: WhereExpression | undefined,
): string | null {
  if (!where) return null;
  if (
    "field" in where &&
    where.field[0] === "thread_id" &&
    where.operator === "eq"
  ) {
    return String(where.value);
  }
  if ("conditions" in where) {
    for (const condition of where.conditions) {
      const found = extractThreadIdFromWhere(condition);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Output schema for thread messages list
 */
const ListMessagesOutputSchema = createCollectionListOutputSchema(
  ThreadMessageEntitySchema,
);

export const THREAD_MESSAGES_LIST = defineTool({
  name: "THREAD_MESSAGES_LIST",
  description:
    "List messages in a thread with pagination. Returns messages in chronological order.",
  annotations: {
    title: "List Thread Messages",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CollectionListInputSchema,
  outputSchema: ListMessagesOutputSchema,

  handler: async (input, ctx) => {
    requireOrganization(ctx);

    await ctx.access.check();

    // Extract threadId from where clause
    const threadId = extractThreadIdFromWhere(input.where);
    if (!threadId) {
      throw new Error("thread_id filter is required in where clause");
    }

    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;

    const { messages, total } = await ctx.storage.threads.listMessages(
      threadId,
      { limit, offset },
    );

    const hasMore = offset + limit < total;

    return {
      items: messages,
      totalCount: total,
      hasMore,
    };
  },
});
