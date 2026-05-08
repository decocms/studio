/**
 * Migration 068: Add branch column to threads
 *
 * Adds a nullable `branch` text column used to pin a thread to a git branch
 * for GitHub-linked virtualmcps. Nullable because non-github threads don't
 * need a branch.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").addColumn("branch", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("branch").execute();
}
