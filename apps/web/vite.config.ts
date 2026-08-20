import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "../api/package.json" with { type: "json" };
import nativePkg from "../native/package.json" with { type: "json" };
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
// Leaf minted by the desktop app into its app-data dir. Read at config time
// so `vite dev` serves the same certificate the Rust listeners do.
const nativeTlsFiles = (() => {
  if (process.env.VITE_TAURI_APP !== "1") return null;
  const dir = `${process.env.HOME}/Library/Application Support/com.decocms.studio/tls`;
  try {
    return {
      cert: readFileSync(`${dir}/leaf-cert.pem`),
      key: readFileSync(`${dir}/leaf-key.pem`),
    };
  } catch {
    return null;
  }
})();

// Must match the scheme local-api actually listens on, which follows the
// shell's control origin. Linux keeps that origin plain http unless
// DECOCMS_LINUX_SECURE_ORIGIN=1 (see src-tauri/src/setup.rs), so defaulting to
// https there makes every proxied path fail: `secure: false` on a proxy entry
// only skips certificate validation, it still opens a TLS handshake against a
// plaintext socket. The page origin is unaffected — `nativeTlsFiles` above
// reads a macOS-only path, so Vite already serves plain http on Linux.
const nativeLocalApiDefaultTarget =
  process.platform === "linux" &&
  process.env.DECOCMS_LINUX_SECURE_ORIGIN !== "1"
    ? "http://127.0.0.1:43121"
    : "https://127.0.0.1:43121";
const nativeLocalApiTarget =
  process.env.NATIVE_LOCAL_API_TARGET ?? nativeLocalApiDefaultTarget;
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
    secure: false,
    ws: true,
  },
  "/mcp": {
    target: appServerTarget,
    changeOrigin: false,
    secure: false,
    ws: true,
  },
  "/oauth-proxy": {
    target: appServerTarget,
    changeOrigin: false,
    secure: false,
    ws: true,
  },
  "/.well-known": {
    target: appServerTarget,
    changeOrigin: false,
    secure: false,
    ws: true,
  },
  "/org": {
    target: appServerTarget,
    changeOrigin: false,
    secure: false,
    ws: true,
  },
  "/health": {
    target: appServerTarget,
    changeOrigin: false,
    secure: false,
  },
  "/metrics": {
    target: appServerTarget,
    changeOrigin: false,
    secure: false,
  },
  // Native-only routes, served by the in-process Rust local-api rather than
  // the Bun API server. Part of the SHARED proxy so `vite preview` reaches
  // them too, not just `vite dev`.
  ...(isNativeBuild
    ? {
        "/_auth": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
          secure: false,
          ws: true,
        },
        "/_local": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
          secure: false,
        },
        "/_sandbox": {
          target: nativeLocalApiTarget,
          changeOrigin: false,
          secure: false,
          ws: true,
        },
      }
    : {}),
};

/**
 * Emit sourcemaps so PostHog error tracking can un-minify stack traces —
 * without them a real captured frame reads `Wr.optimisticHide` at
 * `hooks-12yWjb31.js:15:9394`, naming no file anyone can open.
 *
 * Off unless `BUILD_SOURCEMAPS=1`, which ONLY the release workflow sets. The
 * maps are uploaded and then deleted there, before anything is packed:
 * `build-studio.ts` recursively copies `apps/web/dist` into the shipped
 * package, so a `.map` left behind would publish Studio's sources.
 * The upload lives in CI rather than in a build plugin because a failed
 * upload must never fail a release, and must still clean up after itself.
 */
const emitSourcemaps = process.env.BUILD_SOURCEMAPS === "1" && !isNativeBuild;

