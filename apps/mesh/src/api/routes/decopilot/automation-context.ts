/**
 * Automation Context Factory
 *
 * Builds a StudioContext for background operations (automation recovery, cron,
 * event triggers) without an HTTP request. Verifies the user still has an
 * active membership in the organization before constructing the context.
 */

import { AccessControl } from "@/core/access-control";
import {
  ContextFactory,
  createBoundAuthClient,
  fetchRolePermissions,
  rebindOrgScope,
} from "@/core/context-factory";
import type { StudioContext } from "@/core/studio-context";
import type { Database } from "@/storage/types";
import type { Kysely } from "kysely";
import type { StudioContextFactory } from "@/automations/fire";

export interface BuildAutomationContextDeps {
  db: Kysely<Database>;
}

/**
 * Creates a StudioContextFactory that verifies org membership and builds a full
 * StudioContext scoped to the given user/org pair. Returns null when the user is
 * no longer a member of the organization.
 */
export function createAutomationContextFactory(
  deps: BuildAutomationContextDeps,
): StudioContextFactory {
  return async (
    orgId: string,
    userId: string,
  ): Promise<StudioContext | null> => {
    // Verify org membership
    const membership = await deps.db
      .selectFrom("member")
      .innerJoin("organization", "organization.id", "member.organizationId")
      .select([
        "member.role",
        "organization.id as orgId",
        "organization.slug as orgSlug",
        "organization.name as orgName",
      ])
      .where("member.userId", "=", userId)
      .where("member.organizationId", "=", orgId)
      .executeTakeFirst();

    if (!membership) {
      console.warn(
        `[automationContextFactory] User ${userId} not found in org ${orgId} — returning null`,
      );
      return null;
    }

    // Create a base context (unauthenticated) and override auth/org/access fields
    const ctx = await ContextFactory.create();
    ctx.auth.user = { id: userId, role: membership.role };
    ctx.organization = {
      id: membership.orgId,
      slug: membership.orgSlug,
      name: membership.orgName,
    };

    // Fetch custom-role permissions so that non-built-in roles can pass
    // authorization checks without HTTP headers (background context).
    const permissions = await fetchRolePermissions(
      deps.db,
      orgId,
      membership.role,
    );

    // Reconstruct boundAuth and access with the correct identity so that
    // permission checks use the automation user's role instead of stale
    // undefined values from the unauthenticated base context.
    ctx.boundAuth = createBoundAuthClient({
      auth: ctx.authInstance,
      headers: new Headers(),
      role: membership.role,
      permissions,
      userId,
    });
    ctx.access = new AccessControl(
      userId,
      undefined, // toolName set later by defineTool
      ctx.boundAuth,
      membership.role,
      "self",
    );

    // The base context was built without `req`, so every org-scoped facet
    // (thread storage, object storage, org-fs, asset hoisters) was created
    // org-less. Rebind it all to the verified membership org — the SAME
    // helper the path-scoped middleware uses, so the two paths can't drift.
    rebindOrgScope(ctx, { id: membership.orgId, slug: membership.orgSlug });

    return ctx;
  };
}
