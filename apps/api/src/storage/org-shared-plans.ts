import type { Kysely } from "kysely";
import type { Database } from "./types";

/** A plan shared with an org, as callers see it. The token is never here. */
export interface OrgSharedPlan {
  providerId: string;
  userId: string;
  userName: string | null;
  sharedAt: string;
}

/**
 * Plans members shared with their org (migration 251). A row only points at
 * the sharer's own linked token; resolving it to a secret is the dispatch's job.
 */
export class OrgSharedPlanStorage {
  constructor(private db: Kysely<Database>) {}

  async share(organizationId: string, providerId: string, userId: string) {
    await this.db
      .insertInto("org_shared_plans")
      .values({
        organization_id: organizationId,
        provider_id: providerId,
        user_id: userId,
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "provider_id", "user_id"]).doNothing(),
      )
      .execute();
  }

  async unshare(organizationId: string, providerId: string, userId: string) {
    await this.db
      .deleteFrom("org_shared_plans")
      .where("organization_id", "=", organizationId)
      .where("provider_id", "=", providerId)
      .where("user_id", "=", userId)
      .execute();
  }

  /** Every org the user shared this plan with: their token is gone. */
  async unshareEverywhere(providerId: string, userId: string) {
    await this.db
      .deleteFrom("org_shared_plans")
      .where("provider_id", "=", providerId)
      .where("user_id", "=", userId)
      .execute();
  }

  /**
   * The org's shared plans, oldest first per provider — the order dispatch
   * tries them in. A sharer who left the org no longer counts.
   */
  async list(organizationId: string): Promise<OrgSharedPlan[]> {
    const rows = await this.db
      .selectFrom("org_shared_plans as s")
      .innerJoin("member as m", (join) =>
        join
          .onRef("m.userId", "=", "s.user_id")
          .onRef("m.organizationId", "=", "s.organization_id"),
      )
      .leftJoin("user as u", "u.id", "s.user_id")
      .select([
        "s.provider_id as providerId",
        "s.user_id as userId",
        "u.name as userName",
        "s.created_at as sharedAt",
      ])
      .where("s.organization_id", "=", organizationId)
      .orderBy("s.created_at", "asc")
      .execute();
    return rows.map((row) => ({
      ...row,
      userName: row.userName ?? null,
      sharedAt: new Date(row.sharedAt).toISOString(),
    }));
  }
}
