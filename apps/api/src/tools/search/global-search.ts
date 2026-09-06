/**
 * GLOBAL_SEARCH Tool
 *
 * Single entry point for cross-resource search. Returns a typed union of
 * matches so callers can render mixed result lists without knowing which
 * resource types are searchable today.
 *
 * Threads and task-board cards are searchable. To add a new resource type:
 *   1. Extend `SearchResultSchema` with a new discriminated branch.
 *   2. Add a corresponding case in the handler that queries that resource.
 *   3. Add the type name to `SEARCHABLE_TYPES`.
 *
 * No client changes are required to start receiving the new type — clients
 * that don't handle it should silently ignore unknown `type` values.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/studio-context";
import { normalizeThreadForResponse } from "../thread/helpers";
import { taskKey } from "@decocms/shared/task-key";

const SEARCHABLE_TYPES = ["thread", "task"] as const;

const ThreadResultSchema = z.object({
  type: z.literal("thread"),
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  virtual_mcp_id: z.string().nullable(),
  /** Raw run_config so the client can resolve the agent (mirrors monitoring view). */
  run_config: z.record(z.string(), z.unknown()).nullable(),
  status: z.string().nullable(),
});

const TaskResultSchema = z.object({
  type: z.literal("task"),
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** The human key the card is addressed by (`DECO-01`, or a synced `OS-333`). */
  key: z.string().nullable(),
  status: z.string().nullable(),
  /** `owner/name` routing hint. Null for reports-imported and Jira-synced cards. */
  repo: z.string().nullable(),
});

const SearchResultSchema = z.discriminatedUnion("type", [
  ThreadResultSchema,
  TaskResultSchema,
]);

const InputSchema = z.object({
  query: z
    .string()
    // Bounded to keep an authenticated caller from forcing a pathologically
    // long ILIKE substring scan across every searchable resource type.
    .max(256)
    .describe(
      "Free-text search query. Empty string returns the most recently updated resources.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum results per resource type (default: 20)."),
  types: z
    .array(z.enum(SEARCHABLE_TYPES))
    .optional()
    .describe(
      "Restrict the search to specific resource types. Omit to search across all available types.",
    ),
});

const OutputSchema = z.object({
  items: z.array(SearchResultSchema),
  /** Threads report their full match count; task cards report only the page
   *  returned, because the task-board search has no count query yet. */
  totalCount: z.number(),
});

function toIso(value: string | Date | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * Trims the query and treats a whitespace-only string as "no query" so it
 * falls back to the documented "most recently updated" behavior instead of
 * ILIKE-matching a literal run of whitespace against titles.
 */
export function normalizeSearchQuery(query: string): string | undefined {
  const trimmed = query.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Omitting `types` searches every resource type; passing `types: []` (e.g. a
 * caller unchecked every filter) must narrow to none rather than falling
 * back to "search everything".
 */
export function includesSearchType(
  types: readonly string[] | undefined,
  type: string,
): boolean {
  return types === undefined || types.includes(type);
}

export const GLOBAL_SEARCH = defineTool({
  name: "GLOBAL_SEARCH",
  description:
    "Search across organization resources by free-text query. Returns a typed union of matches (currently: threads and task-board cards). New resource types may be added over time without changes to the call shape.",
  annotations: {
    title: "Global Search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input, ctx) => {
    await ctx.access.check();
    const organization = requireOrganization(ctx);

    const limit = input.limit ?? 20;
    const includeThreads = includesSearchType(input.types, "thread");
    const includeTasks = includesSearchType(input.types, "task");

    const items: z.infer<typeof SearchResultSchema>[] = [];
    let totalCount = 0;

    if (includeThreads) {
      const { threads, total } = await ctx.storage.threads.list(undefined, {
        limit,
        offset: 0,
        search: normalizeSearchQuery(input.query),
        includeArchived: false,
      });
      totalCount += total;
      for (const thread of threads) {
        items.push({
          type: "thread",
          id: thread.id,
          title: thread.title ?? "",
          created_at: toIso(thread.created_at),
          updated_at: toIso(thread.updated_at),
          virtual_mcp_id: thread.virtual_mcp_id ?? null,
          run_config:
            (thread.run_config as Record<string, unknown> | null) ?? null,
          // Same expiry derivation as THREAD_LIST/GET/etc. — otherwise a
          // stale in_progress run shows "in_progress" here but "expired"
          // everywhere else in the app.
          status: normalizeThreadForResponse(thread).status,
        });
      }
    }

    if (includeTasks) {
      /** An empty query is the documented "most recently updated" case: an
       *  empty term matches every title, and the storage query already orders
       *  by `updated_at desc` under the same limit. */
      const tasks = await ctx.storage.taskBoard.searchByTitle(
        organization.id,
        normalizeSearchQuery(input.query) ?? "",
        limit,
      );
      totalCount += tasks.length;
      for (const task of tasks) {
        items.push({
          type: "task",
          id: task.id,
          title: task.title ?? "",
          created_at: toIso(task.createdAt),
          updated_at: toIso(task.updatedAt),
          /** Derived, not stored. */
          key: organization.slug
            ? taskKey(organization.slug, task.keySeq)
            : null,
          status: task.status ?? null,
          repo: task.repo ?? null,
        });
      }
    }

    return { items, totalCount };
  },
});
