/**
 * Local Mode Setup
 *
 * Handles auto-seeding an admin user and "Local" organization
 * for the zero-ceremony local developer experience.
 *
 * Only runs when DECOCMS_LOCAL_MODE=true (set by CLI).
 */

import { getDb, type StudioDatabase } from "@/database";
import { symmetricDecrypt } from "better-auth/crypto";
import { sql } from "kysely";
import { getSettings } from "../settings";
import { userInfo } from "os";
import { auth } from "./index";

const LOCAL_EMAIL_DOMAIN = "localhost.studio";
const LEGACY_LOCAL_EMAIL_DOMAIN = "localhost.mesh";

/**
 * Self-heal stale JWKS keys left by a pre-fix local install.
 *
 * Before local mode persisted a stable secret (see settings/local-secret.ts),
 * Better Auth minted a fresh random secret every process start and encrypted
 * the JWKS private key with it. On the next boot the now-different secret could
 * not decrypt that key — `GET /api/auth/get-session` 500s and the user is
 * trapped in an unbreakable login loop. Persisting the secret stops NEW installs
 * from ever reaching that state, but a DB seeded by a pre-fix version still
 * carries a JWKS row encrypted under a secret that no longer exists, so those
 * users stay stuck until the row is cleared.
 *
 * So on every local-mode boot, probe each JWKS row with the current secret and
 * drop any that no longer decrypt. Better Auth transparently regenerates a fresh
 * key (encrypted with the persisted secret) on the next sign, so `bunx decocms`
 * self-recovers with no manual DB surgery. Local mode is loopback-only, so
 * discarding a signing key only invalidates local sessions the broken boot had
 * already invalidated anyway.
 *
 * Returns the number of undecryptable keys removed.
 */
export async function healLocalJwks(): Promise<number> {
  const settings = getSettings();
  // Defense in depth: this DELETEs signing keys, so it must never run outside
  // local mode even if a future caller forgets the gate. `betterAuthSecret` is
  // truthy in production too, so it alone is not a safe guard — a server
  // recovers via its explicit shared BETTER_AUTH_SECRET, never by dropping keys.
  if (!settings.localMode) return 0;
  // No secret resolved => Better Auth is on its random-per-process path; there
  // is no stable key to probe against, so healing would be meaningless.
  if (!settings.betterAuthSecret) return 0;
  return pruneUndecryptableJwks(getDb().db, settings.betterAuthSecret);
}

/**
 * Core of {@link healLocalJwks}, decoupled from the Settings/DB singletons so it
 * can be exercised against a real Postgres in tests. Probes every JWKS row with
 * `secret` and deletes the ones that no longer decrypt. Returns the count removed.
 */
export async function pruneUndecryptableJwks(
  db: StudioDatabase["db"],
  secret: string,
): Promise<number> {
  let rows: readonly { id: string; privateKey: string }[];
  try {
    const result = await sql<{ id: string; privateKey: string }>`
      select id, "privateKey" from jwks
    `.execute(db);
    rows = result.rows;
  } catch (err) {
    // Postgres 42P01 = undefined_table: a fresh DB hasn't had Better Auth mint
    // its first key yet, so there is genuinely nothing to heal.
    if ((err as { code?: string } | undefined)?.code === "42P01") return 0;
    // Anything else (DB down, permissions, a column renamed by a Better Auth
    // upgrade) must be surfaced — silently returning 0 would leave a genuinely
    // broken install stuck in the login loop with no diagnostic.
    console.warn("[local-mode] JWKS heal skipped — could not read jwks:", err);
    return 0;
  }

  let removed = 0;
  for (const row of rows) {
    // Mirror Better Auth's own decrypt path (plugins/jwt/sign, verified against
    // better-auth@1.4.22): the stored privateKey is a JSON-encoded encrypted
    // payload keyed by the secret. Re-verify this contract on any upgrade.
    let decryptable = true;
    try {
      await symmetricDecrypt({ key: secret, data: JSON.parse(row.privateKey) });
    } catch {
      decryptable = false;
    }
    if (decryptable) continue;

    try {
      await sql`delete from jwks where id = ${row.id}`.execute(db);
      removed++;
    } catch (err) {
      // A transient delete failure must not abort the rest of boot (seeding
      // runs after this); the next clean boot will retry the heal.
      console.warn(
        `[local-mode] JWKS heal could not delete stale key ${row.id}:`,
        err,
      );
    }
  }
  return removed;
}

