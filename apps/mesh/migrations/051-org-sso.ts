import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // SSO provider configuration per organization
  await db.schema
    .createTable("org_sso_config")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("issuer", "text", (col) => col.notNull())
    .addColumn("client_id", "text", (col) => col.notNull())
    .addColumn("client_secret", "text", (col) => col.notNull()) // encrypted
    .addColumn("discovery_endpoint", "text")
    .addColumn("scopes", "text", (col) =>
      col.notNull().defaultTo('["openid","email","profile"]'),
    )
    .addColumn("domain", "text", (col) => col.notNull())
    .addColumn("enforced", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // One SSO config per organization
  await db.schema
    .createIndex("idx_org_sso_config_org_id")
    .unique()
    .on("org_sso_config")
    .column("organization_id")
    .execute();

  // Lookup by email domain
  await db.schema
    .createIndex("idx_org_sso_config_domain")
    .on("org_sso_config")
    .column("domain")
    .execute();

  // Tracks per-user SSO authentication per organization
  await db.schema
    .createTable("org_sso_sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("authenticated_at", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // One active session per user per org
  await db.schema
    .createIndex("idx_org_sso_sessions_user_org")
    .unique()
    .on("org_sso_sessions")
    .columns(["user_id", "organization_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("org_sso_sessions").execute();
  await db.schema.dropTable("org_sso_config").execute();
}
