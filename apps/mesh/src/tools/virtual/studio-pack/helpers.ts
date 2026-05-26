import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";

export function isWellKnownSeededConnection(
  orgId: string,
  id: string,
): boolean {
  return (
    id === WellKnownOrgMCPId.SELF(orgId) ||
    id === WellKnownOrgMCPId.REGISTRY(orgId) ||
    id === WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId) ||
    id === WellKnownOrgMCPId.DEV_ASSETS(orgId)
  );
}

export async function hasAnyObject(
  ctx: MeshContext,
  prefix: string,
): Promise<boolean> {
  const storage = ctx.objectStorage;
  if (!storage) return false;
  try {
    const result = await storage.list({ prefix, maxKeys: 1 });
    return result.objects.length > 0;
  } catch {
    return false;
  }
}
