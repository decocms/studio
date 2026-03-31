import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryUpdateInputSchema,
  RegistryUpdateOutputSchema,
} from "./schema";

export const REGISTRY_ITEM_UPDATE = defineTool({
  name: "REGISTRY_ITEM_UPDATE" as const,
  description: "Update a private registry item",
  inputSchema: RegistryUpdateInputSchema,
  outputSchema: RegistryUpdateOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const item = await storage.items.update(
      organization.id,
      input.id,
      input.data,
    );
    return { item };
  },
});
