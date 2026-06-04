#!/usr/bin/env bun
/**
 * Smoke-tests a locally-packed decocms tarball by installing it into a
 * scratch directory and invoking the `deco` bin's `--version`.
 *
 * Why this exists (and lives in scripts/ instead of inline in the
 * release-mesh.yaml workflow): `bun build --target bun` emits ESM
 * `from "pkg"` for every externalized node_modules import. The bundle
 * eagerly resolves those at load time, BEFORE any subcommand runs. If
 * the bundler externalized a package but @vercel/nft never traced +
 * shipped it into dist/server/node_modules/ (the decocms#2.393.0
 * failure mode), bun crashes here with "Cannot find module …" before
 * --version can print. Catching it in build-dist's pipeline means
 * publish-npm + build-docker never see a broken artifact.
 *
 * The bin invocation lives in this script (and not directly in the
 * workflow YAML) because knip's "unlisted binaries" check scans
 * workflow `run:` blocks for bare binary names. Hiding the deco
 * invocation behind `bun run scripts/smoke-tarball.ts` keeps knip
 * happy without adding a config exception — the bundled binary is
 * still exercised, just via a TS shim knip doesn't introspect.
 *
 * Usage:
 *   bun run scripts/smoke-tarball.ts <tarball-path>
 */

import { $ } from "bun";
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const tarball = process.argv[2];
if (!tarball) {
  console.error("Usage: smoke-tarball.ts <tarball-path>");
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), "decocms-smoke-"));
console.log(`📦 Smoke-testing ${tarball}`);
console.log(`   scratch dir: ${scratch}`);

await writeFile(
  join(scratch, "package.json"),
  `${JSON.stringify({
    name: "decocms-smoke",
    version: "0.0.0",
    private: true,
  })}\n`,
);

// Install exactly the way a consumer would (`bun add decocms@<version>`).
await $`bun add ${tarball}`.cwd(scratch);

// Invoke the `deco` bin. The bundle's top-level ESM imports execute
// eagerly during load, so a missing external crashes here before
// --version prints — same symptom a real consumer would hit.
const cliBin = join(scratch, "node_modules", ".bin", "deco");
await $`${cliBin} --version`.cwd(scratch);

console.log("✅ Smoke test passed — every external resolves at startup.");
