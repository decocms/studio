import type { ServerPluginToolDefinition } from "@decocms/bindings/server-plugin";
import {
  RegistrySearchInputSchema,
  RegistrySearchOutputSchema,
} from "./schema";
import { getPluginStorage, orgHandler } from "./utils";

export const REGISTRY_ITEM_SEARCH: ServerPluginToolDefinition = {
  name: "REGISTRY_ITEM_SEARCH",
  description:
    "Search registry items returning minimal data (id, title, tags, categories, is_public, is_unlisted). " +
    "Use this instead of LIST when you need to find items efficiently without loading full details. " +
    "Supports free-text search across id, title, description, and server name, " +
    "plus filtering by tags and categories.",
  inputSchema: RegistrySearchInputSchema,
  outputSchema: RegistrySearchOutputSchema,

  handler: orgHandler(RegistrySearchInputSchema, async (input, ctx) => {
    const storage = getPluginStorage();
    return storage.items.search(ctx.organization.id, input);
  }),
};
