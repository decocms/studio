/**
 * Test Helpers for Storage Tests
 * Runs production migrations for testing
 */

import type { Kysely } from "kysely";
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

  // organizationRole / organizationResource (Better Auth organization plugin
  // with dynamicAccessControl enabled). Mirrors the schema produced by
  // `getMigrations()` so tests can query custom roles like prod.
  await db.schema
    .createTable("organizationRole")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organizationId", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("permission", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text")
    .execute();

  await db.schema
    .createTable("organizationResource")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organizationId", "text", (col) => col.notNull())
    .addColumn("resource", "text", (col) => col.notNull())
    .addColumn("permissions", "text", (col) => col.notNull())
    .addColumn("createdAt", "text", (col) => col.notNull())
    .addColumn("updatedAt", "text")
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

// `createTestSchema` and `seedCommonTestFixtures` lived here for the PGlite
// era — they hand-rolled Better Auth tables + ran migrations + seeded
// users/orgs against an in-process WASM database. All app/storage tests
// now use the real-Postgres helpers in `src/database/test-db-pg.ts`, where
// equivalents (`resetTestPgDatabase` + `seedCommonTestPgFixtures`) live
// alongside the connection. `createBetterAuthTables` above is kept because
// `migrations/seeds/benchmark.ts` calls it — the benchmark's auth
// configuration doesn't run Better Auth's own migrations.
