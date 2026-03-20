/**
 * Server startup logic extracted from cli.ts.
 *
 * Resolves secrets, starts services, runs migrations, and launches the server.
 * Reports progress via the CLI store so the Ink UI can update live.
 */
import crypto from "crypto";
import { chmod, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import {
  setEnv,
  setMigrationsDone,
  setServerUrl,
  updateService,
} from "../cli-store";
import type { ServiceStatus } from "../header";

export interface ServeOptions {
  port: string;
  home: string;
  skipMigrations: boolean;
  localMode: boolean;
}

export async function startServer(options: ServeOptions): Promise<void> {
  const { port, home, skipMigrations, localMode } = options;

  // Set env vars before any imports that read them
  process.env.DECOCMS_HOME = home;
  process.env.DATA_DIR = home;
  process.env.PORT = port;
  process.env.DECOCMS_LOCAL_MODE = localMode ? "true" : "false";

  if (localMode) {
    process.env.NODE_ENV = "production";
    process.env.DECOCMS_ALLOW_LOCAL_PROD = "true";
  } else if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "production";
  }

  // ── Secrets ──────────────────────────────────────────────────────────
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

  // ── Services ─────────────────────────────────────────────────────────
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

  // ── Migrations ───────────────────────────────────────────────────────
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

  // ── Env ──────────────────────────────────────────────────────────────
  const { env } = await import("../../env");
  setEnv(env);

  // ── Start server ─────────────────────────────────────────────────────
  process.env.DECO_CLI = "1";
  await import("../../index");

  setServerUrl(`http://localhost:${port}`);
}
