#!/usr/bin/env bun
/**
 * Deco Studio CLI Entry Point
 *
 * This script serves as the bin entry point for `deco` / `npx decocms`.
 * It runs database migrations, seeds the local environment, and starts the server.
 *
 * Usage:
 *   deco
 *   npx decocms --port 8080
 *   npx decocms --home ~/my-project
 *   npx decocms --local-mode
 */

import { parseArgs } from "util";
import { homedir } from "os";
import { join } from "path";

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
    "local-mode": {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
Deco Studio — Open-source control plane for your AI agents

Usage:
  deco [options]

Options:
  -p, --port <port>     Port to listen on (default: 3000, or PORT env var)
  --home <path>         Data directory (default: ~/deco/, or DATA_DIR env var)
  --local-mode          Enable local mode (auto-login, no auth required)
  -h, --help            Show this help message
  -v, --version         Show version
  --skip-migrations     Skip database migrations on startup

Environment Variables:
  PORT                  Port to listen on (default: 3000)
  DATA_DIR              Data directory (default: ~/deco/)
  DATABASE_URL          Database connection URL (default: file://$HOME/deco/db.pglite)
  NODE_ENV              Set to 'production' for production mode
  BETTER_AUTH_SECRET    Secret for authentication (auto-generated if not set)
  ENCRYPTION_KEY        Key for encrypting secrets (auto-generated if not set)
  AUTH_CONFIG_PATH      Path to auth config file (default: ./auth-config.json)
  CONFIG_PATH           Path to full config file (default: ./config.json)

Examples:
  deco                            # Start with defaults (~/deco/)
  deco -p 8080                    # Start on port 8080
  deco --home ~/my-project        # Custom data directory
  deco --local-mode               # Enable auto-login (local dev)

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
// Resolve data directory
// ============================================================================

const decoHome =
  values.home ||
  process.env.DATA_DIR ||
  process.env.DECOCMS_HOME ||
  join(homedir(), "deco");
process.env.DECOCMS_HOME = decoHome;
process.env.DATA_DIR = decoHome;
process.env.PORT = values.port;

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

// Determine if local mode should be active (opt-in only)
const localMode = values["local-mode"] === true;
process.env.MESH_LOCAL_MODE = localMode ? "true" : "false";

// CLI is the intended local runner — allow local mode even when NODE_ENV=production
if (localMode) {
  process.env.MESH_ALLOW_LOCAL_PROD = "true";
}

// ============================================================================
// Secrets (auto-generate on first run, persist to ~/deco/secrets.json)
// ============================================================================

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";

const crypto = await import("crypto");
const { chmod, mkdir, writeFile } = await import("fs/promises");

const secretsFilePath = join(decoHome, "secrets.json");
await mkdir(decoHome, { recursive: true, mode: 0o700 });

interface SecretsFile {
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_KEY?: string;
  LOCAL_ADMIN_PASSWORD?: string;
}

let savedSecrets: SecretsFile = {};
try {
  const file = Bun.file(secretsFilePath);
  if (await file.exists()) {
    savedSecrets = await file.json();
  }
} catch {
  // File doesn't exist or is invalid, will create new secrets
}

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

// Generate a per-install local admin password for auto-login
if (!savedSecrets.LOCAL_ADMIN_PASSWORD) {
  savedSecrets.LOCAL_ADMIN_PASSWORD = crypto.randomBytes(24).toString("base64");
  secretsModified = true;
}

if (secretsModified) {
  try {
    await writeFile(secretsFilePath, JSON.stringify(savedSecrets, null, 2), {
      mode: 0o600,
    });
    await chmod(secretsFilePath, 0o600);
  } catch (error) {
    console.warn(
      `${yellow}Warning: Could not save secrets file: ${error}${reset}`,
    );
  }
}

// ============================================================================
// Banner
// ============================================================================

const displayHome = decoHome.replace(homedir(), "~");

console.log("");
console.log(`${bold}${cyan}Deco Studio${reset}`);
console.log(`${dim}Open-source control plane for your AI agents${reset}`);
console.log("");

if (betterAuthFromFile || encryptionKeyFromFile) {
  console.log(
    `${dim}Using generated secrets from: ${displayHome}/secrets.json${reset}`,
  );
  console.log(
    `${dim}For production, set BETTER_AUTH_SECRET and ENCRYPTION_KEY env vars.${reset}`,
  );
  console.log("");
}

// ============================================================================
// Database migrations
// ============================================================================

// Auto-repair corrupted PGlite database before migrations
try {
  const { repairPGliteIfCorrupted } = await import("./database/repair");
  await repairPGliteIfCorrupted();
} catch (error) {
  console.error("PGlite repair failed:", error);
  process.exit(1);
}

if (!values["skip-migrations"]) {
  console.log(`${dim}Running database migrations...${reset}`);
  try {
    const { migrateToLatest } = await import("./database/migrate");
    await migrateToLatest({ keepOpen: true });
    console.log(`${dim}Migrations complete.${reset}`);
  } catch (error) {
    console.error("Failed to run migrations:", error);
    process.exit(1);
  }
}

console.log("");
console.log(
  `${bold}  Mode:       ${localMode ? `\x1b[32mLocal${reset}${bold} (auto-login enabled)` : "Standard (login required)"}${reset}`,
);
console.log("");

// ============================================================================
// Start server
// ============================================================================

await import("./index");
