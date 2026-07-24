/**
 * Migration 034 - Monitoring Dashboards (removed)
 *
 * This feature has been removed. The migration is kept as a no-op
 * so that databases which already ran it are not affected.
 */
import type { Kysely } from "kysely";

export async function up(_db: Kysely<unknown>): Promise<void> {
  // no-op: monitoring dashboards feature removed
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // no-op
}
