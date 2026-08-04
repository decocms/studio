import { type Kysely, sql } from "kysely";

/**
 * Retire the repo-scoped-github-child 1:1 trigger from migration 125.
 *
 * 125 asserted "one repo-scoped github child per agent" because the import
 * flow minted a fresh child per agent. That is no longer true: one repository
 * now has ONE connection, reused across every agent that imports it, so a
 * child legitimately has N parents and the trigger rejects the second import.
 *
 * The bug 125 was defending against (a shared aggregation mutating, flipping
 * the header's "is GitHub attached?" gate off and rendering nothing) was fixed
 * in the same PR by `resolveGithubAttachment` + the detached reconnect pill,
 * neither of which needs 1:1: the gate cross-checks a connection against THIS
 * agent's own aggregation rows, and `virtualMcps.update` rewrites edges scoped
 * to a single parent. The teardown assumption 125 also propped up
 * (`tools/virtual/delete.ts`) now checks for other holders explicitly.
 *
 * `try_parse_jsonb` stays: it is a harmless standalone helper and dropping it
 * would break 125's `down`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_repo_github_child_single_parent ON connection_aggregations;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS enforce_repo_github_child_single_parent();`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-create 125's trigger verbatim. Rows that violate it are NOT deduped:
  // under reuse they are valid data, and deleting an agent's only edge would
  // detach a live repo.
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
