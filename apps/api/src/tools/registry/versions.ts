import { getCatalog, findCatalogItem, resolveItemIdentifier } from "./catalog";
import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/studio-context";
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
    requireOrganization(ctx);
    await ctx.access.check();
    const itemId = resolveItemIdentifier(input);

    const item = findCatalogItem(await getCatalog(), itemId);
    return { versions: item ? [item] : [] };
  },
});
