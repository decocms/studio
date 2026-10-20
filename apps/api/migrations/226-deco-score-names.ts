import { type Kysely, sql } from "kysely";

/**
 * The storefront diagnostic is now called "Deco Score". `REPORTS_SETUP` writes
 * the connection's and agent's titles and the agent's pinned view label once,
 * at creation, so orgs onboarded before the rename keep the old names — and
 * orgs onboarded before #7244 still carry the name before that, "Commerce
 * Discovery", which that rename never migrated.
 *
 * Only values still equal to one of the old defaults change: a title or label
 * someone edited is theirs. The rows are matched by their deterministic ids, as
 * in migration 215: the connection is `<org>_commerce-discovery` and the agent
 * is `commerce-discovery_<org>`.
 *
 * `down` restores the most recent old default. It cannot tell which older one
 * a row carried, so a "Commerce Discovery" row comes back as "Store Report".
 */

interface Field {
  /** Every default this field has shipped with, newest first. */
  old: string[];
  new: string;
}

const CONNECTION: Record<"title" | "description", Field> = {
  title: { old: ["Store Report", "Commerce Discovery"], new: "Deco Score" },
  description: {
    old: [
      "Your store's report and diagnostics",
      "Commerce report and diagnostics",
      "Commerce Discovery report and commerce diagnostics.",
    ],
    new: "Your store's Deco Score",
  },
};
const AGENT: Record<"title" | "description", Field> = {
  title: {
    old: ["Report Agent", "Commerce Discovery"],
    new: "Deco Score Agent",
  },
  description: {
    old: [
      "Ask anything about your store's report",
      "Commerce report and diagnostics",
      "Commerce Discovery report workspace.",
    ],
    new: "Ask anything about your store's Deco Score",
  },
};
const VIEW = {
  toolName: "get_my_diagnostic",
  label: { old: ["Report", "Commerce Discovery"], new: "Deco Score" } as Field,
};

/** Values to match and the value to write, for either direction. */
function step(field: Field, direction: "up" | "down") {
  return direction === "up"
    ? { from: field.old, to: field.new }
    : { from: [field.new], to: field.old[0] as string };
}

async function rename(
  db: Kysely<unknown>,
  direction: "up" | "down",
): Promise<void> {
  for (const [idPattern, fields] of [
    [sql`organization_id || '_commerce-discovery'`, CONNECTION],
    [sql`'commerce-discovery_' || organization_id`, AGENT],
  ] as const) {
    for (const column of ["title", "description"] as const) {
      const { from, to } = step(fields[column], direction);
      await sql`
        UPDATE connections
        SET ${sql.ref(column)} = ${to}
        WHERE id = ${idPattern}
          AND ${sql.ref(column)} = ANY(${sql.val(from)}::text[])
      `.execute(db);
    }
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

  const { from, to } = step(VIEW.label, direction);
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
                 AND v ->> 'label' = ANY(${sql.val(from)}::text[])
                THEN v || jsonb_build_object('label', ${to}::text)
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
            AND v ->> 'label' = ANY(${sql.val(from)}::text[])
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
  await rename(db, "up");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await rename(db, "down");
}
