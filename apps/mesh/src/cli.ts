#!/usr/bin/env bun
/**
 * MCP Mesh CLI Entry Point
 *
 * This script serves as the bin entry point for bunx @decocms/mesh
 * It runs database migrations and starts the production server.
 *
 * Usage:
 *   bunx @decocms/mesh
 *   bunx @decocms/mesh --port 8080
 *   bunx @decocms/mesh --help
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT || "3000",
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
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
MCP Mesh - Self-hostable MCP Server

Usage:
  bunx @decocms/mesh [options]

Options:
  -p, --port <port>     Port to listen on (default: 3000, or PORT env var)
  -h, --help            Show this help message
  -v, --version         Show version
  --skip-migrations     Skip database migrations on startup

Environment Variables:
  PORT                  Port to listen on (default: 3000)
  DATABASE_URL          Database connection URL (default: file:./data/mesh.db)
  NODE_ENV              Set to 'production' for production mode
  BETTER_AUTH_SECRET    Secret for authentication (auto-generated if not set)
  ENCRYPTION_KEY        Key for encrypting secrets (auto-generated if not set)
  AUTH_CONFIG_PATH      Path to auth config file (default: ./auth-config.json)
  CONFIG_PATH           Path to full config file (default: ./config.json)

Examples:
  bunx @decocms/mesh                    # Start on port 3000
  bunx @decocms/mesh -p 8080            # Start on port 8080
  PORT=9000 bunx @decocms/mesh          # Start on port 9000

Documentation:
  https://github.com/decocms/mesh
`);
  process.exit(0);
}

if (values.version) {
  // Try to read version from package.json
  // When bundled, the path changes depending on context:
  // - During development: ../package.json (relative to src/)
  // - When published: ../../package.json (relative to dist/server/)
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

  console.log(`@decocms/mesh v${version}`);
  process.exit(0);
}

// Set PORT environment variable for the server
process.env.PORT = values.port;

// Ensure NODE_ENV defaults to production when running via CLI
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

// ANSI color codes
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";

// Path for storing auto-generated secrets (relative to cwd, alongside database)
const secretsFilePath = "./data/mesh-dev-only-secrets.json";

// Generate or load secrets if not provided via environment variables
// This allows users to try the app without setting up environment variables
// while still persisting sessions across restarts
const crypto = await import("crypto");
const { mkdir } = await import("fs/promises");

interface SecretsFile {
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_KEY?: string;
}

// Try to load existing secrets from file
let savedSecrets: SecretsFile = {};
try {
  const file = Bun.file(secretsFilePath);
  if (await file.exists()) {
    savedSecrets = await file.json();
  }
} catch {
  // File doesn't exist or is invalid, will create new secrets
}

// Track which secrets are from file vs env (independently)
let betterAuthFromFile = false;
let encryptionKeyFromFile = false;
let secretsModified = false;

if (!process.env.BETTER_AUTH_SECRET) {
  if (savedSecrets.BETTER_AUTH_SECRET) {
    process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
  } else {
    savedSecrets.BETTER_AUTH_SECRET = crypto.randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
    secretsModified = true;
  }
  betterAuthFromFile = true;
}

if (!process.env.ENCRYPTION_KEY) {
  if (savedSecrets.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
  } else {
    savedSecrets.ENCRYPTION_KEY = "";
    process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
    secretsModified = true;
  }
  encryptionKeyFromFile = true;
}

// Save secrets to file if we generated new ones
if (secretsModified) {
  try {
    // Ensure data directory exists
    await mkdir("./data", { recursive: true });
    await Bun.write(secretsFilePath, JSON.stringify(savedSecrets, null, 2));
  } catch (error) {
    console.warn(`${yellow}⚠️  Could not save secrets file: ${error}${reset}`);
  }
}

console.log("");
console.log(`${bold}${cyan}MCP Mesh${reset}`);
console.log(`${dim}Self-hostable MCP Server${reset}`);

// Only show warning for secrets that are actually from file
if (betterAuthFromFile || encryptionKeyFromFile) {
  console.log("");
  console.log(
    `${yellow}⚠️  Using generated dev-only secrets from: ${secretsFilePath}${reset}`,
  );
  console.log(
    `${dim}   For production, set these environment variables:${reset}`,
  );
  if (betterAuthFromFile) {
    console.log(
      `${dim}   BETTER_AUTH_SECRET=$(openssl rand -base64 32)${reset}`,
    );
  }
  if (encryptionKeyFromFile) {
    console.log(`${dim}   ENCRYPTION_KEY=$(openssl rand -hex 32)${reset}`);
  }
}

console.log("");

// Run migrations unless skipped
if (!values["skip-migrations"]) {
  console.log(`${dim}Running database migrations...${reset}`);
  try {
    const { migrateToLatest } = await import("./database/migrate");
    // Keep database connection open since server will use it
    await migrateToLatest({ keepOpen: true });
    console.log(`${dim}Migrations complete.${reset}`);
    console.log("");
  } catch (error) {
    console.error("Failed to run migrations:", error);
    process.exit(1);
  }
}

// Import and start the server
// We import dynamically to ensure migrations run first
await import("./index");
