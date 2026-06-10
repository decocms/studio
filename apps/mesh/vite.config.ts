import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import deco from "@decocms/vite-plugin";
import pkg from "./package.json" with { type: "json" };

const bunServerTarget = `http://localhost:${process.env.PORT || "3000"}`;

export default defineConfig({
  define: {
    __MESH_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    hmr: {
      overlay: true,
      host: "localhost",
      clientPort: parseInt(process.env.VITE_PORT || "4000", 10),
    },
    proxy: {
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
    },
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
