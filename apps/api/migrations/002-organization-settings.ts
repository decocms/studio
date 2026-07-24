import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // CASCADE DELETE: When organization is deleted, settings are automatically removed
  await db.schema
    .createTable("organization_settings")
    .addColumn("organizationId", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("modelsBindingConnectionId", "text", (col) =>
      col.references("connections.id").onDelete("set null"),
    )
    .addColumn("createdAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updatedAt", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("organization_settings").execute();
}
