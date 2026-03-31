import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistrySearchInputSchema,
  RegistrySearchOutputSchema,
} from "./schema";

export const REGISTRY_ITEM_SEARCH = defineTool({
  name: "REGISTRY_ITEM_SEARCH" as const,
  description:
    "Search registry items returning minimal data (id, title, tags, categories, is_public, is_unlisted). " +
    "Use this instead of LIST when you need to find items efficiently without loading full details. " +
    "Supports free-text search across id, title, description, and server name, " +
    "plus filtering by tags and categories.",
  inputSchema: RegistrySearchInputSchema,
  outputSchema: RegistrySearchOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    return storage.items.search(organization.id, input);
  },
});
