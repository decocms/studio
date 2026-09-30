import { defineConfig } from "tsup";

// Private workspace packages and their npm-only deps (freestyle) are bundled; the host provides the externals.
export default defineConfig({
  entry: { index: "index.ts" },
  format: ["esm"],
  target: "es2022",
  bundle: true,
  clean: true,
  dts: { resolve: true },
  noExternal: [/^@decocms\//],
  external: [
    "@kubernetes/client-node",
    "@opentelemetry/api",
    "postgres",
    "zod",
  ],
});
