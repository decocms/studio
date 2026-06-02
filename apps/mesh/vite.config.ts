import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import deco from "@decocms/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __MESH_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Bind dual-stack so both IPv4 (127.0.0.1) and IPv6 (::1) `localhost`
    // resolutions hit this server. Without this, Vite defaults to v4 only,
    // and a *different* sandbox's Vite that grabbed [::1]:4000 first will
    // silently win every `localhost:4000` connection (macOS resolves IPv6
    // before IPv4). That mis-routes the `deco link` tunnel → wrong Vite →
    // wrong HMR client → endless "server connection lost".
    host: "::",
    // No clientPort: HMR follows location.host (this Vite server).
    // Works in standalone, conductor (Caddy-fronted), and inside any
    // sandbox proxy chain that delivers the page.
    hmr: { overlay: true },
  },
  clearScreen: false,
  logLevel: "warn",
  plugins: [
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    tailwindcss(),
    tsconfigPaths({ root: "." }),
    deco({
      target: "bun",
    }),
  ],
});
