import type { Kysely } from "kysely";
import type { UserModelPreferences } from "@decocms/shared/organization/schema";
import type { Database } from "./types";
import type { UserModelPreferencesStoragePort } from "./ports";

/**
 * Per-user, per-org override of the chat tier → model mapping. A stored row
 * only carries the tiers the user has overridden; `resolveTier` falls back to
 * the org default for any absent tier.
 */
export class UserModelPreferencesStorage
  implements UserModelPreferencesStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  async get(
    userId: string,
    organizationId: string,
  ): Promise<UserModelPreferences | null> {
    const record = await this.db
      .selectFrom("user_model_preferences")
      .select("tiers")
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!record) return null;

    const tiers =
      typeof record.tiers === "string"
        ? JSON.parse(record.tiers)
        : record.tiers;
    return { tiers: tiers ?? {} };
  }

  async upsert(
    userId: string,
    organizationId: string,
    prefs: UserModelPreferences,
  ): Promise<UserModelPreferences> {
    const now = new Date().toISOString();
    const tiersJson = JSON.stringify(prefs.tiers ?? {});

    await this.db
      .insertInto("user_model_preferences")
      .values({
        user_id: userId,
        organization_id: organizationId,
        tiers: tiersJson,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "organization_id"]).doUpdateSet({
          tiers: tiersJson,
          updated_at: now,
        }),
      )
      .execute();

    return { tiers: prefs.tiers ?? {} };
  }
}
