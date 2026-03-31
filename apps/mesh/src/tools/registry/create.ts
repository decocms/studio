import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryCreateInputSchema,
  RegistryCreateOutputSchema,
} from "./schema";

export const REGISTRY_ITEM_CREATE = defineTool({
  name: "REGISTRY_ITEM_CREATE" as const,
  description: "Create a private registry item",
  inputSchema: RegistryCreateInputSchema,
  outputSchema: RegistryCreateOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const item = await storage.items.create({
      ...input.data,
      organization_id: organization.id,
      created_by: ctx.auth.user?.id ?? null,
    });
    return { item };
  },
});
