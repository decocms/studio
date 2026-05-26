import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { extractBrandFromDomain } from "../../auth/extract-brand";
import { BrandContextSchema } from "./schema.ts";

const BrandContextExtractOutput = BrandContextSchema.pick({
  id: true,
  name: true,
  domain: true,
  overview: true,
  logo: true,
  favicon: true,
  ogImage: true,
  fonts: true,
  colors: true,
}).extend({
  success: z.boolean(),
});

export const BRAND_CONTEXT_EXTRACT = defineTool({
  name: "BRAND_CONTEXT_EXTRACT",
  description:
    "Extract brand context (colors, fonts, logos) from a website URL using Firecrawl.",
  annotations: {
    title: "Extract Brand Context",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    domain: z.string().describe("Website domain to extract brand from"),
    brandId: z
      .string()
      .optional()
      .describe("Existing brand context ID to update (creates new if omitted)"),
  }),

  outputSchema: BrandContextExtractOutput,

  modelSummary: (r) =>
    r.success
      ? `Brand saved (id=${r.id}, name=${r.name}, domain=${r.domain}). The UI rendered the logo, colors, fonts, and overview.`
      : "Brand extraction failed.",

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const apiKey = ctx.firecrawlApiKey;
    if (!apiKey) {
      throw new Error(
        "FIRECRAWL_API_KEY is not configured. Set the environment variable to enable brand extraction.",
      );
    }

    const extracted = await extractBrandFromDomain(
      input.domain,
      apiKey,
      input.domain,
    );
    if (!extracted) {
      throw new Error("Firecrawl did not return branding data for this URL");
    }

    const brandData = {
      name: extracted.name,
      domain: extracted.domain,
      overview: extracted.overview,
      logo: extracted.logo,
      favicon: extracted.favicon,
      ogImage: extracted.ogImage,
      fonts: extracted.fonts,
      colors: extracted.colors,
      images: extracted.images,
      metadata: extracted.metadata,
    };

    const persisted = input.brandId
      ? await (async () => {
          const existing = await ctx.storage.brandContext.get(
            input.brandId!,
            organizationId,
          );
          if (!existing) {
            throw new Error("Brand context not found");
          }
          return ctx.storage.brandContext.update(
            input.brandId!,
            organizationId,
            brandData,
          );
        })()
      : await ctx.storage.brandContext.create(organizationId, brandData);

    return {
      id: persisted.id,
      name: persisted.name,
      domain: persisted.domain,
      overview: persisted.overview,
      logo: persisted.logo,
      favicon: persisted.favicon,
      ogImage: persisted.ogImage,
      fonts: persisted.fonts,
      colors: persisted.colors,
      success: true,
    };
  },
});
