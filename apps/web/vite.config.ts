import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "../api/package.json" with { type: "json" };

const bunServerTarget = `http://localhost:${process.env.PORT || "3000"}`;

// IMPORTANT: the dev server must run under Node, NOT Bun (`vite dev`, never
// `bun --bun vite dev`). The proxy below relies on the ServerResponse "close"
// event to propagate client disconnects upstream (http-proxy destroys the
// proxied request when the downstream client goes away). Bun's node:http
// compat never emits that event on premature disconnect, so under Bun an
// aborted SSE stream / long-poll keeps running on the Bun API server forever —
// chat-turn cancels never arrive and orphaned `GET /api/links/work` polls
// swallow pull-dispatch work items (e2e: link-proxy.spec.ts,
// link-dispatch-pull.spec.ts).

// Shared by the dev server AND `vite preview`: e2e serves the production
// build through preview, and its readiness probe + every spec reach the API
// through these routes. Both run under Node (see the Bun warning above —
// preview uses the same http-proxy and needs the same "close" propagation).
const sharedProxy = {
  "/api": {
    target: bunServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/mcp": {
    target: bunServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/oauth-proxy": {
    target: bunServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/.well-known": {
    target: bunServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/org": {
    target: bunServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/health": {
    target: bunServerTarget,
    changeOrigin: false,
  },
  "/metrics": {
    target: bunServerTarget,
    changeOrigin: false,
  },
};

export default defineConfig({
  define: {
    __STUDIO_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
  },
  server: {
    port: parseInt(process.env.VITE_PORT || "4000", 10),
    strictPort: true,
    // In a sandbox the daemon proxies the preview to Vite over IPv4
    // (127.0.0.1); Vite otherwise binds IPv6-only (localhost → [::1]) and the
    // proxy can't reach it. HOST=0.0.0.0 is the daemon's dev-env tell.
    ...(process.env.HOST === "0.0.0.0" ? { host: true } : {}),
    hmr: {
      overlay: true,
      host: "localhost",
      clientPort: parseInt(process.env.VITE_PORT || "4000", 10),
    },
    proxy: sharedProxy,
  },
  preview: {
    port: parseInt(process.env.VITE_PORT || "4000", 10),
    strictPort: true,
    proxy: sharedProxy,
  },
  clearScreen: false,
  logLevel: "warn",
  plugins: [
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    tailwindcss(),
    tsconfigPaths({ root: "." }),
  ],
});
