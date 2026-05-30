/**
 * COLLECTION_THREAD_MESSAGES_LIST Tool
 *
 * List all messages for a specific thread.
 */

import {
  CollectionListInputSchema,
  createCollectionListOutputSchema,
  type WhereExpression,
} from "@decocms/bindings/collections";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { ThreadMessageEntitySchema } from "./schema";

/**
 * Extract threadId from where clause (backward compat)
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
 * Input schema with top-level thread_id
 */
const ListMessagesInputSchema = CollectionListInputSchema.extend({
  thread_id: z
    .string()
    .optional()
    .describe("ID of the thread to list messages for (required)"),
});

/**
 * Output schema for thread messages list
 */
const ListMessagesOutputSchema = createCollectionListOutputSchema(
  ThreadMessageEntitySchema,
);

export const COLLECTION_THREAD_MESSAGES_LIST = defineTool({
  name: "COLLECTION_THREAD_MESSAGES_LIST",
  description:
    "List messages in a thread with pagination. Requires thread_id. Returns messages in chronological order.",
  annotations: {
    title: "List Thread Messages",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ListMessagesInputSchema,
  outputSchema: ListMessagesOutputSchema,

  handler: async (input, ctx) => {
    requireOrganization(ctx);

    await ctx.access.check();

    // Use top-level thread_id, fall back to extracting from where clause
    const taskId = input.thread_id ?? extractThreadIdFromWhere(input.where);
    if (!taskId) {
      throw new Error(
        "thread_id is required (provide as top-level param or in where clause)",
      );
    }

    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;

    // Translate the first orderBy direction into storage's sort param.
    // The storage layer only supports created_at ordering, so we look at
    // the first orderBy entry's direction (typically `created_at desc`
    // for chat pagination). Default asc preserves the prior behavior
    // when no orderBy is supplied.
    const sort: "asc" | "desc" = input.orderBy?.[0]?.direction ?? "asc";

    const { messages, total } = await ctx.storage.threads.listMessages(taskId, {
      limit,
      offset,
      sort,
    });

    const hasMore = offset + limit < total;

    return {
      items: messages,
      totalCount: total,
      hasMore,
    };
  },
});
