import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { BrandContextSchema } from "./schema.ts";

const BrandContextOutput = BrandContextSchema.extend({
  organizationId: z.string(),
  archivedAt: z.string().nullable().optional().describe("ISO 8601 timestamp"),
  createdAt: z.string().describe("ISO 8601 timestamp"),
  updatedAt: z.string().describe("ISO 8601 timestamp"),
});

export const BRAND_CONTEXT_LIST = defineTool({
  name: "BRAND_CONTEXT_LIST",
  description:
    "List all brand contexts (company profiles) for the current organization.",
  annotations: {
    title: "List Brand Contexts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    includeArchived: z
      .boolean()
      .optional()
      .describe("Include archived brands in the list"),
  }),

  outputSchema: z.object({
    items: z.array(BrandContextOutput),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brands = await ctx.storage.brandContext.list(organizationId, {
      includeArchived: input.includeArchived,
    });

    return {
      items: brands.map((b) => ({
        ...b,
        archivedAt:
          b.archivedAt instanceof Date
            ? b.archivedAt.toISOString()
            : b.archivedAt,
        createdAt:
          b.createdAt instanceof Date ? b.createdAt.toISOString() : b.createdAt,
        updatedAt:
          b.updatedAt instanceof Date ? b.updatedAt.toISOString() : b.updatedAt,
      })),
    };
  },
});

export const BRAND_CONTEXT_GET = defineTool({
  name: "BRAND_CONTEXT_GET",
  description: "Get a specific brand context by ID.",
  annotations: {
    title: "Get Brand Context",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("Brand context ID"),
  }),

  outputSchema: BrandContextOutput.extend({
    organizationId: z.string(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brand = await ctx.storage.brandContext.get(input.id, organizationId);
    if (!brand) {
      throw new Error("Brand context not found");
    }

    return {
      ...brand,
      archivedAt:
        brand.archivedAt instanceof Date
          ? brand.archivedAt.toISOString()
          : brand.archivedAt,
      createdAt:
        brand.createdAt instanceof Date
          ? brand.createdAt.toISOString()
          : brand.createdAt,
      updatedAt:
        brand.updatedAt instanceof Date
          ? brand.updatedAt.toISOString()
          : brand.updatedAt,
    };
  },
});
