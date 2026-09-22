import { getCatalog, listCatalog } from "./catalog";
import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/studio-context";
import { RegistryListInputSchema, RegistryListOutputSchema } from "./schema";

export const REGISTRY_ITEM_LIST = defineTool({
  name: "REGISTRY_ITEM_LIST" as const,
  description: "List Deco registry items for the current organization",
  inputSchema: RegistryListInputSchema,
  outputSchema: RegistryListOutputSchema,

  handler: async (input, ctx) => {
    requireOrganization(ctx);
    await ctx.access.check();
    return listCatalog(await getCatalog(), input);
  },
});
