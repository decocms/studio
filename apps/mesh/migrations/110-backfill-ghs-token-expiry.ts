import { sql, type Kysely } from "kysely";

// GitHub App installation tokens (ghs_) have a ~1h lifetime. Rows written
// before this fix stored NULL for expires_at, causing isExpired() to treat
// them as "never expires" and serve stale tokens indefinitely. Backfill those
// rows with created_at + 55 minutes so they are detected as expired on the
// next ensureRepoScopedToken call and a fresh token is minted.
//
// Using created_at as the anchor is conservative: any token older than 55 min
// at deploy time is already past GitHub's 60-min window and will be treated
// as expired immediately, which is the correct outcome.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE downstream_tokens
    SET "expiresAt" = "createdAt"::timestamptz + INTERVAL '55 minutes'
    WHERE "expiresAt" IS NULL
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally a no-op: we cannot know which rows originally had NULL
  // expires_at vs rows that had a legitimate future expiry before this migration.
}
