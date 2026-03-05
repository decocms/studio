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
import { startDebugServer } from "./debug";

const port = parseInt(process.env.PORT || "3000", 10);
const debugPort = parseInt(process.env.DEBUG_PORT || "9090", 10);
const enableDebugServer = process.env.ENABLE_DEBUG_SERVER === "true";

// ANSI color codes
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const green = "\x1b[32m";
const cyan = "\x1b[36m";
const underline = "\x1b[4m";

const url = `http://localhost:${port}`;

// Create asset handler - handles both dev proxy and production static files
const handleAssets = createAssetHandler({
  clientDir: resolveClientDir(import.meta.url, "../client"),
  isServerPath,
});

// Create the Hono app
const app = await createApp();

console.log("");
console.log(`${green}✓${reset} ${bold}Ready${reset}`);
console.log("");
console.log(
  `  ${dim}Open in browser:${reset}  ${cyan}${underline}${url}${reset}`,
);
console.log("");

Bun.serve({
  // This was necessary because MCP has SSE endpoints (like notification) that disconnects after 10 seconds (default bun idle timeout)
  idleTimeout: 0,
  port,
  hostname: "0.0.0.0", // Listen on all network interfaces (required for K8s)
  fetch: async (request) => {
    // Try assets first (static files or dev proxy), then API
    return (await handleAssets(request)) ?? app.fetch(request);
  },
  development: process.env.NODE_ENV !== "production",
});

// Internal debug server (only enabled via ENABLE_DEBUG_SERVER=true)
if (enableDebugServer) {
  startDebugServer({ port: debugPort });

  console.log(
    `  ${dim}Debug server:${reset}     ${cyan}${underline}http://localhost:${debugPort}${reset}`,
  );
  console.log("");
}
