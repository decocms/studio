import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database } from "./types";

/** A linked subscription, as callers see it. The token is never in the shape. */
export interface ClaudeSubscriptionInfo {
  expiresAt: string;
}

export class ClaudeSubscriptionStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  /** Link (or re-link) a user's subscription. One row per user. */
  async upsert(params: {
    userId: string;
    accessToken: string; // plaintext — encrypted before storage
    expiresAt: Date;
  }): Promise<ClaudeSubscriptionInfo> {
    const encrypted = await this.vault.encrypt(params.accessToken);
    await this.db
      .insertInto("claude_subscriptions")
      .values({
        user_id: params.userId,
        encrypted_access_token: encrypted,
        expires_at: params.expiresAt,
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          encrypted_access_token: encrypted,
          expires_at: params.expiresAt,
          created_at: new Date(),
        }),
      )
      .execute();
    return { expiresAt: params.expiresAt.toISOString() };
  }

  /** Expiry only — for the settings UI, which must never see the token. */
  async find(userId: string): Promise<ClaudeSubscriptionInfo | null> {
    const row = await this.db
      .selectFrom("claude_subscriptions")
      .select("expires_at")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    return { expiresAt: new Date(row.expires_at).toISOString() };
  }

  /**
   * The decrypted token, or null when it is absent or expired. Expired rows
   * are not deleted here: the dispatch path is a reader, and the row is what
   * lets the UI say "expired, re-link" rather than "never linked".
   */
  async findLiveToken(userId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("claude_subscriptions")
      .select(["encrypted_access_token", "expires_at"])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return this.vault.decrypt(row.encrypted_access_token);
  }

  async delete(userId: string): Promise<void> {
    await this.db
      .deleteFrom("claude_subscriptions")
      .where("user_id", "=", userId)
      .execute();
  }
}
