#!/usr/bin/env node

// Re-export the @decocms/mesh CLI entry point.
// This wrapper package exists so that `npx decocms` / `deco` works
// while the canonical package remains @decocms/mesh.

const { execFileSync } = require("child_process");
const { createRequire } = require("module");
const { dirname, join } = require("path");

const require_ = createRequire(__filename);
const meshPkgJson = require_.resolve("@decocms/mesh/package.json");
const meshDir = dirname(meshPkgJson);
const meshBin = join(meshDir, "dist", "server", "cli.js");

// The built CLI uses Bun APIs (Bun.file, Bun.serve), so bun is required.
try {
  execFileSync("bun", ["--version"], { stdio: "ignore" });
} catch {
  console.error("Deco Studio requires Bun to run.");
  console.error("Install it with: curl -fsSL https://bun.sh/install | bash");
  console.error("");
  console.error("Then run: bunx decocms");
  process.exit(1);
}

try {
  execFileSync("bun", [meshBin, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (e) {
  process.exit(e.status || 1);
}
