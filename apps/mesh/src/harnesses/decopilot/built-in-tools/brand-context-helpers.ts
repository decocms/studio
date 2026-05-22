/**
 * Shared envelopes for the brand-context built-in tools. The two tool
 * factories (`brand-context-setup`, `brand-context-confirm`) hand-roll
 * the same auth/firecrawl/brand-resolution checks inline; these helpers
 * pull that boilerplate to one place so the tools shrink to actual logic.
 */

import type { MeshContext } from "@/core/mesh-context";
import { getOrgPrimaryBrand } from "@/agents/brand-context";
import type { ExtractedBrand } from "@/auth/extract-brand";
import type { BrandContext } from "@/storage/types";

export type ToolFailure = { success: false; error: string };

/** Returns the org id, or a `{ success: false, error }` payload to short-circuit. */
export function requireOrgId(ctx: MeshContext): string | ToolFailure {
  const id = ctx.organization?.id;
  return (
    id ?? {
      success: false,
      error: "Organization required (no active organization in context)",
    }
  );
}

/** Returns the firecrawl api key, or a `{ success: false, error }` payload. */
export function requireFirecrawlKey(ctx: MeshContext): string | ToolFailure {
  const key = ctx.firecrawlApiKey;
  return (
    key ?? {
      success: false,
      error: "FIRECRAWL_API_KEY is not configured.",
    }
  );
}

export interface OrgBrand {
  organizationId: string;
  brand: BrandContext;
}

/** Combined: returns `{ organizationId, brand }` or a `{ success: false, error }` payload. */
export async function requireOrgBrand(
  ctx: MeshContext,
): Promise<OrgBrand | ToolFailure> {
  const orgRes = requireOrgId(ctx);
  if (typeof orgRes !== "string") return orgRes;
  const brand = await getOrgPrimaryBrand(orgRes, ctx);
  if (!brand) {
    return {
      success: false,
      error: "No brand context exists for this organization yet.",
    };
  }
  return { organizationId: orgRes, brand };
}

/**
 * Field-for-field copy from a Firecrawl extraction to the shape accepted by
 * `storage.brandContext.{create,update}`. Same for setup (initial create) and
 * confirm-mode reextract (overwrite-in-place).
 */
export function brandSnapshot(
  extracted: ExtractedBrand,
): Pick<
  ExtractedBrand,
  | "name"
  | "domain"
  | "overview"
  | "logo"
  | "favicon"
  | "ogImage"
  | "fonts"
  | "colors"
  | "images"
  | "metadata"
> {
  return {
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
}
