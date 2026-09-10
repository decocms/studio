import { type Kysely, sql } from "kysely";

/**
 * The card's issue in the tracker it came from, as a link of its own.
 *
 * The Jira pull used to write that link as the FIRST LINE of the card's
 * description (`{site}/browse/{KEY}\n\n{body}`), which is the only place the
 * board had to put it. But a card's description is not a place to keep
 * metadata: it is quoted verbatim into every agent run's prompt (see
 * `buildSuperAgentTaskPrompt`), so the URL leaked into the model's context and
 * from there into the work it produced — orgs were writing board prompts
 * telling the agent to ignore it. As a column it is structured data the UI can
 * render as a link and the prompt simply never reads.
 *
 * Not `external_key`, the column next to it: that one is a reports-minted
 * finding IDENTITY used to dedupe imports. This is a URL for a human to open.
 *
 * Backfilled here, in both halves, so no card has to wait for its issue to be
 * touched in Jira again: the link table plus the integration's `site_url` give
 * the URL for every synced card, and stripping the prefix is anchored on that
 * exact string, so a description that never carried one is left alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("external_url", "text")
    .execute();

  await sql`
    UPDATE task_board_items i
       SET external_url = t.url,
           description = CASE
             WHEN left(i.description, length(t.url)) = t.url
               THEN nullif(
                      btrim(substr(i.description, length(t.url) + 1), E' \\t\\r\\n'),
                      ''
                    )
             ELSE i.description
           END
      FROM (
            SELECT l.item_id,
                   g.site_url || '/browse/' || l.jira_issue_key AS url
              FROM task_board_item_jira_links l
              JOIN org_jira_integrations g
                ON g.organization_id = l.organization_id
           ) t
     WHERE t.item_id = i.id
  `.execute(db);
}

/** Descriptions keep their stripped prefix: the next sync rewrites every one
 *  it owns, and re-prepending a URL to a since-edited description is worse. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("external_url")
    .execute();
}
