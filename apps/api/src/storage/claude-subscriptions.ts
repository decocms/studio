import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database } from "./types";

/** A linked subscription, as callers see it. The token is never in the shape. */
export interface ClaudeSubscriptionInfo {
  linkedAt: string;
  /** Null when the token carries no expiry we can read — see migration 162. */
  expiresAt: string | null;
}

export class ClaudeSubscriptionStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  /** Link (or re-link) a user's subscription token. One row per user. */
  async upsert(params: {
    userId: string;
    accessToken: string; // plaintext — encrypted before storage
    expiresAt?: Date | null;
  }): Promise<ClaudeSubscriptionInfo> {
    const encrypted = await this.vault.encrypt(params.accessToken);
    const expiresAt = params.expiresAt ?? null;
    const createdAt = new Date();
    await this.db
      .insertInto("claude_subscriptions")
      .values({
        user_id: params.userId,
        encrypted_access_token: encrypted,
        expires_at: expiresAt,
        created_at: createdAt,
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          encrypted_access_token: encrypted,
          expires_at: expiresAt,
          created_at: createdAt,
        }),
      )
      .execute();
    return {
      linkedAt: createdAt.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
    };
  }

  /** Metadata only — for the settings UI, which must never see the token. */
  async find(userId: string): Promise<ClaudeSubscriptionInfo | null> {
    const row = await this.db
      .selectFrom("claude_subscriptions")
      .select(["created_at", "expires_at"])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      linkedAt: new Date(row.created_at).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
  }

  /**
   * The decrypted token, or null when absent or known-expired. A null
   * `expires_at` is live: it means the token's lifetime is unknown, not zero.
   *
   * Expired rows are not deleted here — the dispatch path is a reader, and the
   * row is what lets the UI say "expired, paste a new one" rather than "never
   * linked".
   */
  async findLiveToken(userId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("claude_subscriptions")
      .select(["encrypted_access_token", "expires_at"])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }
    return this.vault.decrypt(row.encrypted_access_token);
  }

  async delete(userId: string): Promise<void> {
    await this.db
      .deleteFrom("claude_subscriptions")
      .where("user_id", "=", userId)
      .execute();
  }
}
