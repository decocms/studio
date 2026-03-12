import type { Kysely } from "kysely";
import type { Database } from "./types";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class OAuthPkceStateStorage {
  constructor(private db: Kysely<Database>) {}

  async create(
    codeVerifier: string,
    organizationId: string,
    userId: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await this.db
      .insertInto("oauth_pkce_states")
      .values({
        id,
        organization_id: organizationId,
        user_id: userId,
        code_verifier: codeVerifier,
        expires_at: expiresAt,
        created_at: new Date(),
      })
      .execute();

    return id;
  }

  /** Atomically retrieve and delete the verifier (single-use). Validates org/user ownership. */
  async consume(
    stateToken: string,
    organizationId: string,
    userId: string,
  ): Promise<string> {
    const row = await this.db
      .deleteFrom("oauth_pkce_states")
      .where("id", "=", stateToken)
      .where("organization_id", "=", organizationId)
      .where("user_id", "=", userId)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new Error("Invalid or expired OAuth state token");
    }

    const expiresAt =
      row.expires_at instanceof Date
        ? row.expires_at
        : new Date(row.expires_at);

    if (expiresAt < new Date()) {
      throw new Error("OAuth state token has expired");
    }

    return row.code_verifier;
  }
}
