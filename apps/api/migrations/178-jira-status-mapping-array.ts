import { type Kysely, sql } from "kysely";

/**
 * Invert `org_jira_integrations.status_mapping` from `{ "<jira status>":
 * "<lane>" }` to `{ "<lane>": ["<jira status>", …] }`.
 *
 * Several Jira statuses sharing one lane is the normal case, so the push has to
 * pick one. Under the old shape it picked by iterating `Object.entries` over
 * jsonb, which Postgres orders by key length and then bytes — the Jira column a
 * card landed in was decided by how many characters its status name had. An
 * array makes the choice explicit: position 0 is the lane's leftmost board
 * column, and the settings UI writes it in board order.
 *
 * The old shape cannot say which status came first, so a lane that collapsed
 * several keeps them in jsonb key order here. That is no worse than the
 * behaviour being replaced, and re-picking the columns in settings rewrites it
 * in board order.
 *
 * Readers go through `normalizeStatusMapping`, which still accepts the old
 * shape, so a rolling deploy keeps syncing on either side of this.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE org_jira_integrations
       SET status_mapping = (
             SELECT COALESCE(jsonb_object_agg(lane, statuses), '{}'::jsonb)
               FROM (
                 SELECT value AS lane, jsonb_agg(key ORDER BY key) AS statuses
                   FROM jsonb_each_text(status_mapping)
                  GROUP BY value
               ) AS grouped
           )
     WHERE jsonb_typeof(status_mapping) = 'object'
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_each(status_mapping)
              WHERE jsonb_typeof(value) = 'array'
           )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE org_jira_integrations
       SET status_mapping = (
             SELECT COALESCE(jsonb_object_agg(status, lane), '{}'::jsonb)
               FROM (
                 SELECT jsonb_array_elements_text(value) AS status, key AS lane
                   FROM jsonb_each(status_mapping)
                  WHERE jsonb_typeof(value) = 'array'
               ) AS flattened
           )
     WHERE jsonb_typeof(status_mapping) = 'object'
       AND EXISTS (
             SELECT 1 FROM jsonb_each(status_mapping)
              WHERE jsonb_typeof(value) = 'array'
           )
  `.execute(db);
}
