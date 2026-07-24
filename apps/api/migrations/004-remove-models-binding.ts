import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
  // First, create a new table without the modelsBindingConnectionId column
  // CASCADE DELETE: When organization is deleted, settings are automatically removed
  await db.schema
    .createTable("organization_settings_new")
    .addColumn("organizationId", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Copy data from old table to new table
  await db
    .insertInto("organization_settings_new" as never)
    .columns(["organizationId", "createdAt", "updatedAt"] as never)
    .expression((eb) =>
      eb
        .selectFrom("organization_settings" as never)
        .select([
          "organizationId" as never,
          "createdAt" as never,
          "updatedAt" as never,
        ]),
    )
    .execute();

  // Drop old table
  await db.schema.dropTable("organization_settings").execute();

  // Rename new table to original name
  await db.schema
    .alterTable("organization_settings_new")
    .renameTo("organization_settings")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Re-add the modelsBindingConnectionId column by recreating the table
  // CASCADE DELETE: When organization is deleted, settings are automatically removed
  await db.schema
    .createTable("organization_settings_new")
    .addColumn("organizationId", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("modelsBindingConnectionId", "text", (col) =>
      col.references("connections.id").onDelete("set null"),
    )
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Copy data from current table
  await db
    .insertInto("organization_settings_new" as never)
    .columns([
      "organizationId",
      "modelsBindingConnectionId",
      "createdAt",
      "updatedAt",
    ] as never)
    .expression((eb) =>
      eb
        .selectFrom("organization_settings" as never)
        .select([
          "organizationId" as never,
          eb.val(null).as("modelsBindingConnectionId"),
          "createdAt" as never,
          "updatedAt" as never,
        ]),
    )
    .execute();

  // Drop current table
  await db.schema.dropTable("organization_settings").execute();

  // Rename new table to original name
  await db.schema
    .alterTable("organization_settings_new")
    .renameTo("organization_settings")
    .execute();
}
