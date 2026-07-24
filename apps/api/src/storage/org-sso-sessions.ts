import type { Kysely } from "kysely";
import type { Database, OrgSsoSession } from "./types";

/** Default SSO session duration: 24 hours */
const SSO_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export class OrgSsoSessionStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async get(
    userId: string,
    organizationId: string,
  ): Promise<OrgSsoSession | null> {
    const record = await this.db
      .selectFrom("org_sso_sessions")
      .selectAll()
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!record) return null;

    return {
      id: record.id,
      userId: record.user_id,
      organizationId: record.organization_id,
      authenticatedAt: record.authenticated_at,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
    };
  }

  async isValid(userId: string, organizationId: string): Promise<boolean> {
    const session = await this.get(userId, organizationId);
    if (!session) return false;
    return new Date(session.expiresAt) > new Date();
  }

  async upsert(userId: string, organizationId: string): Promise<OrgSsoSession> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SSO_SESSION_DURATION_MS);
    const id = crypto.randomUUID();

    await this.db
      .insertInto("org_sso_sessions")
      .values({
        id,
        user_id: userId,
        organization_id: organizationId,
        authenticated_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "organization_id"]).doUpdateSet({
          authenticated_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
        }),
      )
      .execute();

    const result = await this.get(userId, organizationId);
    if (!result) throw new Error("Failed to upsert SSO session");
    return result;
  }

  async deleteExpired(): Promise<void> {
    await this.db
      .deleteFrom("org_sso_sessions")
      .where("expires_at", "<", new Date().toISOString())
      .execute();
  }
}
