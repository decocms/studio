/**
 * Automation Context Factory
 *
 * Builds a MeshContext for background operations (automation recovery, cron,
 * event triggers) without an HTTP request. Verifies the user still has an
 * active membership in the organization before constructing the context.
 */

import { AccessControl } from "@/core/access-control";
import { ContextFactory, createBoundAuthClient } from "@/core/context-factory";
import type { MeshContext } from "@/core/mesh-context";
import type { Database } from "@/storage/types";
import { OrgScopedThreadStorage } from "@/storage/threads";
import type { Kysely } from "kysely";
import type { SqlThreadStorage } from "@/storage/threads";
import type { MeshContextFactory } from "@/automations/fire";

export interface BuildAutomationContextDeps {
  db: Kysely<Database>;
  threadStorage: SqlThreadStorage;
}

/**
 * Creates a MeshContextFactory that verifies org membership and builds a full
 * MeshContext scoped to the given user/org pair. Returns null when the user is
 * no longer a member of the organization.
 */
export function createAutomationContextFactory(
  deps: BuildAutomationContextDeps,
): MeshContextFactory {
  return async (orgId: string, userId: string): Promise<MeshContext | null> => {
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

    console.log(
      `[automationContextFactory] Resolved context: user=${userId}, org=${orgId}, role=${membership.role}`,
    );

    // Create a base context (unauthenticated) and override auth/org/access fields
    const ctx = await ContextFactory.create();
    ctx.auth.user = { id: userId, role: membership.role };
    ctx.organization = {
      id: membership.orgId,
      slug: membership.orgSlug,
      name: membership.orgName,
    };

    // Reconstruct boundAuth and access with the correct identity so that
    // permission checks use the automation user's role instead of stale
    // undefined values from the unauthenticated base context.
    ctx.boundAuth = createBoundAuthClient({
      auth: ctx.authInstance,
      headers: new Headers(),
      role: membership.role,
      userId,
    });
    ctx.access = new AccessControl(
      ctx.authInstance,
      userId,
      undefined, // toolName set later by defineTool
      ctx.boundAuth,
      membership.role,
      "self",
    );

    // Rebuild thread storage with the correct org so OrgScopedThreadStorage
    // doesn't throw "thread operations require an authenticated organization".
    ctx.storage.threads = new OrgScopedThreadStorage(
      deps.threadStorage,
      membership.orgId,
    );

    return ctx;
  };
}
