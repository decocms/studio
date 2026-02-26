import { defineConfig, type Options } from "tsup";

const config: Options = {
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "es2022",
  bundle: true,
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: true,
  treeshake: true,
  shims: true,
  external: [
    "node:*",
    "@modelcontextprotocol/sdk",
    "json-schema-to-typescript",
    "prettier",
  ],
};

export default defineConfig(config);
