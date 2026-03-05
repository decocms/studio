#!/usr/bin/env bun
/**
 * MCP Mesh CLI Entry Point
 *
 * This script serves as the bin entry point for bunx @decocms/mesh
 * It runs database migrations, seeds the local environment, and starts the server.
 *
 * Usage:
 *   bunx @decocms/mesh
 *   bunx @decocms/mesh --port 8080
 *   bunx @decocms/mesh --home ~/my-mesh
 *   bunx @decocms/mesh --no-local-mode
 *   bunx @decocms/mesh --help
 */

import { parseArgs } from "util";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { createInterface } from "readline";

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
MCP Mesh - Self-hostable MCP Server

Usage:
  bunx @decocms/mesh [options]

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
  bunx @decocms/mesh                          # Start with defaults (~/deco/)
  bunx @decocms/mesh -p 8080                  # Start on port 8080
  bunx @decocms/mesh --home ~/my-project      # Custom data directory
  bunx @decocms/mesh --no-local-mode          # Require login (SaaS mode)

Documentation:
  https://github.com/decocms/mesh
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

  console.log(`@decocms/mesh v${version}`);
  process.exit(0);
}

// ============================================================================
// Setup environment
// ============================================================================

// Set PORT environment variable for the server
process.env.PORT = values.port;

// ANSI color codes (needed early for the prompt)
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";
const green = "\x1b[32m";

// ============================================================================
// Resolve MESH_HOME — prompt on first run if using default
// ============================================================================

/**
 * Prompt the user for input via readline.
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

let meshHome: string;

if (values.home) {
  // Explicitly passed via --home flag — expand ~ to home directory
  meshHome = values.home.startsWith("~")
    ? join(homedir(), values.home.slice(1))
    : values.home;
} else if (existsSync(defaultHome)) {
  // Default directory already exists (not first run)
  meshHome = defaultHome;
} else if (!process.stdin.isTTY) {
  // Non-interactive (Docker, CI, systemd) — use default without prompting
  meshHome = defaultHome;
} else {
  // First run with default path — ask the user
  const displayDefault = defaultHome.replace(homedir(), "~");
  console.log("");
  console.log(`${bold}${cyan}MCP Mesh${reset}`);
  console.log("");
  const answer = await prompt(
    `  Where should Mesh store its data? ${dim}(${displayDefault})${reset} `,
  );
  if (answer === "") {
    meshHome = defaultHome;
  } else {
    // Expand ~ to home directory (only bare ~ or ~/path, not ~user)
    meshHome =
      answer === "~"
        ? homedir()
        : answer.startsWith("~/")
          ? join(homedir(), answer.slice(2))
          : answer;
  }
}

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

// ============================================================================
// Secrets management
// ============================================================================

const secretsFilePath = join(meshHome, "secrets.json");

const crypto = await import("crypto");
const { mkdir, chmod } = await import("fs/promises");

interface SecretsFile {
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_KEY?: string;
}

// Ensure MESH_HOME directory exists
await mkdir(meshHome, { recursive: true, mode: 0o700 });

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
    savedSecrets.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
    secretsModified = true;
  }
  encryptionKeyFromFile = true;
}

// Save secrets to file if we generated new ones
if (secretsModified) {
  try {
    await Bun.write(secretsFilePath, JSON.stringify(savedSecrets, null, 2));
    await chmod(secretsFilePath, 0o600);
  } catch (error) {
    console.warn(
      `${yellow}Warning: Could not save secrets file: ${error}${reset}`,
    );
  }
}

// ============================================================================
// Startup banner
// ============================================================================

const displayHome = meshHome.replace(homedir(), "~");

console.log("");
console.log(`${bold}${cyan}MCP Mesh${reset}`);
console.log(`${dim}Self-hostable MCP Server${reset}`);
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
// Build frontend if needed (when running from source)
// ============================================================================

{
  const scriptDir = new URL(".", import.meta.url).pathname;
  const clientDistDir = join(scriptDir, "../dist/client");
  const clientIndexPath = join(clientDistDir, "index.html");

  if (!existsSync(clientIndexPath)) {
    console.log(`${dim}Building frontend (first run)...${reset}`);
    const { execSync } = await import("child_process");
    // Resolve apps/mesh directory — works whether running from src/ or dist/server/
    const meshAppDir = existsSync(join(scriptDir, "../vite.config.ts"))
      ? join(scriptDir, "..")
      : existsSync(join(scriptDir, "../../vite.config.ts"))
        ? join(scriptDir, "../..")
        : null;

    if (meshAppDir) {
      try {
        execSync("bun --bun vite build", {
          cwd: meshAppDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        console.log(`${dim}Frontend build complete.${reset}`);
      } catch (error) {
        console.warn(
          `${yellow}Warning: Could not build frontend. UI may not be available.${reset}`,
        );
      }
    }
  }
}

// ============================================================================
// Database migrations
// ============================================================================

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

// ============================================================================
// Print final status and start server
// ============================================================================

const port = values.port;
console.log("");
console.log(
  `${bold}  Mode:     ${localMode ? `${green}Local${reset}${bold} (auto-login enabled)` : "Standard (login required)"}${reset}`,
);
console.log(`${bold}  Home:     ${dim}${displayHome}/${reset}`);
console.log(`${bold}  Database: ${dim}${displayHome}/mesh.db${reset}`);
if (localMode) {
  console.log(`${bold}  Assets:   ${dim}${displayHome}/assets/${reset}`);
}
console.log(
  `${bold}  URL:      ${dim}${process.env.BASE_URL || `http://localhost:${port}`}${reset}`,
);
console.log("");

// Import and start the server
await import("./index");
