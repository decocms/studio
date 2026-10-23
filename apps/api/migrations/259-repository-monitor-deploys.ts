import { type Kysely, sql } from "kysely";

/**
 * Which repositories' default-branch pushes the Monitor's Deploys tab reads:
 * every one, existing rows included, until the org switches it off.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE repositories
      ADD COLUMN IF NOT EXISTS monitor_deploys boolean NOT NULL DEFAULT true
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE repositories DROP COLUMN IF EXISTS monitor_deploys
  `.execute(db);
}
