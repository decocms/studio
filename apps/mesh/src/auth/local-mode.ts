/**
 * Local Mode Setup
 *
 * Handles auto-seeding an admin user and "Local" organization
 * for the zero-ceremony local developer experience.
 *
 * Only runs when MESH_LOCAL_MODE=true (set by CLI).
 */

import { getDb } from "@/database";
import { auth } from "./index";

const LOCAL_ADMIN_EMAIL = "admin@localhost";
const LOCAL_ADMIN_PASSWORD = "admin";
const LOCAL_ADMIN_NAME = "Local Admin";
const LOCAL_ORG_NAME = "Local";
const LOCAL_ORG_SLUG = "local";

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
 * Creates an admin user and "Local" organization if the database is fresh.
 *
 * Returns true if seeding was performed, false if skipped (already set up).
 */
export async function seedLocalMode(): Promise<boolean> {
  const fresh = await isDatabaseFresh();
  if (!fresh) {
    return false;
  }

  // Create admin user via Better Auth
  const signUpResult = await auth.api.signUpEmail({
    body: {
      email: LOCAL_ADMIN_EMAIL,
      password: LOCAL_ADMIN_PASSWORD,
      name: LOCAL_ADMIN_NAME,
    },
  });

  if (!signUpResult?.user?.id) {
    throw new Error("Failed to create local admin user");
  }

  const userId = signUpResult.user.id;

  // Set user as admin
  await auth.api.setRole({
    body: {
      userId,
      role: "admin",
    },
    headers: new Headers(),
  });

  // Create the "Local" organization
  await auth.api.createOrganization({
    body: {
      name: LOCAL_ORG_NAME,
      slug: LOCAL_ORG_SLUG,
      userId,
    },
  });

  return true;
}

/**
 * Get the local admin user, if it exists.
 * Used by the auto-login middleware.
 */
export async function getLocalAdminUser() {
  const database = getDb();
  return database.db
    .selectFrom("user")
    .where("email", "=", LOCAL_ADMIN_EMAIL)
    .selectAll()
    .executeTakeFirst();
}

export function isLocalMode(): boolean {
  return process.env.MESH_LOCAL_MODE === "true";
}
