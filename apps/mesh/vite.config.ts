import { Socket } from "node:net";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "./package.json" with { type: "json" };

const API_PORT = process.env.API_PORT ?? "3001";
const apiTarget = `http://127.0.0.1:${API_PORT}`;

// ── Bun socket `destroySoon` polyfill ────────────────────────────────
// Vite's bundled http-proxy calls `socket.destroySoon()` on the `end`
// event of a proxied chunked / streaming response (notably long-running
// MCP POSTs and SSE on /api, /mcp). Bun's node:http polyfill does not
// expose `destroySoon` on the sockets it hands the HTTP layer (as of
// v1.3.14), so the first such response crashes Vite with
//   TypeError: socket.destroySoon is not a function
// and the cross-linked-children kill in dev.ts then drops the API
// child too. We polyfill at two layers — `net.Socket.prototype`
// (covers anything inheriting from the canonical class) and
// per-incoming HTTP connection (covers Bun's own socket class if it
// differs) — using end-then-destroy-on-finish semantics that mirror
// Node. Both checks become no-ops the moment Bun ships a native
// implementation.
interface SocketLike {
  writable?: boolean;
  end?: () => void;
  destroy?: () => void;
  once?: (ev: string, cb: () => void) => void;
}

function destroySoonPolyfill(this: SocketLike) {
  if (this.writable && typeof this.end === "function") {
    this.end();
    if (typeof this.once === "function" && typeof this.destroy === "function") {
      this.once("finish", () => this.destroy?.());
      return;
    }
  }
  this.destroy?.();
}

{
  const proto = Socket.prototype as unknown as {
    destroySoon?: typeof destroySoonPolyfill;
  };
  if (typeof proto.destroySoon !== "function") {
    proto.destroySoon = destroySoonPolyfill;
  }
}

function bunSocketDestroySoonPolyfill(): Plugin {
  return {
    name: "bun-destroysoon-polyfill",
    configureServer(server) {
      server.httpServer?.on("connection", (socket: unknown) => {
        const s = socket as SocketLike & {
          destroySoon?: typeof destroySoonPolyfill;
        };
        if (typeof s.destroySoon !== "function") {
          s.destroySoon = destroySoonPolyfill;
        }
      });
    },
  };
}

export default defineConfig({
  define: {
    __MESH_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist/client",
  },
  server: {
    // Vite binds PORT (user-facing). The CLI sets PORT=userPort for the
    // Vite child. Explicit here to override any default that
    // @decocms/vite-plugin's baseDecoPlugin might inject via server.port.
    port: Number(process.env.PORT ?? "3000"),
    // Bind dual-stack so `localhost` clients on either v4 (127.0.0.1) or
    // v6 (::1) connect successfully. On Linux/macOS with the default
    // `bindv6only=0`, a `[::]` socket also accepts IPv4-mapped traffic.
    // The previous topology hid this — Bun.serve with hostname "0.0.0.0"
    // was de facto dual-stacking — but Vite's default `127.0.0.1` only
    // listens on v4, and Playwright's APIRequestContext doesn't Happy-
    // Eyeballs-fall-back from `::1` ECONNREFUSED to `127.0.0.1`, so e2e
    // jobs whose runners resolve `localhost` to `::1` first all failed
    // with `connect ECONNREFUSED ::1:3000`.
    host: "::",
    // No clientPort: HMR follows location.host (this Vite server).
    // Works in standalone, conductor (Caddy-fronted), and inside any
    // sandbox proxy chain that delivers the page.
    hmr: { overlay: true },
    // When adding a new top-level route to the API, add a proxy entry
    // here. Browser hits Vite first; only listed prefixes reach the API.
    proxy: {
      "/api": { target: apiTarget, ws: true, changeOrigin: true },
      "/mcp": { target: apiTarget, ws: true, changeOrigin: true },
      "/oauth-proxy": { target: apiTarget, changeOrigin: true },
      "/.well-known": { target: apiTarget, changeOrigin: true },
      "/org": { target: apiTarget, changeOrigin: true },
      "/health": { target: apiTarget, changeOrigin: true },
      "/metrics": { target: apiTarget, changeOrigin: true },
    },
  },
  clearScreen: false,
  logLevel: "warn",
  plugins: [
    // Must come before any plugin that may handle HTTP — runs first in
    // `configureServer` to wire the `connection` listener before the
    // first incoming request.
    bunSocketDestroySoonPolyfill(),
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    tailwindcss(),
    tsconfigPaths({ root: "." }),
  ],
});
