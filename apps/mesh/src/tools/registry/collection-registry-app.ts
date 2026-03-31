import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { z } from "zod";
import {
  RegistryFiltersOutputSchema,
  RegistryGetInputSchema,
  RegistryGetOutputSchema,
  RegistryItemSchema,
  RegistryListInputSchema,
  RegistryListOutputSchema,
} from "./schema";
import { getRegistryPluginSettings } from "./utils";
import type { RegistryWhereExpression } from "@/storage/registry/types";

function applyPrivateOnlyWhere(
  where: RegistryWhereExpression | undefined,
  privateOnly: boolean,
): RegistryWhereExpression | undefined {
  if (!privateOnly) return where;
  const privateWhere: RegistryWhereExpression = {
    field: ["is_public"],
    operator: "eq",
    value: false,
  };
  if (!where) return privateWhere;
  return {
    operator: "and",
    conditions: [where, privateWhere],
  };
}

function buildFiltersFromItems(
  items: Array<{ _meta?: Record<string, unknown> }>,
) {
  const tagsCount = new Map<string, number>();
  const categoriesCount = new Map<string, number>();

  for (const item of items) {
    const mesh = item._meta?.["mcp.mesh"] as
      | { tags?: string[]; categories?: string[] }
      | undefined;
    for (const tag of mesh?.tags ?? []) {
      tagsCount.set(tag, (tagsCount.get(tag) ?? 0) + 1);
    }
    for (const category of mesh?.categories ?? []) {
      categoriesCount.set(category, (categoriesCount.get(category) ?? 0) + 1);
    }
  }

  const toSorted = (source: Map<string, number>) =>
    Array.from(source.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));

  return {
    tags: toSorted(tagsCount),
    categories: toSorted(categoriesCount),
  };
}

export const COLLECTION_REGISTRY_APP_LIST = defineTool({
  name: "COLLECTION_REGISTRY_APP_LIST" as const,
  description:
    "List registry items for Store discovery. Supports private-only mode from plugin settings.",
  inputSchema: RegistryListInputSchema,
  outputSchema: RegistryListOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const settings = await getRegistryPluginSettings(ctx, organization.id);
    return storage.items.list(organization.id, {
      ...input,
      where: applyPrivateOnlyWhere(
        input.where,
        settings.storePrivateOnly === true,
      ),
    });
  },
});

export const COLLECTION_REGISTRY_APP_GET = defineTool({
  name: "COLLECTION_REGISTRY_APP_GET" as const,
  description:
    "Get a registry item for Store details. Respects private-only mode from plugin settings.",
  inputSchema: RegistryGetInputSchema,
  outputSchema: RegistryGetOutputSchema,
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const settings = await getRegistryPluginSettings(ctx, organization.id);
    const identifier = input.id ?? input.name;
    if (!identifier) return { item: null };
    const item = await storage.items.findByIdOrName(
      organization.id,
      identifier,
    );
    if (!item) return { item: null };
    if (settings.storePrivateOnly && item.is_public) return { item: null };
    return { item };
  },
});

export const COLLECTION_REGISTRY_APP_VERSIONS = defineTool({
  name: "COLLECTION_REGISTRY_APP_VERSIONS" as const,
  description:
    "Get registry item versions for Store details. Respects private-only mode from plugin settings.",
  inputSchema: RegistryGetInputSchema,
  outputSchema: z.object({
    versions: z.array(RegistryItemSchema),
  }),
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const settings = await getRegistryPluginSettings(ctx, organization.id);
    const identifier = input.id ?? input.name;
    if (!identifier) return { versions: [] };
    const item = await storage.items.findByIdOrName(
      organization.id,
      identifier,
    );
    if (!item) return { versions: [] };
    if (settings.storePrivateOnly && item.is_public) return { versions: [] };
    return { versions: [item] };
  },
});

export const COLLECTION_REGISTRY_APP_FILTERS = defineTool({
  name: "COLLECTION_REGISTRY_APP_FILTERS" as const,
  description:
    "List Store filter facets for registry items. Respects private-only mode from plugin settings.",
  inputSchema: z.object({}),
  outputSchema: RegistryFiltersOutputSchema,
  handler: async (_input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const settings = await getRegistryPluginSettings(ctx, organization.id);
    if (!settings.storePrivateOnly) {
      return storage.items.getFilters(organization.id);
    }
    const items = await storage.items.list(organization.id, {
      limit: 10000,
      where: {
        field: ["is_public"],
        operator: "eq",
        value: false,
      },
    });
    return buildFiltersFromItems(items.items);
  },
});
