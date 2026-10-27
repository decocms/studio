import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database } from "./types";

export class CodexSubscriptionStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  async upsert(userId: string, authJson: string) {
    const createdAt = new Date();
    const values = {
      encrypted_auth: await this.vault.encrypt(authJson),
      auth_hash: createHash("sha256").update(authJson).digest("hex"),
      created_at: createdAt,
    };
    await this.db
      .insertInto("codex_subscriptions")
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column("user_id").doUpdateSet(values))
      .execute();
    return { linkedAt: createdAt.toISOString(), expiresAt: null };
  }

  async find(userId: string) {
    const row = await this.db
      .selectFrom("codex_subscriptions")
      .select("created_at")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return row
      ? { linkedAt: new Date(row.created_at).toISOString(), expiresAt: null }
      : null;
  }

  async findLiveToken(userId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("codex_subscriptions")
      .select("encrypted_auth")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return row ? this.vault.decrypt(row.encrypted_auth) : null;
  }

  /** A late run cannot restore a disconnected credential or replace a newer login. */
  async sync(
    userId: string,
    previousHash: string,
    authJson: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("codex_subscriptions")
      .set({
        encrypted_auth: await this.vault.encrypt(authJson),
        auth_hash: createHash("sha256").update(authJson).digest("hex"),
      })
      .where("user_id", "=", userId)
      .where("auth_hash", "=", previousHash)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async delete(userId: string): Promise<void> {
    await this.db
      .deleteFrom("codex_subscriptions")
      .where("user_id", "=", userId)
      .execute();
  }
}
