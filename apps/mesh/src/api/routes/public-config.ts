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
import pkg from "../../../package.json" with { type: "json" };

const app = new Hono();

/**
 * Public configuration exposed to the UI
 */
export type PublicConfig = {
  /**
   * Deployed server version (apps/mesh/package.json). Compared against the
   * client's build-time `__MESH_VERSION__` to detect a stale bundle.
   */
  version: string;
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
  /**
   * Google Maps JS API key for the `format: map` widget (area selector).
   * `null` when GOOGLE_MAPS_API_KEY is unset. It's a client-side token by
   * design (the Maps JS API ships it to the browser); security relies on the
   * key's HTTP-referrer + API restrictions in Google Cloud, not on secrecy.
   * Read at runtime so it can be configured per environment (like posthog).
   */
  googleMapsApiKey: string | null;
  /**
   * Server runtime capabilities that affect client-side affordances.
   */
  runtime: {
    agentSandbox: boolean;
  };
};

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
      agentSandbox:
        !isLocalMode() && getSettings().sandboxProviderKind === "agent-sandbox",
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
