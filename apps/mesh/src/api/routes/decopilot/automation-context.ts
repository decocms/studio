/**
 * Automation Context Factory
 *
 * Builds a MeshContext for background operations (automation recovery, cron,
 * event triggers) without an HTTP request. Verifies the user still has an
 * active membership in the organization before constructing the context.
 */

import { AccessControl } from "@/core/access-control";
import {
  ContextFactory,
  createBoundAuthClient,
  fetchRolePermissions,
} from "@/core/context-factory";
import type { MeshContext } from "@/core/mesh-context";
import type { Database } from "@/storage/types";
import { OrgScopedThreadStorage } from "@/storage/threads";
import type { Kysely } from "kysely";
import type { SqlThreadStorage } from "@/storage/threads";
import {
  OrgScopedAsyncResearchJobStorage,
  SqlAsyncResearchJobStorage,
} from "@/storage/async-research-jobs";
import type { MeshContextFactory } from "@/automations/fire";
import { getObjectStorageS3Service } from "@/object-storage/factory";
import { createBoundObjectStorage } from "@/object-storage/bound-object-storage";
import { DevObjectStorage } from "@/object-storage/dev-object-storage";

export interface BuildAutomationContextDeps {
  db: Kysely<Database>;
  threadStorage: SqlThreadStorage;
  asyncResearchJobStorage: SqlAsyncResearchJobStorage;
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
    // Same fix for the async-research-job store. The web_search tool reads
    // this from `ctx.storage.asyncResearchJobs` and would otherwise throw
    // the matching "requires an authenticated organization" error the
    // first time a deep-research call hits the persist step.
    ctx.storage.asyncResearchJobs = new OrgScopedAsyncResearchJobStorage(
      deps.asyncResearchJobStorage,
      membership.orgId,
    );

    // The base context was built without `req`, so it had no organization and
    // objectStorage was set to null (context-factory.ts). Now that the org is
    // resolved, rebuild it the same way the request path does — otherwise tools
    // like generate_image silently fall back to inlining base64 data: URIs.
    const s3Service = getObjectStorageS3Service();
    ctx.objectStorage = s3Service
      ? createBoundObjectStorage(s3Service, membership.orgId)
      : new DevObjectStorage(membership.orgId, ctx.baseUrl);

    return ctx;
  };
}
