import { defineConfig } from "tsup";

// The workspace packages are private, so they are bundled in; npm
// dependencies stay external.
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
