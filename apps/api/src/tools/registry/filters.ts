import { getCatalog, catalogFilters } from "./catalog";
import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/studio-context";
import { z } from "zod";
import { RegistryFiltersOutputSchema } from "./schema";

export const REGISTRY_ITEM_FILTERS = defineTool({
  name: "REGISTRY_ITEM_FILTERS" as const,
  description: "List available tag/category filters for Deco registry items",
  inputSchema: z.object({}),
  outputSchema: RegistryFiltersOutputSchema,

  handler: async (_input, ctx) => {
    requireOrganization(ctx);
    await ctx.access.check();
    return catalogFilters(await getCatalog());
  },
});
