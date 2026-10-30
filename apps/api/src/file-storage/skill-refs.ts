import { bundleIdOfRef, expandSkillRefs } from "@decocms/shared/skills";
import type { StudioContext } from "../core/studio-context";
import { buildSkillCatalog } from "./skill-catalog";

/**
 * The catalog ids stored skill references load for one run. The catalog is
 * only read when a bundle needs resolving — plain ids pass straight through.
 * Best-effort: an unreadable catalog drops the bundles, never the run.
 */
export async function expandOrgSkillRefs(
  ctx: StudioContext,
  organizationId: string,
  refs: string[],
): Promise<string[]> {
  if (!refs.some((ref) => bundleIdOfRef(ref) !== null)) return refs;
  const catalog = await buildSkillCatalog(ctx, organizationId).catch(() => []);
  return expandSkillRefs(refs, catalog);
}
