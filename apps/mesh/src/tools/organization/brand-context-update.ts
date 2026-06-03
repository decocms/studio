import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { BrandContextSchema } from "./schema.ts";

const BrandContextOutput = BrandContextSchema.extend({
  organizationId: z.string(),
  createdAt: z.string().describe("ISO 8601 timestamp"),
  updatedAt: z.string().describe("ISO 8601 timestamp"),
});

export const BRAND_CONTEXT_CREATE = defineTool({
  name: "BRAND_CONTEXT_CREATE",
  description:
    "Create a new brand context (company profile) for the current organization.",
  annotations: {
    title: "Create Brand Context",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: BrandContextSchema.omit({ id: true }),

  outputSchema: BrandContextOutput,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brand = await ctx.storage.brandContext.create(organizationId, {
      name: input.name,
      domain: input.domain,
      overview: input.overview,
      logo: input.logo ?? null,
      favicon: input.favicon ?? null,
      ogImage: input.ogImage ?? null,
      fonts: input.fonts ?? null,
      colors: input.colors ?? null,
      images: (input.images as Record<string, unknown>[] | null) ?? null,
      metadata: (input.metadata as Record<string, unknown> | null) ?? null,
    });

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

export const BRAND_CONTEXT_UPDATE = defineTool({
  name: "BRAND_CONTEXT_UPDATE",
  description: "Update an existing brand context by ID.",
  annotations: {
    title: "Update Brand Context",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: BrandContextSchema.partial().required({ id: true }),

  outputSchema: BrandContextOutput,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Verify ownership before updating
    const existing = await ctx.storage.brandContext.get(
      input.id,
      organizationId,
    );
    if (!existing) {
      throw new Error("Brand context not found");
    }

    const { id, ...data } = input;

    // Use setDefault to atomically clear other defaults
    if (data.isDefault === true) {
      await ctx.storage.brandContext.setDefault(id, organizationId);
    }

    const brand = await ctx.storage.brandContext.update(id, organizationId, {
      name: data.name,
      domain: data.domain,
      overview: data.overview,
      logo: data.logo !== undefined ? (data.logo ?? null) : undefined,
      favicon: data.favicon !== undefined ? (data.favicon ?? null) : undefined,
      ogImage: data.ogImage !== undefined ? (data.ogImage ?? null) : undefined,
      fonts: data.fonts !== undefined ? (data.fonts ?? null) : undefined,
      colors: data.colors !== undefined ? (data.colors ?? null) : undefined,
      images:
        data.images !== undefined
          ? ((data.images as Record<string, unknown>[] | null) ?? null)
          : undefined,
      metadata:
        data.metadata !== undefined
          ? ((data.metadata as Record<string, unknown> | null) ?? null)
          : undefined,
      archivedAt:
        data.archivedAt !== undefined ? (data.archivedAt ?? null) : undefined,
      // isDefault: true is handled by setDefault above; pass false through directly
      isDefault: data.isDefault === false ? false : undefined,
    });

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

export const BRAND_CONTEXT_DELETE = defineTool({
  name: "BRAND_CONTEXT_DELETE",
  description: "Archive a brand context by ID (soft delete).",
  annotations: {
    title: "Archive Brand Context",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("Brand context ID"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
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

    const existing = await ctx.storage.brandContext.get(
      input.id,
      organizationId,
    );
    if (!existing) {
      throw new Error("Brand context not found");
    }

    await ctx.storage.brandContext.update(input.id, organizationId, {
      archivedAt: new Date().toISOString(),
      isDefault: false,
    });
    return { success: true };
  },
});
