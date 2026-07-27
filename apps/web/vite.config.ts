import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "../api/package.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { shouldServeNativeEntryInDev } from "./src/lib/vite-native-entry-rules";

const bunServerTarget = `http://localhost:${process.env.PORT || "3000"}`;

// Desktop (Tauri) build mode — VITE_TAURI_APP=1 bun --bun vite build. Points
// the build at index.native.html (-> src/index.native.tsx) instead
// of the standard index.html, into a SEPARATE output dir, so a standard
// `bun run build:web` run (VITE_TAURI_APP=0) is entirely unaffected — every
// branch below falls through to today's exact values when this is false.
// `apps/web`'s `build:native` script (`VITE_TAURI_APP=1 vite build`) sets this;
// tauri.conf's `frontendDist` points straight at `dist/native`, whose
// entry is emitted as `index.html` (see the rename plugin below). See
// apps/web/src/index.native.tsx for the entry itself and
// apps/web/src/lib/desktop/transport.ts for what it wires up.
const isNativeBuild = process.env.VITE_TAURI_APP === "1";
const nativeLocalApiTarget =
  process.env.NATIVE_LOCAL_API_TARGET ?? "http://127.0.0.1:43121";
const appServerTarget = isNativeBuild ? nativeLocalApiTarget : bunServerTarget;

// Native (Tauri) build ONLY: emit the entry as `index.html`, not
// `index.native.html`. Tauri adds a page's inline-script hashes to the CSP
// ONLY for the conventional `index.html` entry, so any other filename makes
// `script-src 'self'` block the entry's own inline bootstrap, which the
// packaged app then can't run. The SOURCE keeps its `.native` suffix so it
// coexists with the web `index.html`; only the emitted file is normalized.
const emitNativeEntryAsIndexHtml: Plugin = {
  name: "native-index-html",
  // `writeBundle` (post-write, on disk) rather than `generateBundle`: vite's
  // own HTML plugin emits the entry LATER in `generateBundle`, so the asset
  // isn't in the bundle map when a user plugin's `generateBundle` runs.
  writeBundle(options) {
    if (!options.dir) return;
    const from = join(options.dir, "index.native.html");
    const to = join(options.dir, "index.html");
    if (existsSync(from)) renameSync(from, to);
  },
};

// Native (Tauri) DEV SERVER only — the HMR loop behind `bun run dev:native`
// (tauri.conf's `devUrl` points the shell's webview at this server). Serve
// `index.native.html` for every SPA html navigation: the shell's window opens
// `index.html` (same literal path as the packaged app), and a mid-session
// full reload can land on `/` or a deep link like `/my-org` — without this
// rewrite Vite's SPA fallback would serve the WEB entry (`index.html` →
// `index.web.tsx`, no desktop transport) inside the native window. Mirrors what
// `emitNativeEntryAsIndexHtml` does for the built output, at request time.
// User middlewares run BEFORE Vite's internal html/SPA-fallback middleware,
// so rewriting `req.url` here is all it takes. Unsafe methods, reserved API
// paths, and non-navigation requests pass through untouched.
const serveNativeEntryInDev: Plugin = {
  name: "native-index-html-dev",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (
        shouldServeNativeEntryInDev({
          method: req.method,
          url: req.url,
          accept: req.headers.accept,
        })
      ) {
        req.url = "/index.native.html";
      }
      next();
    });
  },
};

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
    target: appServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/mcp": {
    target: appServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/oauth-proxy": {
    target: appServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/.well-known": {
    target: appServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/org": {
    target: appServerTarget,
    changeOrigin: false,
    ws: true,
  },
  "/health": {
    target: appServerTarget,
    changeOrigin: false,
  },
  "/metrics": {
    target: appServerTarget,
    changeOrigin: false,
  },
  // Native-only routes, served by the in-process Rust local-api rather than
  // the Bun API server. Part of the SHARED proxy so `vite preview` reaches
  // them too, not just `vite dev`.
  ...(isNativeBuild
    ? {
        "/_auth": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
          ws: true,
        },
        "/_local": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
        },
        "/_sandbox": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
          ws: true,
        },
        "/threads": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
        },
        "/models": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
        },
      }
    : {}),
};

export default defineConfig({
  define: {
    __STUDIO_VERSION__: JSON.stringify(pkg.version),
    // Build-time constant so e2e-only hooks (window.__forceTabError) survive
    // the e2e production build but stay dead-stripped from real prod builds.
    __E2E_TEST_HOOKS__: JSON.stringify(process.env.E2E_TEST_HOOKS === "1"),
  },
  build: {
    outDir: isNativeBuild ? "dist/native" : "dist",
    ...(isNativeBuild
      ? {
          rollupOptions: {
            input: fileURLToPath(
              new URL("./index.native.html", import.meta.url),
            ),
          },
        }
      : {}),
  },
  server: {
    port: parseInt(process.env.VITE_PORT || "4000", 10),
    strictPort: true,
    // In a sandbox the daemon proxies the preview to Vite over IPv4
    // (127.0.0.1); Vite otherwise binds IPv6-only (localhost → [::1]) and the
    // proxy can't reach it. HOST=0.0.0.0 is the daemon's dev-env tell.
    ...(isNativeBuild
      ? { host: "127.0.0.1" }
      : process.env.HOST === "0.0.0.0"
        ? { host: true }
        : {}),
    ...(isNativeBuild ? { allowedHosts: ["localhost"] } : {}),
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
    ...(isNativeBuild
      ? [emitNativeEntryAsIndexHtml, serveNativeEntryInDev]
      : []),
  ],
});
