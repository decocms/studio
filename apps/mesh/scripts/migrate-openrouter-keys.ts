#!/usr/bin/env bun
/**
 * Migrate OpenRouter OAuth Tokens → ai_provider_keys
 *
 * For connections installed via PKCE OAuth (openrouter, ai-gateway), the
 * access token lives in `downstream_tokens` (not `connections.connection_token`).
 *
 * This script:
 *   1. Finds connections where app_name IN (APP_NAMES)
 *   2. Joins to downstream_tokens to get the encrypted access token
 *   3. Decrypts the access token
 *   4. Creates an ai_provider_keys row (provider_id=openrouter) per connection,
 *      preserving organization_id and created_by
 *
 * Environment variables:
 *   DATABASE_URL   - DB connection string (defaults to file://$HOME/deco/db.pglite)
 *   ENCRYPTION_KEY - AES-256 vault key (defaults to "" like the app)
 *   APP_NAMES      - Comma-separated app_name values to migrate (required)
 *                    e.g. "openrouter,ai-gateway"
 *   DRY_RUN        - "true" to preview without writing (default: false)
 *
 * Usage:
 *   APP_NAMES="openrouter,ai-gateway" DRY_RUN=true bun run --cwd=apps/mesh scripts/migrate-openrouter-keys.ts
 *   DATABASE_URL=postgres://... ENCRYPTION_KEY=... APP_NAMES="openrouter,ai-gateway" bun run --cwd=apps/mesh scripts/migrate-openrouter-keys.ts
 */

import {
  createHash,
  createDecipheriv,
  createCipheriv,
  randomBytes,
} from "crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import { nanoid } from "nanoid";
import * as path from "path";

// ============================================================================
// Config
// ============================================================================

const DEFAULT_DB_URL = `file://${process.env.HOME}/deco/db.pglite`;
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "";
const APP_NAMES_RAW = process.env.APP_NAMES;
const DRY_RUN = process.env.DRY_RUN === "true";

if (!APP_NAMES_RAW) {
  console.error(
    "ERROR: APP_NAMES is required (e.g. APP_NAMES=openrouter,ai-gateway)",
  );
  process.exit(1);
}

const APP_NAMES = APP_NAMES_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`
=== OpenRouter Key Migration ===
App names: ${APP_NAMES.join(", ")}
Dry run:   ${DRY_RUN}
Database:  ${DATABASE_URL.replace(/:[^:@]+@/, ":****@")}
`);

// ============================================================================
// Encryption (mirrors CredentialVault)
// ============================================================================

const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function deriveKey(encryptionKey: string): Buffer {
  const base64Decoded = Buffer.from(encryptionKey, "base64");
  if (base64Decoded.length === KEY_LENGTH) {
    return base64Decoded;
  }
  return createHash("sha256").update(encryptionKey).digest();
}

async function decrypt(ciphertext: string, key: Buffer): Promise<string> {
  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

async function encrypt(plaintext: string, key: Buffer): Promise<string> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

// ============================================================================
// Database setup
// ============================================================================

function createDb(databaseUrl: string) {
  const url = databaseUrl.startsWith("/")
    ? `file://${databaseUrl}`
    : databaseUrl;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const protocol = parsed?.protocol.replace(":", "") ?? url.split("://")[0];

  if (protocol === "postgres" || protocol === "postgresql") {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl:
        process.env.DATABASE_PG_SSL === "true"
          ? { rejectUnauthorized: false }
          : undefined,
    });
    const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    return { type: "postgres" as const, db, pool };
  }

  if (protocol === "file") {
    const raw = url.replace(/^file:(?:\/\/(?:localhost(?=\/|$))?)?/, "");
    const pglite = new PGlite(path.resolve(raw));
    const db = new Kysely<any>({ dialect: new KyselyPGlite(pglite).dialect });
    return { type: "pglite" as const, db, pglite };
  }

  throw new Error(`Unsupported database protocol: ${protocol}`);
}

function generatePrefixedId(prefix: string) {
  return `${prefix}_${nanoid()}`;
}

// ============================================================================
// Main migration
// ============================================================================

async function main() {
  const key = deriveKey(ENCRYPTION_KEY);
  const database = createDb(DATABASE_URL);
  const { db } = database;

  try {
    // 1. Find connections from target apps that have a downstream_token (OAuth token)
    const rows = await db
      .selectFrom("connections as c")
      .innerJoin("downstream_tokens as dt", "dt.connectionId", "c.id")
      .select([
        "c.id as conn_id",
        "c.organization_id",
        "c.created_by",
        "c.app_name",
        "c.title",
        "dt.accessToken as encrypted_access_token",
        "dt.expiresAt",
      ])
      .where("c.app_name", "in", APP_NAMES)
      .execute();

    console.log(
      `Found ${rows.length} connection(s) with app_name in [${APP_NAMES.join(", ")}] that have an OAuth token.\n`,
    );

    if (rows.length === 0) {
      console.log("Nothing to migrate.");
      return;
    }

    // 2. Load existing openrouter keys to avoid duplicates
    const existingKeys = await db
      .selectFrom("ai_provider_keys")
      .select(["organization_id", "created_by"])
      .where("provider_id", "=", "openrouter")
      .execute();

    const existingSet = new Set(
      existingKeys.map((r: any) => `${r.organization_id}:${r.created_by}`),
    );

    // 3. Process each row
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      const dedupKey = `${row.organization_id}:${row.created_by}`;
      const prefix = `  [${row.conn_id}] "${row.title}" (app_name=${row.app_name})`;

      // Warn if token is expired — we migrate it anyway, user will need to re-auth eventually
      if (row.expiresAt && new Date(row.expiresAt as string) < new Date()) {
        console.warn(`${prefix} — WARNING: OAuth token is expired`);
      }

      // Decrypt the access token
      let apiKey: string;
      try {
        apiKey = await decrypt(row.encrypted_access_token as string, key);
      } catch (err) {
        console.error(`${prefix} — FAILED to decrypt access token: ${err}`);
        failed++;
        continue;
      }

      // Skip if an openrouter key already exists for this org+user
      if (existingSet.has(dedupKey)) {
        console.log(
          `${prefix} — SKIP (openrouter ai_provider_key already exists for this org+user)`,
        );
        skipped++;
        continue;
      }

      const encryptedApiKey = await encrypt(apiKey, key);
      const id = generatePrefixedId("aik");
      const label = `OpenRouter (migrated from "${row.title}")`;

      if (DRY_RUN) {
        console.log(
          `${prefix} — DRY RUN: would create id=${id} label="${label}" org=${row.organization_id} user=${row.created_by}`,
        );
      } else {
        await db
          .insertInto("ai_provider_keys")
          .values({
            id,
            organization_id: row.organization_id,
            provider_id: "openrouter",
            label,
            encrypted_api_key: encryptedApiKey,
            created_by: row.created_by,
            created_at: new Date(),
          })
          .execute();
        console.log(`${prefix} — CREATED ai_provider_key id=${id}`);
      }

      existingSet.add(dedupKey);
      created++;
    }

    console.log(`
=== Migration complete ===
Created: ${created}
Skipped: ${skipped} (already existed)
Failed:  ${failed}
${DRY_RUN ? "\n(DRY RUN — no rows were written)" : ""}
`);
  } finally {
    await db.destroy();
    if (database.type === "postgres") {
      await database.pool.end();
    }
    if (database.type === "pglite") {
      try {
        await database.pglite.close();
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
