import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import {
  type JiraStatusMapping,
  normalizeStatusMapping,
} from "@decocms/shared/jira-status-mapping";
import type { Database, OrgJiraIntegration } from "./types";

/**
 * Per-org Jira Cloud integration configs (see migration 171). One row per
 * org; the API token is vault-encrypted at rest and decrypted on read — the
 * sync needs it, tools must never echo it. Org-facing methods take the
 * organizationId in the WHERE clause; `listEnabled()` exists only for the
 * sync cron.
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
  status_mapping: unknown;
  auto_delegate: boolean;
  webhook_secret: string;
  enabled: boolean;
  last_synced_at: Date | string | null;
  last_sync_error: string | null;
  rescan_pending: boolean;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export interface TaskBoardItemJiraLink {
  itemId: string;
  jiraIssueId: string;
  jiraIssueKey: string;
  jiraUpdatedAt: string;
  jiraStatus: string | null;
}

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
      // Defensive parse — driver jsonb handling varies (see organization-settings.ts).
      // Normalized on the way out, so every reader gets lane → statuses and
      // a row still in the legacy status → lane shape keeps syncing.
      statusMapping: normalizeStatusMapping(
        typeof row.status_mapping === "string"
          ? JSON.parse(row.status_mapping)
          : row.status_mapping,
      ),
      autoDelegate: row.auto_delegate,
      webhookSecret: row.webhook_secret,
      enabled: row.enabled,
      lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : null,
      lastSyncError: row.last_sync_error,
      rescanPending: row.rescan_pending,
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
    statusMapping: JiraStatusMapping;
    autoDelegate: boolean;
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
        status_mapping: JSON.stringify(params.statusMapping),
        auto_delegate: params.autoDelegate,
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
          status_mapping: JSON.stringify(params.statusMapping),
          auto_delegate: params.autoDelegate,
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

  /**
   * Ids of every enabled integration across all orgs — the sync cron's work
   * list.
   *
   * Ids, not entities, because this runs as a DBOS step and DBOS persists step
   * OUTPUT in its system database: returning `OrgJiraIntegration` here would
   * write every tenant's vault-decrypted `apiToken` to that table on every
   * tick. Each leg re-reads (and re-decrypts) its own row instead.
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

  async getById(id: string): Promise<OrgJiraIntegration | null> {
    const row = await this.db
      .selectFrom("org_jira_integrations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.toEntity(row as Row) : null;
  }

  /** Record a sync outcome. `watermark` (the max issue `updated` fully
   *  processed) only advances on success — an errored run keeps the old one
   *  so the next run re-covers the gap. `rescanPending` left unset (an error,
   *  or a run that hasn't decided) leaves the flag as it was — only a run
   *  that actually ran the rescan/incremental decision gets to change it. */
  async recordSyncResult(
    id: string,
    result: { error: string | null; watermark?: Date; rescanPending?: boolean },
  ): Promise<void> {
    await this.db
      .updateTable("org_jira_integrations")
      .set({
        last_sync_error: result.error,
        ...(result.watermark ? { last_synced_at: result.watermark } : {}),
        ...(result.rescanPending !== undefined
          ? { rescan_pending: result.rescanPending }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Drop the watermark, so the next run re-scans the board from the start.
   *
   * `last_synced_at` means "every issue in scope up to here has been
   * processed", which stops being true whenever what we do with an issue
   * changes — a widened status mapping, a fixed renderer — rather than only
   * when the scope does. Issues already behind the watermark are never asked
   * for again, so those repairs reach nothing without this.
   *
   * Safe to call: a null watermark is the initial-import path, which is
   * idempotent (the link table's UNIQUE dedupes every issue) and deliberately
   * suppresses auto-delegation, so a re-scan cannot dispatch a paid agent run
   * per pre-existing card. `MAX_ISSUES_PER_RUN` paces the rest.
   */
  async clearWatermark(id: string): Promise<void> {
    await this.db
      .updateTable("org_jira_integrations")
      .set({
        last_synced_at: null,
        last_sync_error: null,
        rescan_pending: false,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Every linked issue in the org, for the reconciliation pass — the cards
   * whose issue is no longer in the board's scope.
   *
   * Only cards still on the board: an already-archived one is the resting
   * state this reconciliation moves cards TO, so re-reading it every tick
   * would re-archive it forever.
   */
  async listLinkedIssuesOnBoard(
    organizationId: string,
  ): Promise<
    Array<{ itemId: string; jiraIssueId: string; jiraIssueKey: string }>
  > {
    const rows = await this.db
      .selectFrom("task_board_item_jira_links as l")
      .innerJoin("task_board_items as t", "t.id", "l.item_id")
      .select(["l.item_id", "l.jira_issue_id", "l.jira_issue_key"])
      .where("l.organization_id", "=", organizationId)
      .where("t.status", "!=", "archived")
      .execute();
    return rows.map((row) => ({
      itemId: row.item_id,
      jiraIssueId: row.jira_issue_id,
      jiraIssueKey: row.jira_issue_key,
    }));
  }

  async getLinksByIssueIds(
    organizationId: string,
    jiraIssueIds: string[],
  ): Promise<Map<string, TaskBoardItemJiraLink>> {
    if (jiraIssueIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("task_board_item_jira_links")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("jira_issue_id", "in", jiraIssueIds)
      .execute();
    return new Map(
      rows.map((row) => [
        row.jira_issue_id,
        {
          itemId: row.item_id,
          jiraIssueId: row.jira_issue_id,
          jiraIssueKey: row.jira_issue_key,
          jiraUpdatedAt: toIso(row.jira_updated_at),
          jiraStatus: row.jira_status,
        },
      ]),
    );
  }

  async createLink(params: {
    itemId: string;
    organizationId: string;
    jiraIssueId: string;
    jiraIssueKey: string;
    jiraUpdatedAt: Date;
    jiraStatus: string;
  }): Promise<void> {
    await this.db
      .insertInto("task_board_item_jira_links")
      .values({
        item_id: params.itemId,
        organization_id: params.organizationId,
        jira_issue_id: params.jiraIssueId,
        jira_issue_key: params.jiraIssueKey,
        jira_updated_at: params.jiraUpdatedAt,
        jira_status: params.jiraStatus,
      })
      .execute();
  }

  async touchLink(
    itemId: string,
    patch: { jiraUpdatedAt?: Date; jiraStatus?: string },
  ): Promise<void> {
    await this.db
      .updateTable("task_board_item_jira_links")
      .set({
        ...(patch.jiraUpdatedAt !== undefined
          ? { jira_updated_at: patch.jiraUpdatedAt }
          : {}),
        ...(patch.jiraStatus !== undefined
          ? { jira_status: patch.jiraStatus }
          : {}),
      })
      .where("item_id", "=", itemId)
      .execute();
  }

  /** The card's Jira link, if it mirrors an issue — the comment push's gate. */
  async getLinkByItemId(
    itemId: string,
    organizationId: string,
  ): Promise<TaskBoardItemJiraLink | null> {
    const row = await this.db
      .selectFrom("task_board_item_jira_links")
      .selectAll()
      .where("item_id", "=", itemId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      itemId: row.item_id,
      jiraIssueId: row.jira_issue_id,
      jiraIssueKey: row.jira_issue_key,
      jiraUpdatedAt: toIso(row.jira_updated_at),
      jiraStatus: row.jira_status,
    };
  }

  /** Which of these Jira comment ids are already linked (pushed or pulled). */
  async knownJiraCommentIds(
    organizationId: string,
    jiraCommentIds: string[],
  ): Promise<Set<string>> {
    if (jiraCommentIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom("task_board_comment_jira_links")
      .select("jira_comment_id")
      .where("organization_id", "=", organizationId)
      .where("jira_comment_id", "in", jiraCommentIds)
      .execute();
    return new Set(rows.map((row) => row.jira_comment_id));
  }

  /** Whether this board comment was already pushed to Jira — the comment-push
   *  workflow's re-entry (idempotency) check. */
  async hasCommentLink(commentId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("task_board_comment_jira_links")
      .select("comment_id")
      .where("comment_id", "=", commentId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async createCommentLink(params: {
    commentId: string;
    organizationId: string;
    jiraCommentId: string;
  }): Promise<void> {
    await this.db
      .insertInto("task_board_comment_jira_links")
      .values({
        comment_id: params.commentId,
        organization_id: params.organizationId,
        jira_comment_id: params.jiraCommentId,
      })
      .execute();
  }
}
