/**
 * brand-context confirm-mode built-in tools.
 *
 * Per-run injection. Attached by dispatchRun when the brand-context agent
 * is running and the org already has a default brand_context row — i.e.
 * the "confirm your brand" preset face. None of these take a brand id:
 * they all operate on the org's default brand, resolved server-side. The
 * LLM has the brand snapshot in its system prompt (see
 * `apps/mesh/src/agents/brand-context.ts`), so it doesn't need to fetch.
 *
 * `confirm_brand` is what closes the preset task. No DBOS workflow here —
 * unlike setup mode there's no asynchronous wait to bridge across pods;
 * the tool handler can write the preset state directly.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MeshContext } from "@/core/mesh-context";
import { extractBrandFromDomain } from "@/auth/extract-brand";
import { getOrgPrimaryBrand } from "@/agents/brand-context";
import { BRAND_CONTEXT_PRESET_ID } from "@/preset-tasks/brand-context-workflow";

const FontsSchema = z
  .object({
    heading: z.string().optional(),
    body: z.string().optional(),
    code: z.string().optional(),
  })
  .partial();

const ColorsSchema = z
  .object({
    primary: z.string().optional(),
    secondary: z.string().optional(),
    accent: z.string().optional(),
    background: z.string().optional(),
    foreground: z.string().optional(),
  })
  .partial();

const UpdateBrandInputSchema = z
  .object({
    name: z.string().optional().describe("Brand / organization name"),
    domain: z.string().optional().describe("Primary website domain"),
    overview: z.string().optional().describe("Short brand description"),
    logo: z.string().nullable().optional().describe("Logo image URL"),
    favicon: z.string().nullable().optional().describe("Favicon URL"),
    ogImage: z.string().nullable().optional().describe("OG image URL"),
    fonts: FontsSchema.nullable().optional(),
    colors: ColorsSchema.nullable().optional(),
  })
  .describe(
    "Fields to update on the organization's default brand. Omit fields you don't want to change.",
  );

function createUpdateBrandContextTool(ctx: MeshContext) {
  return tool({
    description:
      "Update one or more fields on the organization's current brand " +
      "context. Only include the fields the user wants to change.",
    inputSchema: zodSchema(UpdateBrandInputSchema),
    execute: async (input) => {
      const organizationId = ctx.organization?.id;
      if (!organizationId) {
        return {
          success: false,
          error: "Organization required (no active organization in context)",
        };
      }
      const brand = await getOrgPrimaryBrand(organizationId, ctx);
      if (!brand) {
        return {
          success: false,
          error: "No brand context exists for this organization yet.",
        };
      }

      const updated = await ctx.storage.brandContext.update(
        brand.id,
        organizationId,
        {
          name: input.name,
          domain: input.domain,
          overview: input.overview,
          logo: input.logo,
          favicon: input.favicon,
          ogImage: input.ogImage,
          fonts: input.fonts,
          colors: input.colors,
        },
      );
      return {
        success: true,
        id: updated.id,
        name: updated.name,
        domain: updated.domain,
      };
    },
  });
}

const ReextractBrandInputSchema = z.object({
  domain: z
    .string()
    .describe(
      "Website URL to re-extract brand from. Replaces the current brand snapshot in place.",
    ),
});

function createReextractBrandContextTool(ctx: MeshContext) {
  return tool({
    description:
      "Re-run brand extraction (Firecrawl) against a website URL and " +
      "overwrite the organization's current brand context with the result. " +
      "Use when the user wants to refresh the brand from a different URL.",
    inputSchema: zodSchema(ReextractBrandInputSchema),
    execute: async (input) => {
      const organizationId = ctx.organization?.id;
      if (!organizationId) {
        return {
          success: false,
          error: "Organization required (no active organization in context)",
        };
      }
      const apiKey = ctx.firecrawlApiKey;
      if (!apiKey) {
        return {
          success: false,
          error: "FIRECRAWL_API_KEY is not configured.",
        };
      }
      const brand = await getOrgPrimaryBrand(organizationId, ctx);
      if (!brand) {
        return {
          success: false,
          error: "No brand context exists for this organization yet.",
        };
      }

      const extracted = await extractBrandFromDomain(
        input.domain,
        apiKey,
        input.domain,
      );
      if (!extracted) {
        return {
          success: false,
          error: "Firecrawl did not return branding data for this URL.",
        };
      }

      const updated = await ctx.storage.brandContext.update(
        brand.id,
        organizationId,
        {
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
        },
      );
      return {
        success: true,
        id: updated.id,
        name: updated.name,
        domain: updated.domain,
      };
    },
  });
}

const ConfirmBrandInputSchema = z.object({});

function createConfirmBrandTool(ctx: MeshContext) {
  return tool({
    description:
      "Mark the user's brand context as confirmed. Call this exactly " +
      "once, only after the user explicitly says the brand details look " +
      "correct. After this call the brand-context preset task is done.",
    inputSchema: zodSchema(ConfirmBrandInputSchema),
    execute: async () => {
      const organizationId = ctx.organization?.id;
      if (!organizationId) {
        return {
          success: false,
          error: "Organization required (no active organization in context)",
        };
      }
      const prev = await ctx.storage.presetTasks.get(
        organizationId,
        BRAND_CONTEXT_PRESET_ID,
      );
      await ctx.storage.presetTasks.set(
        organizationId,
        BRAND_CONTEXT_PRESET_ID,
        {
          ...prev,
          status: "completed",
          completedAt: new Date().toISOString(),
        },
      );
      return { success: true };
    },
  });
}

/** Convenience: the full toolset for the confirm face of the brand agent. */
export function createBrandContextConfirmTools(ctx: MeshContext) {
  return {
    update_brand_context: createUpdateBrandContextTool(ctx),
    reextract_brand_context: createReextractBrandContextTool(ctx),
    confirm_brand: createConfirmBrandTool(ctx),
  };
}
