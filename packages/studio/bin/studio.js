#!/usr/bin/env node

// Re-export the @decocms/mesh CLI entry point.
// This wrapper package exists so that `bunx @decocms/studio` works
// while the canonical package remains @decocms/mesh.

const { execFileSync } = require("child_process");
const { createRequire } = require("module");
const { dirname, join } = require("path");

const require_ = createRequire(__filename);
const meshPkgJson = require_.resolve("@decocms/mesh/package.json");
const meshDir = dirname(meshPkgJson);
const meshBin = join(meshDir, "dist", "server", "cli.js");

try {
  execFileSync(process.execPath, [meshBin, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (e) {
  process.exit(e.status || 1);
}
