import { isValidUrlSlug } from "@decocms/shared/url-slug";
import type { StudioContext } from "../../core/studio-context";

/**
 * A project by id, or by the URL slug a link carries. Slugs can't contain
 * `_`, so a prefixed id never takes the slug path.
 */
export async function findVirtualMcpByIdOrSlug(
  ctx: StudioContext,
  organizationId: string,
  idOrSlug: string,
) {
  const byId = await ctx.storage.virtualMcps.findById(idOrSlug);
  if (byId || !isValidUrlSlug(idOrSlug)) return byId;

  const resolved = await ctx.storage.connections.resolveUrlSlug(
    organizationId,
    idOrSlug,
    "project",
  );
  return resolved ? ctx.storage.virtualMcps.findById(resolved.id) : null;
}
