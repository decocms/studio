/**
 * Dev mode startup logic.
 *
 * Loads .env, starts services, runs migrations, and spawns dev servers.
 * Reports progress via the CLI store so the Ink UI can update live.
 */
import crypto from "crypto";
import { readFileSync } from "fs";
import { chmod, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { Subprocess } from "bun";
import {
  setEnv,
  setMigrationsDone,
  setServerUrl,
  updateService,
} from "../cli-store";
import type { ServiceStatus } from "../header";

export interface DevOptions {
  port: string;
  vitePort: string;
  home: string;
  baseUrl?: string;
  skipMigrations: boolean;
  envFile?: string;
}

function loadDotEnv(path: string): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function startDevServer(
  options: DevOptions,
): Promise<{ port: number; process: Subprocess }> {
  const { port, vitePort, home, baseUrl, skipMigrations, envFile } = options;

  // ── .env loading ────────────────────────────────────────────────────
  if (envFile) {
    const dotEnv = loadDotEnv(envFile);
    for (const [key, value] of Object.entries(dotEnv)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }

  // ── Environment ─────────────────────────────────────────────────────
  process.env.DECOCMS_HOME = home;
  process.env.DATA_DIR = home;
  process.env.PORT = port;
  process.env.VITE_PORT = vitePort;
  process.env.NODE_ENV = "development";
  process.env.DECO_CLI = "1";

  if (baseUrl) {
    process.env.BASE_URL = baseUrl;
  }

  // ── Secrets ─────────────────────────────────────────────────────────
  const secretsFilePath = join(home, "secrets.json");
  await mkdir(home, { recursive: true, mode: 0o700 });

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
    // File doesn't exist or is invalid
  }

  let secretsModified = false;

  if (!process.env.BETTER_AUTH_SECRET) {
    if (savedSecrets.BETTER_AUTH_SECRET) {
      process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
    } else {
      savedSecrets.BETTER_AUTH_SECRET = crypto
        .randomBytes(32)
        .toString("base64");
      process.env.BETTER_AUTH_SECRET = savedSecrets.BETTER_AUTH_SECRET;
      secretsModified = true;
    }
  }

  if (!process.env.ENCRYPTION_KEY) {
    if (savedSecrets.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
    } else {
      savedSecrets.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
      process.env.ENCRYPTION_KEY = savedSecrets.ENCRYPTION_KEY;
      secretsModified = true;
    }
  }

  if (!savedSecrets.LOCAL_ADMIN_PASSWORD) {
    savedSecrets.LOCAL_ADMIN_PASSWORD = crypto
      .randomBytes(24)
      .toString("base64");
    secretsModified = true;
  }

  if (secretsModified) {
    try {
      await writeFile(secretsFilePath, JSON.stringify(savedSecrets, null, 2), {
        mode: 0o600,
      });
      await chmod(secretsFilePath, 0o600);
    } catch {
      // Non-fatal — continue
    }
  }

  // ── Services ──────────────────────────────────────────────────────
  const { ensureServices } = await import("../../services/ensure-services");
  const services = await ensureServices(home);

  for (const s of services) {
    const svc: ServiceStatus = {
      name: s.name === "PostgreSQL" ? "Postgres" : s.name,
      status: "ready",
      port: s.port,
    };
    updateService(svc);
  }

  // ── Migrations ────────────────────────────────────────────────────
  if (!skipMigrations) {
    try {
      const { migrateToLatest } = await import("../../database/migrate");
      await migrateToLatest({ keepOpen: true });
    } catch (error) {
      console.error("Failed to run migrations:", error);
      process.exit(1);
    }
  }
  setMigrationsDone();

  // ── Env ───────────────────────────────────────────────────────────
  const { env } = await import("../../env");
  setEnv(env);

  // ── Spawn dev servers ─────────────────────────────────────────────
  // import.meta.dir = apps/mesh/src/cli/commands → go up 5 levels to repo root
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const serverUrl = baseUrl || `http://localhost:${port}`;
  setServerUrl(serverUrl);

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  return { port: Number(port), process: child };
}
