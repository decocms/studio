/**
 * Public Configuration Routes
 *
 * Provides public (no-auth) configuration endpoints for UI customization.
 * These are fetched by the client before authentication.
 */

import { Hono } from "hono";
import { getThemeConfig, type ThemeConfig } from "@/core/config";

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
  };

  return c.json({ success: true, config });
});

export default app;
