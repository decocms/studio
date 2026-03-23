/**
 * MCP Mesh Server Entry Point
 *
 * Bundled server entry point for production.
 * Start with: bun run index.js
 * Or: bun run src/index.ts
 */

// Import observability module early to initialize OpenTelemetry SDK
import "./observability";

import {
  createAssetHandler,
  resolveClientDir,
} from "@decocms/runtime/asset-server";
import { createApp } from "./api/app";
import { isServerPath } from "./api/utils/paths";
import { env, logConfiguration } from "./env";
import { red } from "./fmt";

const port = env.PORT;

// Refuse local mode in production — it disables authentication
if (
  env.DECOCMS_LOCAL_MODE &&
  env.NODE_ENV === "production" &&
  !env.DECOCMS_ALLOW_LOCAL_PROD
) {
  console.error(
    red(
      "Error: Local mode is not allowed in production (NODE_ENV=production).",
    ),
  );
  console.error(
    "Set DECOCMS_ALLOW_LOCAL_PROD=true to override (not recommended).",
  );
  process.exit(1);
}

// Create asset handler - handles both dev proxy and production static files
// When running from source (src/index.ts), the "../client" relative path
// doesn't resolve to dist/client/. Fall back to dist/client/ relative to CWD.
import { existsSync } from "fs";
const resolvedClientDir = resolveClientDir(import.meta.url, "../client");
const clientDir = existsSync(resolvedClientDir)
  ? resolvedClientDir
  : resolveClientDir(import.meta.url, "../dist/client");
const handleAssets = createAssetHandler({
  clientDir,
  isServerPath,
});

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Create the Hono app
const app = await createApp();

// When DECO_CLI is set, the calling script handles its own banner/config output
if (!process.env.DECO_CLI) {
  const { ASCII_ART } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }

  logConfiguration(env);
}

Bun.serve({
  // This was necessary because MCP has SSE endpoints (like notification) that disconnects after 10 seconds (default bun idle timeout)
  idleTimeout: 0,
  port,
  hostname: "0.0.0.0", // Listen on all network interfaces (required for K8s)
  fetch: async (request, server) => {
    // Try assets first (static files or dev proxy), then API
    // Pass server as env so Hono's getConnInfo can access requestIP
    const assetRes = await handleAssets(request);
    if (assetRes) return withSecurityHeaders(assetRes);
    return app.fetch(request, { server });
  },
  development: env.NODE_ENV !== "production",
});

// Local mode: seed admin user + organization after server is listening
// This must run after Bun.serve() so that the org seed can fetch tools
// from the self MCP endpoint (http://localhost:PORT/mcp/self)
if (env.DECOCMS_LOCAL_MODE) {
  import("./auth/local-mode")
    .then(async ({ seedLocalMode, markSeedComplete }) => {
      try {
        const seeded = await seedLocalMode();
        void seeded;
      } catch (error) {
        console.error("Failed to seed local mode:", error);
      } finally {
        markSeedComplete();
      }
    })
    .catch(async (error) => {
      console.error("Failed to load local-mode module:", error);
      // Still release the seed gate so /local-session doesn't hang forever
      try {
        const { markSeedComplete } = await import("./auth/local-mode");
        markSeedComplete();
      } catch {
        // Module itself failed to load — gate was never armed (isLocalMode()
        // would have resolved it immediately in the Promise constructor)
      }
    });
}
