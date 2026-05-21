import z from "zod";
import { capabilitySchema } from "@/links/protocol";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const LINK_CURRENT_GET = defineTool({
  name: "LINK_CURRENT_GET",
  description:
    "Return the calling user's currently registered desktop link, or `online: false` if no link is registered or the TTL has expired. The `linkSecret` is never returned.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    online: z.boolean(),
    machineId: z.string().optional(),
    cliVersion: z.string().optional(),
    capabilities: z.array(capabilitySchema).default([]),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const registry = ctx.linkRegistry;
    if (!registry) return { online: false, capabilities: [] };

    const entry = await registry.get(ctx.auth.user!.id);
    if (!entry) return { online: false, capabilities: [] };

    return {
      online: true,
      machineId: entry.machineId,
      cliVersion: entry.cliVersion,
      capabilities: entry.capabilities,
    };
  },
});
