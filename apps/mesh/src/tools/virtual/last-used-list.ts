/**
 * VIRTUAL_MCP_LAST_USED_LIST Tool
 *
 * Returns the most recent thread timestamp + creator per virtual MCP id.
 * Kept on a dedicated endpoint so the agent fetch hot path doesn't pay for
 * this query on every request.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

const InputSchema = z.object({
  ids: z.array(z.string()).describe("Virtual MCP ids to look up"),
});

const OutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      last_used_at: z.string().optional(),
      last_used_by: z.string().optional(),
    }),
  ),
});

export const VIRTUAL_MCP_LAST_USED_LIST = defineTool({
  name: "VIRTUAL_MCP_LAST_USED_LIST",
  description:
    "Get last-used info (timestamp + user) for one or more virtual MCPs, derived from the most recent thread per agent.",
  annotations: {
    title: "List Virtual MCP Last Used",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const map = await ctx.storage.threads.findLastUsedByVirtualMcpIds(
      input.ids,
    );

    return {
      items: input.ids.map((id) => ({
        id,
        last_used_at: map.get(id)?.last_used_at,
        last_used_by: map.get(id)?.last_used_by,
      })),
    };
  },
});
