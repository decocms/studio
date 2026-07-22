/**
 * Settings accessor for Studio.
 *
 * getSettings() returns the frozen Settings object constructed by the
 * startup pipeline. Throws if called before buildSettings() completes.
 *
 * When running as a child process (e.g., dev:server), settings are
 * auto-initialized from process.env on first access.
 */

import { resolveConfig } from "./resolve-config";
import type { Settings } from "./types";

let _settings: Settings | null = null;

export function setGlobalSettings(s: Settings): void {
  _settings = Object.freeze(s);
}

export function getSettings(): Settings {
  if (!_settings) {
    // Auto-initialize from process.env when running as a child process
    // (e.g., dev:server spawned by the CLI — parent already resolved everything
    // and passed settings as env vars).
    initSettingsFromEnv();
  }
  return _settings!;
}

/**
 * Initialize settings directly from process.env.
 *
 * Used by child processes (dev:server) and the bundled production server
 * that receive env vars set externally. No service startup or migrations.
 */
function initSettingsFromEnv(): void {
  if (_settings) return;

  const envVars: Record<string, string | undefined> = { ...process.env };

  const config = resolveConfig(
    {
      port: envVars.PORT || "3000",
      home: envVars.DATA_DIR || envVars.DECOCMS_HOME || "",
      localMode: envVars.DECOCMS_LOCAL_MODE === "true",
      skipMigrations: true,
      noTui: envVars.DECO_NO_TUI === "true",
      vitePort: envVars.VITE_PORT,
      baseUrl: envVars.BASE_URL,
    },
    envVars,
  );

  _settings = Object.freeze({
    ...config.settings,
    databaseUrl:
      envVars.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/postgres",
    natsUrls: (envVars.NATS_URL || "nats://localhost:4222")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
  });
}

export type {
  Settings,
  CliFlags,
  ServiceInputs,
  ServiceOutputs,
} from "./types";
