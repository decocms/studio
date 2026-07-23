/**
 * KV Storage
 *
 * Org-scoped key-value store backed by PostgreSQL.
 * Used by external MCPs for lightweight persistence (e.g., trigger state).
 */

import type { Kysely } from "kysely";
import type { Database } from "./types";

export interface KVStorage {
  get(
    organizationId: string,
    key: string,
  ): Promise<Record<string, unknown> | null>;
  set(
    organizationId: string,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>;
  delete(organizationId: string, key: string): Promise<void>;
}

export class KyselyKVStorage implements KVStorage {
  constructor(private db: Kysely<Database>) {}

  async get(
    organizationId: string,
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .selectFrom("kv")
      .select("value")
      .where("organization_id", "=", organizationId)
      .where("key", "=", key)
      .executeTakeFirst();

    if (!row) return null;
    return row.value as Record<string, unknown>;
  }

  async set(
    organizationId: string,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insertInto("kv")
      .values({
        organization_id: organizationId,
        key,
        value: JSON.stringify(value),
        updated_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "key"]).doUpdateSet({
          value: JSON.stringify(value),
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async delete(organizationId: string, key: string): Promise<void> {
    await this.db
      .deleteFrom("kv")
      .where("organization_id", "=", organizationId)
      .where("key", "=", key)
      .execute();
  }
}
