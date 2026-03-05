/**
 * Public Configuration Routes
 *
 * Provides public (no-auth) configuration endpoints for UI customization.
 * These are fetched by the client before authentication.
 */

import { Hono } from "hono";
import { getThemeConfig, type ThemeConfig } from "@/core/config";
import { getInternalUrl } from "@/core/server-constants";

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
   * The server's internal URL (localhost:PORT).
   * Used as the OAuth redirect origin when the browser is behind a proxy
   * (e.g. tokyo.localhost) that external OAuth servers may not accept.
   */
  internalUrl?: string;
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
    internalUrl: getInternalUrl(),
  };

  return c.json({ success: true, config });
});

export default app;
