import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { RegistryListInputSchema, RegistryListOutputSchema } from "./schema";

export const REGISTRY_ITEM_LIST = defineTool({
  name: "REGISTRY_ITEM_LIST" as const,
  description: "List private registry items for the current organization",
  inputSchema: RegistryListInputSchema,
  outputSchema: RegistryListOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    return storage.items.list(organization.id, input);
  },
});
