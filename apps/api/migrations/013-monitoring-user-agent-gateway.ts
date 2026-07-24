/**
 * Add user_agent and gateway_id fields to monitoring_logs table
 *
 * - user_agent: Captures the client-identification header
 * - gateway_id: Links logs to the gateway used (if applicable)
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("monitoring_logs")
    .addColumn("user_agent", "text")
    .execute();

  await db.schema
    .alterTable("monitoring_logs")
    .addColumn("gateway_id", "text")
    .execute();

  // Create index for gateway_id filtering
  await db.schema
    .createIndex("monitoring_logs_gateway_timestamp")
    .on("monitoring_logs")
    .columns(["gateway_id", "timestamp"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("monitoring_logs_gateway_timestamp").execute();

  await db.schema
    .alterTable("monitoring_logs")
    .dropColumn("gateway_id")
    .execute();

  await db.schema
    .alterTable("monitoring_logs")
    .dropColumn("user_agent")
    .execute();
}