/**
 * Cold-start reload storm fix. Vite's esbuild dep crawler only scans the html
 * entry's STATIC import graph up front; anything reached through a lazily
 * executed code path (auth flow, org switcher, home widgets, decopilot tools,
 * route-level lazy panels) is discovered later, at request time, in the
 * browser. Every such discovery re-runs the optimizer and forces a FULL page
 * reload so the module graph stays consistent — on an app this size that is
 * dozens of hard reloads in a row on the first boot of a fresh sandbox /
 * coding-agent Preview, one per newly-found dependency, until
 * `node_modules/.vite` has absorbed them all.
 *
 * Listing them here makes the optimizer pre-bundle everything in ONE pass
 * before the first request is served, so the browser loads once. Nothing in
 * the repo deletes `node_modules/.vite` (the dev command in
 * `apps/api/src/cli/commands/dev.ts` never passes `--force` and never clears
 * it), so on a warm sandbox this is a no-op — it only matters when the cache
 * is genuinely cold.
 *
 * Entries prefixed `@decocms/ui > ` are third-party deps reached THROUGH the
 * linked workspace package: `@decocms/ui` is source, not a pre-bundled dep, so
 * its own imports are crawled as source and their bare specifiers have to be
 * named this way to resolve from that package rather than from `apps/web`.
 * `vite build` ignores `optimizeDeps` entirely, so this is dev-server-only and
 * cannot affect a production bundle.
 */
const optimizeDepsInclude = [
  // Core runtime, statically reachable — listed so a cold rebuild is one pass.
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@tanstack/react-query",
  "@tanstack/react-router",
  "@tanstack/react-virtual",
  "zod",
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
  "sonner",
  "date-fns",
  "@untitledui/icons",

  // Auth — only executes once the user hits the sign-in / SSO path.
  "better-auth/react",
  "better-auth/client/plugins",
  "@better-auth/sso/client",
  "@daveyplate/better-auth-ui",

  // Forms — mounted by dialogs and settings panes, not by the shell.
  "react-hook-form",
  "@hookform/resolvers/zod",

  // Chat / decopilot.
  "ai",
  "@ai-sdk/react",
  "use-stick-to-bottom",
  "marked",
  "mustache",
  "react-markdown",
  "remark-gfm",
  "rehype-raw",

  // MCP client + app host.
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/types.js",
  "@modelcontextprotocol/ext-apps",

  // Heavy lazy panels: editor, terminal, charts, JSON forms, DnD.
  "@monaco-editor/react",
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-web-links",
  "@xterm/addon-webgl",
  "echarts",
  "recharts",
  "react-syntax-highlighter",
  "react-syntax-highlighter/dist/esm/styles/prism/index.js",
  "prettier",
  "@rjsf/shadcn",
  "@rjsf/utils",
  "@rjsf/validator-ajv8",
  "@dnd-kit/core",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@floating-ui/react",
  "@radix-ui/react-dialog",
  "react-resizable-panels",
  "driver.js",
  "posthog-js",

  // Rich-text editor — the single biggest lazy cluster.
  "@tiptap/core",
  "@tiptap/react",
  "@tiptap/react/menus",
  "@tiptap/starter-kit",
  "@tiptap/suggestion",
  "@tiptap/markdown",
  "@tiptap/pm/state",
  "@tiptap/pm/view",
  "@tiptap/extension-bubble-menu",
  "@tiptap/extension-image",
  "@tiptap/extension-link",
  "@tiptap/extension-placeholder",
  "@tiptap/extension-text-align",
  "@tiptap/extension-text-style",

  // Reached only through @decocms/ui's own components.
  "@decocms/ui > @radix-ui/react-accordion",
  "@decocms/ui > @radix-ui/react-alert-dialog",
  "@decocms/ui > @radix-ui/react-aspect-ratio",
  "@decocms/ui > @radix-ui/react-avatar",
  "@decocms/ui > @radix-ui/react-checkbox",
  "@decocms/ui > @radix-ui/react-collapsible",
  "@decocms/ui > @radix-ui/react-context-menu",
  "@decocms/ui > @radix-ui/react-dialog",
  "@decocms/ui > @radix-ui/react-dropdown-menu",
  "@decocms/ui > @radix-ui/react-hover-card",
  "@decocms/ui > @radix-ui/react-label",
  "@decocms/ui > @radix-ui/react-menubar",
  "@decocms/ui > @radix-ui/react-navigation-menu",
  "@decocms/ui > @radix-ui/react-popover",
  "@decocms/ui > @radix-ui/react-progress",
  "@decocms/ui > @radix-ui/react-radio-group",
  "@decocms/ui > @radix-ui/react-scroll-area",
  "@decocms/ui > @radix-ui/react-select",
  "@decocms/ui > @radix-ui/react-separator",
  "@decocms/ui > @radix-ui/react-slider",
  "@decocms/ui > @radix-ui/react-slot",
  "@decocms/ui > @radix-ui/react-switch",
  "@decocms/ui > @radix-ui/react-tabs",
  "@decocms/ui > @radix-ui/react-toggle",
  "@decocms/ui > @radix-ui/react-toggle-group",
  "@decocms/ui > @radix-ui/react-tooltip",
  "@decocms/ui > @radix-ui/react-use-controllable-state",
  "@decocms/ui > cmdk",
  "@decocms/ui > embla-carousel-react",
  "@decocms/ui > next-themes",
  "@decocms/ui > react-day-picker",
  "@decocms/ui > vaul",
  "@decocms/ui > input-otp",
  "@decocms/ui > recharts",
  "@decocms/ui > react-markdown",
  "@decocms/ui > remark-gfm",
];

