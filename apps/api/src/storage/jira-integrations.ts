import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, OrgJiraIntegration } from "./types";

/**
 * Per-org Jira Cloud integration configs (see migration 171). One row per
 * org; the API token is vault-encrypted at rest and decrypted on read — the
 * server spends it, tools must never echo it.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

type Row = {
  id: string;
  organization_id: string;
  site_url: string;
  email: string;
  api_token: string;
  board_id: string | null;
  board_name: string | null;
  webhook_secret: string;
  enabled: boolean;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export class JiraIntegrationStorage {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly vault: CredentialVault,
  ) {}

  private async toEntity(row: Row): Promise<OrgJiraIntegration> {
    return {
      id: row.id,
      organizationId: row.organization_id,
      siteUrl: row.site_url,
      email: row.email,
      apiToken: await this.vault.decrypt(row.api_token),
      boardId: row.board_id,
      boardName: row.board_name,
      webhookSecret: row.webhook_secret,
      enabled: row.enabled,
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async getByOrg(organizationId: string): Promise<OrgJiraIntegration | null> {
    const row = await this.db
      .selectFrom("org_jira_integrations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? this.toEntity(row as Row) : null;
  }

  /** Full-value upsert (one integration per org) — callers merge partials. */
  async upsert(params: {
    organizationId: string;
    siteUrl: string;
    email: string;
    apiToken: string;
    boardId: string | null;
    boardName: string | null;
    enabled: boolean;
    createdBy: string;
  }): Promise<OrgJiraIntegration> {
    const encryptedToken = await this.vault.encrypt(params.apiToken);
    const row = await this.db
      .insertInto("org_jira_integrations")
      .values({
        organization_id: params.organizationId,
        site_url: params.siteUrl,
        email: params.email,
        api_token: encryptedToken,
        board_id: params.boardId,
        board_name: params.boardName,
        enabled: params.enabled,
        created_by: params.createdBy,
      })
      .onConflict((oc) =>
        oc.column("organization_id").doUpdateSet({
          site_url: params.siteUrl,
          email: params.email,
          api_token: encryptedToken,
          board_id: params.boardId,
          board_name: params.boardName,
          enabled: params.enabled,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toEntity(row as Row);
  }

  /** Webhook-route lookup — the secret IS the authentication, so this is the
   *  only method keyed by something other than the org. */
  async getByWebhookSecret(secret: string): Promise<OrgJiraIntegration | null> {
    const row = await this.db
      .selectFrom("org_jira_integrations")
      .selectAll()
      .where("webhook_secret", "=", secret)
      .executeTakeFirst();
    return row ? this.toEntity(row as Row) : null;
  }

  async delete(organizationId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("org_jira_integrations")
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async getById(id: string): Promise<OrgJiraIntegration | null> {
    const row = await this.db
      .selectFrom("org_jira_integrations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.toEntity(row as Row) : null;
  }
}
