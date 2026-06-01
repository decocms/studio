import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "./package.json" with { type: "json" };

const STUDIO_API_PORT = process.env.STUDIO_API_PORT ?? "3001";
const studioApiTarget = `http://127.0.0.1:${STUDIO_API_PORT}`;

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
    // No host/clientPort: HMR follows location.host (this Vite server).
    // Works in standalone, conductor (Caddy-fronted), and inside any
    // sandbox proxy chain that delivers the page.
    hmr: { overlay: true },
    // When adding a new top-level route to the Studio API, add a proxy
    // entry here. Browser hits Vite first; only listed prefixes reach the API.
    proxy: {
      "/api": { target: studioApiTarget, ws: true, changeOrigin: true },
      "/mcp": { target: studioApiTarget, ws: true, changeOrigin: true },
      "/oauth-proxy": { target: studioApiTarget, changeOrigin: true },
      "/.well-known": { target: studioApiTarget, changeOrigin: true },
      "/org": { target: studioApiTarget, changeOrigin: true },
      "/health": { target: studioApiTarget, changeOrigin: true },
      "/metrics": { target: studioApiTarget, changeOrigin: true },
    },
  },
  clearScreen: false,
  logLevel: "warn",
  plugins: [
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    tailwindcss(),
    tsconfigPaths({ root: "." }),
  ],
});
