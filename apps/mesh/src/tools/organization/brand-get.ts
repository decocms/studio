import {
  BrandGetInputSchema,
  BrandSchema,
  BrandListInputSchema,
  BrandListOutputSchema,
} from "@decocms/bindings/brand";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import type { BrandContext } from "../../storage/types";

function toBrandOutput(brand: BrandContext) {
  const metadata = brand.metadata ?? {};
  return {
    id: brand.id,
    name: brand.name,
    domain: brand.domain || undefined,
    colors: brand.colors ?? undefined,
    fonts: brand.fonts ?? undefined,
    assets:
      brand.logo || brand.favicon || brand.ogImage
        ? {
            logo: brand.logo ?? undefined,
            favicon: brand.favicon ?? undefined,
            ogImage: brand.ogImage ?? undefined,
          }
        : undefined,
    overview: brand.overview || undefined,
    tagline:
      typeof metadata.tagline === "string" ? metadata.tagline : undefined,
    tone: typeof metadata.tone === "string" ? metadata.tone : undefined,
    metadata: (() => {
      const filtered = Object.fromEntries(
        Object.entries(metadata).filter(
          ([k]) => k !== "tagline" && k !== "tone",
        ),
      );
      return Object.keys(filtered).length > 0 ? filtered : undefined;
    })(),
  };
}

export const BRAND_GET = defineTool({
  name: "BRAND_GET",
  description:
    "Get a brand context by ID. Omit the ID to get the default brand for the organization.",
  annotations: {
    title: "Get Brand",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: BrandGetInputSchema,
  outputSchema: BrandSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brand = input.id
      ? await ctx.storage.brandContext.get(input.id, organizationId)
      : await ctx.storage.brandContext.getDefault(organizationId);

    if (!brand) {
      throw new Error(
        input.id ? "Brand not found" : "No default brand configured",
      );
    }

    return toBrandOutput(brand);
  },
});

export const BRAND_LIST = defineTool({
  name: "BRAND_LIST",
  description: "List all active brands for the current organization.",
  annotations: {
    title: "List Brands",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: BrandListInputSchema,
  outputSchema: BrandListOutputSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brands = await ctx.storage.brandContext.list(organizationId);
    return { items: brands.map(toBrandOutput) };
  },
});
