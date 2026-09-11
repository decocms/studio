/**
 * Which org the dev seeds write into, and on whose behalf.
 *
 * "The first org" is not enough: a local DB also carries system orgs with no
 * members (`user-filesystems`, the public skills org), and a seed attributed to
 * a memberless org has no `created_by` to use. So the pick is the first org
 * that has a member, which is the one local mode seeds for the developer.
 */

import type { Kysely } from "kysely";
import type { Database } from "../apps/api/src/storage/types";

export interface SeedOrg {
  id: string;
  name: string;
  slug: string;
  owner: { id: string; email: string };
}

export async function resolveSeedOrg(
  db: Kysely<Database>,
  orgRef?: string,
): Promise<SeedOrg> {
  const rows = await db
    .selectFrom("organization")
    .innerJoin("member", "member.organizationId", "organization.id")
    .innerJoin("user", "user.id", "member.userId")
    .select([
      "organization.id as id",
      "organization.name as name",
      "organization.slug as slug",
      "user.id as ownerId",
      "user.email as ownerEmail",
    ])
    .where("organization.id", "!=", "org_orgfs_public_skills")
    .orderBy("organization.createdAt", "asc")
    .orderBy("member.createdAt", "asc")
    .execute();

  const match = orgRef
    ? rows.find((r) => r.slug === orgRef || r.id === orgRef)
    : rows[0];
  if (!match) {
    const available = [...new Set(rows.map((r) => r.slug))].join(", ");
    throw new Error(
      `organization not found (${orgRef ?? "first with a member"}); have: ${available || "none"}`,
    );
  }
  return {
    id: match.id,
    name: match.name,
    slug: match.slug,
    owner: { id: match.ownerId, email: match.ownerEmail },
  };
}
