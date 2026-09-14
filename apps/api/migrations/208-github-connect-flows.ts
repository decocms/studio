import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE github_connect_flows (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      encrypted_access_token text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX github_connect_flows_owner ON github_connect_flows(organization_id, user_id);
    CREATE INDEX github_connect_flows_expiry ON github_connect_flows(expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("github_connect_flows").execute();
}
