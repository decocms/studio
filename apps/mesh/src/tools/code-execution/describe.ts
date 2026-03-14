/**
 * CODE_EXECUTION_DESCRIBE_TOOLS Tool
 *
 * Get detailed schemas for specific tools.
 * Call after searching to get full input/output schemas.
 *
 * Uses:
 * - If ctx.connectionId points to a Virtual MCP: describes tools from its connections
 * - Otherwise: describes tools from ALL active connections in the organization
 */

import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { DescribeToolsInputSchema, DescribeToolsOutputSchema } from "./schema";
import { describeTools, getToolsWithConnections } from "./utils";

export const CODE_EXECUTION_DESCRIBE_TOOLS = defineTool({
  name: "CODE_EXECUTION_DESCRIBE_TOOLS",
  description:
    "Get detailed schemas for specific tools. Call after CODE_EXECUTION_SEARCH_TOOLS to get full input/output schemas before executing code.",
  annotations: {
    title: "Describe Tools",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: DescribeToolsInputSchema,
  outputSchema: DescribeToolsOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    // Get tools from connections (agent-specific or all org connections)
    const toolContext = await getToolsWithConnections(ctx);

    try {
      // Describe requested tools
      return describeTools(input.tools, toolContext.tools);
    } finally {
      await toolContext.close();
    }
  },
});
