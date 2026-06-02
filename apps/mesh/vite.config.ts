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
    //
    // Trade-off: `::` is the IPv6 unspecified address, so on stacks with
    // dual-stack sockets enabled (macOS default; Linux when
    // `net.ipv6.bindv6only=0`) this also accepts connections from any LAN
    // interface, not just loopback. That widens the attack surface of the
    // dev server (which serves source). Acceptable here because:
    //  - this file only affects `vite dev` (development), never production;
    //  - Vite's `host` option doesn't support binding to multiple specific
    //    addresses, so there's no in-config way to bind 127.0.0.1 + ::1
    //    only — the cure (loopback-only) reintroduces the cross-sandbox
    //    `localhost:4000` race this fix exists to solve;
    //  - developers running on untrusted networks should firewall :4000 at
    //    the OS level, the same posture as any `vite --host` invocation.
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
