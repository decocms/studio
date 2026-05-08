/**
 * Public Configuration Routes
 *
 * Provides public (no-auth) configuration endpoints for UI customization.
 * These are fetched by the client before authentication.
 */

import { Hono } from "hono";
import { getConfig, getThemeConfig, type ThemeConfig } from "@/core/config";
import { isLocalMode } from "@/auth/local-mode";
import { getInternalUrl } from "@/core/server-constants";
import { getSettings } from "@/settings";
import { buildAuthConfig, type AuthConfig } from "@/api/routes/auth";

const app = new Hono();

/**
 * Public configuration exposed to the UI
 */
export type PublicConfig = {
  /**
   * Theme customization for light and dark modes.
   * Contains CSS variable overrides that will be injected into the document.
   */
  theme?: ThemeConfig;
  /**
   * Product logo shown in the sidebar.
   * Can be a single URL or per-mode { light, dark } URLs.
   */
  logo?: string | { light: string; dark: string };
  /**
   * The server's internal URL (localhost:PORT).
   * Used as the OAuth redirect origin when the browser is behind a proxy
   * (e.g. tokyo.localhost) that external OAuth servers may not accept.
   */
  internalUrl?: string;
  /**
   * Whether the deco.cx import feature is enabled.
   * Controlled by the ENABLE_DECO_IMPORT environment variable.
   */
  enableDecoImport?: boolean;
  /**
   * Whether brand context auto-extraction is available.
   * Requires FIRECRAWL_API_KEY to be configured.
   */
  brandExtractEnabled?: boolean;
  /**
   * Authentication methods available on this deployment.
   * Replaces the previous /api/auth/custom/config endpoint.
   */
  auth: AuthConfig;
  /**
   * PostHog frontend config. `null` when POSTHOG_KEY is unset so the
   * client can disable analytics cleanly without checking for `undefined`.
   */
  posthog: { key: string; host: string } | null;
};

const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

function buildPosthogConfig(): PublicConfig["posthog"] {
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  return {
    key,
    host: process.env.POSTHOG_HOST ?? POSTHOG_DEFAULT_HOST,
  };
}

/**
 * Public Configuration Endpoint
 *
 * Returns UI customization settings, auth methods, and analytics config.
 * No authentication required — fetched by the SPA on boot.
 *
 * Route: GET /api/config
 */
app.get("/", (c) => {
  const config: PublicConfig = {
    theme: getThemeConfig(),
    ...(getConfig().logo && { logo: getConfig().logo }),
    // Only expose internalUrl in local mode — production uses the public URL directly
    ...(isLocalMode() && { internalUrl: getInternalUrl() }),
    ...(getSettings().enableDecoImport && { enableDecoImport: true }),
    brandExtractEnabled: !!getSettings().firecrawlApiKey,
    auth: buildAuthConfig(),
    posthog: buildPosthogConfig(),
  };

  return c.json({ success: true, config });
});

export default app;
