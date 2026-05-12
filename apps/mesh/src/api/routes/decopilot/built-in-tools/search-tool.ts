/**
 * search_tool Built-in Tool
 *
 * Server-side tool that lets the model discover tools available in the
 * current Virtual MCP via case-insensitive substring matching on tool id
 * and description. Scope is implicit (current Virtual MCP) — the catalog
 * is captured at request build time by stream-core.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";

const DESCRIPTION_MAX_LEN = 140;
const MAX_RESULTS = 10;

export const SearchToolInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Substring to match against tool ids and descriptions " +
        "(case-insensitive).",
    ),
});

const SearchToolOutputSchema = z.object({
  results: z.array(
    z.object({
      tool_id: z.string(),
      description: z.string(),
    }),
  ),
});

export interface SearchToolCatalogEntry {
  id: string;
  description: string;
}

const DESCRIPTION =
  "Search for tools available in the current agent. Returns up to 10 tools " +
  "matching the query by id or description. Read-only and safe to call at any time.\n\n" +
  "Usage notes:\n" +
  "- Call before enable_tool when you do not know exact tool ids.\n" +
  "- The query is matched case-insensitively against ids and descriptions.\n" +
  "- This searches only the current agent. To use tools from another agent, delegate with subtask.";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function createSearchToolTool(catalog: SearchToolCatalogEntry[]) {
  return tool({
    description: DESCRIPTION,
    inputSchema: zodSchema(SearchToolInputSchema),
    outputSchema: zodSchema(SearchToolOutputSchema),
    execute: async ({ query }) => {
      const needle = query.toLowerCase();
      const matches: { tool_id: string; description: string }[] = [];
      for (const entry of catalog) {
        const hay = `${entry.id} ${entry.description}`.toLowerCase();
        if (!hay.includes(needle)) continue;
        matches.push({
          tool_id: entry.id,
          description: truncate(entry.description, DESCRIPTION_MAX_LEN),
        });
        if (matches.length >= MAX_RESULTS) break;
      }
      return { results: matches };
    },
  });
}
