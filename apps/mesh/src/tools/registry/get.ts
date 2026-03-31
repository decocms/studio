import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { RegistryGetInputSchema, RegistryGetOutputSchema } from "./schema";

export const REGISTRY_ITEM_GET = defineTool({
  name: "REGISTRY_ITEM_GET" as const,
  description: "Get a private registry item by ID or name",
  inputSchema: RegistryGetInputSchema,
  outputSchema: RegistryGetOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const itemId = input.id ?? input.name;
    if (!itemId) {
      throw new Error("Either 'id' or 'name' is required");
    }

    const storage = ctx.storage.registry;
    return {
      item: await storage.items.findByIdOrName(organization.id, itemId),
    };
  },
});
