#!/usr/bin/env bun
/**
 * Deco Studio CLI Entry Point
 *
 * This script serves as the bin entry point for `deco` / `bunx decocms`.
 * It runs database migrations, seeds the local environment, and starts the server.
 *
 * Usage:
 *   deco
 *   decocms --port 8080
 *   decocms --home ~/my-mesh
 *   decocms --no-local-mode
 *   decocms --help
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  ansi,
  loadOrCreateSecrets,
  resolveMeshHome,
  printBanner,
  printStatus,
} from "../scripts/bootstrap";

const defaultHome = process.env.MESH_HOME || join(homedir(), "deco");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT || "3000",
    },
    home: {
      type: "string",
    },
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
    version: {
      type: "boolean",
      short: "v",
      default: false,
    },
    "skip-migrations": {
      type: "boolean",
      default: false,
    },
    "no-local-mode": {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Deco Studio - Open-source control plane for your AI agents

Usage:
  deco [options]

Options:
  -p, --port <port>     Port to listen on (default: 3000, or PORT env var)
  --home <path>         Data directory (default: ~/deco/, or MESH_HOME env var)
  --no-local-mode       Disable local mode (require login, no auto-setup)
  -h, --help            Show this help message
  -v, --version         Show version
  --skip-migrations     Skip database migrations on startup

Environment Variables:
  PORT                  Port to listen on (default: 3000)
  MESH_HOME             Data directory (default: ~/deco/)
  DATABASE_URL          Database connection URL (default: MESH_HOME/mesh.db)
  NODE_ENV              Set to 'production' for production mode
  BETTER_AUTH_SECRET    Secret for authentication (auto-generated if not set)
  ENCRYPTION_KEY        Key for encrypting secrets (auto-generated if not set)
  AUTH_CONFIG_PATH      Path to auth config file (default: ./auth-config.json)
  CONFIG_PATH           Path to full config file (default: ./config.json)

Examples:
  deco                            # Start with defaults (~/deco/)
  deco -p 8080                    # Start on port 8080
  deco --home ~/my-project        # Custom data directory
  deco --no-local-mode            # Require login (SaaS mode)

Documentation:
  https://decocms.com/studio
`);
  process.exit(0);
}

if (values.version) {
  const possiblePaths = [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];

  let version = "unknown";
  for (const path of possiblePaths) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const packageJson = await file.json();
        version = packageJson.version;
        break;
      }
    } catch {
      // Try next path
    }
  }

  console.log(`Deco Studio v${version}`);
  process.exit(0);
}

// ============================================================================
// Setup environment
// ============================================================================

process.env.PORT = values.port;

// ============================================================================
// Resolve MESH_HOME
// ============================================================================

const meshHome = await resolveMeshHome({
  explicit: values.home || process.env.MESH_HOME,
  defaultPath: defaultHome,
  banner: `${ansi.bold}${ansi.cyan}Deco Studio${ansi.reset}`,
});

process.env.MESH_HOME = meshHome;

// Default DATABASE_URL to MESH_HOME/mesh.db if not explicitly set.
// Respects user-provided DATABASE_URL (e.g. PostgreSQL connection strings).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${join(meshHome, "mesh.db")}`;
}

// Ensure NODE_ENV defaults to production when running via CLI
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

// Determine if local mode should be active
// Local mode is on by default unless:
// - --no-local-mode flag is passed
// - A custom auth config with social providers / SSO is detected
const hasCustomAuthConfig =
  process.env.AUTH_CONFIG_PATH &&
  process.env.AUTH_CONFIG_PATH !== "./auth-config.json";
const localMode = !values["no-local-mode"] && !hasCustomAuthConfig;
process.env.MESH_LOCAL_MODE = localMode ? "true" : "false";

// CLI is the intended local runner — allow local mode even when NODE_ENV=production
if (localMode) {
  process.env.MESH_ALLOW_LOCAL_PROD = "true";
}

// ============================================================================
// First-time setup (auto-run if secrets don't exist yet)
// ============================================================================

const isFirstRun = !existsSync(join(meshHome, "secrets.json"));
if (isFirstRun) {
  console.log(`${ansi.dim}First run detected — running setup...${ansi.reset}`);
}

const { betterAuthFromFile, encryptionKeyFromFile } =
  await loadOrCreateSecrets(meshHome);

if (isFirstRun) {
  const displayHome = meshHome.replace((await import("os")).homedir(), "~");
  console.log(
    `${ansi.dim}Created secrets at ${displayHome}/secrets.json${ansi.reset}`,
  );
}

// ============================================================================
// Startup banner
// ============================================================================

printBanner({
  meshHome,
  localMode,
  showSecretHint: betterAuthFromFile || encryptionKeyFromFile,
});

// ============================================================================
// Database migrations
// ============================================================================

if (!values["skip-migrations"]) {
  console.log(`${ansi.dim}Running database migrations...${ansi.reset}`);
  try {
    const { migrateToLatest } = await import("./database/migrate");
    await migrateToLatest({ keepOpen: true });
    console.log(`${ansi.dim}Migrations complete.${ansi.reset}`);
  } catch (error) {
    console.error("Failed to run migrations:", error);
    process.exit(1);
  }
}

// ============================================================================
// Print final status and start server
// ============================================================================

printStatus({
  meshHome,
  localMode,
  port: values.port,
  showAssets: true,
});

// Import and start the server
await import("./index");
