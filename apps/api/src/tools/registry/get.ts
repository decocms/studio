import { getCatalog, findCatalogItem, resolveItemIdentifier } from "./catalog";
import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/studio-context";
import { RegistryGetInputSchema, RegistryGetOutputSchema } from "./schema";

export const REGISTRY_ITEM_GET = defineTool({
  name: "REGISTRY_ITEM_GET" as const,
  description: "Get a Deco registry item by ID or name",
  inputSchema: RegistryGetInputSchema,
  outputSchema: RegistryGetOutputSchema,

  handler: async (input, ctx) => {
    requireOrganization(ctx);
    await ctx.access.check();
    const itemId = resolveItemIdentifier(input);

    return {
      item: findCatalogItem(await getCatalog(), itemId),
    };
  },
});
