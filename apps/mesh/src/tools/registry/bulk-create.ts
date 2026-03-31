import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryBulkCreateInputSchema,
  RegistryBulkCreateOutputSchema,
} from "./schema";

export const REGISTRY_ITEM_BULK_CREATE = defineTool({
  name: "REGISTRY_ITEM_BULK_CREATE" as const,
  description: "Create many private registry items at once",
  inputSchema: RegistryBulkCreateInputSchema,
  outputSchema: RegistryBulkCreateOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const errors: Array<{ id: string; error: string }> = [];
    let created = 0;

    for (const item of input.items) {
      try {
        await storage.items.create({
          ...item,
          organization_id: organization.id,
          created_by: ctx.auth.user?.id ?? null,
        });
        created += 1;
      } catch (error) {
        errors.push({
          id: item.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return { created, errors };
  },
});
