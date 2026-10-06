import { defineConfig } from "tsup";

// Node runs dist/ (the `decocms` binary, and `import` from plain Node); Bun and
// TypeScript resolve src/ through the package's export conditions, so no
// declaration files are built.
export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: ["esm"],
  target: "node20",
  bundle: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: false,
  external: [
    "@modelcontextprotocol/sdk",
    "json-schema-to-typescript",
    "prettier",
    "zod",
  ],
});
