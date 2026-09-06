import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, OrgJiraIntegration } from "./types";

/** The issue a run's anchor item stands for. */
export interface JiraIssueLink {
  itemId: string;
  jiraIssueId: string;
  jiraIssueKey: string;
}

/** A rule on a Jira status: row existence is the switch, `prompt` null is the
 *  agent's own instruction. */
export interface JiraColumnAutomation {
  jiraStatus: string;
  prompt: string | null;
}

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

  /**
   * Ids of every enabled integration — the safety-net poll's work list. Ids,
   * not entities: a DBOS step's output is persisted, and an entity carries
   * the decrypted token.
   */
  async listEnabledIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("org_jira_integrations")
      .select("id")
      .where("enabled", "=", true)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => row.id);
  }

  async getLinkByIssueId(
    organizationId: string,
    jiraIssueId: string,
  ): Promise<JiraIssueLink | null> {
    const row = await this.db
      .selectFrom("task_board_item_jira_links")
      .select(["item_id", "jira_issue_id", "jira_issue_key"])
      .where("organization_id", "=", organizationId)
      .where("jira_issue_id", "=", jiraIssueId)
      .executeTakeFirst();
    return row ? linkFromRow(row) : null;
  }

  async getLinkByItemId(
    itemId: string,
    organizationId: string,
  ): Promise<JiraIssueLink | null> {
    const row = await this.db
      .selectFrom("task_board_item_jira_links")
      .select(["item_id", "jira_issue_id", "jira_issue_key"])
      .where("item_id", "=", itemId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? linkFromRow(row) : null;
  }

  /** Idempotent on the issue: a second caller for the same issue changes
   *  nothing, so both read the same anchor back. */
  async createLink(params: {
    itemId: string;
    organizationId: string;
    jiraIssueId: string;
    jiraIssueKey: string;
  }): Promise<void> {
    await this.db
      .insertInto("task_board_item_jira_links")
      .values({
        item_id: params.itemId,
        organization_id: params.organizationId,
        jira_issue_id: params.jiraIssueId,
        jira_issue_key: params.jiraIssueKey,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /**
   * Claim one transition for dispatch. Exactly one caller gets `true` per
   * (issue, changelog entry) — the webhook, its redelivery and the poll can all
   * see the same entry, and only the winner may start the run.
   */
  async claimTrigger(
    organizationId: string,
    jiraIssueId: string,
    changelogId: string,
  ): Promise<boolean> {
    const result = await this.db
      .insertInto("jira_trigger_claims")
      .values({
        organization_id: organizationId,
        jira_issue_id: jiraIssueId,
        changelog_id: changelogId,
      })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async listAutomations(
    organizationId: string,
  ): Promise<JiraColumnAutomation[]> {
    const rows = await this.db
      .selectFrom("org_jira_column_automations")
      .select(["jira_status", "prompt"])
      .where("organization_id", "=", organizationId)
      .orderBy("jira_status", "asc")
      .execute();
    return rows.map((r) => ({ jiraStatus: r.jira_status, prompt: r.prompt }));
  }

  async getAutomation(
    organizationId: string,
    jiraStatus: string,
  ): Promise<JiraColumnAutomation | null> {
    const row = await this.db
      .selectFrom("org_jira_column_automations")
      .select(["jira_status", "prompt"])
      .where("organization_id", "=", organizationId)
      .where("jira_status", "=", jiraStatus)
      .executeTakeFirst();
    return row ? { jiraStatus: row.jira_status, prompt: row.prompt } : null;
  }

  async upsertAutomation(
    organizationId: string,
    jiraStatus: string,
    prompt: string | null,
  ): Promise<JiraColumnAutomation> {
    await this.db
      .insertInto("org_jira_column_automations")
      .values({
        organization_id: organizationId,
        jira_status: jiraStatus,
        prompt,
      })
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "jira_status"])
          .doUpdateSet({ prompt, updated_at: new Date() }),
      )
      .execute();
    return { jiraStatus, prompt };
  }

  /** Deleting IS the off switch. Returns whether there was a rule. */
  async removeAutomation(
    organizationId: string,
    jiraStatus: string,
  ): Promise<boolean> {
    const result = await this.db
      .deleteFrom("org_jira_column_automations")
      .where("organization_id", "=", organizationId)
      .where("jira_status", "=", jiraStatus)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}

function linkFromRow(row: {
  item_id: string;
  jira_issue_id: string;
  jira_issue_key: string;
}): JiraIssueLink {
  return {
    itemId: row.item_id,
    jiraIssueId: row.jira_issue_id,
    jiraIssueKey: row.jira_issue_key,
  };
}
