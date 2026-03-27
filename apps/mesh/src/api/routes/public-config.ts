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
};

/**
 * Public Configuration Endpoint
 *
 * Returns UI customization settings that don't require authentication.
 * This includes theme overrides and other public settings.
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
  };

  return c.json({ success: true, config });
});

export default app;
