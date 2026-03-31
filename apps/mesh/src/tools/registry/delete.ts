import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryDeleteInputSchema,
  RegistryDeleteOutputSchema,
} from "./schema";

export const REGISTRY_ITEM_DELETE = defineTool({
  name: "REGISTRY_ITEM_DELETE" as const,
  description: "Delete a private registry item",
  inputSchema: RegistryDeleteInputSchema,
  outputSchema: RegistryDeleteOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const item = await storage.items.delete(organization.id, input.id);
    if (!item) {
      throw new Error(`Registry item not found: ${input.id}`);
    }
    return { item };
  },
});
