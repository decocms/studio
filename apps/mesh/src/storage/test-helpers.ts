/**
 * Test Helpers for Storage Tests
 * Runs production migrations for testing
 */

import { Migrator, sql, type Kysely } from "kysely";
import migrations from "../../migrations";
import type { Database } from "./types";

/**
 * Create Better Auth tables that are normally created by Better Auth migrations
 * We create these manually because Better Auth uses its own migration system
 * that's tied to the global auth config/database
 */
export async function createBetterAuthTables(
  db: Kysely<Database>,
): Promise<void> {
  // User table (Better Auth core table - singular name)
  await db.schema
    .createTable("user")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("emailVerified", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("image", "text")
    .addColumn("role", "text")
    .addColumn("banned", "integer")
    .addColumn("banReason", "text")
    .addColumn("banExpires", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Users table (plural - for application code compatibility)
  // This matches the Database type's "users" table
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull().defaultTo("user"))
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Session table (Better Auth core table)
  await db.schema
    .createTable("session")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("expiresAt", "text", (col) => col.notNull())
    .addColumn("ipAddress", "text")
    .addColumn("userAgent", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Account table (Better Auth core table)
  await db.schema
    .createTable("account")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) => col.notNull())
    .addColumn("accountId", "text", (col) => col.notNull())
    .addColumn("providerId", "text", (col) => col.notNull())
    .addColumn("accessToken", "text")
    .addColumn("refreshToken", "text")
    .addColumn("accessTokenExpiresAt", "text")
    .addColumn("refreshTokenExpiresAt", "text")
    .addColumn("scope", "text")
    .addColumn("idToken", "text")
    .addColumn("password", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Verification table (Better Auth core table)
  await db.schema
    .createTable("verification")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identifier", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("expiresAt", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // Organization table (Better Auth organization plugin)
  await db.schema
    .createTable("organization")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull().unique())
    .addColumn("logo", "text")
    .addColumn("metadata", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .execute();

  // Member table (Better Auth organization plugin)
  await db.schema
    .createTable("member")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) => col.notNull())
    .addColumn("organizationId", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) => col.notNull())
    .execute();

  // Invitation table (Better Auth organization plugin)
  await db.schema
    .createTable("invitation")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("organizationId", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("inviterId", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("expiresAt", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) => col.notNull())
    .execute();

  // API Key table (Better Auth API key plugin)
  await db.schema
    .createTable("apiKey")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("start", "text")
    .addColumn("prefix", "text")
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("refillInterval", "text")
    .addColumn("refillAmount", "integer")
    .addColumn("lastRefillAt", "text")
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("rateLimitEnabled", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn("rateLimitTimeWindow", "integer")
    .addColumn("rateLimitMax", "integer")
    .addColumn("requestCount", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("remaining", "integer")
    .addColumn("lastRequest", "text")
    .addColumn("expiresAt", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .addColumn("permissions", "text")
    .addColumn("metadata", "text")
    .execute();

  // OAuth Application table (Better Auth OAuth plugin)
  await db.schema
    .createTable("oauthApplication")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("icon", "text")
    .addColumn("metadata", "text")
    .addColumn("clientId", "text", (col) => col.notNull().unique())
    .addColumn("clientSecret", "text", (col) => col.notNull())
    .addColumn("redirectURLs", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("disabled", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("userId", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // OAuth Access Token table
  await db.schema
    .createTable("oauthAccessToken")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("accessToken", "text", (col) => col.notNull())
    .addColumn("refreshToken", "text")
    .addColumn("accessTokenExpiresAt", "text", (col) => col.notNull())
    .addColumn("refreshTokenExpiresAt", "text")
    .addColumn("clientId", "text", (col) => col.notNull())
    .addColumn("userId", "text")
    .addColumn("scopes", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();

  // OAuth Consent table
  await db.schema
    .createTable("oauthConsent")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("userId", "text", (col) => col.notNull())
    .addColumn("clientId", "text", (col) => col.notNull())
    .addColumn("scopes", "text")
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text", (col) => col.notNull())
    .execute();
}

/**
 * Create test schema by running production migrations
 * This ensures tests use the same schema as production
 */
export async function createTestSchema(db: Kysely<Database>): Promise<void> {
  console.log("Running migrations for test schema...");

  // First create Better Auth tables (they're not in Kysely migrations)
  await createBetterAuthTables(db);

  // Then run Kysely migrations
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });

  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    console.error("Migration failed:", error);
    throw error;
  }

  const successCount =
    results?.filter((r) => r.status === "Success").length ?? 0;
  console.log(`✅ ${successCount} migrations applied`);
}

/**
 * Seed common parent records required by FK constraints.
 * PGlite (PostgreSQL) enforces FK constraints, so tests that insert into
 * FK-constrained tables (e.g. connections) need parent records to exist first.
 */
export async function seedCommonTestFixtures(
  db: Kysely<Database>,
): Promise<void> {
  const now = new Date().toISOString();

  // Create test users
  for (const userId of ["user_1", "user_123", "user_test", "test_user"]) {
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${userId + "@test.com"}, 0, ${"Test " + userId}, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  }

  // Create test organizations
  for (const orgId of ["org_1", "org_123", "org_456", "org_test"]) {
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  }
}
