#!/usr/bin/env bun
/**
 * Development environment setup script.
 *
 * Mirrors the CLI (src/cli.ts) behaviour so that `bun dev` and
 * `bunx @decocms/mesh` share the same ~/deco data directory, secrets,
 * and local-mode defaults.
 *
 * After setting up the environment it spawns the regular dev pipeline:
 *   bun run migrate && concurrently "bun run dev:client" "bun run dev:server"
 */

import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { createInterface } from "readline";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";

// ============================================================================
// Resolve MESH_HOME
// ============================================================================

// When MESH_HOME is explicitly set, respect it (CI, tests, custom setups).
// Otherwise default to ~/deco for interactive dev.
const meshAppDir = import.meta.dir.replace("/scripts", "");
const explicitHome = process.env.MESH_HOME;
const userHome = join(homedir(), "deco");
// In CI / non-TTY without explicit MESH_HOME, use a repo-local directory
// so tests never touch the developer's real ~/deco data.
const ciHome = join(meshAppDir, ".mesh-dev");

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";
const green = "\x1b[32m";

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

if (explicitHome) {
  // Explicit MESH_HOME takes priority (CI, tests, custom setups)
  meshHome = explicitHome;
} else if (!process.stdin.isTTY) {
  // Non-interactive (CI) — use repo-local directory to avoid touching ~/deco
  meshHome = ciHome;
} else if (existsSync(userHome)) {
  // Interactive with existing ~/deco — use it
  meshHome = userHome;
} else {
  // Interactive, first run — prompt for location
  const displayDefault = userHome.replace(homedir(), "~");
  console.log("");
  console.log(`${bold}${cyan}MCP Mesh${reset} ${dim}(dev)${reset}`);
  console.log("");
  const answer = await prompt(
    `  Where should Mesh store its data? ${dim}(${displayDefault})${reset} `,
  );
  if (answer === "") {
    meshHome = userHome;
  } else {
    meshHome = answer.startsWith("~")
      ? join(homedir(), answer.slice(1))
      : answer;
  }
}

// ============================================================================
// Secrets management (same logic as src/cli.ts)
// ============================================================================

await mkdir(meshHome, { recursive: true, mode: 0o700 });

const secretsFilePath = join(meshHome, "secrets.json");

interface SecretsFile {
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_KEY?: string;
}

let savedSecrets: SecretsFile = {};
try {
  const file = Bun.file(secretsFilePath);
  if (await file.exists()) {
    savedSecrets = await file.json();
  }
} catch {
  // File doesn't exist or is invalid — will create new secrets
}

let secretsModified = false;

if (!process.env.BETTER_AUTH_SECRET) {
  if (savedSecrets.BETTER_AUTH_SECRET) {
    process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
  } else {
    savedSecrets.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
    secretsModified = true;
  }
}

if (!process.env.ENCRYPTION_KEY) {
  if (savedSecrets.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
  } else {
    savedSecrets.ENCRYPTION_KEY = "";
    process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
    secretsModified = true;
  }
}

if (secretsModified) {
  try {
    await Bun.write(secretsFilePath, JSON.stringify(savedSecrets, null, 2));
  } catch (error) {
    console.warn(
      `${yellow}Warning: Could not save secrets file: ${error}${reset}`,
    );
  }
}

// ============================================================================
// Set environment variables
// ============================================================================

process.env.MESH_HOME = meshHome;
process.env.DATABASE_URL = `file:${join(meshHome, "mesh.db")}`;
process.env.MESH_LOCAL_MODE = "true";

// ============================================================================
// Banner
// ============================================================================

const displayHome = meshHome.replace(homedir(), "~");

console.log("");
console.log(`${bold}${cyan}MCP Mesh${reset} ${dim}(dev)${reset}`);
console.log("");
console.log(
  `${bold}  Mode:     ${green}Local${reset}${bold} (auto-login enabled)${reset}`,
);
console.log(`${bold}  Home:     ${dim}${displayHome}/${reset}`);
console.log(`${bold}  Database: ${dim}${displayHome}/mesh.db${reset}`);
console.log("");

// ============================================================================
// Spawn the dev pipeline
// ============================================================================

const child = spawn(
  "bun",
  [
    "run",
    "migrate",
    "&&",
    "concurrently",
    '"bun run dev:client"',
    '"bun run dev:server"',
  ],
  {
    stdio: "inherit",
    shell: true,
    env: process.env,
    cwd: meshAppDir,
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
