import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { z } from "zod";
import { RegistryGetInputSchema, RegistryItemSchema } from "./schema";

export const REGISTRY_ITEM_VERSIONS = defineTool({
  name: "REGISTRY_ITEM_VERSIONS" as const,
  description: "Get available versions of a registry item",
  inputSchema: RegistryGetInputSchema,
  outputSchema: z.object({
    versions: z.array(RegistryItemSchema),
  }),

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const itemId = input.id ?? input.name;
    if (!itemId) {
      throw new Error("Either 'id' or 'name' is required");
    }

    const storage = ctx.storage.registry;
    const item = await storage.items.findByIdOrName(organization.id, itemId);
    return { versions: item ? [item] : [] };
  },
});
