/**
 * Local Mode Setup
 *
 * Handles auto-seeding an admin user and "Local" organization
 * for the zero-ceremony local developer experience.
 *
 * Only runs when MESH_LOCAL_MODE=true (set by CLI).
 */

import { getDb } from "@/database";
import { homedir, userInfo } from "os";
import { join } from "path";
import { auth } from "./index";

/**
 * Try to read LOCAL_ADMIN_PASSWORD from a secrets.json in the given directory.
 */
async function readPasswordFromDir(dir: string): Promise<string | null> {
  try {
    const file = Bun.file(join(dir, "secrets.json"));
    if (await file.exists()) {
      const secrets = await file.json();
      if (secrets.LOCAL_ADMIN_PASSWORD) {
        return secrets.LOCAL_ADMIN_PASSWORD;
      }
    }
  } catch {
    // Not available in this directory
  }
  return null;
}

/**
 * Get the per-install local admin password from secrets.json.
 *
 * Checks MESH_HOME first, then the default ~/deco directory (which the CLI
 * and dev.ts both use). Throws if neither location has a password — never
 * falls back to a hardcoded credential.
 */
export async function getLocalAdminPassword(): Promise<string> {
  // 1. Try MESH_HOME (set by CLI / dev.ts)
  const meshHome = process.env.MESH_HOME;
  if (meshHome) {
    const pw = await readPasswordFromDir(meshHome);
    if (pw) return pw;
  }

  // 2. Try default ~/deco (covers `bun run dev:server` without MESH_HOME)
  const defaultHome = join(homedir(), "deco");
  if (!meshHome || meshHome !== defaultHome) {
    const pw = await readPasswordFromDir(defaultHome);
    if (pw) return pw;
  }

  // No password found — fail loudly rather than using a known credential
  throw new Error(
    "Local admin password unavailable — secrets.json was not initialized. " +
      "Ensure loadOrCreateSecrets() runs before the server starts (the CLI does this automatically).",
  );
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
  return process.env.MESH_LOCAL_MODE === "true";
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
