import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "../api/package.json" with { type: "json" };
import nativePkg from "../native/package.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { shouldServeNativeEntryInDev } from "./src/lib/vite-native-entry-rules";
import { MONACO_VS_PATH } from "./src/lib/monaco-vs-path";

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

/**
 * Serves the Monaco editor engine from this app's own origin — in dev and in
 * the built bundle alike — out of the installed `monaco-editor` package.
 *
 * `@monaco-editor/loader` pulls the engine in at runtime via
 * `<script src="{paths.vs}/loader.js">`. From a CDN that script is refused by
 * the packaged desktop shell's `script-src 'self'`
 * (`apps/native/src-tauri/tauri.conf.json5`) and every code surface hangs on
 * its loading spinner. `src/lib/monaco-vs-path.ts` holds the path both halves
 * agree on; `src/components/monaco/loader.ts` is the client half.
 *
 * Deliberately NOT under `assets/`: the desktop shell serves that prefix
 * `immutable` (`apps/native/src-tauri/src/ui_assets.rs`) since Vite
 * content-hashes those filenames. These are unhashed — they carry the engine
 * version in the path instead, which is what makes them cacheable.
 */
const monacoVsDir = dirname(
  createRequire(import.meta.url).resolve("monaco-editor/min/vs/loader.js"),
);
/** `min/vs` ships .js, .css and one .ttf; anything else is not ours to serve. */
const MONACO_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
};
/**
 * Translation bundles for monaco's own UI strings — ~1.7 MB the app can never
 * reach, since loading one takes a `require.config({ "vs/nls": … })` call that
 * nothing here makes. Studio's own i18n (`src/i18n/`) is unrelated.
 */
const MONACO_UNREACHABLE = /^nls\.messages\..*\.js$/;

function monacoVsFiles(dir = monacoVsDir, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return monacoVsFiles(join(dir, entry.name), relativePath);
    }
    const servable =
      extname(entry.name) in MONACO_CONTENT_TYPES &&
      !MONACO_UNREACHABLE.test(relativePath);
    return servable ? [relativePath] : [];
  });
}

/** Decoded request path, or null when its escape sequences are malformed. */
function decodeRequestPath(url: string | undefined): string | null {
  const [path = "/"] = (url ?? "/").split("?");
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

const serveSelfHostedMonaco: Plugin = {
  name: "self-hosted-monaco",
  configureServer(server) {
    /**
     * Prefix-mounted, so connect strips it from `req.url`. A miss is answered
     * 404 here rather than passed on: Vite's SPA fallback would hand a
     * `<script>` the index.html body, surfacing as `Unexpected token '<'`.
     */
    server.middlewares.use(MONACO_VS_PATH, (req, res) => {
      const requested = decodeRequestPath(req.url);
      const file = requested && resolve(monacoVsDir, `.${requested}`);
      const contentType = file ? MONACO_CONTENT_TYPES[extname(file)] : null;
      // A crafted `..` stays inside the package dir; anything else 404s.
      if (
        !file ||
        !contentType ||
        !file.startsWith(`${monacoVsDir}/`) ||
        !existsSync(file)
      ) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", contentType);
      res.end(readFileSync(file));
    });
  },
  generateBundle() {
    for (const relativePath of monacoVsFiles()) {
      this.emitFile({
        type: "asset",
        fileName: `${MONACO_VS_PATH.slice(1)}/${relativePath}`,
        source: readFileSync(join(monacoVsDir, relativePath)),
      });
    }
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

export default defineConfig({
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
    serveSelfHostedMonaco,
    ...(isNativeBuild
      ? [emitNativeEntryAsIndexHtml, serveNativeEntryInDev]
      : []),
  ],
});
