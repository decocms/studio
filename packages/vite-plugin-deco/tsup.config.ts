import { defineConfig, type Options } from "tsup";

const config: Options = {
  entry: {
    index: "index.ts",
  },
  format: ["esm"],
  target: "es2022",
  bundle: true,
  sourcemap: true,
  clean: true,
  dts: true,
  minify: false,
  splitting: false,
  treeshake: true,
  shims: true,
};

export default defineConfig(config);
