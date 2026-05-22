/**
 * Brand-context agent helpers — currently just primary-brand resolution.
 * Prompt and tool-injection logic from the original branch is parked
 * pending wiring into the harness layer.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { BrandContext } from "@/storage/types";

/**
 * Resolve the org's "primary" brand for the brand-context agent.
 *
 * We can't use `brandContext.getDefault()` alone because the existing
 * `create()` path hard-codes `is_default: false` — so brands created from
 * the Settings page never satisfy that predicate. Until that's fixed,
 * fall back to the oldest non-archived row, which matches what the
 * Settings UI displays.
 *
 * Anyone deciding "does the brand-context agent run in setup or confirm
 * mode" — the resolver, the tool injection, the workflow gate — must
 * call this helper so they all agree on the answer.
 */
export async function getOrgPrimaryBrand(
  organizationId: string,
  ctx: MeshContext,
): Promise<BrandContext | null> {
  const def = await ctx.storage.brandContext.getDefault(organizationId);
  if (def) return def;
  const all = await ctx.storage.brandContext.list(organizationId, {
    includeArchived: false,
  });
  return all[0] ?? null;
}
