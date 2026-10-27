import { type AuthConfig, loadAuthConfig } from "@/auth/auth-env";
import type { ThemeConfig } from "@decocms/shared/config";
import { existsSync, readFileSync } from "fs";
import { getSettings } from "../settings";

// ── Types ────────────────────────────────────────────────────────────

export type { ThemeConfig } from "@decocms/shared/config";

export interface Config {
  auth: AuthConfig;
  theme?: ThemeConfig;
  logo?: string | { light: string; dark: string };
  autoCreateOrganizationOnSignup?: boolean;
}

// ── Loading ──────────────────────────────────────────────────────────

function loadConfig(): Config {
  const auth = loadAuthConfig();

  const configPath = getSettings().configPath;
  if (!existsSync(configPath)) {
    return { auth };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));

    if (raw.auth) {
      console.warn(
        "[config] DEPRECATION: 'auth' key found in config.json. " +
          "Auth is now configured via AUTH_* environment variables. " +
          "The 'auth' key will be ignored.",
      );
    }

    return {
      auth,
      theme: raw.theme,
      logo: raw.logo,
      autoCreateOrganizationOnSignup: raw.autoCreateOrganizationOnSignup,
    };
  } catch {
    return { auth };
  }
}

// ── Public API ───────────────────────────────────────────────────────

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function getThemeConfig(): ThemeConfig | undefined {
  return getConfig().theme;
}
