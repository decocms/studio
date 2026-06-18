import type { Kysely } from "kysely";

/**
 * Adds a credential discriminator to `org_file_configs` so a config can hold
 * either a static long-lived key pair (the existing behaviour, default
 * `static`) or a `sts-session` reference whose temporary credentials are
 * fetched on demand from `refresh_url` and auto-refreshed by the S3 client.
 *
 * For `sts-session` rows, `encrypted_credentials` holds only the API key used
 * to authenticate the refresh call — never any S3 secret. Existing rows keep
 * `credential_type = 'static'` and their `{accessKeyId, secretAccessKey}` blob
 * untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_file_configs")
    .addColumn("credential_type", "text", (col) =>
      col.notNull().defaultTo("static"),
    )
    .addColumn("refresh_url", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_file_configs")
    .dropColumn("credential_type")
    .dropColumn("refresh_url")
    .execute();
}
