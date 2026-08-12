/**
 * Migration 171: Per-user OAuth on downstream MCP connections
 *
 * Adds `auth_mode` to `connections` and re-introduces `userId` on
 * `downstream_tokens` as a nullable column. Migration 017
 * (017-downstream-token-remove-userid) had removed `userId` because all
 * tokens were treated as connection-scoped.
 *
 * This change reintroduces user-scoped tokens as an opt-in per connection:
 *
 *   - `connections.auth_mode = 'shared'`  → one token per connection
 *     (legacy behaviour; `downstream_tokens.userId IS NULL`).
 *   - `connections.auth_mode = 'per_user'` → one token per
 *     (connection, user) pair; each member authorizes with their own
 *     identity, and audit logs at the downstream provider show the real
 *     person acting.
 *
 * Two partial unique indexes enforce the rule:
 *   - `downstream_tokens_shared_unique` on (connectionId) WHERE userId IS NULL
 *   - `downstream_tokens_per_user_unique` on (connectionId, userId)
 *       WHERE userId IS NOT NULL
 *
 * Existing rows are untouched: their `userId` becomes NULL (= shared) and
 * the parent connection keeps `auth_mode = 'shared'` (column default).
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. connections.auth_mode (default 'shared' for backward compatibility)
  await db.schema
    .alterTable("connections")
    .addColumn("auth_mode", "text", (col) => col.notNull().defaultTo("shared"))
    .execute();

  await sql`
    ALTER TABLE connections
    ADD CONSTRAINT connections_auth_mode_check
    CHECK (auth_mode IN ('shared', 'per_user'))
  `.execute(db);

  // 2. downstream_tokens.userId (nullable, FK to user.id, cascade on delete)
  await db.schema
    .alterTable("downstream_tokens")
    .addColumn("userId", "text", (col) =>
      col.references("user.id").onDelete("cascade"),
    )
    .execute();

  // 3. Drop legacy unique-on-connectionId index created by migration 017.
  // Kysely's createIndex concatenated the column name onto the base, so the
  // actual index in Postgres is `idx_downstream_tokens_connectionId` (quoted,
  // with the camelCase column). DROP IF EXISTS keeps both spellings safe.
  await sql`DROP INDEX IF EXISTS "idx_downstream_tokens_connectionId"`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_downstream_tokens_connection`.execute(db);

  // 4. New partial unique indexes — one shared row, many per-user rows.
  await sql`
    CREATE UNIQUE INDEX downstream_tokens_shared_unique
    ON downstream_tokens ("connectionId")
    WHERE "userId" IS NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX downstream_tokens_per_user_unique
    ON downstream_tokens ("connectionId", "userId")
    WHERE "userId" IS NOT NULL
  `.execute(db);

  // 5. Lookup index for "my connections" views.
  await db.schema
    .createIndex("idx_downstream_tokens_user")
    .on("downstream_tokens")
    .column("userId")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes/constraints in reverse order, then columns.
  await db.schema.dropIndex("idx_downstream_tokens_user").execute();
  await db.schema.dropIndex("downstream_tokens_per_user_unique").execute();
  await db.schema.dropIndex("downstream_tokens_shared_unique").execute();

  // Restore the legacy single-token-per-connection unique index. Any
  // per-user rows must be deduplicated first; keep the most recently
  // updated row (mirrors the strategy used in migration 017).
  await sql`
    DELETE FROM downstream_tokens
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, "connectionId",
          ROW_NUMBER() OVER (
            PARTITION BY "connectionId" ORDER BY "updatedAt" DESC
          ) AS rn
        FROM downstream_tokens
      ) ranked
      WHERE rn = 1
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX "idx_downstream_tokens_connectionId"
    ON downstream_tokens ("connectionId")
  `.execute(db);

  await db.schema
    .alterTable("downstream_tokens")
    .dropColumn("userId")
    .execute();

  await sql`
    ALTER TABLE connections
    DROP CONSTRAINT connections_auth_mode_check
  `.execute(db);

  await db.schema.alterTable("connections").dropColumn("auth_mode").execute();
}