/**
 * Get the local admin password.
 *
 * A fixed constant, intentionally NOT derived from betterAuthSecret: local mode
 * is loopback-only auto-login (never typed by a human), and coupling it to the
 * secret would break auto-login on any existing local DB whenever the secret
 * changed — e.g. once local mode began persisting a random secret. Seed and
 * sign-in both read this same constant, so they always agree.
 */
export async function getLocalAdminPassword(): Promise<string> {
  return "local-mode-default";
}

function getLocalUserName(): string {
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Check if the database already has users.
 * Returns true if the database is fresh (no users).
 */
async function isDatabaseFresh(): Promise<boolean> {
  const database = getDb();
  const result = await database.db
    .selectFrom("user")
    .select(database.db.fn.countAll().as("count"))
    .executeTakeFirst();
  return Number(result?.count ?? 0) === 0;
}

/**
 * Seed the local mode environment.
 * Creates an admin user and a default organization if the database is fresh.
 *
 * The signup triggers Better Auth's databaseHooks.user.create.after hook
 * which automatically creates a default organization with seeded connections.
 *
 * Returns true if seeding was performed, false if skipped (already set up).
 */
export async function seedLocalMode(): Promise<boolean> {
  const fresh = await isDatabaseFresh();
  if (!fresh) {
    return false;
  }

  const username = getLocalUserName();
  const email = `${username}@${LOCAL_EMAIL_DOMAIN}`;
  const displayName = capitalize(username);
  const password = await getLocalAdminPassword();

  // Create admin user via Better Auth signup.
  // The databaseHooks.user.create.after hook in auth/index.ts will
  // automatically create a default organization for this user.
  const signUpResult = await auth.api.signUpEmail({
    body: {
      email,
      password,
      name: displayName,
    },
  });

  if (!signUpResult?.user?.id) {
    throw new Error("Failed to create local admin user");
  }

  const userId = signUpResult.user.id;
  const database = getDb();

  // Set user as admin directly in the database (avoids needing auth headers)
  await database.db
    .updateTable("user")
    .set({ role: "admin" })
    .where("id", "=", userId)
    .execute();

  // Rename the auto-created org to {username}-local
  // Normalize slug: lowercase, replace non-alphanumeric with hyphens, collapse/trim
  const orgSlug = `${username}-local`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const orgName = `${displayName} Local`;
  await database.db
    .updateTable("organization")
    .set({ name: orgName, slug: orgSlug })
    .where("id", "in", (qb) =>
      qb
        .selectFrom("member")
        .select("organizationId")
        .where("userId", "=", userId),
    )
    .execute();

  return true;
}

/**
 * Get the local admin user, if it exists.
 * Used by the auto-login middleware.
 */
export async function getLocalAdminUser() {
  const database = getDb();
  const username = getLocalUserName();
  const canonicalUser = await database.db
    .selectFrom("user")
    .where("email", "=", `${username}@${LOCAL_EMAIL_DOMAIN}`)
    .selectAll()
    .executeTakeFirst();
  if (canonicalUser) return canonicalUser;

  return database.db
    .selectFrom("user")
    .where("email", "=", `${username}@${LEGACY_LOCAL_EMAIL_DOMAIN}`)
    .selectAll()
    .executeTakeFirst();
}

export function isLocalMode(): boolean {
  return getSettings().localMode;
}

// Seed readiness gate — local-session waits for this before granting access.
// Resolves immediately if not in local mode (no seeding to wait for).
let _seedResolve: () => void;
const _seedReady = new Promise<void>((resolve) => {
  _seedResolve = resolve;
  if (!isLocalMode()) {
    resolve();
  }
});

/** Mark local-mode seeding as complete. Called from index.ts after seedLocalMode(). */
export function markSeedComplete(): void {
  _seedResolve();
}

/** Wait for local-mode seeding to finish. No-op if already complete or not in local mode. */
export function waitForSeed(): Promise<void> {
  return _seedReady;
}
