/**
 * Trigger Callback Tokens Storage
 *
 * Manages opaque callback tokens that external MCPs use to authenticate
 * trigger callbacks to Mesh. Tokens are stored as SHA-256 hashes;
 * plaintext is only returned once at creation time.
 *
 * Each row keys on `subscription_id` (= `automation_triggers.id`) so a
 * single connection can host many independent subscriptions, each with
 * its own token. Token validation still resolves to (orgId, connId)
 * because the trigger callback endpoint fans out by `(connection, type)`
 * downstream of token validation.
 */

import type { Kysely } from "kysely";
import type { Database } from "./types";

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface TokenPair {
  plaintext: string;
  hash: string;
}

export interface TriggerCallbackTokenStorage {
  /**
   * Generate a token pair (plaintext + hash) without persisting.
   * Use with persistTokenHash() for two-phase token creation.
   */
  generateTokenPair(): Promise<TokenPair>;

  /**
   * Persist a token hash for a specific subscription. Upserts on
   * `subscription_id`, so re-running TRIGGER_CONFIGURE for the same
   * subscription rotates the token cleanly without orphaning siblings
   * on the same connection.
   */
  persistTokenHash(args: {
    organizationId: string;
    connectionId: string;
    subscriptionId: string;
    tokenHash: string;
  }): Promise<void>;

  /**
   * Create or rotate a callback token for a subscription. Returns the
   * plaintext token (only available at creation time).
   */
  createOrRotateToken(args: {
    organizationId: string;
    connectionId: string;
    subscriptionId: string;
  }): Promise<string>;

  /**
   * Validate a callback token. Returns the connection + org context for
   * the row that owns this token, or null if no row matches.
   */
  validateToken(
    token: string,
  ): Promise<{
    organizationId: string;
    connectionId: string;
    subscriptionId: string;
  } | null>;

  /**
   * Delete the callback token for one specific subscription.
   */
  deleteBySubscription(subscriptionId: string): Promise<void>;

  /**
   * Delete every callback token attached to a connection. Used during
   * connection deletion to garbage-collect every subscription that was
   * bound to it.
   */
  deleteByConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<void>;

  /**
   * List every (subscription, connection) pair tied to a connection so
   * the caller can iterate them — e.g. to send TRIGGER_CONFIGURE
   * disable to the MCP for each subscription before the connection
   * itself is deleted.
   */
  listByConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<Array<{ subscriptionId: string }>>;
}

export class KyselyTriggerCallbackTokenStorage
  implements TriggerCallbackTokenStorage
{
  constructor(private db: Kysely<Database>) {}

  async generateTokenPair(): Promise<TokenPair> {
    const plaintext = generateToken();
    const hash = await hashToken(plaintext);
    return { plaintext, hash };
  }

  async persistTokenHash({
    organizationId,
    connectionId,
    subscriptionId,
    tokenHash,
  }: {
    organizationId: string;
    connectionId: string;
    subscriptionId: string;
    tokenHash: string;
  }): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .insertInto("trigger_callback_tokens")
      .values({
        id,
        organization_id: organizationId,
        connection_id: connectionId,
        subscription_id: subscriptionId,
        token_hash: tokenHash,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(["subscription_id"]).doUpdateSet({
          id,
          organization_id: organizationId,
          connection_id: connectionId,
          token_hash: tokenHash,
        }),
      )
      .execute();
  }

  async createOrRotateToken({
    organizationId,
    connectionId,
    subscriptionId,
  }: {
    organizationId: string;
    connectionId: string;
    subscriptionId: string;
  }): Promise<string> {
    const { plaintext, hash } = await this.generateTokenPair();
    await this.persistTokenHash({
      organizationId,
      connectionId,
      subscriptionId,
      tokenHash: hash,
    });
    return plaintext;
  }

  async validateToken(
    token: string,
  ): Promise<{
    organizationId: string;
    connectionId: string;
    subscriptionId: string;
  } | null> {
    const tokenHash = await hashToken(token);

    const row = await this.db
      .selectFrom("trigger_callback_tokens")
      .select(["organization_id", "connection_id", "subscription_id"])
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    if (!row) return null;

    return {
      organizationId: row.organization_id,
      connectionId: row.connection_id,
      subscriptionId: row.subscription_id,
    };
  }

  async deleteBySubscription(subscriptionId: string): Promise<void> {
    await this.db
      .deleteFrom("trigger_callback_tokens")
      .where("subscription_id", "=", subscriptionId)
      .execute();
  }

  async deleteByConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<void> {
    await this.db
      .deleteFrom("trigger_callback_tokens")
      .where("connection_id", "=", connectionId)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  async listByConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<Array<{ subscriptionId: string }>> {
    const rows = await this.db
      .selectFrom("trigger_callback_tokens")
      .select(["subscription_id"])
      .where("connection_id", "=", connectionId)
      .where("organization_id", "=", organizationId)
      .execute();
    return rows.map((r) => ({ subscriptionId: r.subscription_id }));
  }
}