export default defineConfig({
  optimizeDeps: {
    include: optimizeDepsInclude,
  },
  define: {
    // What `v{__STUDIO_VERSION__}` renders (account popover, settings
    // footer) and what busts the persisted query cache. Read from the
    // manifest of the thing this bundle actually runs inside: apps/api for
    // the browser (the deploy behind the page), apps/native for the desktop
    // (the installed binary). The two share one release line
    // (scripts/release-changes.ts bumps them together), so today they are
    // equal — but sourcing the native value from its OWN manifest keeps the
    // popover honest even if that coupling is ever broken upstream, rather
    // than showing the server's number on a desktop build.
    __STUDIO_VERSION__: JSON.stringify(
      isNativeBuild ? nativePkg.version : pkg.version,
    ),
    // Build-time constant so e2e-only hooks (window.__forceTabError) survive
    // the e2e production build but stay dead-stripped from real prod builds.
    __E2E_TEST_HOOKS__: JSON.stringify(process.env.E2E_TEST_HOOKS === "1"),
  },
  build: {
    outDir: isNativeBuild ? "dist/native" : "dist",
    sourcemap: emitSourcemaps,
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
    // The desktop shell is served from a real hostname, not `localhost`:
    // sandbox previews live at `<handle>.local.studio.decocms.com` so each gets
    // its own cookie jar, and that only keeps the preview iframe first-party if
    // the shell shares its registrable domain. See
    // `apps/native/src-tauri/src/control_origin.rs`.
    // Sandbox previews arrive via the daemon proxy with the external Host intact.
    ...(isNativeBuild
      ? { allowedHosts: ["localhost", ".local.studio.decocms.com"] }
      : process.env.HOST === "0.0.0.0"
        ? {
            allowedHosts: [
              "localhost",
              ".preview-studio.decocms.com",
              ".local.studio.decocms.com",
            ],
          }
        : {}),
    // The desktop dev shell is served by Vite, so it — not just local-api —
    // has to speak HTTPS: the webview's origin must be a secure context (Web
    // Crypto) while also being a real domain (per-sandbox cookie jars). The
    // app mints this leaf on first run from a CA it trusted with macOS; see
    // `apps/native/src-tauri/src/local_tls.rs`. Absent (first ever run, before
    // the app has booted once) we stay on HTTP rather than failing to start.
    ...(isNativeBuild && nativeTlsFiles ? { https: nativeTlsFiles } : {}),
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
