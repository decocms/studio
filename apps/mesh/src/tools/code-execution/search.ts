/**
 * CODE_EXECUTION_SEARCH_TOOLS Tool
 *
 * Search for available tools by name or description.
 * Returns tool names and brief descriptions without full schemas.
 *
 * Uses:
 * - If ctx.connectionId points to a Virtual MCP: searches tools from its connections
 * - Otherwise: searches ALL active connections in the organization
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { SearchToolsInputSchema, SearchToolsOutputSchema } from "./schema";
import { getToolsWithConnections, searchTools } from "./utils";

export const CODE_EXECUTION_SEARCH_TOOLS = defineTool({
  name: "CODE_EXECUTION_SEARCH_TOOLS",
  description:
    "Search for available tools by name or description. Returns tool names and brief descriptions without full schemas. Use this to discover tools before calling CODE_EXECUTION_DESCRIBE_TOOLS for detailed schemas.",
  annotations: {
    title: "Search Tools",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: SearchToolsInputSchema,
  outputSchema: SearchToolsOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    // Get tools from connections (agent-specific or all org connections)
    const toolContext = await getToolsWithConnections(ctx);

    try {
      // Search tools by query
      const results = searchTools(input.query, toolContext.tools, input.limit);

      return {
        query: input.query,
        results: results.map((t) => ({
          name: t.name,
          description: t.description,
          connection: t._meta?.connectionTitle ?? "",
        })),
        totalAvailable: toolContext.tools.length,
      };
    } finally {
      await toolContext.close();
    }
  },
});
