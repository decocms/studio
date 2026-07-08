/**
 * Enforce the 1:1 invariant for repo-scoped GitHub child connections.
 *
 * A repo-scoped GitHub child (a connection carrying `metadata.repoScope`) is a
 * per-agent, disposable credential holder for exactly one repository. The import
 * flow mints a fresh child per agent, so such a child must be aggregated under
 * AT MOST ONE parent Virtual MCP. That invariant lived only in code and drifted:
 * a setup flow re-used another agent's github child, aggregating it under two
 * parents. When the shared aggregation later mutated, the header's
 * "is GitHub attached?" gate flipped off and the save/publish button vanished.
 *
 * This migration makes the invariant SQL-enforced:
 *   1. Dedupe existing violations — keep exactly one edge per repo-scoped child
 *      (preferring the parent that actually references it in
 *      `metadata.githubRepo.connectionId`, else the oldest edge). The last
 *      remaining edge is never deleted, so no agent loses its only github child.
 *   2. Install a BEFORE INSERT trigger that rejects attaching a repo-scoped
 *      github child to a second parent.
 *
 * `connections.metadata` is stored as TEXT (JSON string), so all JSON access
 * goes through `try_parse_jsonb`, which returns NULL on malformed input rather
 * than aborting the migration/trigger on a single bad row.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Defensive text->jsonb: never throw on a malformed metadata row.
  await sql`
    CREATE OR REPLACE FUNCTION try_parse_jsonb(t text)
    RETURNS jsonb AS $fn$
    BEGIN
      RETURN t::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql IMMUTABLE;
  `.execute(db);

  // Step 1: dedupe existing violations. Keep one edge per repo-scoped github
  // child: the parent that claims it wins, then the oldest edge.
  await sql`
    DELETE FROM connection_aggregations a
    USING (
      SELECT
        agg.id,
        ROW_NUMBER() OVER (
          PARTITION BY agg.child_connection_id
          ORDER BY
            CASE
              WHEN COALESCE(
                try_parse_jsonb(parent.metadata) #>> '{githubRepo,connectionId}',
                ''
              ) = agg.child_connection_id THEN 0
              ELSE 1
            END,
            agg.created_at ASC,
            agg.id ASC
        ) AS rn
      FROM connection_aggregations agg
      JOIN connections child ON child.id = agg.child_connection_id
      JOIN connections parent ON parent.id = agg.parent_connection_id
      WHERE jsonb_typeof(try_parse_jsonb(child.metadata) -> 'repoScope') = 'object'
    ) ranked
    WHERE a.id = ranked.id AND ranked.rn > 1;
  `.execute(db);

  // Step 2: enforce it going forward.
  await sql`
    CREATE OR REPLACE FUNCTION enforce_repo_github_child_single_parent()
    RETURNS trigger AS $fn$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM connections c
        WHERE c.id = NEW.child_connection_id
          AND jsonb_typeof(try_parse_jsonb(c.metadata) -> 'repoScope') = 'object'
      ) AND EXISTS (
        SELECT 1 FROM connection_aggregations existing
        WHERE existing.child_connection_id = NEW.child_connection_id
          AND existing.parent_connection_id <> NEW.parent_connection_id
      ) THEN
        RAISE EXCEPTION
          'repo-scoped GitHub child % is already attached to another agent (1:1 invariant)',
          NEW.child_connection_id
          USING ERRCODE = 'unique_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_repo_github_child_single_parent
      BEFORE INSERT ON connection_aggregations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_repo_github_child_single_parent();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Deleted duplicate edges are not restored (they were invariant violations).
  await sql`DROP TRIGGER IF EXISTS trg_repo_github_child_single_parent ON connection_aggregations;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS enforce_repo_github_child_single_parent();`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS try_parse_jsonb(text);`.execute(db);
}
