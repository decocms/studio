/**
 * Better Auth Migration Runner
 *
 * Runs Better Auth migrations programmatically without requiring the CLI.
 * This gets bundled with the application, avoiding the need for node_modules.
 *
 * IMPORTANT: Does NOT import auth/index.ts to avoid triggering the full
 * Better Auth initialization (which requires Settings to be initialized).
 * Instead, constructs minimal options needed for migration discovery.
 */

import { getMigrations } from "better-auth/db";
import { sso } from "@better-auth/sso";
import { organization } from "@decocms/better-auth/plugins";
import {
  admin as adminPlugin,
  apiKey,
  jwt,
  magicLink,
  mcp,
  openAPI,
} from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import { getDatabaseUrl, getDbDialect } from "../database";

/**
 * Run Better Auth migrations programmatically.
 *
 * Constructs minimal Better Auth options with just the plugins needed
 * to discover migration tables, without importing the full auth module
 * (which would trigger getSettings() at module load time).
 */
export async function migrateBetterAuth(databaseUrl?: string): Promise<string> {
  const freshDatabase = getDbDialect(databaseUrl || getDatabaseUrl());

  // Minimal options — only needs plugins to discover which tables to create.
  // Does not need auth config, rate limiting, hooks, etc.
  //
  // Plugin options that change which tables get created (e.g. organization's
  // dynamicAccessControl, which gates the organizationRole and
  // organizationResource tables) must mirror the real auth config in
  // ../auth/index.ts so the in-process migration matches the CLI migration.
  const options = {
    database: freshDatabase,
    plugins: [
      organization({
        dynamicAccessControl: { enabled: true, enableCustomResources: true },
      }),
      adminPlugin(),
      apiKey(),
      jwt(),
      openAPI(),
      mcp({ loginPage: "/login" }),
      sso(),
      magicLink({ sendMagicLink: async () => {} }),
      emailOTP({ sendVerificationOTP: async () => {} }),
    ],
  };

  const { toBeAdded, toBeCreated, runMigrations } =
    await getMigrations(options);

  if (!toBeAdded.length && !toBeCreated.length) {
    return "up to date";
  }

  await runMigrations();

  const count = toBeCreated.length + toBeAdded.length;
  return `${count} table(s) migrated`;
}
