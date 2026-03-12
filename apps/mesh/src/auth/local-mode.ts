/**
 * Local Mode Setup
 *
 * Handles auto-seeding an admin user and "Local" organization
 * for the zero-ceremony local developer experience.
 *
 * Only runs when MESH_LOCAL_MODE=true (set by CLI).
 */

import { getDb } from "@/database";
import { randomBytes } from "crypto";
import { env } from "../env";
import { mkdir, writeFile, chmod } from "fs/promises";
import { userInfo } from "os";
import { join } from "path";
import { auth } from "./index";

let _cachedPassword: string | undefined;

/**
 * Get the per-install local admin password from secrets.json.
 *
 * Reads from DECOCMS_HOME (set by CLI) or the default ~/deco directory.
 * Throws if no password is found — never falls back to a hardcoded credential.
 */
export async function getLocalAdminPassword(): Promise<string> {
  if (_cachedPassword) return _cachedPassword;

  const decoHome = env.DATA_DIR;

  const secretsPath = join(decoHome, "secrets.json");

  // Try to read existing secrets
  try {
    const file = Bun.file(secretsPath);
    if (await file.exists()) {
      const secrets = await file.json();
      if (secrets.LOCAL_ADMIN_PASSWORD) {
        const pw: string = secrets.LOCAL_ADMIN_PASSWORD;
        _cachedPassword = pw;
        return pw;
      }
    }
  } catch {
    // File not readable or doesn't exist
  }

  // Auto-generate password when running dev:local (bypasses CLI)
  const pw = randomBytes(24).toString("base64");
  try {
    await mkdir(decoHome, { recursive: true, mode: 0o700 });
    let secrets: Record<string, string> = {};
    try {
      const file = Bun.file(secretsPath);
      if (await file.exists()) {
        secrets = await file.json();
      }
    } catch {
      // Start fresh
    }
    secrets.LOCAL_ADMIN_PASSWORD = pw;
    await writeFile(secretsPath, JSON.stringify(secrets, null, 2), {
      mode: 0o600,
    });
    await chmod(secretsPath, 0o600);
  } catch (err) {
    console.warn("Warning: Could not save secrets file:", err);
  }
  _cachedPassword = pw;
  return pw;
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
  const email = `${username}@localhost.mesh`;
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
  const email = `${getLocalUserName()}@localhost.mesh`;
  return database.db
    .selectFrom("user")
    .where("email", "=", email)
    .selectAll()
    .executeTakeFirst();
}

export function isLocalMode(): boolean {
  return env.MESH_LOCAL_MODE;
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
