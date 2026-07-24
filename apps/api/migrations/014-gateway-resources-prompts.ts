/**
 * Gateway Resources and Prompts Selection Migration
 *
 * Adds support for selecting resources and prompts in gateway connections,
 * in addition to the existing tool selection.
 *
 * - selected_resources: JSON array of URIs/patterns (exact URIs for individual selection,
 *   patterns with `*`/`**` for wildcard matching)
 * - selected_prompts: JSON array of prompt names (same behavior as selected_tools)
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add selected_resources column
  await db.schema
    .alterTable("gateway_connections")
    .addColumn("selected_resources", "text")
    .execute();

  // Add selected_prompts column
  await db.schema
    .alterTable("gateway_connections")
    .addColumn("selected_prompts", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("gateway_connections")
    .dropColumn("selected_resources")
    .execute();

  await db.schema
    .alterTable("gateway_connections")
    .dropColumn("selected_prompts")
    .execute();
}
