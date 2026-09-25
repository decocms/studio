import { sql, type Kysely } from "kysely";

/**
 * The deployment's GitHub App, registered from the admin dashboard through
 * GitHub's App Manifest flow instead of five environment variables.
 *
 * Deployment-wide, not org-scoped: one App serves every org on the instance,
 * exactly like the `GITHUB_APP_*` variables it stands in for (which still win
 * when set). A single row, pinned by the `id = 'default'` check, so a second
 * registration replaces the first instead of leaving two to choose between.
 *
 * The private key, client secret and webhook secret are vault-encrypted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("deployment_github_app")
    .addColumn("id", "text", (col) =>
      col.primaryKey().defaultTo("default").check(sql`id = 'default'`),
    )
    .addColumn("app_id", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("client_id", "text", (col) => col.notNull())
    .addColumn("encrypted_client_secret", "text", (col) => col.notNull())
    .addColumn("encrypted_private_key", "text", (col) => col.notNull())
    .addColumn("encrypted_webhook_secret", "text")
    .addColumn("html_url", "text")
    .addColumn("owner_login", "text")
    .addColumn("created_by", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("deployment_github_app").execute();
}
