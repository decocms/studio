/**
 * Public Configuration Routes
 *
 * Provides public (no-auth) configuration endpoints for UI customization.
 * These are fetched by the client before authentication.
 */

import { Hono } from "hono";
import type { PublicConfig } from "@decocms/shared/config";
import { getConfig, getThemeConfig } from "@/core/config";
import { isLocalMode } from "@/auth/local-mode";
import { getInternalUrl } from "@/core/server-constants";
import { getSettings } from "@/settings";
import { buildAuthConfig } from "@/api/routes/auth";
import pkg from "../../../package.json" with { type: "json" };

const app = new Hono();

/**
 * Public configuration exposed to the UI
 */
export type { PublicConfig } from "@decocms/shared/config";

// First-party reverse proxy (Cloudflare Worker, repo decocms/posthog-proxy) so
// ad blockers don't drop browser events. Server-side posthog-node (src/posthog.ts)
// is unaffected and keeps talking to PostHog directly. POSTHOG_HOST still overrides.
const POSTHOG_DEFAULT_HOST = "https://ph.studio.decocms.com";

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
    version: pkg.version,
    theme: getThemeConfig(),
    ...(getConfig().logo && { logo: getConfig().logo }),
    // Only expose internalUrl in local mode — production uses the public URL directly
    ...(isLocalMode() && { internalUrl: getInternalUrl() }),
    ...(getSettings().enableDecoImport && { enableDecoImport: true }),
    brandExtractEnabled: !!getSettings().firecrawlApiKey,
    auth: buildAuthConfig(),
    posthog: buildPosthogConfig(),
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || null,
    runtime: {
      // Local/dev mode has no cloud agent-sandbox cluster, so cloud Decopilot
      // can't run there — report it unavailable to drop it from the picker.
      agentSandbox: !isLocalMode() && getSettings().agentSandboxEnabled,
    },
  };

  // No explicit Cache-Control previously meant browser/intermediary caching
  // was left to default heuristics. version-check-dialog.tsx polls this on
  // a timer specifically to detect drift — a cached response would return
  // the same stale value forever, defeating the poll and (via a hard
  // refresh clearing that cache) making a stuck dialog look like it only
  // "fixes itself" after Cmd+Shift+R.
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, config });
});

export default app;
