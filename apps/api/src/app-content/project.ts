/**
 * The gates every app-content surface shares: org flag `app_content_delivery`,
 * the `cms` plan, and the virtual MCP belonging to the org. Callers map a miss
 * to one generic 404 so the routes cannot enumerate projects.
 */

import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import type { StudioContext } from "@/core/studio-context";
import { orgHasFeature } from "@/core/plan-feature-gate";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";

export const VIRTUAL_MCP_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface AppProject {
  /** Null when the project has no repository binding. */
  repository: RepositoryBinding | null;
  packagePath: string | null;
}

/** Null = not an app-content project of this org (flag, plan or ownership). */
export async function resolveAppProject(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
): Promise<AppProject | null> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!orgFlagEnabled(settings?.flags, "app_content_delivery")) return null;
  if (!(await orgHasFeature(ctx, organizationId, "cms"))) return null;

  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organizationId) {
    return null;
  }
  const metadata = (virtualMcp.metadata as Record<string, unknown>) ?? null;
  const repository = parseRepositoryBinding(
    metadata,
    virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
  );
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  const packagePath = runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
  return { repository, packagePath };
}
