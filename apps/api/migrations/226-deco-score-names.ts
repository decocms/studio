import { type Kysely, sql } from "kysely";

/**
 * The storefront diagnostic is now called "Deco Score". `REPORTS_SETUP` writes
 * the connection's and agent's titles and the agent's pinned view label once,
 * at creation, so orgs onboarded before the rename keep the old names.
 *
 * Only values still equal to the old defaults change: a title or label someone
 * edited is theirs. The rows are matched by their deterministic ids, as in
 * migration 215: the connection is `<org>_commerce-discovery` and the agent is
 * `commerce-discovery_<org>`.
 */

const CONNECTION = {
  old: {
    title: "Store Report",
    description: "Your store's report and diagnostics",
  },
  new: { title: "Deco Score", description: "Your store's Deco Score" },
};
const AGENT = {
  old: {
    title: "Report Agent",
    description: "Ask anything about your store's report",
  },
  new: {
    title: "Deco Score Agent",
    description: "Ask anything about your store's Deco Score",
  },
};
const VIEW = {
  toolName: "get_my_diagnostic",
  old: "Report",
  new: "Deco Score",
};

async function rename(
  db: Kysely<unknown>,
  from: "old" | "new",
  to: "old" | "new",
): Promise<void> {
  for (const column of ["title", "description"] as const) {
    await sql`
      UPDATE connections
      SET ${sql.ref(column)} = ${CONNECTION[to][column]}
      WHERE id = organization_id || '_commerce-discovery'
        AND ${sql.ref(column)} = ${CONNECTION[from][column]}
    `.execute(db);
    await sql`
      UPDATE connections
      SET ${sql.ref(column)} = ${AGENT[to][column]}
      WHERE id = 'commerce-discovery_' || organization_id
        AND ${sql.ref(column)} = ${AGENT[from][column]}
    `.execute(db);
  }

  /** `metadata` is TEXT holding JSON; a row that never parsed is skipped. */
  await sql`
    CREATE OR REPLACE FUNCTION deco_score_try_jsonb(t text)
    RETURNS jsonb AS $fn$
    BEGIN
      RETURN t::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql IMMUTABLE;
  `.execute(db);

  await sql`
    WITH agents AS (
      SELECT id, deco_score_try_jsonb(metadata) AS m
      FROM connections
      WHERE id = 'commerce-discovery_' || organization_id
    ),
    relabeled AS (
      SELECT
        a.id,
        jsonb_set(
          a.m,
          '{ui,pinnedViews}',
          (
            SELECT jsonb_agg(
              CASE
                WHEN v ->> 'toolName' = ${VIEW.toolName}
                 AND v ->> 'label' = ${VIEW[from]}
                THEN v || jsonb_build_object('label', ${VIEW[to]}::text)
                ELSE v
              END
              ORDER BY ord
            )
            FROM jsonb_array_elements(a.m -> 'ui' -> 'pinnedViews')
              WITH ORDINALITY AS t(v, ord)
          )
        ) AS m
      FROM agents a
      WHERE jsonb_typeof(a.m -> 'ui' -> 'pinnedViews') = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(a.m -> 'ui' -> 'pinnedViews') AS e(v)
          WHERE v ->> 'toolName' = ${VIEW.toolName}
            AND v ->> 'label' = ${VIEW[from]}
        )
    )
    UPDATE connections c
    SET metadata = r.m::text
    FROM relabeled r
    WHERE c.id = r.id
  `.execute(db);

  await sql`DROP FUNCTION IF EXISTS deco_score_try_jsonb(text)`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await rename(db, "old", "new");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await rename(db, "new", "old");
}
