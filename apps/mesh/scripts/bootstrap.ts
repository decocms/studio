/**
 * Shared bootstrap utilities for CLI and dev scripts.
 *
 * Extracted to avoid duplication between src/cli.ts and scripts/dev.ts.
 * Both entry points resolve MESH_HOME, manage secrets, and print banners
 * using these shared functions.
 */

import { existsSync } from "fs";
import { chmod, mkdir } from "fs/promises";
import { createInterface } from "readline";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// ============================================================================
// ANSI color codes
// ============================================================================

export const ansi = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
} as const;

// ============================================================================
// Interactive prompt
// ============================================================================

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// Tilde expansion
// ============================================================================

/**
 * Expand ~ and ~/path to the user's home directory.
 * Does NOT expand ~user (returns as-is).
 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// ============================================================================
// Secrets management
// ============================================================================

export interface SecretsFile {
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_KEY?: string;
  LOCAL_ADMIN_PASSWORD?: string;
}

export interface SecretsResult {
  secrets: SecretsFile;
  betterAuthFromFile: boolean;
  encryptionKeyFromFile: boolean;
}

/**
 * Load or generate secrets (BETTER_AUTH_SECRET, ENCRYPTION_KEY).
 * Persists new secrets to MESH_HOME/secrets.json with 0600 permissions.
 * Sets the corresponding environment variables.
 */
export async function loadOrCreateSecrets(
  meshHome: string,
): Promise<SecretsResult> {
  const secretsFilePath = join(meshHome, "secrets.json");

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

  let betterAuthFromFile = false;
  let encryptionKeyFromFile = false;
  let secretsModified = false;

  if (!process.env.BETTER_AUTH_SECRET) {
    if (savedSecrets.BETTER_AUTH_SECRET) {
      process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
    } else {
      savedSecrets.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
      process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
      secretsModified = true;
    }
    betterAuthFromFile = true;
  }

  if (!process.env.ENCRYPTION_KEY) {
    if (savedSecrets.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
    } else {
      savedSecrets.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
      secretsModified = true;
    }
    encryptionKeyFromFile = true;
  }

  // Generate a per-install local admin password if not already in secrets
  if (!savedSecrets.LOCAL_ADMIN_PASSWORD) {
    savedSecrets.LOCAL_ADMIN_PASSWORD = randomBytes(24).toString("base64");
    secretsModified = true;
  }

  // Save secrets to file if we generated new ones
  if (secretsModified) {
    try {
      await Bun.write(secretsFilePath, JSON.stringify(savedSecrets, null, 2));
      await chmod(secretsFilePath, 0o600);
    } catch (error) {
      console.warn(
        `${ansi.yellow}Warning: Could not save secrets file: ${error}${ansi.reset}`,
      );
    }
  }

  return { secrets: savedSecrets, betterAuthFromFile, encryptionKeyFromFile };
}

// ============================================================================
// MESH_HOME resolution
// ============================================================================

export interface ResolveMeshHomeOptions {
  /** Explicitly provided path (e.g. --home flag or MESH_HOME env var) */
  explicit?: string;
  /** Default path (usually ~/deco) */
  defaultPath: string;
  /** Fallback for non-interactive environments (CI) — if not provided, uses defaultPath */
  ciFallback?: string;
  /** Banner text for the first-run prompt */
  banner: string;
}

/**
 * Resolve MESH_HOME: uses explicit path, prompts on first run, or uses default.
 */
export async function resolveMeshHome(
  opts: ResolveMeshHomeOptions,
): Promise<string> {
  if (opts.explicit) {
    return expandTilde(opts.explicit);
  }

  // Non-interactive (CI) — always use the CI-safe path so we never
  // accidentally touch the developer's real ~/deco data on shared runners.
  if (!process.stdin.isTTY) {
    return opts.ciFallback ?? opts.defaultPath;
  }

  if (existsSync(opts.defaultPath)) {
    return opts.defaultPath;
  }

  // First run — prompt the user
  const displayDefault = opts.defaultPath.replace(homedir(), "~");
  console.log("");
  console.log(opts.banner);
  console.log("");
  const answer = await prompt(
    `  Where should Deco store its data? ${ansi.dim}(${displayDefault})${ansi.reset} `,
  );

  if (answer === "") return opts.defaultPath;
  return expandTilde(answer);
}

// ============================================================================
// Startup banner
// ============================================================================

export interface BannerOptions {
  meshHome: string;
  localMode: boolean;
  port?: string;
  baseUrl?: string;
  showSecretHint?: boolean;
  showAssets?: boolean;
  label?: string;
}

export function printBanner(opts: BannerOptions): void {
  const { dim, reset, bold, cyan } = ansi;
  const displayHome = opts.meshHome.replace(homedir(), "~");
  const label = opts.label ?? "Deco Studio";

  console.log("");
  console.log(`${bold}${cyan}${label}${reset}`);
  console.log(`${dim}Open-source control plane for your AI agents${reset}`);
  console.log("");

  if (opts.showSecretHint) {
    console.log(
      `${dim}Using generated secrets from: ${displayHome}/secrets.json${reset}`,
    );
    console.log(
      `${dim}For production, set BETTER_AUTH_SECRET and ENCRYPTION_KEY env vars.${reset}`,
    );
    console.log("");
  }
}

export function printStatus(opts: BannerOptions): void {
  const { dim, reset, bold, green } = ansi;
  const displayHome = opts.meshHome.replace(homedir(), "~");

  console.log("");
  console.log(
    `${bold}  Mode:     ${opts.localMode ? `${green}Local${reset}${bold} (auto-login enabled)` : "Standard (login required)"}${reset}`,
  );
  console.log(`${bold}  Home:     ${dim}${displayHome}/${reset}`);
  console.log(`${bold}  Database: ${dim}${displayHome}/mesh.db${reset}`);
  if (opts.showAssets && opts.localMode) {
    console.log(`${bold}  Assets:   ${dim}${displayHome}/assets/${reset}`);
  }
  const url =
    opts.baseUrl ||
    `http://localhost:${opts.port || process.env.PORT || "3000"}`;
  console.log(`${bold}  URL:      ${dim}${url}${reset}`);
  console.log("");
}
