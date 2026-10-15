import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import type { StudioContext } from "../../core/studio-context";

/**
 * Agentic blog generation is behind `blog_ai_enabled`, on every path into it.
 *
 * The flag used to gate the web app alone, which left every one of these tools
 * reachable over MCP — and so callable by an agent — for an organization that
 * had deliberately turned the feature off. Each run spends that organization's
 * AI credits, reaches whatever connections its virtual MCP carries, and in the
 * case of a post draft uploads an image to its bucket. A switch that only hides
 * a button is a preference; this is the switch.
 *
 * Not an authorization check. Whether the caller may act for this organization
 * is `ctx.access.check()`'s question and is answered before this one; this
 * decides whether the product behavior exists at all.
 */
export async function requireBlogAi(
  ctx: StudioContext,
  organizationId: string,
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (orgFlagEnabled(settings?.flags, "blog_ai_enabled")) return;
  throw new Error(
    "Agentic blog generation is off for this organization. An admin can turn it on under Settings → General.",
  );
}
