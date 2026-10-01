/**
 * Cleanup when a member leaves an organization through Better Auth's
 * `removeMember` (the ORGANIZATION_MEMBER_REMOVE tool and the web UI both end
 * up there).
 *
 * Access is already cut by the membership check on the API-key auth path
 * (core/context-factory.ts); this removes what would otherwise linger: the
 * member's API keys for the org (they would revive if the user were re-added),
 * their per-org SSO session, and this pod's cached role. Failures are logged
 * rather than thrown because the member row is already gone by then.
 */

import type { Kysely } from "kysely";
import { z } from "zod";
import type { BetterAuthInstance } from "./index";
import { OrgSsoSessionStorage } from "../storage/org-sso-sessions";
import type { Database } from "../storage/types";
import { memberRoleCache } from "./member-role-cache";

/** Keys minted for the org's own default connections (auth/org.ts `seedOrgDb`).
 *  They belong to the org: the `_self` connection keeps using its key after
 *  its creator leaves, as long as the acting user is a member. */
const ORG_CONNECTION_KEY_PURPOSE = "default-org-connections";

const ApiKeyMetadataSchema = z.object({
  organization: z.object({ id: z.string() }).optional(),
  purpose: z.unknown().optional(),
});

function parseMetadata(raw: unknown): z.infer<typeof ApiKeyMetadataSchema> {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const parsed = ApiKeyMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * Which of a user's API keys are bound to `organizationId` and should be
 * revoked when they leave it. Pure — exported for unit tests.
 */
export function apiKeyIdsToRevoke(
  keys: ReadonlyArray<{ id: string; metadata?: unknown }>,
  organizationId: string,
): string[] {
  return keys.flatMap((key) => {
    const metadata = parseMetadata(key.metadata);
    if (metadata.organization?.id !== organizationId) return [];
    if (metadata.purpose === ORG_CONNECTION_KEY_PURPOSE) return [];
    return [key.id];
  });
}

export async function revokeRemovedMemberAccess(
  auth: BetterAuthInstance,
  db: Kysely<Database>,
  member: { userId: string; organizationId: string },
): Promise<void> {
  const { userId, organizationId } = member;
  memberRoleCache.invalidate(userId, organizationId);

  const results = await Promise.allSettled([
    (async () => {
      const { adapter } = await auth.$context;
      const keys = await adapter.findMany<{ id: string; metadata?: unknown }>({
        model: "apikey",
        where: [{ field: "userId", value: userId }],
      });
      const ids = apiKeyIdsToRevoke(keys, organizationId);
      if (ids.length === 0) return;
      await adapter.deleteMany({
        model: "apikey",
        where: [{ field: "id", value: ids, operator: "in" }],
      });
    })(),
    new OrgSsoSessionStorage(db).deleteForMember(userId, organizationId),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "[auth] cleanup after member removal failed:",
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
    }
  }
}
