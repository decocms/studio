import { getStudioMcpMetadata } from "@decocms/shared/registry/metadata";
import { buildTextSearchWhere, getCatalog, listCatalog } from "./catalog";
import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/studio-context";
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
    requireOrganization(ctx);
    await ctx.access.check();
    const tokens = input.query?.trim().split(/\s+/).filter(Boolean) ?? [];
    const result = listCatalog(await getCatalog(), {
      ...input,
      where: tokens.length ? buildTextSearchWhere(tokens) : undefined,
    });
    return {
      ...result,
      items: result.items.map((item) => ({
        id: item.id,
        title: item.title,
        tags: getStudioMcpMetadata(item._meta)?.tags ?? [],
        categories: getStudioMcpMetadata(item._meta)?.categories ?? [],
        is_public: true,
        is_unlisted: false,
      })),
    };
  },
});
