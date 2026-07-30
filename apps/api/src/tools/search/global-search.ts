/**
 * GLOBAL_SEARCH Tool
 *
 * Single entry point for cross-resource search. Returns a typed union of
 * matches so callers can render mixed result lists without knowing which
 * resource types are searchable today.
 *
 * Today only threads are searchable. To add a new resource type:
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

const SEARCHABLE_TYPES = ["thread"] as const;

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

const SearchResultSchema = z.discriminatedUnion("type", [ThreadResultSchema]);

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

export const GLOBAL_SEARCH = defineTool({
  name: "GLOBAL_SEARCH",
  description:
    "Search across organization resources by free-text query. Returns a typed union of matches (currently: threads). New resource types may be added over time without changes to the call shape.",
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
    requireOrganization(ctx);

    const limit = input.limit ?? 20;
    const requested = input.types?.length ? new Set(input.types) : null;
    const includeThreads = !requested || requested.has("thread");

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

    return { items, totalCount };
  },
});
